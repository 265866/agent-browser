// Keeps the local CI job table in step with .github/workflows/ci.yml: every
// workflow job and matrix leg must have a local counterpart.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED,
  LINT_DIR,
  SHELLCHECK_OPTS,
  compareFindings,
  lintCommand,
  parseRun,
  workflowFiles,
} from './actionlint.mjs';
import { archiveCommit, compareArchive, objectHasher, readTar, treeEntries } from './archive.mjs';
import { CI_YML_SHA256, JOBS, jobsFor } from './jobs.mjs';
import { MAX_LOG, untrustedReceipt } from './fence.mjs';
import { acquireLock } from './isolation.mjs';
import { OWNER_LABEL, legOutcome, summarize, writeHostFile } from './util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

/** Top-level job ids with their matrix targets (from `target:` entries). */
function workflowJobs(text) {
  const jobs = new Map();
  let current = null;
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (job) {
      current = job[1];
      jobs.set(current, { targets: [], pushOnly: false });
      continue;
    }
    if (!current) continue;
    const target = line.match(/^\s+target:\s*([\w.-]+)\s*$/);
    if (target) jobs.get(current).targets.push(target[1]);
    if (/^\s+if:\s*github\.event_name != 'pull_request'/.test(line))
      jobs.get(current).pushOnly = true;
  }
  return jobs;
}

const ciJobs = workflowJobs(workflow);
const localCi = JOBS.filter((j) => j.kind !== 'extra');

test('ci.yml matches the revision the job table mirrors', () => {
  const actual = createHash('sha256').update(workflow.replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(
    actual,
    CI_YML_SHA256,
    'ci.yml changed: update test/local-ci/jobs.mjs to mirror it, then update CI_YML_SHA256'
  );
});

test('the workflow parser finds jobs', () => {
  assert.ok(ciJobs.size >= 5, `parsed only ${ciJobs.size} jobs from ci.yml`);
});

for (const [id, { targets, pushOnly }] of ciJobs) {
  test(`ci.yml job ${id} has local counterparts`, () => {
    const local = localCi.filter((j) => j.ciJob === id || j.ciJob?.startsWith(`${id} (`));
    assert.ok(local.length > 0, `no local job mirrors ci.yml job "${id}"`);
    for (const target of targets) {
      const covered = local.some(
        (j) => j.ciJob.includes(target) || j.steps.some((s) => s.run.includes(target))
      );
      assert.ok(covered, `ci.yml ${id} matrix target ${target} has no local job`);
    }
    for (const j of local)
      assert.equal(Boolean(j.pushOnly), pushOnly, `${j.id} pushOnly should be ${pushOnly}`);
  });
}

test('every local ci job maps to a job that still exists in ci.yml', () => {
  for (const j of localCi) {
    const id = j.ciJob.split(' (')[0];
    assert.ok(ciJobs.has(id), `${j.id} mirrors "${id}", which ci.yml no longer defines`);
  }
});

test('job ids are unique and needs refer to same-platform jobs', () => {
  const ids = new Set();
  for (const j of JOBS) {
    assert.ok(!ids.has(j.id), `duplicate job id ${j.id}`);
    ids.add(j.id);
  }
  for (const j of JOBS) {
    for (const n of j.needs ?? []) {
      const dep = JOBS.find((x) => x.id === n);
      assert.ok(dep, `${j.id} needs unknown job ${n}`);
      assert.equal(dep.platform, j.platform, `${j.id} needs ${n} on another platform`);
    }
  }
});

test('every Windows job that writes the real profile directory says so', () => {
  for (const job of JOBS.filter((j) => j.platform === 'windows')) {
    const runsCode =
      job.usesRealHome ||
      job.steps.some(
        (s) => /cargo test|cargo\(.test/.test(s.run) || /\btest --profile/.test(s.run)
      );
    if (runsCode)
      assert.equal(
        job.writesProfile,
        true,
        `${job.id} runs tests or the real CLI but lacks writesProfile`
      );
  }
});

// ---- receipts and verdicts ----

const SHA = 'a'.repeat(40);
const fresh = (over = {}) => ({
  sha: SHA,
  runToken: 'tok',
  finishedAt: '2026-01-01T00:00:00.000Z',
  ciResult: 'pass',
  extraResult: null,
  jobs: [{ id: 'x', status: 'pass' }],
  ...over,
});

test('a leg counts only a finished receipt from this run', () => {
  const ok = legOutcome({ receipt: fresh(), code: 0, sha: SHA, runToken: 'tok' });
  assert.equal(ok.ciResult, 'pass');
  assert.equal(ok.error, null);
  // A pass left in a reused --out by an earlier run.
  const stale = legOutcome({
    receipt: fresh({ runToken: 'old' }),
    code: 0,
    sha: SHA,
    runToken: 'tok',
  });
  assert.equal(stale.ciResult, 'error');
  assert.match(stale.error, /not from this run/);
  assert.deepEqual(stale.jobs, []);
  const otherCommit = legOutcome({
    receipt: fresh({ sha: 'b'.repeat(40) }),
    code: 0,
    sha: SHA,
    runToken: 'tok',
  });
  assert.equal(otherCommit.ciResult, 'error');
  // The runner exited before writing anything.
  const none = legOutcome({ receipt: null, code: 2, sha: SHA, runToken: 'tok' });
  assert.equal(none.ciResult, 'error');
  assert.match(none.error, /no receipt \(exit 2\)/);
  // Interrupted: the receipt is this run's but unfinished.
  const cut = legOutcome({
    receipt: fresh({ finishedAt: null }),
    code: 130,
    sha: SHA,
    runToken: 'tok',
  });
  assert.equal(cut.ciResult, 'error');
  assert.equal(cut.jobs.length, 1);
});

test('extras-only selections pass with no ci.yml verdict, and skipped legs do not count', () => {
  const extrasOnly = legOutcome({
    receipt: fresh({ ciResult: null, extraResult: 'pass' }),
    code: 0,
    sha: SHA,
    runToken: 'tok',
  });
  assert.equal(extrasOnly.ciResult, null);
  assert.deepEqual(summarize([extrasOnly]), { ciResult: null, extraResult: 'pass', exitCode: 0 });
  const skipped = { platform: 'macos', skipped: 'no selected jobs', ciResult: null };
  assert.equal(summarize([{ ciResult: 'pass', extraResult: null }, skipped]).exitCode, 0);
  assert.equal(summarize([skipped]).exitCode, 1);
  assert.deepEqual(summarize([{ ciResult: 'pass' }, { ciResult: 'error' }]), {
    ciResult: 'fail',
    extraResult: null,
    exitCode: 1,
  });
  assert.equal(summarize([{ ciResult: 'pass', extraResult: 'fail' }]).exitCode, 1);
});

const runMjs = join(here, 'run.mjs');
const runCli = (args) =>
  spawnSync(process.execPath, [runMjs, '--repo', root, '--ref', 'HEAD', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });

test('run.mjs rejects unknown job ids and a platform left without jobs before starting', (t) => {
  const out = mkdtempSync(join(tmpdir(), 'ci-sel-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  let r = runCli(['--platform', 'linux', '--out', out, '--jobs', 'no-such-job']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown job ids: no-such-job/);
  r = runCli(['--platform', 'linux', '--out', out, '--jobs', 'extra-clippy-windows']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no jobs selected for linux/);
});

// ---- exec.mjs with a stand-in job table ----
// On Windows exec.mjs takes the real profile directory lease, which tests
// must not touch; the Linux leg runs these.
const execSkip = process.platform === 'win32' && 'exec.mjs leases the real profile dir on Windows';

function execFixture(t, steps) {
  const base = mkdtempSync(join(tmpdir(), 'ci-exec-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  const table = join(base, 'table.mjs');
  writeFileSync(
    table,
    `const steps = ${JSON.stringify(steps)};
export function jobsFor(platform, { only, includeExtra = true } = {}) {
  return [
    { id: 'main', ciJob: 'main', platform, writesProfile: Boolean(steps.writesProfile), steps: steps.main },
    { id: 'extra-check', kind: 'extra', platform, steps: steps.extra },
  ]
    .filter((j) => includeExtra || j.kind !== 'extra')
    .filter((j) => !only || only.includes(j.id));
}
`
  );
  const out = join(base, 'out');
  const args = (extra = []) => [
    join(here, 'exec.mjs'),
    '--platform',
    'test',
    '--sha',
    sha,
    '--repo',
    repo,
    '--work',
    join(base, 'w'),
    '--out',
    out,
    '--target-dir',
    join(base, 't', 'target'),
    '--cache',
    join(base, 'cache'),
    '--job-table',
    table,
    '--run-token',
    'tok123',
    ...extra,
  ];
  const receipt = () => JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
  return { sha, out, args, receipt };
}

const artifactStep = {
  name: 'save artifact',
  shell: 'bash',
  run: 'mkdir -p "$LOCAL_CI_ARTIFACTS" && echo pkg > "$LOCAL_CI_ARTIFACTS/agent-browser-0.0.0.tgz"',
};

test(
  'exec.mjs records the run token, harness, and trust, and keeps packages of trusted runs only',
  { skip: execSkip },
  (t) => {
    const steps = { main: [artifactStep], extra: [{ name: 'ok', shell: 'bash', run: 'true' }] };
    const trusted = execFixture(t, steps);
    let r = spawnSync(process.execPath, trusted.args(['--harness-sha', 'h1']), {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    let rec = trusted.receipt();
    assert.equal(rec.runToken, 'tok123');
    assert.equal(rec.sha, trusted.sha);
    assert.deepEqual(rec.harness, { sha: 'h1', dirty: false });
    assert.equal(rec.untrusted, false);
    assert.equal(existsSync(join(trusted.out, 'artifacts', 'agent-browser-0.0.0.tgz')), true);

    const untrusted = execFixture(t, steps);
    r = spawnSync(process.execPath, untrusted.args(['--untrusted']), { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    rec = untrusted.receipt();
    assert.equal(rec.untrusted, true);
    assert.equal(rec.ciResult, 'pass');
    assert.equal(existsSync(join(untrusted.out, 'artifacts')), false);
  }
);

test('exec.mjs passes an extras-only selection with no ci.yml verdict', { skip: execSkip }, (t) => {
  const f = execFixture(t, {
    main: [artifactStep],
    extra: [{ name: 'ok', shell: 'bash', run: 'true' }],
  });
  const r = spawnSync(process.execPath, f.args(['--jobs', 'extra-check']), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rec = f.receipt();
  assert.equal(rec.ciResult, null);
  assert.equal(rec.extraResult, 'pass');
});

test(
  'a signal while a finished step drains its output marks the job interrupted, not passed',
  { skip: execSkip },
  async (t) => {
    // The step exits at once, but a detached grandchild keeps its output pipe
    // open, so the runner waits up to two seconds for the output to drain.
    const holdPipe = `node -e "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref(); console.log('step-done')"`;
    const f = execFixture(t, {
      main: [{ name: 'quick', shell: 'bash', run: holdPipe }],
      extra: [],
    });
    const child = spawn(process.execPath, f.args(['--no-extra']), { stdio: 'ignore' });
    const log = join(f.out, 'main.log');
    const deadline = Date.now() + 60_000;
    while (!(existsSync(log) && readFileSync(log, 'utf8').includes('step-done'))) {
      assert.ok(Date.now() < deadline, 'step never ran');
      await new Promise((r) => setTimeout(r, 25));
    }
    child.kill('SIGTERM');
    const code = await new Promise((r) => child.on('exit', (c) => r(c)));
    assert.equal(code, 130);
    const rec = f.receipt();
    assert.equal(rec.ciResult, 'error');
    assert.equal(rec.jobs.find((j) => j.id === 'main').status, 'interrupted');
  }
);

test(
  'waiting for the real-home lock does not use up the job time limit',
  { skip: execSkip },
  async (t) => {
    const f = execFixture(t, {
      main: [{ name: 'quick', shell: 'bash', run: 'true' }],
      extra: [],
      writesProfile: true,
    });
    // Another run holds the lock until this job has waited longer than its
    // whole time limit (3 s); killing the holder frees the lock.
    const isolationUrl = new URL('./isolation.mjs', import.meta.url).href;
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { acquireLock } = await import(${JSON.stringify(isolationUrl)});
         await acquireLock('host:real-home', { timeoutMs: 10000 });
         console.log('held');
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    t.after(() => holder.kill('SIGKILL'));
    await new Promise((r) => holder.stdout.on('data', (d) => String(d).includes('held') && r()));
    const run = spawn(process.execPath, f.args(['--no-extra', '--job-timeout-min', '0.05']), {
      stdio: 'ignore',
    });
    const exited = new Promise((r) => run.on('exit', (code) => r(code)));
    const log = join(f.out, 'main.log');
    const deadline = Date.now() + 60_000;
    while (!(
      existsSync(log) && readFileSync(log, 'utf8').includes('waiting for the real-home lock')
    )) {
      assert.ok(Date.now() < deadline, 'the job never waited for the lock');
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 4000));
    holder.kill('SIGKILL');
    assert.equal(await exited, 0);
    const entry = f.receipt().jobs.find((j) => j.id === 'main');
    assert.equal(entry.status, 'pass', entry.failedStep);
    assert.ok(entry.lockWaitSec >= 4, `lockWaitSec ${entry.lockWaitSec}`);
  }
);

test('a leg whose exit code disagrees with its receipt is an error', () => {
  const passWithExit1 = legOutcome({ receipt: fresh(), code: 1, sha: SHA, runToken: 'tok' });
  assert.equal(passWithExit1.ciResult, 'error');
  assert.match(passWithExit1.error, /exit 1 disagrees with the receipt/);
  const failWithExit0 = legOutcome({
    receipt: fresh({ ciResult: 'fail' }),
    code: 0,
    sha: SHA,
    runToken: 'tok',
  });
  assert.equal(failWithExit0.ciResult, 'error');
  const extraFail = legOutcome({
    receipt: fresh({ extraResult: 'fail' }),
    code: 1,
    sha: SHA,
    runToken: 'tok',
  });
  assert.equal(extraFail.ciResult, 'pass');
  assert.equal(extraFail.extraResult, 'fail');
  assert.equal(extraFail.error, null);
});

test('host writes refuse a directory or a link in place of the file', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ci-write-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(base, 'receipt.json');
  writeHostFile(file, 'one');
  writeHostFile(file, 'two');
  assert.equal(readFileSync(file, 'utf8'), 'two');
  const dir = join(base, 'egress.log');
  mkdirSync(dir);
  assert.throws(() => writeHostFile(dir, 'x'), /not a regular file/);
  // A directory link needs no privileges on Windows (a junction).
  const target = join(base, 'target');
  mkdirSync(target);
  const link = join(base, 'linked');
  symlinkSync(target, link, 'junction');
  assert.throws(() => writeHostFile(link, 'x'), /not a regular file/);
  assert.deepEqual(readdirSync(target), []);
});

test('an untrusted receipt takes only reported fields and is marked untrusted by the host', () => {
  const forged = JSON.stringify({
    sha: SHA,
    runToken: 'tok',
    untrusted: false,
    finishedAt: 'now',
    ciResult: 'pass',
    jobs: [{ id: 'main', status: 'pass', log: 'main.log' }, 'junk'],
    artifacts: [{ file: 'agent-browser-9.9.9.tgz', sha256: 'f'.repeat(64) }],
    injected: true,
  });
  const r = untrustedReceipt(forged, { ref: 'pr-head' });
  assert.equal(r.untrusted, true);
  assert.deepEqual(r.artifacts, []);
  assert.equal(r.injected, undefined);
  assert.equal(r.ref, 'pr-head');
  assert.equal(r.reportedByContainer, true);
  assert.deepEqual(r.jobs, [{ id: 'main', status: 'pass', log: 'container/main.log' }]);
  for (const text of [null, 'not json', '[1]'])
    assert.deepEqual(untrustedReceipt(text, { ref: 'x' }), {
      schema: 1,
      platform: 'linux',
      ref: 'x',
      jobs: [],
      untrusted: true,
      reportedByContainer: false,
      artifacts: [],
    });
});

test('the fence keeps logs up to MAX_LOG bytes and notes the cut', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'small.log'), 'ok\n');
  writeFileSync(join(dir, 'big.log'), 'x');
  truncateSync(join(dir, 'big.log'), MAX_LOG + 4096);
  writeFileSync(join(dir, 'receipt.json'), '{"ciResult":"pass"}');
  mkdirSync(join(dir, 'artifacts'));
  const r = spawnSync(process.execPath, [join(here, 'fence.mjs'), dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.receipt, '{"ciResult":"pass"}');
  assert.deepEqual(out.truncated, [{ log: 'big.log', bytes: MAX_LOG + 4096 }]);
  assert.deepEqual(readdirSync(dir).sort(), ['big.log', 'small.log']);
  assert.equal(readFileSync(join(dir, 'small.log'), 'utf8'), 'ok\n');
  const big = statSync(join(dir, 'big.log')).size;
  assert.ok(big > MAX_LOG && big < MAX_LOG + 200, `big.log is ${big} bytes`);
  const fd = openSync(join(dir, 'big.log'), 'r');
  const tail = Buffer.alloc(big - MAX_LOG);
  readSync(fd, tail, 0, tail.length, MAX_LOG);
  closeSync(fd);
  assert.match(tail.toString(), /local CI fence: cut from \d+ bytes/);
});

// ---- run.mjs with a real Linux container and a stand-in job table ----

const linuxImage = (() => {
  if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) return null;
  const dockerfile = join(here, 'linux.Dockerfile');
  const tag = `abci-linux:${createHash('sha256').update(readFileSync(dockerfile)).digest('hex').slice(0, 12)}`;
  return spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0
    ? tag
    : null;
})();
const containerSkip = !linuxImage && 'docker or the local CI image is not available';

// A one-commit repository with `files`, a job table running `run` as the
// only Linux job, and run.mjs started against them.
function linuxFixture(t, files, run) {
  const base = mkdtempSync(join(tmpdir(), 'ci-linux-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const table = join(base, 'table.mjs');
  writeFileSync(
    table,
    `export function jobsFor(platform, { only } = {}) {
  return [{ id: 'main', ciJob: 'main', platform: 'linux', steps: [{ name: 'main', shell: 'bash', run: ${JSON.stringify(run)} }] }]
    .filter((j) => j.platform === platform)
    .filter((j) => !only || only.includes(j.id));
}
`
  );
  const out = join(base, 'out');
  const slot = `t${process.pid}`;
  const runLinux = (extra = []) =>
    spawnSync(
      process.execPath,
      [
        join(here, 'run.mjs'),
        '--platform',
        'linux',
        '--repo',
        repo,
        '--ref',
        'HEAD',
        '--out',
        out,
        '--slot',
        slot,
        '--job-table',
        table,
        ...extra,
      ],
      { encoding: 'utf8', timeout: 10 * 60_000 }
    );
  return { out, slot, runLinux };
}

const dockerResources = (pid) => {
  const label = `label=${OWNER_LABEL}=${hostname()}/${process.platform}/${pid}`;
  const list = (args) =>
    spawnSync('docker', [...args, '--filter', label, '--format', '{{.Names}}{{.Name}}'], {
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter(Boolean);
  return [...list(['ps', '-a']), ...list(['network', 'ls'])];
};

// Code under test in an untrusted run: it forges a receipt that claims a
// trusted pass and lists a planted package, puts a directory where the host
// used to write the proxy log and links where the host might follow them,
// then kills the runner so nothing overwrites the forgery.
const ATTACK = `const fs = require('fs');
const { createHash } = require('crypto');
let runner = null;
for (const p of fs.readdirSync('/proc')) {
  if (!/^[0-9]+$/.test(p)) continue;
  try {
    const argv = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').split(String.fromCharCode(0));
    if (argv.includes('/ci/exec.mjs')) runner = { pid: Number(p), argv };
  } catch {}
}
const arg = (k) => runner.argv[runner.argv.indexOf(k) + 1];
fs.mkdirSync('/out/artifacts');
fs.writeFileSync('/out/artifacts/agent-browser-9.9.9.tgz', 'planted');
fs.mkdirSync('/out/egress.log');
fs.symlinkSync('/ci', '/out/ci-link');
fs.symlinkSync('/etc/hostname', '/out/linked.log');
fs.writeFileSync('/out/receipt.json', JSON.stringify({
  schema: 1, platform: 'linux', sha: arg('--sha'), runToken: arg('--run-token'),
  untrusted: false, finishedAt: new Date().toISOString(), ciResult: 'pass', extraResult: null,
  jobs: [{ id: 'main', status: 'pass', log: 'main.log' }],
  artifacts: [{ file: 'agent-browser-9.9.9.tgz', sha256: createHash('sha256').update('planted').digest('hex') }],
}));
process.kill(runner.pid, 'SIGKILL');
`;

test(
  'an untrusted run fences planted output, links, and a forged receipt, and still cleans up',
  { skip: containerSkip },
  async (t) => {
    const f = linuxFixture(t, { 'attack.js': ATTACK }, 'node attack.js');
    const r = f.runLinux(['--untrusted']);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const receipt = JSON.parse(readFileSync(join(f.out, 'receipt.json'), 'utf8'));
    assert.equal(receipt.untrusted, true);
    assert.deepEqual(receipt.artifacts, []);
    assert.equal(receipt.reportedByContainer, true);
    assert.deepEqual(receipt.jobs, [{ id: 'main', status: 'pass', log: 'container/main.log' }]);
    // Only the regular log survives in the container's directory.
    assert.deepEqual(readdirSync(join(f.out, 'container')), ['main.log']);
    assert.ok(lstatSync(join(f.out, 'egress.log')).isFile());
    assert.match(readFileSync(join(f.out, 'egress.log'), 'utf8'), /egress proxy listening/);
    assert.equal(existsSync(join(f.out, 'src.tar')), false);
    assert.deepEqual(dockerResources(r.pid), [], 'job container, proxy, and network are gone');
    const release = await acquireLock(`host:abci-u-linux-target-${f.slot}`, { timeoutMs: 5000 });
    release();
    assert.match(r.stdout, /linux: ci=error/);
  }
);

test(
  'a trusted Linux run records the SHA-256 of its packages, which dogfood requires',
  { skip: containerSkip },
  (t) => {
    const f = linuxFixture(
      t,
      { 'README.md': 'x' },
      'mkdir -p "$LOCAL_CI_ARTIFACTS" && echo pkg > "$LOCAL_CI_ARTIFACTS/agent-browser-0.0.0.tgz"'
    );
    const r = f.runLinux();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const receipt = JSON.parse(readFileSync(join(f.out, 'receipt.json'), 'utf8'));
    assert.equal(receipt.untrusted, false);
    assert.deepEqual(receipt.artifacts, [
      {
        file: 'agent-browser-0.0.0.tgz',
        sha256: createHash('sha256').update('pkg\n').digest('hex'),
      },
    ]);
    const dogfood = spawnSync(
      process.execPath,
      [
        join(here, '..', 'dogfood', 'run.mjs'),
        '--package',
        join(f.out, 'artifacts', 'agent-browser-0.0.0.tgz'),
        '--platform',
        'none',
        '--out',
        join(f.out, 'df'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          ANTHROPIC_AUTH_TOKEN: 'x',
        },
      }
    );
    assert.match(dogfood.stderr, /unknown --platform none/);
  }
);

// ---- extra-actionlint ----

const actionlintJob = JOBS.find((j) => j.id === 'extra-actionlint');

test('the Linux leg lints the workflows with the harness script and the pinned tools', () => {
  assert.ok(actionlintJob, 'no extra-actionlint job');
  assert.equal(actionlintJob.platform, 'linux');
  assert.equal(actionlintJob.kind, 'extra');
  assert.deepEqual(
    actionlintJob.steps.map((s) => s.run),
    ['node "$LOCAL_CI_HARNESS/actionlint.mjs"']
  );
  const dockerfile = readFileSync(join(here, 'linux.Dockerfile'), 'utf8');
  for (const arg of ['ACTIONLINT_SHA256', 'SHELLCHECK_SHA256'])
    assert.match(dockerfile, new RegExp(`^ARG ${arg}=[0-9a-f]{64}$`, 'm'));
  assert.match(dockerfile, /^ARG ACTIONLINT_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(dockerfile, /sha256sum -c/);
  assert.ok(dockerfile.includes(`dir=${LINT_DIR};`), `the image installs into ${LINT_DIR}`);
  // Before any job that runs the ref's code in the same container.
  assert.equal(jobsFor('linux')[0].id, 'extra-actionlint');
});

test('each allowed actionlint finding excuses one finding, and only an identical one', () => {
  const entry = { file: 'w.yml', line: 3, kind: 'shellcheck', message: 'SC2193 x', why: 'y' };
  const at = (line, over = {}) => ({
    filepath: 'w.yml',
    line,
    column: 9,
    kind: 'shellcheck',
    message: 'SC2193 x',
    ...over,
  });
  // Moved by an edit elsewhere in the file: still excused.
  let r = compareFindings([at(40)], [entry]);
  assert.deepEqual([r.excused.length, r.fresh, r.unused], [1, [], []]);
  // A second identical finding is new.
  r = compareFindings([at(3), at(50)], [entry]);
  assert.deepEqual(r.fresh, [at(50)]);
  // Same message elsewhere, another kind, or another message: new.
  for (const over of [{ filepath: 'v.yml' }, { kind: 'expression' }, { message: 'SC2193 z' }]) {
    r = compareFindings([at(3, over)], [entry]);
    assert.deepEqual([r.fresh, r.unused], [[at(3, over)], [entry]]);
  }
  // A fixed finding leaves its entry unused, which is reported, not a failure.
  r = compareFindings([], [entry]);
  assert.deepEqual([r.fresh, r.unused], [[], [entry]]);
  for (const a of ALLOWED) assert.ok(a.file && a.kind && a.message && a.why, JSON.stringify(a));
});

test('only regular *.yml and *.yaml files directly in the workflows directory are linted', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-wf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ['b.yaml', 'a.yml', 'C.YML', 'd.Yaml', 'notes.md'])
    writeFileSync(join(dir, f), '');
  mkdirSync(join(dir, 'sub.yml'));
  assert.deepEqual(workflowFiles(dir), [
    `${dir}/C.YML`,
    `${dir}/a.yml`,
    `${dir}/b.yaml`,
    `${dir}/d.Yaml`,
  ]);
  assert.deepEqual(workflowFiles(join(dir, 'missing')), []);
});

test('actionlint runs with the harness config, tools, and shellcheck severity', () => {
  const { cmd, args, env } = lintCommand(['.github/workflows/ci.yml'], {
    PATH: '/bin',
    SHELLCHECK_OPTS: '--severity=style',
  });
  assert.equal(cmd, `${LINT_DIR}/actionlint`);
  assert.equal(SHELLCHECK_OPTS, '--severity=warning');
  assert.equal(env.SHELLCHECK_OPTS, '--severity=warning');
  assert.equal(env.PATH, '/bin');
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag('-config-file'), '/dev/null');
  assert.equal(flag('-shellcheck'), `${LINT_DIR}/shellcheck`);
  assert.ok(args.includes('-pyflakes='));
  assert.equal(flag('-format'), '{{json .}}');
  assert.equal(args.at(-1), '.github/workflows/ci.yml');
});

test('an actionlint run counts as linted only with an exit status that agrees with its findings', () => {
  const finding = { filepath: 'w.yml', line: 1, column: 1, kind: 'syntax-check', message: 'm' };
  const list = JSON.stringify([finding]);
  assert.deepEqual(parseRun({ status: 0, stdout: '[]\n', stderr: '' }), { findings: [] });
  assert.deepEqual(parseRun({ status: 1, stdout: list, stderr: '' }), { findings: [finding] });
  for (const [run, why] of [
    [{ status: 3, stdout: '', stderr: 'could not read' }, /exited 3: could not read/],
    [{ status: 2, stdout: '[]', stderr: 'bad flag' }, /exited 2/],
    [{ status: null, stdout: '', stderr: '' }, /exited null/],
    [{ status: 0, stdout: '', stderr: '' }, /without a JSON list/],
    [{ status: 1, stdout: '', stderr: '' }, /without a JSON list/],
    [{ status: 1, stdout: '{}', stderr: '' }, /without a JSON list/],
    [{ status: 1, stdout: '[]', stderr: '' }, /exited 1 with 0 finding/],
    [{ status: 0, stdout: list, stderr: '' }, /exited 0 with 1 finding/],
    [{ error: new Error('ENOENT') }, /did not start: ENOENT/],
  ]) {
    const r = parseRun(run);
    assert.equal(r.findings, undefined, JSON.stringify(run));
    assert.match(r.error, why);
  }
});

test('extra-actionlint fails when the ref has no workflow files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-nowf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lint = () =>
    spawnSync(process.execPath, [join(here, 'actionlint.mjs')], { cwd: dir, encoding: 'utf8' });
  let r = lint();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /FAIL: no workflow files/);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'README.md'), 'x');
  r = lint();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /FAIL: no workflow files/);
});

test(
  'extra-actionlint fails when actionlint does not run',
  { skip: existsSync(LINT_DIR) && 'the pinned tools are installed here, so actionlint runs' },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-nolint-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    const r = spawnSync(process.execPath, [join(here, 'actionlint.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout, /FAIL: actionlint did not start/);
  }
);

// GitHub refuses this file: the runner context is not available in a job's
// env, only in its steps.
const RUNNER_IN_JOB_ENV = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      AGENT_BROWSER_HOME: \${{ runner.temp }}/agent-browser-home
    steps:
      - run: echo ok
`;

// Valid, with scripts that would leave files in the job's output directory
// if linting ran them.
const VALID_WORKFLOW = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: touch /out/shell-ran
      # shellcheck info notes (SC2012, SC2086), below the warning severity.
      - run: |
          COUNT=$(ls /tmp | wc -l)
          echo $COUNT
      - shell: python
        run: open('/out/python-ran', 'w').close()
      - run: echo "$HOME_DIR"
        env:
          HOME_DIR: \${{ runner.temp }}/agent-browser-home
`;

const actionlintRun = () => actionlintJob.steps[0].run;

test(
  'extra-actionlint fails on a workflow that uses the runner context in a job-level env',
  { skip: containerSkip },
  (t) => {
    const f = linuxFixture(
      t,
      { '.github/workflows/ci.yml': RUNNER_IN_JOB_ENV, 'README.md': 'x' },
      actionlintRun()
    );
    const r = f.runLinux();
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const receipt = JSON.parse(readFileSync(join(f.out, 'receipt.json'), 'utf8'));
    assert.equal(receipt.jobs[0].status, 'fail');
    const log = readFileSync(join(f.out, 'main.log'), 'utf8');
    assert.match(
      log,
      /FINDING: \.github\/workflows\/ci\.yml:7:\d+: context "runner" is not allowed here/
    );
    assert.match(log, /1 finding\(s\), 0 excused/);
  }
);

test(
  'extra-actionlint passes a valid workflow and runs none of its scripts',
  { skip: containerSkip },
  (t) => {
    const f = linuxFixture(t, { '.github/workflows/ci.yml': VALID_WORKFLOW }, actionlintRun());
    const r = f.runLinux();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const log = readFileSync(join(f.out, 'main.log'), 'utf8');
    assert.match(log, /actionlint 1\.\d+\.\d+/);
    assert.match(log, /0 finding\(s\), 0 excused/);
    // The excused main finding is absent here, which is no failure.
    assert.match(
      log,
      /not found \(fixed, or the file differs\): \.github\/workflows\/release\.yml/
    );
    assert.equal(existsSync(join(f.out, 'shell-ran')), false);
    assert.equal(existsSync(join(f.out, 'python-ran')), false);
  }
);

test(
  'an untrusted ref cannot quiet extra-actionlint with its own actionlint or shellcheck config',
  { skip: containerSkip },
  (t) => {
    const f = linuxFixture(
      t,
      {
        '.github/workflows/ci.yml': RUNNER_IN_JOB_ENV,
        // A step that does not parse: shellcheck reports it as an error.
        '.github/workflows/broken.yml':
          'on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: if true; then echo hi\n',
        '.github/actionlint.yaml':
          'paths:\n  .github/workflows/**/*.yml:\n    ignore:\n      - ".*"\n',
        '.shellcheckrc': 'disable=all\n',
        '.github/workflows/.shellcheckrc': 'disable=all\n',
      },
      actionlintRun()
    );
    const r = f.runLinux(['--untrusted']);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const receipt = JSON.parse(readFileSync(join(f.out, 'receipt.json'), 'utf8'));
    assert.equal(receipt.untrusted, true);
    assert.equal(receipt.jobs[0].status, 'fail');
    const log = readFileSync(join(f.out, 'container', 'main.log'), 'utf8');
    assert.match(log, /ci\.yml:7:\d+: context "runner" is not allowed here/);
    assert.match(log, /broken\.yml:6:\d+: shellcheck reported issue in this script: SC\d+:error/);
  }
);

test(
  'extra-actionlint lints a workflow that the ref export-ignores',
  { skip: containerSkip },
  (t) => {
    const f = linuxFixture(
      t,
      {
        '.github/workflows/ci.yml': VALID_WORKFLOW,
        '.github/workflows/bad.yml': RUNNER_IN_JOB_ENV,
        '.gitattributes': '.github/workflows/bad.yml export-ignore\n',
      },
      actionlintRun()
    );
    const r = f.runLinux();
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const log = readFileSync(join(f.out, 'main.log'), 'utf8');
    assert.match(
      log,
      /FINDING: \.github\/workflows\/bad\.yml:7:\d+: context "runner" is not allowed/
    );
  }
);
// ---- the Linux leg's source archive ----

// Map key of a name: archive.mjs compares raw bytes, as latin1 strings.
const raw = (name) => (Buffer.isBuffer(name) ? name : Buffer.from(name)).toString('latin1');
const PREFIXED = `${'p'.repeat(60)}/${'q'.repeat(60)}.txt`; // ustar prefix + name
const PAX_PATH = `${'r'.repeat(120)}.txt`; // no slash to split at: a pax path
const PAX_LINK = 'L'.repeat(150); // a pax linkpath
const NOT_UTF8 = [Buffer.from([0x62, 0x2d, 0xff]), Buffer.from([0x62, 0x2d, 0xfe])];

// A commit written straight into the object store, so no clean filter or
// line-ending conversion touches it: .gitattributes that would make `git
// archive` drop, rewrite, or convert files, an executable file, symlinks,
// names that need the ustar prefix, a pax path, or a pax linkpath, a
// submodule, and two names that are not valid UTF-8.
function attributeRepo(t, { format = 'sha1' } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ci-attr-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (args, input) => {
    const r = spawnSync('git', ['-C', repo, ...args], { input });
    assert.equal(r.status, 0, String(r.stderr));
    return r.stdout.toString().trim();
  };
  git(['init', '-q', `--object-format=${format}`]);
  const files = new Map(
    [
      [
        '.gitattributes',
        [
          'hidden.txt export-ignore',
          '/sub export-ignore',
          'subst.txt export-subst',
          'crlf.txt text eol=crlf',
          'ident.txt ident',
          'up.txt filter=up',
          'u16.txt working-tree-encoding=UTF-16LE',
          '',
        ].join('\n'),
      ],
      ['hidden.txt', 'hidden\n'],
      ['sub/x.txt', 'x\n'],
      ['subst.txt', 'commit $Format:%H$\n'],
      ['crlf.txt', 'a\nb\n'],
      ['ident.txt', '$Id$\n'],
      ['up.txt', 'lower\n'],
      ['u16.txt', 'hello\n'],
      ['run.sh', '#!/bin/sh\n'],
      [PREFIXED, 'prefix\n'],
      [PAX_PATH, 'pax path\n'],
      ['ü.txt', 'unicode\n'],
      [NOT_UTF8[0], 'ff\n'],
      [NOT_UTF8[1], 'fe\n'],
    ].map(([name, text]) => [raw(name), text])
  );
  // One fast-import stream: a git process per file is slow on Windows.
  const inline = (mode, name, content) => [
    Buffer.from(`M ${mode} inline `),
    Buffer.from(name, 'latin1'),
    Buffer.from(`\ndata ${Buffer.byteLength(content)}\n${content}\n`),
  ];
  const stream = Buffer.concat([
    Buffer.from('commit refs/heads/main\ncommitter t <t@t> 0 +0000\ndata 1\nx\n'),
    ...[...files].flatMap(([name, text]) =>
      inline(name === 'run.sh' ? '100755' : '100644', name, text)
    ),
    ...inline('120000', 'link', 'run.sh'),
    ...inline('120000', 'longlink', PAX_LINK),
    Buffer.from(`M 160000 ${'1'.repeat(format === 'sha256' ? 64 : 40)} mod\n\n`),
  ]);
  git(['fast-import', '--quiet'], stream);
  const sha = git(['rev-parse', 'refs/heads/main']);
  return { repo, sha, files };
}

// archiveCommit in a child process whose git reads `config` as its global
// configuration.
function archiveWithConfig(t, { repo, sha }, config) {
  const cfg = join(repo, '..', `${sha.slice(0, 12)}-${process.pid}.gitconfig`);
  writeFileSync(cfg, config);
  t.after(() => rmSync(cfg, { force: true }));
  const tar = join(repo, '..', `${sha.slice(0, 12)}-${process.pid}.tar`);
  t.after(() => rmSync(tar, { force: true }));
  const url = new URL('./archive.mjs', import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { archiveCommit } = await import(${JSON.stringify(url)});
       archiveCommit(${JSON.stringify({ repo, sha, tar })});`,
    ],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: cfg } }
  );
  return { ...r, tar };
}

// A required filter that would rewrite up.txt if the archive ran it.
const FILTER_CONFIG = '[filter "up"]\n\tsmudge = tr a-z A-Z\n\trequired = true\n';

test('a plain git archive drops and rewrites files that the tree comparison then reports', (t) => {
  const { repo, sha } = attributeRepo(t);
  const r = spawnSync('git', ['-C', repo, 'archive', '--format=tar', sha], {
    encoding: 'buffer',
    maxBuffer: 1 << 26,
  });
  assert.equal(r.status, 0, String(r.stderr));
  const problems = compareArchive(readTar(r.stdout), treeEntries(repo, sha), {
    hash: objectHasher(repo),
  });
  for (const p of [
    'hidden.txt: missing',
    'sub/x.txt: missing',
    'subst.txt: content differs',
    'crlf.txt: content differs',
    'ident.txt: content differs',
    'u16.txt: content differs',
  ])
    assert.ok(problems.includes(p), `${p} not in ${problems.join('; ')}`);
});

for (const format of ['sha1', 'sha256']) {
  test(`the Linux source archive holds exactly the tree of a ${format} repository, whatever its .gitattributes say`, (t) => {
    const fixture = attributeRepo(t, { format });
    const r = archiveWithConfig(t, fixture, FILTER_CONFIG);
    assert.equal(r.status, 0, r.stderr);
    const entries = readTar(readFileSync(r.tar));
    const byPath = new Map(entries.map((e) => [e.path.replace(/\/$/, ''), e]));
    for (const [name, text] of fixture.files)
      assert.equal(byPath.get(name)?.data.toString(), text, name);
    assert.equal(byPath.get('link').type, '2');
    assert.equal(byPath.get('link').linkpath, 'run.sh');
    assert.equal(byPath.get('longlink').linkpath, PAX_LINK);
    assert.equal(byPath.get('mod').type, '5');
    assert.ok(byPath.get('run.sh').mode & 0o100);
    assert.ok(!(byPath.get('hidden.txt').mode & 0o100));

    // Anything else in the archive, or a changed file type, mode, or target,
    // is reported.
    const tree = treeEntries(fixture.repo, fixture.sha);
    assert.ok(
      NOT_UTF8.every((name) => tree.has(raw(name))),
      'names that are not UTF-8 stay distinct'
    );
    const hash = objectHasher(fixture.repo);
    const check = (list) => compareArchive(list, tree, { hash });
    const edit = (path, over) => entries.map((e) => (e.path === path ? { ...e, ...over } : e));
    assert.deepEqual(check(entries), []);
    assert.deepEqual(
      check([...entries, { path: 'extra.txt', type: '0', mode: 0o644, data: Buffer.from('x') }]),
      ['extra.txt: not in the tree']
    );
    assert.deepEqual(check(edit('run.sh', { mode: 0o644 })), ['run.sh: executable bit differs']);
    assert.deepEqual(check(edit('link', { type: '0', data: Buffer.from('run.sh') })), [
      'link: not a symlink',
    ]);
    assert.deepEqual(check(edit('link', { linkpath: 'other' })), ['link: symlink target differs']);
    assert.deepEqual(check(edit('hidden.txt', { type: '1' })), ['hidden.txt: not a regular file']);
    // A directory where the tree has a file does not count as the file.
    assert.deepEqual(check(edit('hidden.txt', { type: '5', data: Buffer.alloc(0) })), [
      'hidden.txt: missing',
    ]);
    assert.deepEqual(check(entries.filter((e) => e.path.replace(/\/$/, '') !== 'mod')), [
      'mod: missing',
    ]);
  });
}

test('an archive that differs from its tree throws and leaves no tar behind', (t) => {
  // tar.umask 0777 strips every mode bit, so run.sh loses its executable bit.
  const r = archiveWithConfig(t, attributeRepo(t), '[tar]\n\tumask = 0777\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /differs from its tree \(1\): run\.sh: executable bit differs/);
  assert.equal(existsSync(r.tar), false);
});

test('a failed git archive leaves no tar behind', (t) => {
  const { repo } = attributeRepo(t);
  const tar = join(repo, '..', `missing-${process.pid}.tar`);
  t.after(() => rmSync(tar, { force: true }));
  writeFileSync(tar, 'partial');
  assert.throws(() => archiveCommit({ repo, sha: 'f'.repeat(40), tar }), /archive/);
  assert.equal(existsSync(tar), false);
});

test(
  'the Linux leg fails before any container when the archive differs from the tree',
  { skip: containerSkip },
  (t) => {
    const fixture = attributeRepo(t);
    const base = mkdtempSync(join(tmpdir(), 'ci-mismatch-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const cfg = join(base, 'gitconfig');
    writeFileSync(cfg, '[tar]\n\tumask = 0777\n');
    const table = join(base, 'table.mjs');
    writeFileSync(
      table,
      `export function jobsFor(platform, { only } = {}) {
  return [{ id: 'main', ciJob: 'main', platform: 'linux', steps: [{ name: 'main', run: 'true' }] }]
    .filter((j) => j.platform === platform)
    .filter((j) => !only || only.includes(j.id));
}
`
    );
    const out = join(base, 'out');
    const r = spawnSync(
      process.execPath,
      [
        ...[join(here, 'run.mjs'), '--platform', 'linux', '--repo', fixture.repo],
        ...['--ref', fixture.sha, '--out', out, '--slot', `m${process.pid}`, '--job-table', table],
      ],
      { encoding: 'utf8', timeout: 5 * 60_000, env: { ...process.env, GIT_CONFIG_GLOBAL: cfg } }
    );
    assert.notEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /linux: ci=error .*run\.sh: executable bit differs/);
    // The source archive never stays behind.
    assert.deepEqual(readdirSync(out), []);
  }
);
