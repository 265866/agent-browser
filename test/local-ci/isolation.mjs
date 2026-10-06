// Process and state isolation shared by local CI (exec.mjs) and the dogfood
// harness: environment scrubbing, process cleanup, locks, ownership markers,
// the Windows profile directory lease, and per-run agent-browser homes.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  watch as fsWatch,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { createServer, connect } from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';

const isWin = process.platform === 'win32';

// Host variables that must never reach code under test: agent-browser's own
// configuration (it could point at a real Chrome profile or CDP endpoint),
// agent sockets, git overrides, and anything credential-shaped. The XDG base
// directory variables go too: with them, agent-browser (and other tools) put
// state in the host user's directories whatever HOME says.
const SCRUB = [
  /^AGENT_BROWSER_/i,
  /^XDG_(CONFIG_HOME|STATE_HOME|DATA_HOME|CACHE_HOME|RUNTIME_DIR|CONFIG_DIRS|DATA_DIRS)$/i,
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
// Folder API, so for refs without AGENT_BROWSER_HOME (see refReadsStateHome)
// no environment variable can move %USERPROFILE%\.agent-browser into a
// throwaway location, and code under test (cargo tests, e2e tests, the real
// CLI) writes there. If the directory does not exist, the harness creates
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
const MARKER_TEXT = 'Created by agent-browser local CI or dogfood harness.\n';
// Serializes creating, marking, and parking a profile directory.
const leaseLockFor = (dir) =>
  dir === profileStateDir() ? 'host:profile-lease' : `${dir}.lease-lock`;

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
  const lockName = leaseLockFor(dir ?? profileStateDir());
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
    if (created) writeFileSync(marker, MARKER_TEXT);
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

// ---- Per-run agent-browser homes ----
//
// A CLI that reads AGENT_BROWSER_HOME keeps everything it would put in
// %USERPROFILE%\.agent-browser (config, sessions, auth profiles, the key,
// installed browsers, default output, fallback sockets, and on Windows the
// daemon port's identity) in that directory instead. Such a ref needs no lease
// and no turn on the real profile directory. Older refs keep both.
const STATE_HOME_VAR = 'AGENT_BROWSER_HOME';
export const STATE_HOME_SOURCE = 'cli/src/paths.rs';

/**
 * Whether a ref's cli/src/paths.rs names AGENT_BROWSER_HOME: the name must
 * appear as a Rust string literal in code, so a comment or a longer name that
 * contains it does not count. This only nominates a ref. Code can name the
 * variable without honoring it (dead code, a test module), so before any
 * Windows job skips the lock, exec.mjs builds the ref's own CLI and confirms
 * with probeStateHome; a ref it cannot confirm keeps the lease and the lock.
 */
export function sourceReadsStateHome(text) {
  if (typeof text !== 'string') return false;
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return code.includes(`"${STATE_HOME_VAR}"`);
}

/** Reads STATE_HOME_SOURCE at `sha` from a repository, or from a `git archive` tarball. */
export function refReadsStateHome({ repo, sha, srcTar }) {
  const r = repo
    ? spawnSync('git', ['-C', repo, 'show', `${sha}:${STATE_HOME_SOURCE}`], { encoding: 'utf8' })
    : spawnSync('tar', ['-xOf', srcTar, STATE_HOME_SOURCE], { encoding: 'utf8' });
  return r.status === 0 && sourceReadsStateHome(r.stdout);
}

/**
 * Whether a CLI binary keeps its state in AGENT_BROWSER_HOME. A binary without
 * the name is not run. One with it opens and closes a named session (whose
 * state the CLI saves under its state directory) with AGENT_BROWSER_HOME set
 * to `home` and a random namespace, which must leave the saved state under
 * `home` and nothing under `realDir`. `command` runs the candidate; `binary`
 * is the file to search.
 *
 * On Windows the session's daemon listens on a port derived from its name, so
 * `portCheck(namespace, home)` says why a namespace's ports are unsafe (another
 * program listens there), or null; the probe tries a few namespaces and runs
 * nothing if all are taken.
 *
 * The probe runs before any lease. If the candidate wrote the real directory
 * after all, the probe removes, under the lease lock, its namespace and
 * whichever of `realDir` and `realDir/namespaces` it created. A `realDir` it
 * created that holds anything else gets the harness marker, as a lease would
 * have given it, so later runs do not take it for the user's.
 */
export async function probeStateHome({
  binary,
  command,
  env,
  home,
  realDir = profileStateDir(),
  portCheck = () => null,
  attempts = 5,
  timeoutMs = 60_000,
}) {
  const result = { supported: false, home, namespace: null, reason: '', homeFiles: [] };
  let text;
  try {
    text = readFileSync(binary);
  } catch (err) {
    result.reason = `cannot read ${binary}: ${err.message}`;
    return result;
  }
  if (!text.includes(STATE_HOME_VAR)) {
    result.reason = `${basename(binary)} does not contain ${STATE_HOME_VAR}`;
    return result;
  }
  const taken = [];
  for (let i = 0; i < attempts && !result.namespace; i++) {
    const ns = `df-probe-${randomBytes(4).toString('hex')}`;
    const problem = portCheck(ns, home);
    if (problem) taken.push(problem);
    else result.namespace = ns;
  }
  if (!result.namespace) {
    result.reason = `no probe namespace had free daemon ports: ${taken.join('; ')}`;
    return result;
  }
  const namespace = result.namespace;
  const existed = {
    real: existsSync(realDir),
    namespaces: existsSync(join(realDir, 'namespaces')),
  };
  const probeEnv = { ...env, [STATE_HOME_VAR]: home, AGENT_BROWSER_NAMESPACE: namespace };
  const cli = (args) =>
    spawnSync(command[0], [...command.slice(1), ...args], {
      env: probeEnv,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
  const open = cli(['--session-name', 'probe', 'open', 'about:blank']);
  cli(['close']);
  const own = join(home, 'namespaces', namespace);
  result.homeFiles = [...snapshotDir(own).entries()]
    .filter(([, sig]) => sig !== 'd')
    .map(([p]) => `namespaces/${namespace}/${p}`);
  const leaked =
    existsSync(join(realDir, 'namespaces', namespace)) ||
    (!existed.real && existsSync(realDir)) ||
    (!existed.namespaces && existsSync(join(realDir, 'namespaces')));
  if (leaked) {
    const notes = await removeProbeLeftovers(realDir, namespace, existed);
    result.reason = `the probe session's state went to ${realDir}, not to ${home} (${notes})`;
  } else if (open.status !== 0)
    result.reason = `the probe session did not open (exit ${open.status ?? open.error?.message}): ${`${open.stderr}${open.stdout}`.trim().slice(0, 300)}`;
  else if (!result.homeFiles.length) result.reason = `the probe session saved nothing under ${own}`;
  else {
    result.supported = true;
    result.reason = `the probe session saved ${result.homeFiles.join(', ')} under ${home} and nothing under ${realDir}`;
  }
  return result;
}

async function removeProbeLeftovers(realDir, namespace, existed) {
  const notes = [];
  // The lease lock keeps this from racing a run that creates, marks, or parks
  // the directory.
  const unlock = await acquireLock(leaseLockFor(realDir), { timeoutMs: 120_000 });
  try {
    rmSync(join(realDir, 'namespaces', namespace), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
    notes.push(`removed namespaces/${namespace}`);
    for (const [dir, before] of [
      [join(realDir, 'namespaces'), existed.namespaces],
      [realDir, existed.real],
    ]) {
      if (before || !existsSync(dir)) continue;
      try {
        rmdirSync(dir);
        notes.push(`removed ${dir}, which it created`);
      } catch {}
    }
    if (!existed.real && existsSync(realDir) && !existsSync(join(realDir, PROFILE_MARKER))) {
      writeFileSync(join(realDir, PROFILE_MARKER), MARKER_TEXT);
      notes.push(`marked ${realDir}, which it created with other files in it, as the harness's`);
    }
  } finally {
    unlock();
  }
  return notes.join('; ');
}

// Files only the harness writes in the profile directory: lease files (a
// lease held by another run, or the profile keeper, refreshes its own) and the
// ownership marker (written when a run creates the directory).
const SNAPSHOT_SKIP = new Set([LEASES, PROFILE_MARKER]);

/**
 * Every entry under `dir` (relative path with `/` separators) mapped to `d`
 * for a directory or `<kind>:<size>:<mtimeMs>` otherwise. Links are not
 * followed. A missing directory yields an empty map.
 */
export function snapshotDir(dir) {
  const entries = new Map();
  const walk = (abs, rel) => {
    let names;
    try {
      names = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (!rel && SNAPSHOT_SKIP.has(d.name)) continue;
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        entries.set(path, 'd');
        walk(join(abs, d.name), path);
        continue;
      }
      try {
        const s = lstatSync(join(abs, d.name));
        entries.set(path, `${d.isSymbolicLink() ? 'l' : 'f'}:${s.size}:${s.mtimeMs}`);
      } catch {}
    }
  };
  walk(dir, '');
  return entries;
}

/** Entries added, modified, or removed between two snapshots. Directory mtimes are not compared. */
export function snapshotChanges(before, after) {
  const changes = [];
  for (const [path, sig] of after) {
    const old = before.get(path);
    if (old === undefined) changes.push({ path, change: 'added' });
    else if (old !== sig) changes.push({ path, change: 'modified' });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, change: 'removed' });
  return changes;
}

// Namespaces that concurrent harness runs give their real-CLI daemons: local
// CI's abci-<sha>-<id> and dogfood's df-<scenario>-<id> and df-probe-<hex>.
// Each is unique to its run, so state under another run's namespace is that
// run's.
const HARNESS_NAMESPACE = /^(abci|df)-/;

/**
 * Splits changes in the real profile directory into this job's (`own`, under
 * its own namespace), other harness runs' (`others`, under their namespaces,
 * with the parent directories those create), and the rest. `namespace` is
 * this job's namespace, or a function that says whether one is this run's.
 * The CLI lowercases namespaces, so they compare without case.
 */
export function attributeChanges(changes, { namespace } = {}) {
  const isOwn =
    typeof namespace === 'function'
      ? namespace
      : (ns) => Boolean(namespace) && ns === namespace.toLowerCase();
  const own = [];
  const others = [];
  const rest = [];
  for (const c of changes) {
    const ns = c.path.match(/^namespaces\/([^/]+)/)?.[1]?.toLowerCase();
    if (ns && isOwn(ns)) own.push(c);
    else if (ns && HARNESS_NAMESPACE.test(ns)) others.push(c);
    else rest.push(c);
  }
  const parentOfOthers = (c) => others.some((o) => o.path.startsWith(`${c.path}/`));
  return {
    own,
    others: [...others, ...rest.filter(parentOfOthers)],
    rest: rest.filter((c) => !parentOfOthers(c)),
  };
}

// Dogfood runs hold a profile lease for the whole run, and an older candidate
// writes the real directory outside its namespace without the real-home lock
// (pathless screenshot, pdf, HAR, trace, and profile output go to tmp/).
const DOGFOOD_RUN = /dogfood[\\/]run\.mjs/i;

/** A process's command line, or null when it cannot be read. */
function processCommandLine(pid) {
  const r = isWin
    ? spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', windowsHide: true }
      )
    : spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Live leases in `dir` whose holders may write it without the real-home lock:
 * dogfood runs, and holders whose command line cannot be read. Local CI runs
 * write there only while they hold the lock, and other holders (a profile
 * keeper) are not harness runs. `cache` keeps each holder's verdict, keyed by
 * its pid and lease token.
 */
export async function leaseWriters(
  dir,
  { cache = new Map(), commandLine = processCommandLine } = {}
) {
  const leases = join(dir, LEASES);
  const writers = [];
  let names = [];
  try {
    names = readdirSync(leases).filter((f) => /^\d+$/.test(f));
  } catch {
    return writers;
  }
  for (const f of names) {
    // A holder that is gone writes nothing, whatever its lease file says.
    if (!isAlive(Number(f))) continue;
    const file = join(leases, f);
    const s = readStamp(file);
    const key = `${f} ${s?.token ?? ''}`;
    if (!cache.has(key)) {
      const cmd = commandLine(Number(f));
      cache.set(
        key,
        cmd === null
          ? `lease holder pid ${f} (command line unreadable)`
          : DOGFOOD_RUN.test(cmd)
            ? `dogfood run pid ${f} (holds the profile lease)`
            : null
      );
    }
    const verdict = cache.get(key);
    if (verdict && (await leaseAlive(file))) writers.push(verdict);
  }
  return writers;
}

/**
 * Watches the real profile directory while a job that should never touch it
 * runs, and reports what changed there. Concurrent runs of older refs and
 * older dogfood candidates still write that directory: local CI jobs only
 * while they hold the host:real-home lock, dogfood runs anywhere in it while
 * they hold the profile lease (leaseWriters). Changes are attributed as
 * follows:
 *
 * - under this job's own namespace: a leak;
 * - under another harness run's namespace: that run's;
 * - otherwise, a leak when no other writer was active, else `unattributed`.
 *
 * "Active" is decided twice. Every `intervalMs` the watcher snapshots the
 * directory and checks for writers; an interval counts as having a writer
 * when one was active at either end. A change event (recursive fs.watch)
 * checks again at once, so a change made after a writer let go, while nobody
 * else wrote, is a leak even inside an interval that began with a writer.
 * The bound: when the OS drops change events, a change made within one
 * interval of a writer's start or end is reported `unattributed`.
 *
 * Only a harness answer on the lock port counts as a holder. A holder that
 * accepts and stays silent or drops connections counts until acquireLock
 * would give up on it (ten minutes, twenty dropped probes); any other program
 * answering there makes the check `unverifiable`, which fails the job, as
 * acquireLock refuses that port. When the whole directory was moved away (the
 * last lease's release parks it), its removed entries are not counted.
 */
export async function watchProfileDir({
  dir = profileStateDir(),
  namespace,
  intervalMs = 3000,
  writerLock = 'host:real-home',
  commandLine,
} = {}) {
  const { port } = lockPortFor(writerLock);
  const leaseCache = new Map();
  const foreign = new Set();
  let closedProbes = 0;
  let silentSince = null;
  const writers = async () => {
    const p = await probeLockPort(port);
    closedProbes = p.closed ? closedProbes + 1 : 0;
    silentSince = p.silent ? (silentSince ?? Date.now()) : null;
    const active = [];
    if (p.kind === 'harness') active.push(describeHolder(p));
    else if (
      p.kind === 'foreign' ||
      closedProbes >= MAX_CLOSED_PROBES ||
      (silentSince !== null && Date.now() - silentSince > MAX_SILENT_MS)
    )
      foreign.add(
        `port ${port} of ${writerLock} is used by another program${p.kind === 'foreign' ? ` (it answered ${JSON.stringify(String(p.text).slice(0, 60))})` : ''}`
      );
    else if (p.kind === 'busy') active.push(describeHolder(p));
    active.push(...(await leaseWriters(dir, { cache: leaseCache, commandLine })));
    return active;
  };
  const markerSig = () => {
    try {
      return String(statSync(join(dir, PROFILE_MARKER)).mtimeMs);
    } catch {
      return null;
    }
  };

  // Paths that changed while no writer was active, from change events.
  let freePaths = new Set();
  let freeUnknown = false;
  let pending = new Set();
  let draining = null;
  const drain = async () => {
    while (pending.size) {
      const batch = pending;
      pending = new Set();
      const active = await writers().catch(() => ['(writer check failed)']);
      if (active.length) continue;
      for (const p of batch) {
        if (p === null) freeUnknown = true;
        else freePaths.add(p);
      }
    }
    draining = null;
  };
  const onEvent = (_type, name) => {
    const path = name ? String(name).replace(/\\/g, '/') : null;
    if (path && SNAPSHOT_SKIP.has(path.split('/')[0])) return;
    pending.add(path);
    draining ??= drain();
  };
  let fsw = null;
  const watch = () => {
    if (fsw || !existsSync(dir)) return;
    try {
      fsw = fsWatch(dir, { recursive: true }, onEvent);
      fsw.on('error', () => {
        fsw?.close();
        fsw = null;
      });
    } catch {
      fsw = null;
    }
  };

  const report = { leaks: [], unattributed: [], writers: new Set(), intervals: 0 };
  watch();
  let prev = { snap: snapshotDir(dir), writers: await writers(), marker: markerSig() };
  let stopped = false;
  let wake = () => {};
  const tick = async () => {
    watch();
    const cur = { writers: await writers(), snap: snapshotDir(dir), marker: markerSig() };
    await draining;
    const events = { paths: freePaths, unknown: freeUnknown };
    freePaths = new Set();
    freeUnknown = false;
    report.intervals++;
    const parked = prev.marker !== null && cur.marker !== prev.marker;
    const changes = snapshotChanges(prev.snap, cur.snap).filter(
      (c) => !(parked && c.change === 'removed')
    );
    const { own, rest } = attributeChanges(changes, { namespace });
    const held = [...prev.writers, ...cur.writers];
    for (const w of held) report.writers.add(w);
    report.leaks.push(...own);
    for (const c of rest) {
      const free = !held.length || events.unknown || events.paths.has(c.path);
      (free ? report.leaks : report.unattributed).push(c);
    }
    prev = cur;
  };
  const loop = async () => {
    while (!stopped) {
      await new Promise((r) => {
        const timer = setTimeout(r, intervalMs);
        wake = () => {
          clearTimeout(timer);
          r();
        };
      });
      if (stopped) break;
      await tick().catch(() => {});
    }
  };
  const running = loop();
  return {
    dir,
    /**
     * Takes a final snapshot and returns `{ status: 'clean' | 'unattributed' |
     * 'unverifiable' | 'leak', ... }`.
     */
    async stop() {
      stopped = true;
      wake();
      await running;
      await tick();
      fsw?.close();
      await draining;
      const status = report.leaks.length
        ? 'leak'
        : foreign.size
          ? 'unverifiable'
          : report.unattributed.length
            ? 'unattributed'
            : 'clean';
      return {
        status,
        dir,
        leaks: report.leaks,
        unattributed: report.unattributed,
        writers: [...report.writers],
        foreign: [...foreign],
        intervals: report.intervals,
      };
    },
  };
}

/** Whether a profile check fails the job or run that it watched. */
export const profileCheckFails = (check) =>
  check.status === 'leak' || check.status === 'unverifiable';

/** One line for a job log or receipt naming what a profile check found. */
export function describeProfileCheck(check) {
  const list = (cs) =>
    cs
      .slice(0, 5)
      .map((c) => `${c.change} ${c.path}`)
      .join(', ') + (cs.length > 5 ? `, and ${cs.length - 5} more` : '');
  if (check.status === 'leak')
    return `profile-leak: ${check.leaks.length} change(s) under ${check.dir} although this job had its own AGENT_BROWSER_HOME: ${list(check.leaks)}`;
  if (check.status === 'unverifiable')
    return `profile-check: cannot attribute changes under ${check.dir}: ${check.foreign.join('; ')}`;
  if (check.status === 'unattributed')
    return `${check.unattributed.length} change(s) under ${check.dir} while another writer was active (${check.writers.join('; ')}), not attributed to this job: ${list(check.unattributed)}`;
  return `nothing changed under ${check.dir}`;
}

/**
 * A job's status and first failure after its profile check, and what the
 * receipt keeps of the check (the log lists every change; the receipt keeps
 * the first hundred of each kind).
 */
export function applyProfileCheck({ status, failedStep }, check) {
  const fails = profileCheckFails(check);
  return {
    status: fails ? 'fail' : status,
    failedStep: fails
      ? [failedStep, describeProfileCheck(check)].filter(Boolean).join('; ')
      : failedStep,
    profileCheck: {
      status: check.status,
      summary: describeProfileCheck(check),
      leakCount: check.leaks.length,
      unattributedCount: check.unattributed.length,
      leaks: check.leaks.slice(0, 100),
      unattributed: check.unattributed.slice(0, 100),
      writers: check.writers,
      foreign: check.foreign,
    },
  };
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
