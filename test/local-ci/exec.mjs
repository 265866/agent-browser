#!/usr/bin/env node
// Runs local CI jobs for one platform against one commit and writes
// <out>/receipt.json plus one log per job. Invoked by run.mjs, either natively
// (Windows, macOS) or inside the Linux container.
//
// Each job gets its own clean tree of the commit: a `git worktree` when
// --repo is given, otherwise a fresh extraction of --src-tar turned into a
// one-commit git repository (some code paths call `git rev-parse`).

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  acquireLock,
  acquireProfileLease,
  applyProfileCheck,
  compareProfile,
  profileSnapshot,
  profileStateDir,
  claimDir,
  killProcessesUnder,
  killTree,
  probeStateHome,
  refReadsStateHome,
  removeOwnWorktree,
  scrubbedEnv,
  sweepOrphans,
  STATE_HOME_SOURCE,
} from './isolation.mjs';
import { onInterrupt } from './util.mjs';

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
    'run-token': { type: 'string' },
    'harness-sha': { type: 'string' },
    'harness-dirty': { type: 'boolean', default: false },
    untrusted: { type: 'boolean', default: false },
    // Tests substitute their own job table (a module exporting jobsFor, and
    // STATE_HOME_PROBE as jobs.mjs does).
    'job-table': { type: 'string' },
    // Tests substitute a profile directory for %USERPROFILE%\.agent-browser;
    // with it, the lease, the AGENT_BROWSER_HOME probe, and the profile check
    // run on any platform.
    'profile-dir': { type: 'string' },
  },
});

for (const k of ['platform', 'sha', 'work', 'out', 'target-dir', 'cache']) {
  if (!opt[k]) fail(`missing --${k}`);
}
if (!opt.repo === !opt['src-tar']) fail('pass exactly one of --repo or --src-tar');

const isWin = process.platform === 'win32';
const runId = `${opt.sha.slice(0, 8)}-${Date.now().toString(36)}`;
const NAMESPACE = `abci-${runId}`;
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
const { jobsFor, STATE_HOME_PROBE } = await import(
  opt['job-table'] ? pathToFileURL(resolve(opt['job-table'])).href : './jobs.mjs'
);
const jobs = jobsFor(opt.platform, { only, includeExtra: !opt['no-extra'] });
if (jobs.length === 0) fail(`no jobs selected for ${opt.platform}`);

const bash = isWin ? findGitBash() : 'bash';
const realHome = homedir();
// The profile directory that code under test can write: on Windows, a CLI
// without AGENT_BROWSER_HOME keeps state there whatever the environment says.
// Elsewhere every job has a throwaway HOME.
const profileDir = opt['profile-dir']
  ? resolve(opt['profile-dir'])
  : isWin
    ? profileStateDir()
    : null;
// A ref whose CLI reads AGENT_BROWSER_HOME gets a home of its own in each
// job's scratch directory. Where a profile directory exists, its jobs then
// skip the profile lease and the real-home lock once the ref's own CLI has
// shown it honors the variable (confirmStateHome). A comparison of the
// directory before and after each job is a safety net (see isolation.mjs).
let stateHome = refReadsStateHome({ repo: opt.repo, sha: opt.sha, srcTar: opt['src-tar'] });
const receiptPath = join(out, 'receipt.json');
const receipt = {
  schema: 1,
  platform: opt.platform,
  ref: opt.ref ?? opt.sha,
  sha: opt.sha,
  runToken: opt['run-token'] ?? null,
  untrusted: opt.untrusted,
  harness: { sha: opt['harness-sha'] ?? null, dirty: opt['harness-dirty'] },
  host: hostname(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  toolchain: toolchain(),
  chrome: opt.chrome ?? null,
  stateHome,
  stateHomeProbe: null,
  ciResult: null,
  extraResult: null,
  jobs: jobs.map((j) => ({
    id: j.id,
    ciJob: j.ciJob ?? null,
    kind: j.kind ?? 'ci',
    status: 'pending',
    durationSec: null,
    lockWaitSec: null,
    profileCheck: null,
    failedStep: null,
    log: `${j.id}.log`,
  })),
};
saveReceipt();

// A lost SSH connection or closed pipe must not crash the runner before it
// cleans up.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// Remove what earlier runs left behind when they were killed outright
// (TerminateProcess on Windows skips every handler). Each job's scratch dir
// carries an ownership marker; its worktree is the same name without "-x".
sweepOrphans(work, [''], (scratchDir) => {
  const worktree = scratchDir.replace(/-x$/, '');
  if (worktree === scratchDir) return;
  try {
    killProcessesUnder([worktree]);
    if (opt.repo) removeOwnWorktree(opt.repo, worktree);
    else rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    console.log(`[local-ci] removed leftovers of a dead run: ${worktree}`);
  } catch (err) {
    console.log(`[local-ci] could not remove leftovers ${worktree}: ${err.message}`);
  }
});
if (!isWin) sweepOrphans('/tmp', ['abci-']);
// Untrusted Linux runs reach the internet only through the egress proxy
// (run.mjs, egress.mjs). `sudo` resets the environment, so apt (which
// `install --with-deps` runs through sudo) learns the proxy from its config.
if (process.env.LOCAL_CI_EGRESS_PROXY && process.platform === 'linux' && process.getuid?.() === 0) {
  const proxy = process.env.LOCAL_CI_EGRESS_PROXY;
  writeFileSync(
    '/etc/apt/apt.conf.d/95local-ci-egress-proxy',
    `Acquire::http::Proxy "${proxy}";\nAcquire::https::Proxy "${proxy}";\n`
  );
}

// The build slot is exclusive: cleanup stops processes whose image lives in
// its target dir, so a second run on the same slot must wait.
const targetDir = resolve(opt['target-dir']);
mkdirSync(dirname(targetDir), { recursive: true });
let slotWaitLogged = false;
const releaseSlot = await acquireLock(`${targetDir}.lock`, {
  timeoutMs: 6 * 60 * 60_000,
  onWait: (holder) => {
    if (!slotWaitLogged)
      console.log(`[local-ci] waiting for build slot ${targetDir}, held by ${holder}`);
    slotWaitLogged = true;
  },
});
// A run that died while holding this slot may have left daemons or test
// binaries running from it, which would lock its executables.
{
  const stopped = killProcessesUnder([], { images: [targetDir] });
  if (stopped) console.log(`[local-ci] stopped leftovers in ${targetDir}:\n${stopped}`);
}
// Code under test may write the profile directory (see isolation.mjs); the
// run holds a lease on it unless each job has its own home.
let lease = { userOwned: false, release: async () => '' };
const results = new Map();
// The step process currently running, for interrupt cleanup.
let activeStep = null;
// Set while a job (or the AGENT_BROWSER_HOME probe) runs, so an interrupted
// run still stops its processes and removes its worktree and scratch
// directories.
let interruptJob = null;
let stopping = false;
onInterrupt(async () => {
  stopping = true;
  interruptJob?.();
  for (const j of receipt.jobs) if (j.status === 'running') j.status = 'interrupted';
  receipt.finishedAt = new Date().toISOString();
  receipt.ciResult = 'error';
  saveReceipt();
  // Lease first: the slot must stay held until nothing of this run remains.
  console.log(`[local-ci] ${await lease.release()}`);
  releaseSlot();
});
const takeLease = () =>
  acquireProfileLease(
    opt['profile-dir'] ? { dir: profileDir, quarantine: `${profileDir}-quarantine` } : {}
  );
if (stateHome && profileDir && jobs.some((j) => j.writesProfile)) {
  // The probe runs under the lease the run would take anyway, so the profile
  // directory exists and is the harness's while the ref's CLI runs; a CLI
  // that ignores the variable writes only there. The run keeps the lease
  // unless the probe confirms the ref.
  lease = await takeLease();
  receipt.stateHomeProbe = lease.userOwned
    ? {
        supported: false,
        reason: `${profileDir} belongs to the user (it has no harness marker), so the probe does not run in it`,
      }
    : await confirmStateHome().catch((err) => ({
        supported: false,
        reason: `harness error: ${err.message}`,
      }));
  stateHome = receipt.stateHomeProbe.supported;
  receipt.stateHome = stateHome;
  saveReceipt();
  if (stateHome) {
    const note = await lease.release();
    if (note) console.log(`[local-ci] ${note}`);
    lease = { userOwned: false, release: async () => '' };
  }
}
const probe = receipt.stateHomeProbe;
console.log(
  `[local-ci] ${opt.platform}: ${
    stateHome
      ? `${STATE_HOME_SOURCE} reads AGENT_BROWSER_HOME; each job gets its own home`
      : probe
        ? `AGENT_BROWSER_HOME not confirmed: ${probe.reason}`
        : `no AGENT_BROWSER_HOME in ${STATE_HOME_SOURCE}`
  }${
    !profileDir
      ? ''
      : probe?.supported
        ? `, without the profile lease or the real-home lock (${probe.reason})`
        : stateHome
          ? '; no selected job writes the profile directory, so nothing confirms the ref and the run holds the lease as for any ref'
          : '; jobs that write the profile directory take turns on the real-home lock'
  }`
);
// Only a confirmed ref runs without the lease. Like origin/main, every other
// run holds it from here on, also a ref that names the variable when no
// selected job writes the profile directory (nothing confirmed it).
if (profileDir && !probe && !stopping) lease = await takeLease();
try {
  for (const job of jobs) {
    if (stopping) break;
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
    const { status, failedStep, lockWaitSec, profileCheck } = await runJob(job).catch((err) => ({
      status: 'fail',
      failedStep: `harness error: ${err.message}`,
    }));
    // A signal that lands while a step's output drains, or while the job
    // waits for a lock, ends the job without failing a step; it did not pass.
    entry.status = stopping ? 'interrupted' : status;
    entry.failedStep = failedStep;
    entry.lockWaitSec = lockWaitSec ?? null;
    entry.profileCheck = profileCheck ?? null;
    entry.durationSec = Math.round((Date.now() - t0) / 1000);
    results.set(job.id, entry.status);
    saveReceipt();
    console.log(
      `[local-ci] ${opt.platform} ${job.id}: ${entry.status}${failedStep ? ` (${failedStep})` : ''} in ${entry.durationSec}s`
    );
  }
} finally {
  if (!stopping) {
    const note = await lease.release();
    if (note) console.log(`[local-ci] ${note}`);
    releaseSlot();
  }
}
// The interrupt handler owns the exit from here on.
if (stopping) await new Promise(() => {});

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
  claimDir(scratch);
  if (isWin) mkdirSync(sockDir, { recursive: true });
  else claimDir(sockDir);

  const timeoutMs = Number(opt['job-timeout-min']) * 60_000;
  const owned = [dir, scratch, sockDir];
  let status = 'pass';
  let failedStep = null;
  let releaseLock = null;
  let lockWaitSec = null;
  const cleanup = () => {
    const steps = [
      () => (activeStep ? killTree(activeStep.pid, { group: !isWin }) : undefined),
      // This run holds the build slot, so processes whose image lives in its
      // target dir (test binaries, daemons) are this job's.
      () => killProcessesUnder(owned, { images: [targetDir] }),
      // State the job's real-CLI daemons kept under the profile directory
      // (Windows cannot redirect it) is scoped to this run's unique namespace.
      () =>
        job.usesRealHome &&
        !stateHome &&
        profileDir &&
        !lease.userOwned &&
        rmSync(join(profileDir, 'namespaces', NAMESPACE), {
          recursive: true,
          force: true,
        }),
      () => releaseLock?.(),
      () => cleanupSource(dir),
      () => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
      () => rmSync(sockDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
    ];
    for (const step of steps) {
      try {
        const note = step();
        if (typeof note === 'string' && note) appendFileSync(log, `\n##### cleanup\n${note}\n`);
      } catch (err) {
        appendFileSync(log, `\n##### cleanup error: ${err.message}\n`);
      }
    }
  };
  interruptJob = () => {
    appendFileSync(log, '\n##### interrupted\n');
    cleanup();
  };
  let before = null;
  try {
    if (stateHome) {
      appendFileSync(
        log,
        `##### profile: AGENT_BROWSER_HOME=${join(scratch, 'agent-browser-home')}${profileDir ? `; no real-home lock or lease; ${profileDir} is compared before and after the job` : ''}\n`
      );
      if (profileDir) before = profileSnapshot(profileDir);
    }
    // Jobs that write the real Windows profile directory (cargo tests, e2e
    // tests, the real `install`) never run in a directory the user owns, and
    // runs on one host take turns with it. The job's time limit starts once
    // the lock is held; the wait has its own bound, like the build slot's.
    else if (job.writesProfile) {
      if (lease.userOwned)
        throw new Error(
          `refused: ${profileDir} belongs to the user (it has no harness marker) and this job writes there; run on a machine or account without it`
        );
      let waitLogged = false;
      const waitStart = Date.now();
      releaseLock = await acquireLock('host:real-home', {
        timeoutMs: 6 * 60 * 60_000,
        onWait: (holder) => {
          if (!waitLogged) {
            appendFileSync(log, `##### waiting for the real-home lock, held by ${holder}\n`);
            console.log(
              `[local-ci] ${opt.platform} ${job.id}: waiting for the real-home lock, held by ${holder}`
            );
          }
          waitLogged = true;
        },
      });
      lockWaitSec = Math.round((Date.now() - waitStart) / 1000);
      appendFileSync(
        log,
        `##### profile: real ${profileDir ?? profileStateDir()}; real-home lock held after ${lockWaitSec}s\n`
      );
    }
    const deadline = Date.now() + timeoutMs;
    if (stopping) return { status: 'interrupted', failedStep: null, lockWaitSec };
    prepareSource(dir, log);
    const env = jobEnv(job, scratch, sockDir);
    for (const step of job.steps) {
      if (stopping) break;
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
    interruptJob = null;
    cleanup();
  }
  // After cleanup, which stops the job's daemons, so what they write on the
  // way out counts too.
  let profileCheck = null;
  if (before) {
    const check = compareProfile(before, profileSnapshot(profileDir), {
      // NAMESPACE is hex, base-36 digits, and hyphens, which the CLI's
      // sanitize_session_component only lowercases.
      isOwn: (ns) => ns === NAMESPACE.toLowerCase(),
    });
    ({ status, failedStep, profileCheck } = applyProfileCheck({ status, failedStep }, check));
    appendFileSync(log, `\n##### profile check: ${profileCheck.summary}\n`);
    for (const c of [...check.leaks, ...check.unattributed])
      appendFileSync(log, `#####   ${c.change} ${c.path} (${c.mtime})\n`);
    if (check.unattributed.length || check.notes.length)
      console.log(`[local-ci] ${opt.platform} ${job.id}: warning: ${profileCheck.summary}`);
  }
  return { status, failedStep, lockWaitSec, profileCheck };
}

// A ref that names AGENT_BROWSER_HOME may still not honor it (the name in dead
// or test-only code). Before any job that writes the profile directory skips
// the lock, this builds the ref's own CLI as STATE_HOME_PROBE in the job table
// says (jobs.mjs) and runs probeStateHome with it, under the run's lease.
// Anything short of a confirmation keeps the lease and the lock.
async function confirmStateHome() {
  if (!STATE_HOME_PROBE)
    return { supported: false, reason: 'the job table has no STATE_HOME_PROBE' };
  const name = 'state-home-probe';
  const log = join(out, `${name}.log`);
  writeFileSync(log, `# local-ci ${opt.platform} ${name} @ ${opt.sha}\n`);
  const dir = join(work, `${runId}-${name}`);
  const scratch = `${dir}-x`;
  const sockDir = isWin ? join(scratch, 'sock') : `/tmp/abci-${runId}-p`;
  claimDir(scratch);
  if (isWin) mkdirSync(sockDir, { recursive: true });
  else claimDir(sockDir);
  const cleanup = () => {
    for (const step of [
      () => activeStep && killTree(activeStep.pid, { group: !isWin }),
      () => killProcessesUnder([dir, scratch, sockDir], { images: [targetDir] }),
      () => cleanupSource(dir),
      () => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
      () => rmSync(sockDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
    ]) {
      try {
        step();
      } catch (err) {
        appendFileSync(log, `\n##### cleanup error: ${err.message}\n`);
      }
    }
  };
  interruptJob = cleanup;
  try {
    prepareSource(dir, log);
    const env = jobEnv({ id: name, needsChrome: Boolean(opt.chrome) }, scratch, sockDir);
    const { build } = STATE_HOME_PROBE;
    appendFileSync(log, `\n##### step: ${build.name}\n`);
    const rc = await runStep(build, dir, env, log, Number(opt['job-timeout-min']) * 60_000);
    appendFileSync(log, `##### step exit: ${rc}\n`);
    if (rc !== 0) return { supported: false, reason: `${build.name} exited ${rc}` };
    const binary = resolve(dir, STATE_HOME_PROBE.binary.replace('$CARGO_TARGET_DIR', targetDir));
    // The daemon ports of the probe's session; the guard computes them the
    // way the CLI does.
    const { daemonPortsInUse } = isWin ? await import('../dogfood/guard.mjs') : {};
    const result = probeStateHome({
      binary,
      command: STATE_HOME_PROBE.runner ? [STATE_HOME_PROBE.runner, binary] : [binary],
      env,
      home: join(scratch, 'agent-browser-home'),
      realDir: profileDir,
      portCheck: daemonPortsInUse && ((ns, home) => daemonPortsInUse(ns, 'default', home)),
    });
    appendFileSync(
      log,
      `\n##### ${result.supported ? 'confirmed' : 'not confirmed'}: ${result.reason}\n`
    );
    return result;
  } finally {
    interruptJob = null;
    cleanup();
  }
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
  if (opt.repo) removeOwnWorktree(opt.repo, dir);
  else rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

function jobEnv(job, scratch, sockDir) {
  const env = scrubbedEnv();
  env.CI = 'true';
  env.CARGO_TARGET_DIR = resolve(opt['target-dir']);
  env.AGENT_BROWSER_SOCKET_DIR = sockDir;
  if (stateHome) {
    env.AGENT_BROWSER_HOME = join(scratch, 'agent-browser-home');
    mkdirSync(env.AGENT_BROWSER_HOME, { recursive: true });
  }
  // An untrusted run's package must never reach the dogfood harness, so it
  // stays in the job's scratch directory, which cleanup removes.
  env.LOCAL_CI_ARTIFACTS = opt.untrusted ? join(scratch, 'artifacts') : join(out, 'artifacts');
  env.npm_config_cache = join(cache, 'npm-cache');
  env.npm_config_store_dir = env.pnpm_config_store_dir = join(cache, 'pnpm-store');
  env.COREPACK_HOME = join(cache, 'corepack');
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  env.npm_config_update_notifier = 'false';

  // Temp files (tempfile crates, Chrome's temporary profiles) stay in the
  // job's scratch directory, which cleanup also uses to find leftovers.
  const tmp = join(scratch, 'tmp');
  mkdirSync(tmp, { recursive: true });
  env.TMPDIR = env.TMP = env.TEMP = tmp;

  // npm global installs go to a throwaway prefix, never the host's tree.
  const prefix = join(scratch, 'npm-prefix');
  mkdirSync(prefix, { recursive: true });
  env.npm_config_prefix = prefix;
  const prefixBin = isWin ? prefix : join(prefix, 'bin');
  env.PATH = `${prefixBin}${isWin ? ';' : ':'}${env.PATH ?? env.Path ?? ''}`;
  if (isWin) delete env.Path;

  env.CARGO_HOME ??= join(realHome, '.cargo');
  env.RUSTUP_HOME ??= join(realHome, '.rustup');
  if (isWin) {
    // Chrome profile discovery reads LOCALAPPDATA; point it (and APPDATA)
    // at empty directories so nothing can find the user's browser profiles.
    for (const k of ['LOCALAPPDATA', 'APPDATA']) {
      env[k] = join(scratch, k.toLowerCase());
      mkdirSync(env[k], { recursive: true });
    }
  } else if (!job.usesRealHome) {
    // A throwaway HOME keeps agent-browser state (browsers, config, sessions)
    // out of the real home. Windows ignores HOME; see isolation.mjs.
    env.HOME = join(scratch, 'home');
    mkdirSync(env.HOME, { recursive: true });
  }
  if (job.needsChrome) {
    if (!opt.chrome) throw new Error(`${job.id} needs --chrome (Chrome for Testing binary)`);
    env.AGENT_BROWSER_EXECUTABLE_PATH = opt.chrome;
  }
  // Jobs that launch browsers ignore any user config (it could set
  // autoConnect, cdp, or profile). Unit-test jobs keep hosted CI's behavior.
  // They also download into scratch: Chrome's default is the user's real
  // Downloads folder, which no environment variable moves on Windows.
  if (job.needsChrome || job.usesRealHome) {
    env.AGENT_BROWSER_CONFIG = join(scratch, 'empty-config.json');
    writeFileSync(env.AGENT_BROWSER_CONFIG, '{}\n');
    env.AGENT_BROWSER_DOWNLOAD_PATH = join(scratch, 'downloads');
    mkdirSync(env.AGENT_BROWSER_DOWNLOAD_PATH, { recursive: true });
  }
  // On Windows the daemon's TCP port derives from namespace and session name
  // only, not from AGENT_BROWSER_SOCKET_DIR, so concurrent runs that both use
  // "default" would reach each other's daemon. Only jobs that spawn the real
  // CLI daemon need this; the cargo e2e tests run the daemon in-process and
  // assert socket-dir paths that a namespace would move.
  if (job.usesRealHome) env.AGENT_BROWSER_NAMESPACE = NAMESPACE;
  return env;
}

function runStep(step, dir, env, log, timeoutMs) {
  const cwd = step.cwd ? join(dir, step.cwd) : dir;
  // GitHub Actions semantics: a step without `shell:` runs in pwsh on
  // Windows and `bash -e` elsewhere; an explicit `shell: bash` adds
  // `-o pipefail`.
  const shell = step.shell ?? (isWin ? 'pwsh' : 'default-bash');
  let cmd, args;
  if (shell === 'pwsh') {
    const script = `$ErrorActionPreference = 'stop'\n${step.run}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }`;
    cmd = 'pwsh';
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
  } else {
    cmd = bash;
    const flags = shell === 'bash' ? '-eo pipefail' : '-e';
    args = ['--noprofile', '--norc', '-c', `set ${flags}\n${step.run}`];
  }
  return new Promise((resolvePromise) => {
    // On Unix the step leads its own process group so a timeout can stop
    // grandchildren (test binaries, browsers) too.
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin,
    });
    activeStep = child;
    child.stdout.on('data', (d) => appendFileSync(log, d));
    child.stderr.on('data', (d) => appendFileSync(log, d));
    let settled = false;
    const settle = (rc) => {
      if (settled) return;
      settled = true;
      activeStep = null;
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise(rc);
    };
    const timer = setTimeout(() => {
      appendFileSync(log, `\n##### step timed out after ${Math.round(timeoutMs / 60000)} min\n`);
      killTree(child.pid, { group: !isWin });
      settle('timeout');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      appendFileSync(log, `\n##### spawn error: ${err.message}\n`);
      settle('spawn-error');
    });
    // Resolve on exit rather than on stream close: a detached daemon started
    // by the step can inherit our pipe handles and hold them open (hosted
    // runners also wait for the step process, not for pipe EOF).
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const rc = code ?? `signal ${signal}`;
      const drain = setTimeout(() => settle(rc), 2000);
      child.on('close', () => {
        clearTimeout(drain);
        settle(rc);
      });
    });
  });
}

function sh(cmd, args, log) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (log) appendFileSync(log, `$ ${cmd} ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function toolchain() {
  // pnpm and npm are .cmd shims on Windows, which only cmd.exe can run.
  const v = (cmd, args) => {
    const r = isWin
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { encoding: 'utf8' })
      : spawnSync(cmd, args, { encoding: 'utf8' });
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
