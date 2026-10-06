// Process and state isolation shared by local CI (exec.mjs) and the dogfood
// harness: environment scrubbing, process cleanup, locks, ownership markers,
// and the Windows profile directory lease.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';

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

// Lock, lease, and ownership files hold "<pid> <heartbeat ms>" and are
// written atomically. A file is stale when its pid is gone, or its heartbeat
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

// Refreshes the stamp while this process still owns the file; stops as soon
// as someone else has taken it over (for example after a long suspend).
function heartbeat(file) {
  const timer = setInterval(() => {
    // A failed read (for example a transient sharing violation) is not a
    // takeover; only a readable stamp naming another pid is.
    const s = readStamp(file);
    if (s && s.pid !== process.pid) return clearInterval(timer);
    try {
      writeAtomic(file, stamp());
    } catch {}
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Mutual exclusion across concurrent runs on one host. Throws after
 * timeoutMs. Returns an idempotent release function that only removes the
 * lock while this process still owns it.
 */
export async function acquireLock(
  lockDir,
  { timeoutMs = 2 * 60 * 60_000, onWait = () => {} } = {}
) {
  const owner = join(lockDir, 'owner');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      try {
        writeAtomic(owner, stamp());
      } catch (err) {
        // A stale-lock breaker may have moved our fresh dir aside (ENOENT);
        // retry. Any other failure must not leave an ownerless lock behind.
        rmSync(lockDir, { recursive: true, force: true });
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      const stop = heartbeat(owner);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        stop();
        if (readStamp(owner)?.pid === process.pid)
          rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A lock dir whose owner file is not written yet counts as live until
      // the dir is ten minutes old (isStale falls back to its mtime).
      const stale = existsSync(owner) ? isStale(owner) : isStale(lockDir);
      if (stale) {
        // Move it aside, then make sure what was moved really was stale: a
        // waiter racing with us may have replaced it with a fresh lock.
        const aside = `${lockDir}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(lockDir, aside);
          const moved = join(aside, 'owner');
          if (existsSync(moved) && !isStale(moved) && !existsSync(lockDir))
            renameSync(aside, lockDir);
          else rmSync(aside, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockDir}`);
      onWait();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// On Windows, agent-browser resolves its state directory through the Known
// Folder API, so no environment variable can move %USERPROFILE%\.agent-browser
// into a throwaway location. Runs that may write it hold a lease. If the
// directory did not exist when a lease was taken, the harness creates it with
// an ownership marker; when the last lease is released it moves the directory
// into the temp dir and deletes it there (including anything another program
// wrote into it meanwhile). It never stops processes: harness processes are
// stopped by their own job or scenario cleanup. A directory without the marker
// belongs to the user and is never touched.
const PROFILE_MARKER = '.created-by-agent-browser-test-harness';
const LEASE_ROOT = () => join(tmpdir(), 'agent-browser-harness-profile-leases');

export async function acquireProfileLease() {
  if (!isWin) return { release: async () => '' };
  const dir = join(homedir(), '.agent-browser');
  const leases = LEASE_ROOT();
  const mine = join(leases, String(process.pid));
  mkdirSync(leases, { recursive: true });
  const unlock = await acquireLock(join(leases, '.lock'), { timeoutMs: 60_000 });
  try {
    writeAtomic(mine, stamp());
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, PROFILE_MARKER),
        'Created by agent-browser local CI or dogfood harness.\n'
      );
    }
  } finally {
    unlock();
  }
  const stop = heartbeat(mine);
  let released = false;
  return {
    async release() {
      if (released) return '';
      released = true;
      stop();
      const unlockRelease = await acquireLock(join(leases, '.lock'), { timeoutMs: 60_000 });
      try {
        rmSync(mine, { force: true });
        const others = readdirSync(leases).filter(
          (f) => /^\d+$/.test(f) && !isStale(join(leases, f))
        );
        if (others.length > 0 || !existsSync(join(dir, PROFILE_MARKER))) return '';
        const parked = join(tmpdir(), `agent-browser-harness-removed-${Date.now()}`);
        renameSync(dir, parked);
        rmSync(parked, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
        return `removed harness-owned ${dir}`;
      } catch (err) {
        return `could not remove ${dir}: ${err.message}`;
      } finally {
        unlockRelease();
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
