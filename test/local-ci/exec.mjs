#!/usr/bin/env node
// Runs local CI jobs for one platform against one commit and writes
// <out>/receipt.json plus one log per job. Invoked by run.mjs, either natively
// (Windows, macOS) or inside the Linux container.
//
// Each job gets its own clean tree of the commit: a `git worktree` when
// --repo is given, otherwise a fresh extraction of --src-tar turned into a
// one-commit git repository (some code paths call `git rev-parse`).

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { jobsFor } from './jobs.mjs';

const { values: opt } = parseArgs({
  options: {
    platform: { type: 'string' },
    sha: { type: 'string' },
    ref: { type: 'string' },
    repo: { type: 'string' },
    'src-tar': { type: 'string' },
    work: { type: 'string' },
    out: { type: 'string' },
    'target-dir': { type: 'string' },
    cache: { type: 'string' },
    chrome: { type: 'string' },
    jobs: { type: 'string' },
    'no-extra': { type: 'boolean', default: false },
    'job-timeout-min': { type: 'string', default: '120' },
  },
});

for (const k of ['platform', 'sha', 'work', 'out', 'target-dir', 'cache']) {
  if (!opt[k]) fail(`missing --${k}`);
}
if (!opt.repo === !opt['src-tar']) fail('pass exactly one of --repo or --src-tar');

const isWin = process.platform === 'win32';
const runId = `${opt.sha.slice(0, 8)}-${Date.now().toString(36)}`;
const work = resolve(opt.work);
const out = resolve(opt.out);
const cache = resolve(opt.cache);
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

const only = opt.jobs
  ? opt.jobs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;
const jobs = jobsFor(opt.platform, { only, includeExtra: !opt['no-extra'] });
if (jobs.length === 0) fail(`no jobs selected for ${opt.platform}`);

const bash = isWin ? findGitBash() : 'bash';
const realHome = homedir();
const receiptPath = join(out, 'receipt.json');
const receipt = {
  schema: 1,
  platform: opt.platform,
  ref: opt.ref ?? opt.sha,
  sha: opt.sha,
  host: hostname(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  toolchain: toolchain(),
  chrome: opt.chrome ?? null,
  ciResult: null,
  extraResult: null,
  jobs: jobs.map((j) => ({
    id: j.id,
    ciJob: j.ciJob ?? null,
    kind: j.kind ?? 'ci',
    status: 'pending',
    durationSec: null,
    failedStep: null,
    log: `${j.id}.log`,
  })),
};
saveReceipt();

const results = new Map();
for (const job of jobs) {
  const entry = receipt.jobs.find((j) => j.id === job.id);
  const blocked = (job.needs ?? []).filter((n) => results.has(n) && results.get(n) !== 'pass');
  if (blocked.length) {
    entry.status = 'skipped';
    entry.failedStep = `needs failed: ${blocked.join(', ')}`;
    results.set(job.id, 'skipped');
    saveReceipt();
    continue;
  }
  entry.status = 'running';
  saveReceipt();
  const t0 = Date.now();
  const { status, failedStep } = await runJob(job);
  entry.status = status;
  entry.failedStep = failedStep;
  entry.durationSec = Math.round((Date.now() - t0) / 1000);
  results.set(job.id, status);
  saveReceipt();
  console.log(
    `[local-ci] ${opt.platform} ${job.id}: ${status}${failedStep ? ` (${failedStep})` : ''} in ${entry.durationSec}s`
  );
}

const verdict = (kind) => {
  const sel = receipt.jobs.filter((j) => j.kind === kind);
  if (sel.length === 0) return null;
  return sel.every((j) => j.status === 'pass') ? 'pass' : 'fail';
};
receipt.ciResult = verdict('ci');
receipt.extraResult = verdict('extra');
receipt.finishedAt = new Date().toISOString();
saveReceipt();
process.exit(receipt.ciResult === 'fail' || receipt.extraResult === 'fail' ? 1 : 0);

// ---------------------------------------------------------------------------

async function runJob(job) {
  const log = join(out, `${job.id}.log`);
  writeFileSync(log, `# local-ci ${opt.platform} ${job.id} @ ${opt.sha}\n`);
  const dir = join(work, `${runId}-${job.id}`);
  const scratch = join(work, `${runId}-${job.id}-x`);
  // Unix socket paths are limited to ~104 bytes on macOS, so keep this short.
  const sockDir = isWin ? join(scratch, 'sock') : `/tmp/abci-${runId}-${jobs.indexOf(job)}`;
  mkdirSync(scratch, { recursive: true });
  mkdirSync(sockDir, { recursive: true });

  const releaseLock = job.usesRealHome
    ? await acquireLock(join(cache, 'real-home.lock'), log)
    : null;
  const realHomeState = job.usesRealHome ? snapshotRealHome() : null;
  let status = 'pass';
  let failedStep = null;
  try {
    prepareSource(dir, log);
    const env = jobEnv(job, scratch, sockDir);
    const deadline = Date.now() + Number(opt['job-timeout-min']) * 60_000;
    for (const step of job.steps) {
      appendFileSync(log, `\n##### step: ${step.name}\n`);
      const remaining = deadline - Date.now();
      const rc = remaining > 0 ? await runStep(step, dir, env, log, remaining) : 'timeout';
      appendFileSync(log, `##### step exit: ${rc}\n`);
      if (rc !== 0) {
        status = 'fail';
        failedStep = `${step.name} (exit ${rc})`;
        break;
      }
    }
  } catch (err) {
    status = 'fail';
    failedStep = `setup: ${err.message}`;
    appendFileSync(log, `\n##### setup error: ${err.stack}\n`);
  } finally {
    killProcessesUnder([dir, scratch, sockDir], log);
    if (realHomeState) restoreRealHome(realHomeState, log);
    releaseLock?.();
    cleanupSource(dir);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    rmSync(sockDir, { recursive: true, force: true, maxRetries: 5 });
  }
  return { status, failedStep };
}

function prepareSource(dir, log) {
  if (opt.repo) {
    sh('git', ['-C', opt.repo, 'worktree', 'add', '--detach', dir, opt.sha], log);
    return;
  }
  mkdirSync(dir, { recursive: true });
  sh('tar', ['-xf', opt['src-tar'], '-C', dir], log);
  const git = (...a) =>
    sh(
      'git',
      ['-C', dir, '-c', 'user.name=local-ci', '-c', 'user.email=local-ci@localhost', ...a],
      log
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', `local-ci ${opt.sha}`);
}

function cleanupSource(dir) {
  if (opt.repo) {
    spawnSync('git', ['-C', opt.repo, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  if (opt.repo) spawnSync('git', ['-C', opt.repo, 'worktree', 'prune'], { stdio: 'ignore' });
}

function jobEnv(job, scratch, sockDir) {
  const env = { ...process.env };
  env.CI = 'true';
  env.CARGO_TARGET_DIR = resolve(opt['target-dir']);
  env.AGENT_BROWSER_SOCKET_DIR = sockDir;
  env.LOCAL_CI_ARTIFACTS = join(out, 'artifacts');
  env.npm_config_cache = join(cache, 'npm-cache');
  env.npm_config_store_dir = join(cache, 'pnpm-store');
  env.COREPACK_HOME = join(cache, 'corepack');
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  env.npm_config_update_notifier = 'false';

  // npm global installs go to a throwaway prefix, never the host's tree.
  const prefix = join(scratch, 'npm-prefix');
  mkdirSync(prefix, { recursive: true });
  env.npm_config_prefix = prefix;
  const prefixBin = isWin ? prefix : join(prefix, 'bin');
  env.PATH = `${prefixBin}${isWin ? ';' : ':'}${env.PATH ?? env.Path ?? ''}`;
  if (isWin) delete env.Path;

  // A throwaway HOME keeps agent-browser state (installed browsers, config,
  // sessions) out of the real home. Windows resolves the profile directory
  // through the Known Folder API, so HOME has no effect there; Windows jobs
  // instead pin the browser binary below.
  if (!isWin && !job.usesRealHome) {
    env.CARGO_HOME ??= join(realHome, '.cargo');
    env.RUSTUP_HOME ??= join(realHome, '.rustup');
    env.HOME = join(scratch, 'home');
    mkdirSync(env.HOME, { recursive: true });
  }
  if (job.needsChrome) {
    if (!opt.chrome) throw new Error(`${job.id} needs --chrome (Chrome for Testing binary)`);
    env.AGENT_BROWSER_EXECUTABLE_PATH = opt.chrome;
  }
  return env;
}

function runStep(step, dir, env, log, timeoutMs) {
  const cwd = step.cwd ? join(dir, step.cwd) : dir;
  let cmd, args;
  if (step.shell === 'pwsh') {
    // Same wrapper GitHub Actions uses for `shell: pwsh`.
    const script = `$ErrorActionPreference = 'stop'\n${step.run}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }`;
    cmd = 'pwsh';
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
  } else {
    cmd = bash;
    args = ['--noprofile', '--norc', '-c', `set -euo pipefail\n${step.run}`];
  }
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => appendFileSync(log, d));
    child.stderr.on('data', (d) => appendFileSync(log, d));
    const timer = setTimeout(() => {
      appendFileSync(log, `\n##### step timed out after ${Math.round(timeoutMs / 60000)} min\n`);
      killTree(child.pid);
      resolvePromise('timeout');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      appendFileSync(log, `\n##### spawn error: ${err.message}\n`);
      resolvePromise('spawn-error');
    });
    // Resolve on exit rather than on stream close: a detached daemon started
    // by the step can inherit our pipe handles and hold them open (hosted
    // runners also wait for the step process, not for pipe EOF).
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const done = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolvePromise(code ?? `signal ${signal}`);
      };
      const drain = setTimeout(done, 2000);
      child.on('close', () => {
        clearTimeout(drain);
        done();
      });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (isWin) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  else {
    spawnSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' });
    spawnSync('kill', ['-KILL', String(pid)], { stdio: 'ignore' });
  }
}

// Stops leftover processes (daemons, browsers) whose command line or image
// path contains one of this job's unique directories. Those paths embed the
// run id, so this only ever matches processes this job started.
function killProcessesUnder(paths, log) {
  if (isWin) {
    const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    const ps = `$ps=@(${list}); Get-CimInstance Win32_Process | Where-Object { $c = "$($_.ExecutablePath) $($_.CommandLine)"; $ps | Where-Object { $c -and $c.ToLower().Contains($_.ToLower()) } } | ForEach-Object { Write-Output "killing $($_.ProcessId) $($_.Name)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
    });
    if (r.stdout?.trim()) appendFileSync(log, `\n##### cleanup\n${r.stdout}`);
  } else {
    for (const p of paths) {
      const r = spawnSync('pkill', ['-KILL', '-f', p], { encoding: 'utf8' });
      if (r.status === 0) appendFileSync(log, `\n##### cleanup: killed processes matching ${p}\n`);
    }
  }
}

// windows-integration runs the real `install`, which writes
// <profile>/.agent-browser. Remember whether it existed so the job can remove
// only what it created, and stop browsers launched from a cache it created.
function snapshotRealHome() {
  const dir = join(realHome, '.agent-browser');
  return { dir, existed: existsSync(dir), entries: existsSync(dir) ? readdirSync(dir) : [] };
}

function restoreRealHome(state, log) {
  if (state.existed) {
    appendFileSync(
      log,
      `\n##### note: ${state.dir} existed before this job and was left in place\n`
    );
    return;
  }
  killProcessesUnder([state.dir], log);
  rmSync(state.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  appendFileSync(log, `\n##### cleanup: removed ${state.dir} created by this job\n`);
}

// Serializes jobs that write the real profile directory across concurrent
// local CI runs on the same host. A lock whose owner pid is gone is stale.
async function acquireLock(lockDir, log) {
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
      if (Number.isInteger(owner) && !isAlive(owner)) {
        appendFileSync(
          log,
          `##### removing stale lock held by dead pid ${owner}
`
        );
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function sh(cmd, args, log) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (log) appendFileSync(log, `$ ${cmd} ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function toolchain() {
  const v = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', shell: isWin });
    return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
  };
  return {
    rustc: v('rustc', ['--version']),
    node: process.version,
    pnpm: v('pnpm', ['--version']),
    npm: v('npm', ['--version']),
  };
}

function findGitBash() {
  for (const p of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  fail('Git Bash not found; local CI on Windows needs Git for Windows');
}

function saveReceipt() {
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

function fail(msg) {
  console.error(`exec.mjs: ${msg}`);
  process.exit(2);
}
