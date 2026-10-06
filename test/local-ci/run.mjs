#!/usr/bin/env node
// Local CI entry point: runs the .github/workflows/ci.yml jobs for a git ref
// on one platform (or all three) and writes a receipt.
//
//   node test/local-ci/run.mjs --platform linux   --ref <ref> [--untrusted]
//   node test/local-ci/run.mjs --platform windows --ref <ref>
//   node test/local-ci/run.mjs --platform macos   --ref <ref> [--remote <ssh-host>]
//   node test/local-ci/run.mjs --platform all     --ref <ref> --remote <ssh-host>
//
// Linux runs inside a linux/amd64 Docker container that receives only a
// `git archive` of the commit (no .git, no credentials). Windows and macOS run
// natively in throwaway git worktrees. See test/local-ci/README.md.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureChrome } from './chrome.mjs';
import { startEgress } from './egress.mjs';
import { CONTAINER_DIR, fenceUntrustedOutput, untrustedReceipt } from './fence.mjs';
import { acquireLock, killTree } from './isolation.mjs';
import {
  SSH_OPTS,
  dockerPath,
  legOutcome,
  liveChildren,
  onInterrupt,
  ownerLabelArgs,
  remoteShell,
  runSteps,
  shq,
  stream,
  summarize,
  supervisedRemoteScript,
  sweepDeadDocker,
  writeHostFile,
} from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const { values: opt } = parseArgs({
  options: {
    platform: { type: 'string' },
    ref: { type: 'string', default: 'HEAD' },
    repo: { type: 'string', default: process.cwd() },
    out: { type: 'string' },
    jobs: { type: 'string' },
    'no-extra': { type: 'boolean', default: false },
    slot: { type: 'string', default: '0' },
    remote: { type: 'string' },
    'remote-root': { type: 'string', default: '~/abw-zero' },
    'work-root': {
      type: 'string',
      default: process.env.LOCAL_CI_WORK_ROOT ?? join(tmpdir(), 'abci'),
    },
    cache: { type: 'string', default: process.env.LOCAL_CI_CACHE ?? join(tmpdir(), 'abci-cache') },
    'chrome-version': { type: 'string', default: process.env.LOCAL_CI_CHROME_VERSION ?? 'stable' },
    'job-timeout-min': { type: 'string', default: '120' },
    untrusted: { type: 'boolean', default: false },
    // Set by a parent run.mjs for the remote macOS leg, which runs from a
    // copy of the harness outside any repository.
    'harness-sha': { type: 'string' },
    'harness-dirty': { type: 'boolean', default: false },
    'run-token': { type: 'string' },
    // Tests substitute their own job table (a module exporting jobsFor), as
    // exec.mjs allows. The Linux leg then mounts no cache volumes.
    'job-table': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (opt.help || !opt.platform) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 12)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n')
  );
  process.exit(opt.help ? 0 : 2);
}

const repo = resolve(opt.repo);
let sha;
try {
  sha = git(['rev-parse', '--verify', `${opt.ref}^{commit}`]).trim();
} catch (err) {
  die(err.message);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const out = resolve(
  opt.out ?? join(tmpdir(), 'agent-browser-local-ci', `${opt.platform}-${sha.slice(0, 8)}-${stamp}`)
);
mkdirSync(out, { recursive: true });

// The harness may run from a copy outside any repository (the remote macOS
// leg), so its own revision is recorded only when available.
const harnessGit = (args) => {
  const r = spawnSync('git', ['-C', HERE, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const harness = opt['harness-sha']
  ? { sha: opt['harness-sha'], dirty: opt['harness-dirty'] }
  : {
      sha: harnessGit(['rev-parse', 'HEAD']),
      dirty: (harnessGit(['status', '--porcelain', '--', '.']) ?? '') !== '',
    };
// Every leg's receipt must carry this token, so a receipt left in a reused
// --out directory can never stand in for this run's result.
const runToken = opt['run-token'] ?? randomBytes(8).toString('hex');
const only = opt.jobs
  ? opt.jobs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;
const common = [
  ...(opt.jobs ? ['--jobs', opt.jobs] : []),
  ...(opt['no-extra'] ? ['--no-extra'] : []),
  '--job-timeout-min',
  opt['job-timeout-min'],
  '--run-token',
  runToken,
  ...(harness.sha ? ['--harness-sha', harness.sha] : []),
  ...(harness.dirty ? ['--harness-dirty'] : []),
  ...(opt.untrusted ? ['--untrusted'] : []),
];

const runners = {
  linux: runLinux,
  windows: runNative,
  macos: opt.remote ? runRemoteMac : runNative,
};
const platforms = opt.platform === 'all' ? ['linux', 'windows', 'macos'] : [opt.platform];
const jobTable = opt['job-table'] ? resolve(opt['job-table']) : null;
const { jobsFor } = await import(jobTable ? pathToFileURL(jobTable).href : './jobs.mjs');
if (jobTable && opt.remote) die('--job-table is not supported with --remote');
const knownIds = new Set(['linux', 'windows', 'macos'].flatMap((p) => jobsFor(p).map((j) => j.id)));
const unknownJobs = (only ?? []).filter((id) => !knownIds.has(id));
if (unknownJobs.length) die(`unknown job ids: ${unknownJobs.join(', ')}`);
// A platform left without selected jobs by --jobs or --no-extra is skipped.
const selected = (p) => jobsFor(p, { only, includeExtra: !opt['no-extra'] }).length > 0;
// Validate every leg before starting any, so a bad combination never leaves
// a container or remote run behind.
for (const p of platforms) {
  if (!runners[p]) die(`unknown platform ${p}`);
  if (!selected(p)) {
    if (platforms.length === 1) die(`no jobs selected for ${p}`);
    continue;
  }
  if (p === 'windows' && process.platform !== 'win32') die('windows jobs need a Windows host');
  if (p === 'macos' && !opt.remote && process.platform !== 'darwin')
    die('macos jobs need a Mac host or --remote <mac-host>');
  // Native legs run the ref's code directly on the host, with the host's
  // network and files. Code nobody has reviewed yet runs only in Docker.
  if (opt.untrusted && p !== 'linux')
    die(`--untrusted refs run only on the Linux (Docker) leg, not ${p}`);
}
if (!platforms.some(selected)) die('no jobs selected on any platform');
// Untrusted refs get their own cache volumes so they cannot poison caches
// that later trusted runs (or the dogfood harness) read.
const volumePrefix = opt.untrusted ? 'abci-u-' : 'abci-';
const containerName = `abci-${sha.slice(0, 8)}-${stamp.toLowerCase()}-${opt.slot}`;
let remoteCleanup = null;
let egress = null;
// The untrusted Linux leg whose output still needs its fence, if any.
let untrustedLeg = null;
let interrupted = false;
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

if (platforms.includes('linux') && selected('linux')) {
  const swept = sweepDeadDocker();
  if (swept) console.log(`[local-ci] ${swept.replace(/\n/g, '\n[local-ci] ')}`);
}

onInterrupt(async () => {
  interrupted = true;
  if (platforms.includes('linux')) {
    spawnSync('docker', ['stop', '-t', '5', containerName], { stdio: 'ignore' });
    const errors = [
      ...(egress?.stop() ?? []),
      ...runSteps([['fence the container output', () => untrustedLeg && fenceLeg()]]),
    ];
    egress = null;
    for (const e of errors) console.error(`[local-ci] linux cleanup: ${e}`);
  }
  // Native exec.mjs children run their own cleanup on the same signal (and
  // remote legs get SIGHUP through their pty when ssh goes away). Give them
  // time to finish, then stop whatever is left.
  for (const child of liveChildren) {
    if (process.platform !== 'win32') child.kill('SIGTERM');
  }
  const deadline = Date.now() + 60_000;
  while (liveChildren.size > 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 500));
  for (const child of liveChildren) killTree(child.pid);
  remoteCleanup?.();
});

// A summary left by an earlier run in the same --out must not survive a
// crash of this one.
if (platforms.length > 1) rmSync(join(out, 'receipt.json'), { force: true });
const results = await Promise.all(
  platforms.map(async (p) => {
    const pout = platforms.length > 1 ? join(out, p) : out;
    if (!selected(p)) {
      console.log(`[local-ci] ${p}: skipped, no selected jobs on this platform`);
      return { platform: p, skipped: 'no selected jobs on this platform', ciResult: null };
    }
    mkdirSync(pout, { recursive: true });
    rmSync(join(pout, 'receipt.json'), { recursive: true, force: true });
    let code;
    let error = null;
    try {
      code = await runners[p](p, pout);
      if (!opt.untrusted) recordArtifacts(pout);
    } catch (err) {
      error = err.message;
      code = 2;
      console.error(`[${p}] ${error}`);
    }
    const outcome = legOutcome({ receipt: readReceipt(pout), code, error, sha, runToken });
    return { platform: p, exitCode: code, out: pout, ...outcome };
  })
);

const verdict = summarize(results);
const summary = {
  schema: 1,
  ref: opt.ref,
  sha,
  untrusted: opt.untrusted,
  harness,
  runToken,
  host: hostname(),
  finishedAt: new Date().toISOString(),
  ciResult: verdict.ciResult,
  extraResult: verdict.extraResult,
  platforms: results,
};
if (platforms.length > 1) writeHostFile(join(out, 'receipt.json'), json(summary));
for (const r of results) {
  if (r.skipped) {
    console.log(`${r.platform}: skipped (${r.skipped})`);
    continue;
  }
  console.log(
    `${r.platform}: ci=${r.ciResult ?? '-'} extra=${r.extraResult ?? '-'}${r.error ? ` (${r.error})` : ''}`
  );
  for (const j of r.jobs)
    console.log(
      `  ${j.status.padEnd(7)} ${j.kind === 'extra' ? '(extra) ' : ''}${j.id}${j.failedStep ? `: ${j.failedStep}` : ''}`
    );
}
console.log(`receipt: ${join(out, 'receipt.json')}`);
// The interrupt handler owns the exit once a signal has arrived.
if (interrupted) await new Promise(() => {});
process.exit(verdict.exitCode);

// ---------------------------------------------------------------------------
// Runners throw on setup failure instead of exiting, so one failing leg of
// --platform all cannot orphan the others.

async function runLinux(platform, pout) {
  const image = ensureLinuxImage();
  const tar = join(pout, 'src.tar');
  // An untrusted container writes only into its own directory, which the
  // host never reads or writes itself (see fence.mjs). The host's files
  // (receipt, proxy log, source archive) sit next to it.
  const outDir = opt.untrusted ? join(pout, CONTAINER_DIR) : pout;
  if (opt.untrusted) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir);
    // Marked untrusted before the container can write anything, so an
    // interrupted run's output is never taken for a trusted one.
    writeHostFile(join(pout, 'receipt.json'), json(untrustedReceipt(null, { ref: opt.ref })));
  }
  // Force LF: git archive applies the host's core.autocrlf to the contents.
  git([
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
    'archive',
    '--format=tar',
    '-o',
    tar,
    sha,
  ]);
  const v = (name, path) => ['-v', `${volumePrefix}${name}:${path}`];
  // A stand-in job table runs without the shared cache volumes.
  const volumes = jobTable
    ? []
    : [
        ...v('cargo-registry', '/usr/local/cargo/registry'),
        ...v('cargo-git', '/usr/local/cargo/git'),
        ...v(`target-${opt.slot}`, '/work/target'),
        ...v('cache', '/work/cache'),
      ];
  const dockerRun = (fenceArgs) => [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--init',
    '--name',
    containerName,
    ...ownerLabelArgs(),
    ...fenceArgs,
    '-v',
    `${dockerPath(outDir)}:/out`,
    '-v',
    `${dockerPath(tar)}:/in/src.tar:ro`,
    '-v',
    `${dockerPath(HERE)}:/ci:ro`,
    ...(jobTable ? ['-v', `${dockerPath(jobTable)}:/in/job-table.mjs:ro`] : []),
    ...volumes,
    '--shm-size=2g',
    image,
    'node',
    '/ci/exec.mjs',
    '--platform',
    'linux',
    '--sha',
    sha,
    '--ref',
    opt.ref,
    '--src-tar',
    '/in/src.tar',
    '--work',
    '/work/jobs',
    '--out',
    '/out',
    '--target-dir',
    '/work/target',
    '--cache',
    '/work/cache',
    ...common,
    ...(jobTable ? ['--job-table', '/in/job-table.mjs'] : []),
  ];
  // exec.mjs's slot lock inside the container cannot see other containers
  // (each has its own network namespace). Two Linux runs on one slot share
  // the target volume, which is global to the Docker host, so serialize them
  // here on the host under a name that does not depend on --work-root.
  let waitLogged = false;
  const releaseSlot = await acquireLock(`host:${volumePrefix}linux-target-${opt.slot}`, {
    timeoutMs: 6 * 60 * 60_000,
    onWait: (holder) => {
      if (!waitLogged)
        console.log(`[local-ci] linux: waiting for build slot ${opt.slot}, held by ${holder}`);
      waitLogged = true;
    },
  });
  let code;
  const errors = [];
  try {
    // Untrusted code must not reach services on the host (see egress.mjs).
    if (opt.untrusted) {
      untrustedLeg = { pout, outDir, image };
      egress = await startEgress({
        id: containerName,
        image,
        ciDir: dockerPath(HERE),
        labels: ownerLabelArgs(),
      });
      console.log(`[local-ci] linux: untrusted, network ${egress.network} via ${egress.url}`);
    }
    code = await stream('docker', dockerRun(egress?.dockerArgs ?? []), platform);
  } catch (err) {
    errors.push(err.message);
  }
  // Every step runs whatever the container left behind or whichever step
  // failed before it.
  const proxy = egress;
  egress = null;
  errors.push(
    ...(proxy?.stop(join(pout, 'egress.log')) ?? []),
    ...runSteps([
      ['fence the container output', () => untrustedLeg && fenceLeg()],
      ['release the build slot', () => releaseSlot()],
      ['remove the source archive', () => rmSync(tar, { force: true })],
    ])
  );
  if (errors.length) throw new Error(errors.join('; '));
  return code;
}

// Replaces the untrusted leg's receipt with the host's, built from what the
// fenced container output reported (fence.mjs).
function fenceLeg() {
  const { pout, outDir, image } = untrustedLeg;
  untrustedLeg = null;
  const { receipt: reported, truncated } = fenceUntrustedOutput({
    dir: dockerPath(outDir),
    image,
    ciDir: dockerPath(HERE),
    labels: ownerLabelArgs(),
  });
  const receipt = untrustedReceipt(reported, { ref: opt.ref });
  if (truncated.length) receipt.truncatedLogs = truncated;
  writeHostFile(join(pout, 'receipt.json'), json(receipt));
}

// Records the SHA-256 of each package a trusted leg saved, from the host
// side, so the dogfood harness can tell these tarballs from look-alikes.
function recordArtifacts(pout) {
  const receipt = readReceipt(pout);
  if (!receipt || receipt.runToken !== runToken) return;
  const dir = join(pout, 'artifacts');
  receipt.artifacts = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.tgz') && lstatSync(join(dir, f)).isFile())
        .map((file) => ({
          file,
          sha256: createHash('sha256')
            .update(readFileSync(join(dir, file)))
            .digest('hex'),
        }))
    : [];
  writeHostFile(join(pout, 'receipt.json'), json(receipt));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function runNative(platform, pout) {
  const cache = resolve(opt.cache);
  const chrome = await ensureChrome({ cacheDir: cache, version: opt['chrome-version'] });
  const work = resolve(opt['work-root']);
  const args = [
    join(HERE, 'exec.mjs'),
    '--platform',
    platform,
    '--sha',
    sha,
    '--ref',
    opt.ref,
    '--repo',
    repo,
    '--work',
    work,
    '--out',
    pout,
    '--target-dir',
    join(work, `target-${platform}-${opt.slot}`),
    '--cache',
    cache,
    '--chrome',
    chrome.path,
    ...common,
  ];
  console.log(`[local-ci] ${platform}: Chrome for Testing ${chrome.version}`);
  return stream(process.execPath, args, platform);
}

// Copies this harness to the Mac, runs it there against the same commit
// (fetched from origin), and copies the receipt and logs back.
async function runRemoteMac(platform, pout) {
  const host = opt.remote;
  const root = opt['remote-root'];
  const id = `${sha.slice(0, 8)}-${stamp}-${opt.slot}`;
  const rHarness = `${root}/harness-${id}`;
  const rOut = `${root}/out-${id}`;
  const rel = (p) => p.replace(/^~\//, '');
  const zsh = (cmd) => [...SSH_OPTS, host, remoteShell(cmd)];
  const run = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  let r = run(['ssh', ...zsh(`mkdir -p ${root} && rm -rf ${rHarness} && mkdir -p ${rHarness}`)]);
  if (r.status !== 0) throw new Error(`ssh ${host}: ${r.stderr.trim()}`);
  remoteCleanup = () => run(['ssh', ...zsh(`rm -rf ${rHarness} ${rOut}`)]);
  r = run([
    'scp',
    '-q',
    ...SSH_OPTS,
    ...[
      'jobs.mjs',
      'exec.mjs',
      'run.mjs',
      'chrome.mjs',
      'egress.mjs',
      'fence.mjs',
      'isolation.mjs',
      'util.mjs',
    ].map((f) => join(HERE, f)),
    `${host}:${rel(rHarness)}/`,
  ]);
  if (r.status !== 0) throw new Error(`scp harness to ${host}: ${r.stderr.trim()}`);
  const rRepo = `${root}/repo`;
  const origin = git(['remote', 'get-url', '--push', 'origin'])
    .trim()
    .replace(/^git@github\.com:/, 'https://github.com/');
  // -tt gives the remote run a pty, so a dropped connection or an interrupt
  // here delivers SIGHUP, which the script forwards to the remote runner.
  const remoteCmd = supervisedRemoteScript({
    setup: [
      `{ test -d ${rRepo}/.git || git clone -q ${shq(origin)} ${rRepo}; }`,
      `git -C ${rRepo} fetch -q origin`,
      `git -C ${rRepo} cat-file -e ${sha}^{commit}`,
      `cd ${rRepo}`,
    ],
    command: `node ${rHarness}/run.mjs --platform macos --ref ${sha} --repo ${rRepo} --out ${rOut} --work-root ${root}/w --cache ${root}/cache --slot ${opt.slot} --chrome-version ${shq(opt['chrome-version'])} ${common.map(shq).join(' ')}`,
    always: [rHarness],
    onSignal: [rOut],
  });
  const code = await stream('ssh', ['-tt', ...zsh(remoteCmd)], platform);
  r = run(['scp', '-q', '-r', ...SSH_OPTS, `${host}:${rel(rOut)}/.`, pout]);
  if (r.status !== 0)
    console.error(`[local-ci] could not copy results back from ${host}: ${r.stderr}`);
  run(['ssh', ...zsh(`rm -rf ${rHarness} ${rOut}`)]);
  // The remote run only saw the SHA; record the ref the caller asked for.
  const receipt = readReceipt(pout);
  if (receipt) {
    receipt.ref = opt.ref;
    writeHostFile(join(pout, 'receipt.json'), json(receipt));
  }
  return code;
}

function ensureLinuxImage() {
  const dockerfile = join(HERE, 'linux.Dockerfile');
  const tag = `abci-linux:${createHash('sha256').update(readFileSync(dockerfile)).digest('hex').slice(0, 12)}`;
  if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0) return tag;
  console.log(`[local-ci] building ${tag}`);
  const r = spawnSync(
    'docker',
    ['build', '--platform', 'linux/amd64', '-t', tag, '-f', dockerfile, HERE],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) throw new Error('docker build failed');
  return tag;
}

function readReceipt(dir) {
  const p = join(dir, 'receipt.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function git(args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

function die(msg) {
  console.error(`run.mjs: ${msg}`);
  process.exit(2);
}
