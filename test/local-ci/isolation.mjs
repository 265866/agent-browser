// Process and state isolation shared by local CI (exec.mjs) and the dogfood
// harness: environment scrubbing, process cleanup, locks, ownership markers,
// and the Windows profile directory lease.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { createServer, connect } from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';

const isWin = process.platform === 'win32';

// Host variables that must never reach code under test: agent-browser's own
// configuration (it could point at a real Chrome profile or CDP endpoint),
// agent sockets, git overrides, and anything credential-shaped.
const SCRUB = [
  /^AGENT_BROWSER_/i,
  /^ANTHROPIC_/i,
  /^CLAUDE_/i,
  /^(GH|GITHUB|GITLAB|AWS|AZURE|GOOGLE|GCP|OPENAI|NPM|BROWSERBASE|KERNEL|BROWSER_USE)_/i,
  /^(SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO|GIT_ASKPASS|SSH_ASKPASS)$/i,
  /^GIT_CONFIG/i,
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_KEY|PRIVATE_KEY|SESSION_KEY/i,
];

export function scrubbedEnv(source = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    if (SCRUB.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  return env;
}

export function killTree(pid, { group = false } = {}) {
  if (!pid) return;
  if (isWin) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    return;
  }
  if (group) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
  spawnSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' });
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A path matches only as a whole directory ("target-1" must not match
// "target-10"). POSIX classes, because macOS pgrep does not know \s.
const dirPattern = (p) =>
  `${escapeRegex(p)}(${escapeRegex(sep)}|/|"|'|${isWin ? '\\s' : '[[:space:]]'}|$)`;

/**
 * Stops leftover processes (daemons, browsers, test binaries) that belong to
 * a run. `paths` match against the image path or the command line; pass only
 * directories with a per-run unique name. `images` match against the image
 * path alone (Windows ExecutablePath, argv[0] on Unix); use it for shared
 * locations such as a build slot's target dir, where another tool's command
 * line may legitimately mention the path. This process, its parent, and the
 * cleanup helper itself are always spared. Returns a log of what was stopped.
 */
export function killProcessesUnder(paths, { images = [] } = {}) {
  const lines = [];
  const variants = (ps) => [...new Set(ps.flatMap((p) => [p, p.replace(/\\/g, '/')]))];
  if (isWin) {
    const list = (ps) => variants(ps).map((p) => `'${dirPattern(p).replace(/'/g, "''")}'`);
    const ps =
      `$cmd=@(${list(paths).join(',')}); $img=@(${list(images).join(',')}); $self=$PID; ` +
      `$parent=(Get-CimInstance Win32_Process -Filter "ProcessId=$self").ParentProcessId; ` +
      `$targets = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -notin @($self, $parent, ${process.pid}, ${process.ppid}) } | ` +
      `Where-Object { $p = "$($_.ExecutablePath)"; $c = "$p $($_.CommandLine)"; ($cmd | Where-Object { $c -imatch $_ }) -or ($img | Where-Object { $p -imatch $_ }) }); ` +
      `foreach ($t in $targets) { try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop; Write-Output "stopped $($t.ProcessId) $($t.Name)" } catch { Write-Output "could not stop $($t.ProcessId) $($t.Name): $_" } }`;
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
    });
    if (r.stdout?.trim()) lines.push(r.stdout.trim());
    if (r.status !== 0 && r.stderr?.trim()) lines.push(`cleanup error: ${r.stderr.trim()}`);
    return lines.join('\n');
  }
  const spare = new Set([process.pid, process.ppid]);
  const stop = (pid, why) => {
    if (pid <= 0 || spare.has(pid)) return;
    try {
      process.kill(pid, 'SIGKILL');
      lines.push(`stopped ${pid} (${why})`);
    } catch {}
  };
  for (const p of paths) {
    const r = spawnSync('pgrep', ['-f', dirPattern(p)], { encoding: 'utf8' });
    for (const pid of (r.stdout ?? '').split('\n').map(Number)) stop(pid, `matched ${p}`);
  }
  if (images.length) {
    const r = spawnSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split('\n')) {
      // argv[0] may contain spaces, so match the start of the whole args string.
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const dir = images.find((d) => m[2].startsWith(`${d}/`));
      if (dir) stop(Number(m[1]), `image under ${dir}`);
    }
  }
  return lines.join('\n');
}

// Lease files and ownership markers hold "<pid> <heartbeat ms>" and are
// written atomically. A lease is stale when its pid is gone, or its heartbeat
// is older than ten minutes (a reused pid cannot hold it forever; owners
// refresh every minute). Content that cannot be parsed counts as live until
// the file itself is older than ten minutes.
const HEARTBEAT_MS = 60_000;
const STALE_MS = 10 * 60_000;
const stamp = () => `${process.pid} ${Date.now()}`;

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function readStamp(file) {
  try {
    const m = readFileSync(file, 'utf8')
      .trim()
      .match(/^(\d+) (\d+)$/);
    return m ? { pid: Number(m[1]), beat: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

export function isStale(file) {
  const s = readStamp(file);
  if (!s) {
    try {
      return Date.now() - statSync(file).mtimeMs > STALE_MS;
    } catch {
      return true;
    }
  }
  return !isAlive(s.pid) || Date.now() - s.beat > STALE_MS;
}

// Refreshes a per-process stamp file until stopped, or until another process
// has written its own stamp there.
function heartbeat(file) {
  const timer = setInterval(() => {
    const s = readStamp(file);
    if (s && s.pid !== process.pid) return clearInterval(timer);
    try {
      writeAtomic(file, stamp());
    } catch {}
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Locks are exclusive listeners on a loopback port derived from the lock's
// name. The kernel guarantees a single holder and frees the port when the
// holder exits, however it exits, so there is no stale-lock detection. The
// range sits below every OS's ephemeral port range (Linux starts at 32768,
// Windows and macOS at 49152) and clear of Windows' reserved blocks;
// AGENT_BROWSER_HARNESS_LOCK_PORT_BASE moves it if a host needs that.
const LOCK_PORT_BASE = Number(process.env.AGENT_BROWSER_HARNESS_LOCK_PORT_BASE) || 20_000;
const LOCK_PORT_SPAN = 12_000;
const LOCK_GREETING = 'agent-browser-harness-lock';
const heldPorts = new Map();

/**
 * Lock names are either a host-wide resource, `host:<name>`, which every run
 * on the host shares whatever its paths or environment, or a filesystem path
 * for a resource that lives at that path (a build slot's target directory).
 * Paths are canonicalized so 8.3 names, junctions, and case map to one lock.
 */
export function lockPortFor(lock) {
  let name = lock;
  if (!lock.startsWith('host:')) {
    const abs = resolve(lock);
    let parent = dirname(abs);
    try {
      parent = realpathSync.native(parent);
    } catch {}
    name = join(parent, basename(abs));
    if (isWin) name = name.toLowerCase();
  }
  const h = createHash('sha256').update(name).digest();
  return { name, port: LOCK_PORT_BASE + (h.readUInt32BE(0) % LOCK_PORT_SPAN) };
}

function listenExclusive(port, name) {
  return new Promise((res) => {
    const server = createServer((sock) => {
      sock.on('error', () => {});
      sock.end(`${LOCK_GREETING} ${process.pid} ${name}\n`);
    });
    server.once('error', (err) => res({ err }));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      // Later accept errors (for example EMFILE) must not crash the holder.
      server.removeAllListeners('error');
      server.on('error', () => {});
      res({ server });
    });
  });
}

/**
 * Connects to a lock port and classifies whatever answers: `free` when
 * nothing listens (a listener on 0.0.0.0 or :: also accepts loopback
 * connections, so it counts as an answer), `harness` with the holder's pid
 * and lock name, `silent` when something accepts but says nothing in time
 * (a busy harness holder or another program), or `foreign`.
 */
function probeLockPort(port) {
  return new Promise((res) => {
    const sock = connect({ port, host: '127.0.0.1' });
    let text = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      res(r);
    };
    sock.setTimeout(5000, () => done(text ? { kind: 'foreign', text } : { kind: 'silent' }));
    sock.on('data', (d) => {
      text += d;
      if (text.includes('\n')) sock.end();
    });
    sock.on('error', (err) =>
      done(err.code === 'ECONNREFUSED' ? { kind: 'free' } : { kind: 'foreign', text: err.code })
    );
    sock.on('close', () => {
      const [greeting, pid, ...rest] = text.trim().split(' ');
      done(
        greeting === LOCK_GREETING
          ? { kind: 'harness', pid: Number(pid), name: rest.join(' ') }
          : { kind: 'foreign', text: text.trim() }
      );
    });
  });
}

const describeHolder = (p) =>
  p.kind === 'harness'
    ? `harness pid ${p.pid} (${p.name})`
    : p.kind === 'silent'
      ? 'a process that accepts connections but does not answer'
      : 'another program';

/**
 * Mutual exclusion across concurrent runs on one host. Waits while another
 * harness run holds the lock and throws after timeoutMs. Throws at once when
 * another program listens on the lock's port, since waiting would not help
 * and taking the port beside it would intercept that program's connections.
 * Returns an idempotent release function. onWait receives the holder's
 * description.
 */
export async function acquireLock(lock, { timeoutMs = 2 * 60 * 60_000, onWait = () => {} } = {}) {
  const { name, port } = lockPortFor(lock);
  const other = heldPorts.get(port);
  if (other !== undefined)
    throw new Error(`lock ${name} maps to port ${port}, which this process already holds for ${other}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holder = await probeLockPort(port);
    if (holder.kind === 'foreign')
      throw new Error(
        `cannot take lock ${name}: another program listens on port ${port}; set AGENT_BROWSER_HARNESS_LOCK_PORT_BASE to move the harness lock ports`
      );
    if (holder.kind === 'free') {
      const { server, err } = await listenExclusive(port, name);
      if (server) {
        server.unref();
        heldPorts.set(port, name);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          heldPorts.delete(port);
          server.close();
        };
      }
      if (err.code !== 'EADDRINUSE')
        throw new Error(`cannot take lock ${name} on port ${port}: ${err.message}`);
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for lock ${name}: port ${port} is held by ${describeHolder(holder)}`);
    onWait(describeHolder(holder));
    await sleep(500);
  }
}

// On Windows, agent-browser resolves its state directory through the Known
// Folder API, so no environment variable can move %USERPROFILE%\.agent-browser
// into a throwaway location, and code under test (cargo tests, e2e tests, the
// real CLI) writes there. If the directory does not exist, the harness creates
// it with an ownership marker, and every run that uses it holds a lease file
// inside it. When the last lease is released the directory is removed
// (including anything another program wrote into it meanwhile). A directory
// without the marker belongs to the user: the lease reports it as userOwned
// and the harness never writes, moves, or deletes it.
const PROFILE_MARKER = '.created-by-agent-browser-test-harness';
const LEASES = '.harness-leases';

/** The real profile state directory, independent of environment variables. */
export function profileStateDir() {
  return join(userInfo().homedir, '.agent-browser');
}

// `dir` is for tests; real runs always use the profile state directory.
export async function acquireProfileLease({ dir } = {}) {
  if (!isWin && !dir) return { userOwned: false, release: async () => '' };
  dir ??= profileStateDir();
  const leases = join(dir, LEASES);
  const mine = join(leases, String(process.pid));
  let userOwned = false;
  const unlock = await acquireLock('host:profile-lease', { timeoutMs: 120_000 });
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, PROFILE_MARKER), 'Created by agent-browser local CI or dogfood harness.\n');
    }
    userOwned = !existsSync(join(dir, PROFILE_MARKER));
    if (!userOwned) {
      mkdirSync(leases, { recursive: true });
      writeAtomic(mine, stamp());
    }
  } finally {
    unlock();
  }
  const stop = userOwned ? () => {} : heartbeat(mine);
  let released = false;
  return {
    userOwned,
    async release() {
      if (released || userOwned) return '';
      released = true;
      stop();
      let unlockRelease;
      try {
        unlockRelease = await acquireLock('host:profile-lease', { timeoutMs: 120_000 });
        rmSync(mine, { force: true });
        let live = 0;
        for (const f of existsSync(leases) ? readdirSync(leases) : []) {
          if (!/^\d+$/.test(f)) continue;
          if (isStale(join(leases, f))) rmSync(join(leases, f), { force: true });
          else live++;
        }
        if (live > 0 || !existsSync(join(dir, PROFILE_MARKER))) return '';
        // Rename first (same volume) so nothing can write into a directory
        // that is half deleted.
        const parked = `${dir}.harness-removed-${process.pid}-${Date.now()}`;
        renameSync(dir, parked);
        rmSync(parked, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
        return `removed harness-owned ${dir}`;
      } catch (err) {
        return `could not remove ${dir}: ${err.message}`;
      } finally {
        unlockRelease?.();
      }
    },
  };
}

// Ownership markers let a later run remove what a run left behind when it was
// killed outright (TerminateProcess on Windows skips every handler).
const OWNER_MARKER = '.agent-browser-harness-owner';

/** Creates `dir` (if needed) and records this process as its owner. */
export function claimDir(dir) {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, OWNER_MARKER), stamp());
}

/**
 * Removes direct children of `root` whose names start with one of `prefixes`
 * and that carry a valid harness ownership marker naming a process that is
 * gone. Anything else, including directories other programs created, is left
 * alone.
 */
export function sweepOrphans(root, prefixes, onRemove = () => {}) {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const dir = join(root, name);
    const s = readStamp(join(dir, OWNER_MARKER));
    if (!s || isAlive(s.pid)) continue;
    try {
      killProcessesUnder([dir]);
      onRemove(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {}
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
