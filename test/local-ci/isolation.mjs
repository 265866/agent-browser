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
import { join } from 'node:path';

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

// Stops leftover processes (daemons, browsers, test binaries) whose image path
// or command line contains one of the given directories. Callers pass only
// directories that this run created and owns exclusively (paths embed a
// per-run id, or a build slot the run holds), so only processes the run
// started can match. Returns a log of what was stopped.
export function killProcessesUnder(paths) {
  const lines = [];
  if (isWin) {
    const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    // Exclude this pwsh process and its parent (the harness), whose command
    // lines contain the same paths.
    const ps =
      `$ps=@(${list}); $self=$PID; $parent=(Get-CimInstance Win32_Process -Filter "ProcessId=$self").ParentProcessId; ` +
      `$targets = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.ProcessId -ne $parent -and $_.ProcessId -ne ${process.pid} } | ` +
      `Where-Object { $c = "$($_.ExecutablePath) $($_.CommandLine)"; $ps | Where-Object { $c.ToLower().Contains($_.ToLower()) } }); ` +
      `foreach ($t in $targets) { try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop; Write-Output "stopped $($t.ProcessId) $($t.Name)" } catch { Write-Output "could not stop $($t.ProcessId) $($t.Name): $_" } }`;
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
    });
    if (r.stdout?.trim()) lines.push(r.stdout.trim());
    if (r.status !== 0 && r.stderr?.trim()) lines.push(`cleanup error: ${r.stderr.trim()}`);
  } else {
    // The harness's own command line can contain these paths (for example
    // --target-dir), so never stop this process or its parent.
    const spare = new Set([process.pid, process.ppid]);
    for (const p of paths) {
      const r = spawnSync('pgrep', ['-f', escapeRegex(p)], { encoding: 'utf8' });
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
  mkdirSync(leases, { recursive: true });
  const unlock = await acquireLock(join(leases, '.lock'), { timeoutMs: 60_000 });
  try {
    writeFileSync(join(leases, String(process.pid)), lockStamp());
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, MARKER), 'Created by agent-browser local CI or dogfood harness.\n');
    }
  } finally {
    unlock();
  }
  return {
    async release() {
      const unlockRelease = await acquireLock(join(leases, '.lock'), { timeoutMs: 60_000 });
      try {
        rmSync(join(leases, String(process.pid)), { force: true });
        const others = readdirSync(leases).filter(
          (f) => /^\d+$/.test(f) && !leaseIsStale(join(leases, f), Number(f))
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

// A lease or lock file holds "<pid> <start ms>". It is stale when the pid is
// gone, or older than four hours (a reused pid cannot hold it forever).
const MAX_HOLD_MS = 4 * 60 * 60_000;
const lockStamp = () => `${process.pid} ${Date.now()}`;

function leaseIsStale(file, pidHint) {
  let pid = pidHint;
  let started = 0;
  try {
    const [p, t] = readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
    if (Number.isInteger(p) && p > 0) pid = p;
    if (Number.isFinite(t)) started = t;
  } catch {}
  if (!isAlive(pid)) return true;
  if (!started) {
    try {
      started = statSync(file).mtimeMs;
    } catch {
      return true;
    }
  }
  return Date.now() - started > MAX_HOLD_MS;
}

/** Mutual exclusion across concurrent runs on one host. Throws after timeoutMs. */
export async function acquireLock(
  lockDir,
  { timeoutMs = 2 * 60 * 60_000, onWait = () => {} } = {}
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner'), lockStamp());
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = join(lockDir, 'owner');
      let stale;
      if (existsSync(owner)) stale = leaseIsStale(owner, NaN);
      else {
        // Created but not yet stamped; stale only if it stays that way.
        try {
          stale = Date.now() - statSync(lockDir).mtimeMs > 60_000;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockDir}`);
      onWait();
      await new Promise((r) => setTimeout(r, 2000));
    }
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
