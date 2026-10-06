// Keeps the local CI job table in step with .github/workflows/ci.yml: every
// workflow job and matrix leg must have a local counterpart.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CI_YML_SHA256, JOBS } from './jobs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    const runsCode = job.usesRealHome || job.steps.some((s) => /cargo test|cargo\(.test/.test(s.run) || /\btest --profile/.test(s.run));
    if (runsCode) assert.equal(job.writesProfile, true, `${job.id} runs tests or the real CLI but lacks writesProfile`);
  }
});
