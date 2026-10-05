// Process and state isolation shared by local CI (exec.mjs) and the dogfood
// harness: environment scrubbing, process cleanup, and the Windows profile
// directory lease.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const isWin = process.platform === 'win32';

// Host variables that must never reach code under test: agent-browser's own
// configuration (it could point at a real Chrome profile or CDP endpoint) and
// anything credential-shaped.
const SCRUB = [
  /^AGENT_BROWSER_/i,
  /^ANTHROPIC_/i,
  /^CLAUDE_/i,
  /^(GH|GITHUB|GITLAB|AWS|AZURE|GOOGLE|GCP|OPENAI|NPM|BROWSERBASE|KERNEL|BROWSER_USE)_/i,
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

// Stops leftover processes (daemons, browsers) whose image path or command
// line contains one of the given unique directories. Callers pass paths that
// embed a per-run id, so only processes the run started can match. Returns a
// log of what was stopped.
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
    for (const p of paths) {
      const r = spawnSync('pkill', ['-KILL', '-f', escapeRegex(p)], { encoding: 'utf8' });
      if (r.status === 0) lines.push(`stopped processes matching ${p}`);
    }
  }
  return lines.join('\n');
}

// On Windows, agent-browser resolves its state directory through the Known
// Folder API, so no environment variable can move %USERPROFILE%\.agent-browser
// into a throwaway location. Runs that may write it hold a lease: if the
// directory did not exist when the first lease was taken, the harness creates
// it with an ownership marker and removes it when the last lease is released.
// A directory without the marker belongs to the user and is never removed.
const MARKER = '.created-by-agent-browser-test-harness';

export function acquireProfileLease() {
  if (!isWin) return { release: () => '' };
  const dir = join(homedir(), '.agent-browser');
  // One fixed location so local CI and dogfood runs see each other's leases.
  const leases = join(tmpdir(), 'agent-browser-harness-profile-leases');
  mkdirSync(leases, { recursive: true });
  const mine = join(leases, String(process.pid));
  writeFileSync(mine, new Date().toISOString());
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MARKER), 'Created by agent-browser local CI or dogfood harness.\n');
  }
  return {
    release() {
      rmSync(mine, { force: true });
      const others = readdirSync(leases).filter((f) => isAlive(Number(f)));
      if (others.length > 0 || !existsSync(join(dir, MARKER))) return '';
      const stopped = killProcessesUnder([dir]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      return `${stopped}\nremoved harness-owned ${dir}`.trim();
    },
  };
}

// Mutual exclusion across concurrent runs on one host. A lock whose owner pid
// is gone, or whose pid file was never written and is older than 15 minutes,
// is stale.
export async function acquireLock(lockDir, onWait = () => {}) {
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let owner = NaN;
      try {
        owner = Number(readFileSync(join(lockDir, 'pid'), 'utf8'));
      } catch {}
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch {}
      const stale = Number.isInteger(owner) && owner > 0 ? !isAlive(owner) : ageMs > 15 * 60_000;
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      onWait(owner);
      await new Promise((r) => setTimeout(r, 5000));
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
