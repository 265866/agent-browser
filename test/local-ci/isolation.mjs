// Process and state isolation shared by local CI (exec.mjs) and the dogfood
// harness: environment scrubbing, process cleanup, locks, ownership markers,
// and the Windows profile directory lease.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
import { tmpdir, userInfo } from 'node:os';
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

// Ownership markers hold "<pid> <ms>" and are written atomically; a marker
// belongs to its pid while that pid is alive. Profile leases also carry the
// port and token of a listener their holder keeps, which makes their liveness
// exact (see acquireProfileLease). A lease that cannot be parsed counts as live until
// the file itself is older than ten minutes.
const UNPARSEABLE_GRACE_MS = 10 * 60_000;
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
      .match(/^(\d+) (\d+)(?: (\d+) (\S+))?$/);
    return m
      ? { pid: Number(m[1]), beat: Number(m[2]), port: m[3] && Number(m[3]), token: m[4] }
      : null;
  } catch {
    return null;
  }
}

function unparseableIsOld(file) {
  try {
    return Date.now() - statSync(file).mtimeMs > UNPARSEABLE_GRACE_MS;
  } catch {
    return true;
  }
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
 * and lock name, `busy` when the connection is accepted but closed or reset
 * without a word or nothing arrives in time (a harness holder whose event
 * loop is blocked, possibly releasing right now), or `foreign` when bytes
 * other than the harness greeting arrive.
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
    sock.setTimeout(5000, () =>
      done(text ? { kind: 'foreign', text } : { kind: 'busy', silent: true })
    );
    sock.on('data', (d) => {
      text += d;
      if (text.includes('\n')) sock.end();
    });
    sock.on('error', (err) =>
      done(
        err.code === 'ECONNREFUSED'
          ? { kind: 'free' }
          : { kind: 'busy', closed: true, text: err.code }
      )
    );
    sock.on('close', () => {
      const [greeting, pid, ...rest] = text.trim().split(' ');
      if (greeting === LOCK_GREETING)
        done({ kind: 'harness', pid: Number(pid), name: rest.join(' ') });
      else
        done(text.trim() ? { kind: 'foreign', text: text.trim() } : { kind: 'busy', closed: true });
    });
  });
}

const describeHolder = (p) =>
  p.kind === 'harness'
    ? `harness pid ${p.pid} (${p.name})`
    : p.kind === 'busy'
      ? 'a process that accepts connections without answering (a busy harness run, or another program)'
      : p.kind === 'bound'
        ? 'a socket that is bound to the port but not listening'
        : 'another program';

// A harness holder closes a probe without its greeting only while it is
// releasing (once or twice), and stays silent only while its event loop is
// blocked by synchronous work. Anything that keeps doing either is another
// program, such as a port relay that accepts and drops connections.
const MAX_CLOSED_PROBES = 20;
const MAX_SILENT_MS = 10 * 60_000;

/**
 * Mutual exclusion across concurrent runs on one host. Waits while another
 * harness run holds the lock and throws after timeoutMs. Throws early when
 * another program answers on the lock's port, keeps accepting and dropping
 * probes, or stays silent for ten minutes, since waiting would not help and
 * taking the port beside it would intercept that program's connections.
 * Returns an idempotent release function. onWait receives the holder's
 * description.
 */
export async function acquireLock(lock, { timeoutMs = 2 * 60 * 60_000, onWait = () => {} } = {}) {
  const { name, port } = lockPortFor(lock);
  const other = heldPorts.get(port);
  if (other !== undefined)
    throw new Error(
      `lock ${name} maps to port ${port}, which this process already holds for ${other}`
    );
  const deadline = Date.now() + timeoutMs;
  let closedProbes = 0;
  let silentSince = null;
  for (;;) {
    const holder = await probeLockPort(port);
    closedProbes = holder.closed ? closedProbes + 1 : 0;
    silentSince = holder.silent ? (silentSince ?? Date.now()) : null;
    if (
      holder.kind === 'foreign' ||
      closedProbes >= MAX_CLOSED_PROBES ||
      (silentSince !== null && Date.now() - silentSince > MAX_SILENT_MS)
    )
      throw new Error(
        `cannot take lock ${name}: port ${port} is used by ${
          holder.kind === 'foreign'
            ? `another program (it answered ${JSON.stringify(String(holder.text).slice(0, 60))})`
            : holder.closed
              ? 'another program that keeps accepting and dropping connections'
              : 'a process that has accepted connections without answering for ten minutes'
        }; set AGENT_BROWSER_HARNESS_LOCK_PORT_BASE to move the harness lock ports`
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
      // Nothing listens, yet the port is taken: a socket bound to it without
      // listening (for example an outbound connection using it as its local
      // port), or a holder that started listening just now.
      holder.kind = 'bound';
    }
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for lock ${name}: port ${port} is held by ${describeHolder(holder)}`
      );
    onWait(describeHolder(holder));
    await sleep(500);
  }
}

// On Windows, agent-browser resolves its state directory through the Known
// Folder API, so no environment variable can move %USERPROFILE%\.agent-browser
// into a throwaway location, and code under test (cargo tests, e2e tests, the
// real CLI) writes there. If the directory does not exist, the harness creates
// it with an ownership marker, and every run that uses it holds a lease file
// inside it. A lease records the port and a random token of a listener its
// holder keeps (on a port the OS picks, so it never collides with a lock), so
// a lease is live exactly while that listener answers with its token (a
// reused pid cannot keep a dead lease alive). When the last lease is released the directory is
// moved into a quarantine, not deleted: if the user ran agent-browser while it
// existed, their state landed there too and stays recoverable. The first
// release three or more days later deletes a quarantined copy. A directory
// without the marker belongs to the user: the lease reports it as userOwned
// and the harness never writes, moves, or deletes anything in it.
const PROFILE_MARKER = '.created-by-agent-browser-test-harness';
const LEASES = '.harness-leases';
const QUARANTINE_DAYS = 3;
const QUARANTINE = 'agent-browser-harness-quarantine';

/** The real profile state directory, independent of environment variables. */
export function profileStateDir() {
  return join(userInfo().homedir, '.agent-browser');
}

// Earlier harness revisions wrote "<pid> <ms> host:<lock>" leases and did not
// refresh them; those count as live while their pid is.
const LEGACY_LEASE = /^(\d+) \d+ host:\S+$/;

async function leaseAlive(file) {
  const s = readStamp(file);
  if (!s) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8').trim();
    } catch {}
    const legacy = text.match(LEGACY_LEASE);
    return legacy ? isAlive(Number(legacy[1])) : !unparseableIsOld(file);
  }
  if (!s.port) return isAlive(s.pid);
  const p = await probeLockPort(s.port);
  if (p.kind === 'harness') return p.name === s.token;
  // A holder whose event loop is blocked accepts without answering.
  return p.kind === 'busy' && isAlive(s.pid);
}

// `dir`, `quarantine`, and `refreshMs` are for tests; real runs always use
// the profile state directory and a quarantine in the temp dir (or, when that
// is on another volume, next to the profile directory).
export async function acquireProfileLease({ dir, quarantine, refreshMs = 60_000 } = {}) {
  if (!isWin && !dir) return { userOwned: false, release: async () => '' };
  const lockName = dir ? `${dir}.lease-lock` : 'host:profile-lease';
  dir ??= profileStateDir();
  const quarantines = quarantine
    ? [quarantine]
    : [join(tmpdir(), QUARANTINE), join(dirname(dir), `.${QUARANTINE}`)];
  const marker = join(dir, PROFILE_MARKER);
  const leases = join(dir, LEASES);
  const mine = join(leases, String(process.pid));
  let userOwned = false;
  let releaseHold = () => {};
  let leaseText = () => '';
  const unlock = await acquireLock(lockName, { timeoutMs: 120_000 });
  try {
    let created = false;
    try {
      mkdirSync(dir);
      created = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (created) writeFileSync(marker, 'Created by agent-browser local CI or dogfood harness.\n');
    userOwned = !existsSync(marker);
    if (!userOwned) {
      const token = randomBytes(8).toString('hex');
      const { server, err } = await listenExclusive(0, token);
      if (!server) throw err;
      server.unref();
      releaseHold = () => server.close();
      leaseText = () => `${process.pid} ${Date.now()} ${server.address().port} ${token}`;
      mkdirSync(leases, { recursive: true });
      writeAtomic(mine, leaseText());
    }
  } finally {
    unlock();
  }
  // Rewrites the lease (putting it back if something removed it) while the
  // directory carries the harness marker, and never otherwise: a directory
  // without the marker was deleted and recreated by someone else. A later
  // harness run that recreates the directory with its marker gets this
  // lease back on the next tick.
  const timer = userOwned
    ? null
    : setInterval(() => {
        if (!existsSync(marker)) return;
        try {
          try {
            mkdirSync(leases);
          } catch {}
          writeAtomic(mine, leaseText());
        } catch {}
      }, refreshMs);
  timer?.unref();
  let released = false;
  return {
    userOwned,
    async release() {
      if (released || userOwned) return '';
      released = true;
      clearInterval(timer);
      let unlockRelease;
      try {
        unlockRelease = await acquireLock(lockName, { timeoutMs: 120_000 });
        rmSync(mine, { force: true });
        releaseHold();
        let live = 0;
        for (const f of existsSync(leases) ? readdirSync(leases) : []) {
          if (!/^\d+$/.test(f)) continue;
          if (await leaseAlive(join(leases, f))) live++;
          else rmSync(join(leases, f), { force: true });
        }
        for (const q of quarantines) purgeQuarantine(q);
        if (live > 0 || !existsSync(marker)) return '';
        // A holder whose directory was removed and recreated puts its lease
        // back without the lock; look once more right before moving.
        for (const f of existsSync(leases) ? readdirSync(leases) : [])
          if (/^\d+$/.test(f) && (await leaseAlive(join(leases, f)))) return '';
        return parkProfileDir(dir, quarantines);
      } catch (err) {
        return `WARNING: left ${dir} in place: ${err.message}`;
      } finally {
        releaseHold();
        unlockRelease?.();
      }
    },
  };
}

function parkProfileDir(dir, quarantines) {
  let lastErr;
  for (const q of quarantines) {
    const parked = join(q, `${Date.now()}-${process.pid}`);
    try {
      mkdirSync(q, { recursive: true });
      renameSync(dir, parked);
      return `moved harness-owned ${dir} to ${parked} (deleted after ${QUARANTINE_DAYS} days)`;
    } catch (err) {
      lastErr = err;
      // Only a move across volumes is worth retrying in the next location.
      if (err.code !== 'EXDEV') break;
    }
  }
  return `WARNING: left ${dir} in place (${lastErr.code ?? lastErr.message}); a later run moves it`;
}

function purgeQuarantine(root) {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const m = name.match(/^(\d{13})-\d+$/);
    if (!m || Date.now() - Number(m[1]) < QUARANTINE_DAYS * 24 * 60 * 60_000) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {}
  }
}

/**
 * Removes a git worktree this run created, and its metadata, without touching
 * any other worktree. (`git worktree prune` would also drop the metadata of a
 * user's worktree whose directory is only temporarily missing.) When files in
 * the directory are locked, the first `remove` fails; the second, after the
 * directory is deleted, clears the metadata.
 */
export function removeOwnWorktree(repo, dir) {
  const remove = () =>
    spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
  remove();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  remove();
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
