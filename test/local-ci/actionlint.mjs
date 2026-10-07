#!/usr/bin/env node
// The extra-actionlint job (jobs.mjs): lints every workflow file of the ref
// under test with the actionlint and shellcheck that linux.Dockerfile pins,
// and fails on any finding that ALLOWED does not excuse. Runs in the job's
// source directory.
//
// The ref supplies only the files it lints. The configuration is the
// harness's: an empty actionlint config, so a .github/actionlint.yaml in the
// ref cannot ignore findings; actionlint starts shellcheck with --norc, so a
// .shellcheckrc in the ref has no effect; and pyflakes is off. actionlint has
// no inline ignore comments, so its own findings (the ones that make GitHub
// refuse a workflow) cannot be hidden by the ref. A `# shellcheck disable=`
// directive inside a run: script still applies, as everywhere, and hides
// shellcheck findings in that script, parse errors included. actionlint and
// shellcheck parse the workflows and the scripts in them, and run none of it.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LINT_DIR = '/opt/local-ci-lint';
const WORKFLOWS = '.github/workflows';

// shellcheck at its default severity also reports info and style notes
// (quoting that cannot matter, `ls | wc -l`), which would bury the warnings
// and errors that mean a step misbehaves or does not parse.
export const SHELLCHECK_OPTS = '--severity=warning';

// Findings on origin/main (b9d482f0) when this job was added. Each entry
// excuses one finding with the same file, kind, and message, so a second
// identical finding still fails the job. `line` is where the finding was at
// that revision, for people; it is not matched, so edits elsewhere in the
// file do not turn an excused finding into a new one. An entry that matches
// nothing is reported and does not fail the job, because a ref that fixes a
// finding is better, not worse. Remove the entry when the workflow is fixed.
export const ALLOWED = [
  {
    file: '.github/workflows/release.yml',
    line: 207,
    kind: 'shellcheck',
    message:
      'shellcheck reported issue in this script: SC2193:warning:2:35: The arguments to this comparison can never be equal. Make sure your syntax is correct',
    why: 'False positive in "Copy binary": actionlint hands shellcheck a placeholder for ${{ matrix.rust_target }}, so [[ "<placeholder>" == *"windows"* ]] looks constant.',
  },
];

/** Splits actionlint findings into excused ones, new ones, and unused entries. */
export function compareFindings(findings, allowed = ALLOWED) {
  const unused = [...allowed];
  const excused = [];
  const fresh = [];
  for (const f of findings) {
    const i = unused.findIndex(
      (a) => a.file === f.filepath && a.kind === f.kind && a.message === f.message
    );
    if (i === -1) fresh.push(f);
    else excused.push({ finding: f, entry: unused.splice(i, 1)[0] });
  }
  return { excused, fresh, unused };
}

/**
 * The workflow files GitHub reads: regular *.yml and *.yaml files directly in
 * dir. The extension matches in any case, so a file is linted rather than
 * skipped when it is unclear whether GitHub reads it.
 */
export function workflowFiles(dir = WORKFLOWS) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => `${dir}/${e.name}`)
    .sort();
}

/** The actionlint invocation: the harness's config, tools, and shellcheck severity. */
export function lintCommand(files, env = process.env) {
  return {
    cmd: `${LINT_DIR}/actionlint`,
    args: [
      '-config-file',
      '/dev/null',
      '-shellcheck',
      `${LINT_DIR}/shellcheck`,
      '-pyflakes=',
      '-format',
      '{{json .}}',
      ...files,
    ],
    env: { ...env, SHELLCHECK_OPTS },
  };
}

/**
 * The findings of an actionlint run, or why it did not lint. Exit 0 must come
 * with an empty JSON list and exit 1 with a non-empty one; any other exit
 * (3 is a fatal error, with nothing on stdout) or output is a failure, never
 * "no findings".
 */
export function parseRun({ status, stdout, stderr, error }) {
  if (error) return { error: `actionlint did not start: ${error.message}` };
  if (status !== 0 && status !== 1)
    return { error: `actionlint exited ${status}: ${String(stderr).trim()}` };
  let findings;
  try {
    findings = JSON.parse(stdout);
  } catch {
    findings = null;
  }
  if (!Array.isArray(findings))
    return { error: `actionlint exited ${status} without a JSON list of findings: ${stdout}` };
  if ((status === 1) !== findings.length > 0)
    return { error: `actionlint exited ${status} with ${findings.length} finding(s)` };
  return { findings };
}

function main() {
  const files = workflowFiles();
  if (files.length === 0) {
    // A ref of this repository always has workflows; none means the directory
    // went missing, which must not pass as clean.
    console.log(`FAIL: no workflow files (*.yml, *.yaml) in ${WORKFLOWS}`);
    return 1;
  }
  const { cmd, args, env } = lintCommand(files);
  const version = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
  console.log(`actionlint ${version.stdout?.split('\n')[0]}, shellcheck ${SHELLCHECK_OPTS}`);
  console.log(`linting ${files.join(', ')}`);
  const run = parseRun(spawnSync(cmd, args, { encoding: 'utf8', env }));
  if (run.error) {
    console.log(`FAIL: ${run.error}`);
    return 2;
  }
  const { excused, fresh, unused } = compareFindings(run.findings);
  const show = (f) => `${f.filepath}:${f.line}:${f.column}: ${f.message} [${f.kind}]`;
  for (const { finding, entry } of excused)
    console.log(`excused: ${show(finding)}\n  ${entry.why}`);
  for (const e of unused)
    console.log(`not found (fixed, or the file differs): ${e.file}:${e.line} ${e.message}`);
  for (const f of fresh) console.log(`FINDING: ${show(f)}\n${f.snippet}`);
  console.log(
    `${fresh.length} finding(s), ${excused.length} excused by ALLOWED in test/local-ci/actionlint.mjs`
  );
  return fresh.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main());
