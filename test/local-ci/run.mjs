#!/usr/bin/env node
// Local CI entry point: runs the .github/workflows/ci.yml jobs for a git ref
// on one platform (or all three) and writes a receipt.
//
//   node test/local-ci/run.mjs --platform linux   --ref <ref>
//   node test/local-ci/run.mjs --platform windows --ref <ref>
//   node test/local-ci/run.mjs --platform macos   --ref <ref> [--remote <ssh-host>]
//   node test/local-ci/run.mjs --platform all     --ref <ref> --remote <ssh-host>
//
// Linux runs inside a linux/amd64 Docker container that receives only a
// `git archive` of the commit (no .git, no credentials). Windows and macOS run
// natively in throwaway git worktrees. See test/local-ci/README.md.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureChrome } from './chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Detect a dropped connection instead of waiting on it forever.
const SSH_OPTS = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4'];

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
const sha = git(['rev-parse', '--verify', `${opt.ref}^{commit}`]).trim();
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
const harness = {
  sha: harnessGit(['rev-parse', 'HEAD']),
  dirty: (harnessGit(['status', '--porcelain', '--', '.']) ?? '') !== '',
};
const common = [
  `--ref`,
  opt.ref,
  ...(opt.jobs ? ['--jobs', opt.jobs] : []),
  ...(opt['no-extra'] ? ['--no-extra'] : []),
  '--job-timeout-min',
  opt['job-timeout-min'],
];

const runners = {
  linux: runLinux,
  windows: runNative,
  macos: opt.remote ? runRemoteMac : runNative,
};
const platforms = opt.platform === 'all' ? ['linux', 'windows', 'macos'] : [opt.platform];
// Validate every leg before starting any, so a bad combination never leaves
// a container or remote run behind.
for (const p of platforms) {
  if (!runners[p]) die(`unknown platform ${p}`);
  if (p === 'windows' && process.platform !== 'win32') die('windows jobs need a Windows host');
  if (p === 'macos' && !opt.remote && process.platform !== 'darwin')
    die('macos jobs need a Mac host or --remote <mac-host>');
  // Native legs run the ref's code directly on the host, with the host's
  // network and files. Code nobody has reviewed yet runs only in Docker.
  if (opt.untrusted && p !== 'linux')
    die(`--untrusted refs run only on the Linux (Docker) leg, not ${p}`);
}
// Untrusted refs get their own cache volumes so they cannot poison caches
// that later trusted runs (or the dogfood harness) read.
const volumePrefix = opt.untrusted ? 'abci-u-' : 'abci-';

const results = await Promise.all(
  platforms.map(async (p) => {
    const pout = platforms.length > 1 ? join(out, p) : out;
    mkdirSync(pout, { recursive: true });
    const code = await runners[p](p, pout);
    const receipt = readReceipt(pout);
    // A runner that died before finishing leaves ciResult unset or stale.
    const finished = receipt?.finishedAt && (code === 0 || code === 1);
    return {
      platform: p,
      exitCode: code,
      out: pout,
      ciResult: finished ? receipt.ciResult : 'error',
      extraResult: receipt?.extraResult ?? null,
      jobs: receipt?.jobs ?? [],
    };
  })
);

const summary = {
  schema: 1,
  ref: opt.ref,
  sha,
  untrusted: opt.untrusted,
  harness,
  host: hostname(),
  finishedAt: new Date().toISOString(),
  ciResult: results.every((r) => r.ciResult === 'pass') ? 'pass' : 'fail',
  extraResult: results.some((r) => r.extraResult === 'fail')
    ? 'fail'
    : results.some((r) => r.extraResult)
      ? 'pass'
      : null,
  platforms: results,
};
if (platforms.length > 1)
  writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(summary, null, 2)}\n`);
for (const r of results) {
  console.log(`${r.platform}: ci=${r.ciResult} extra=${r.extraResult ?? '-'}`);
  for (const j of r.jobs)
    console.log(
      `  ${j.status.padEnd(7)} ${j.kind === 'extra' ? '(extra) ' : ''}${j.id}${j.failedStep ? `: ${j.failedStep}` : ''}`
    );
}
console.log(`receipt: ${join(out, 'receipt.json')}`);
process.exit(summary.ciResult === 'pass' && summary.extraResult !== 'fail' ? 0 : 1);

// ---------------------------------------------------------------------------

async function runLinux(platform, pout) {
  const image = ensureLinuxImage();
  const tar = join(pout, 'src.tar');
  git(['archive', '--format=tar', '-o', tar, sha]);
  const v = (name, path) => ['-v', `${volumePrefix}${name}:${path}`];
  const args = [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--init',
    '--name',
    `abci-${sha.slice(0, 8)}-${stamp.toLowerCase()}-${opt.slot}`,
    '-v',
    `${toDockerPath(pout)}:/out`,
    '-v',
    `${toDockerPath(HERE)}:/ci:ro`,
    ...v('cargo-registry', '/usr/local/cargo/registry'),
    ...v('cargo-git', '/usr/local/cargo/git'),
    ...v(`target-${opt.slot}`, '/work/target'),
    ...v('cache', '/work/cache'),
    '--shm-size=2g',
    image,
    'node',
    '/ci/exec.mjs',
    '--platform',
    'linux',
    '--sha',
    sha,
    '--src-tar',
    '/out/src.tar',
    '--work',
    '/work/jobs',
    '--out',
    '/out',
    '--target-dir',
    '/work/target',
    '--cache',
    '/work/cache',
    ...common,
  ];
  const code = await stream('docker', args, platform);
  rmSync(tar, { force: true });
  return code;
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
  const zsh = (cmd) => ['ssh', ...SSH_OPTS, host, `zsh -lic ${shq(cmd)}`];
  const run = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  let r = run(zsh(`mkdir -p ${root} && rm -rf ${rHarness} && mkdir -p ${rHarness}`));
  if (r.status !== 0) die(`ssh ${host}: ${r.stderr}`);
  r = run([
    'scp',
    '-q',
    ...SSH_OPTS,
    ...['jobs.mjs', 'exec.mjs', 'run.mjs', 'chrome.mjs', 'isolation.mjs'].map((f) => join(HERE, f)),
    `${host}:${rHarness.replace(/^~\//, '')}/`,
  ]);
  if (r.status !== 0) die(`scp harness to ${host}: ${r.stderr}`);
  const rRepo = `${root}/repo`;
  // The trap removes the harness copy even if the connection drops; results
  // stay until they are copied back below.
  const steps = [
    `test -d ${rRepo}/.git || git clone -q ${shq(
      git(['remote', 'get-url', '--push', 'origin'])
        .trim()
        .replace(/^git@github\.com:/, 'https://github.com/')
    )} ${rRepo}`,
    `git -C ${rRepo} fetch -q origin`,
    `git -C ${rRepo} cat-file -e ${sha}^{commit}`,
    `cd ${rRepo}`,
    `node ${rHarness}/run.mjs --platform macos --ref ${sha} --repo ${rRepo} --out ${rOut} --work-root ${root}/w --cache ${root}/cache --slot ${opt.slot} --chrome-version ${opt['chrome-version']} ${common.slice(2).map(shq).join(' ')}`,
  ];
  const remoteCmd = `trap 'rm -rf ${rHarness}' EXIT HUP INT TERM; ${steps.join(' && ')}`;
  const code = await stream(zsh(remoteCmd)[0], zsh(remoteCmd).slice(1), platform);
  r = run(['scp', '-q', '-r', ...SSH_OPTS, `${host}:${rOut.replace(/^~\//, '')}/.`, pout]);
  if (r.status !== 0)
    console.error(`[local-ci] could not copy results back from ${host}: ${r.stderr}`);
  run(zsh(`rm -rf ${rHarness} ${rOut}`));
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
  if (r.status !== 0) die('docker build failed');
  return tag;
}

function stream(cmd, args, label) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const pipe = (src, dst) =>
      src.on('data', (d) => dst.write(String(d).replace(/^(?=.)/gm, `[${label}] `)));
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('error', (e) => {
      console.error(`[${label}] ${e.message}`);
      res(127);
    });
    // Exit, not close: a leaked daemon can hold inherited pipe handles open.
    child.on('exit', (code) => setTimeout(() => res(code ?? 1), 2000));
  });
}

function readReceipt(dir) {
  const p = join(dir, 'receipt.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function git(args) {
  const r = spawnSync('git', args[0] === '-C' ? args : ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) die(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

function toDockerPath(p) {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function die(msg) {
  console.error(`run.mjs: ${msg}`);
  process.exit(2);
}
