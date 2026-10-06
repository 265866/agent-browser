// Process and state isolation shared by local CI (exec.mjs) and the dogfood
// harness: environment scrubbing, process cleanup, locks, and the Windows
// profile directory lease.

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

// A path matches a command line only as a whole directory: "target-1" must
// not match "target-10".
const dirPattern = (p) => `${escapeRegex(p)}(${escapeRegex(sep)}|/|"|'|\\s|$)`;

// Stops leftover processes (daemons, browsers, test binaries) whose image path
// or command line contains one of the given directories. Callers pass only
// directories that this run created or holds exclusively (paths embed a
// per-run id, or a build slot the run has locked), so only processes the run
// started can match. This process, its parent, and the cleanup helper itself
// are always spared. Returns a log of what was stopped.
export function killProcessesUnder(paths) {
  const lines = [];
  if (isWin) {
    // Command lines may spell the same directory with either separator.
    const variants = paths.flatMap((p) => [p, p.replace(/\\/g, '/')]);
    const list = [...new Set(variants)]
      .map((p) => `'${dirPattern(p).replace(/'/g, "''")}'`)
      .join(',');
    const ps =
      `$ps=@(${list}); $self=$PID; $parent=(Get-CimInstance Win32_Process -Filter "ProcessId=$self").ParentProcessId; ` +
      `$targets = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -notin @($self, $parent, ${process.pid}, ${process.ppid}) } | ` +
      `Where-Object { $c = "$($_.ExecutablePath) $($_.CommandLine)"; $ps | Where-Object { $c -imatch $_ } }); ` +
      `foreach ($t in $targets) { try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop; Write-Output "stopped $($t.ProcessId) $($t.Name)" } catch { Write-Output "could not stop $($t.ProcessId) $($t.Name): $_" } }`;
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
    });
    if (r.stdout?.trim()) lines.push(r.stdout.trim());
    if (r.status !== 0 && r.stderr?.trim()) lines.push(`cleanup error: ${r.stderr.trim()}`);
  } else {
    const spare = new Set([process.pid, process.ppid]);
    for (const p of paths) {
      const r = spawnSync('pgrep', ['-f', dirPattern(p)], { encoding: 'utf8' });
      const pids = (r.stdout ?? '')
        .split('\n')
        .map(Number)
        .filter((pid) => pid > 0 && !spare.has(pid));
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
          lines.push(`stopped ${pid} (matched ${p})`);
        } catch {}
      }
    }
  }
  return lines.join('\n');
}

// Lock and lease files hold "<pid> <heartbeat ms>". The owner rewrites the
// heartbeat every minute, so a file is stale when its pid is gone or its
// heartbeat is older than ten minutes (a reused pid cannot hold it forever,
// and a long but live run never ages out).
const HEARTBEAT_MS = 60_000;
const STALE_MS = 10 * 60_000;
const stamp = () => `${process.pid} ${Date.now()}`;

export function isStale(file) {
  let pid = 0;
  let beat = 0;
  try {
    [pid, beat] = readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
  } catch {
    try {
      return Date.now() - statSync(file).mtimeMs > STALE_MS;
    } catch {
      return true;
    }
  }
  return !isAlive(pid) || !(Date.now() - beat < STALE_MS);
}

function heartbeat(file) {
  const timer = setInterval(() => {
    try {
      writeFileSync(file, stamp());
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
      writeFileSync(owner, stamp());
      const stop = heartbeat(owner);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        stop();
        try {
          if (readFileSync(owner, 'utf8').startsWith(`${process.pid} `))
            rmSync(lockDir, { recursive: true, force: true });
        } catch {}
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A lock dir whose owner file is not written yet counts as live for a
      // minute after creation (isStale falls back to the dir's mtime).
      const stale = existsSync(owner) ? isStale(owner) : isStale(lockDir);
      if (stale) {
        // Rename before deleting, so two waiters that both judged it stale
        // cannot delete each other's fresh lock.
        const graveyard = `${lockDir}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(lockDir, graveyard);
          rmSync(graveyard, { recursive: true, force: true });
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
// into the temp dir and deletes it there. It never stops processes: harness
// processes are stopped by their own job or scenario cleanup. A directory
// without the marker belongs to the user and is never touched.
const MARKER = '.created-by-agent-browser-test-harness';
const LEASE_ROOT = () => join(tmpdir(), 'agent-browser-harness-profile-leases');

export async function acquireProfileLease() {
  if (!isWin) return { release: async () => '' };
  const dir = join(homedir(), '.agent-browser');
  const leases = LEASE_ROOT();
  const mine = join(leases, String(process.pid));
  mkdirSync(leases, { recursive: true });
  const unlock = await acquireLock(join(leases, '.lock'), { timeoutMs: 60_000 });
  try {
    writeFileSync(mine, stamp());
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, MARKER), 'Created by agent-browser local CI or dogfood harness.\n');
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
        if (others.length > 0 || !existsSync(join(dir, MARKER))) return '';
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

/**
 * Records this process as the owner of a scratch directory, so a later run
 * can remove it if this process dies without cleaning up (TerminateProcess
 * on Windows skips every handler).
 */
export function claimDir(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.owner'), stamp());
}

/** Removes direct children of `root` that were claimed by a process that is gone. */
export function sweepOrphans(root, onRemove = () => {}) {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const owner = join(dir, '.owner');
    if (!existsSync(owner)) continue;
    let pid = 0;
    try {
      pid = Number(readFileSync(owner, 'utf8').trim().split(/\s+/)[0]);
    } catch {}
    if (isAlive(pid)) continue;
    killProcessesUnder([dir]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    onRemove(dir);
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
