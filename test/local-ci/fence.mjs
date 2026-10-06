// Output fence for --untrusted Linux runs.
//
// Code under test runs as root in the job container and can leave anything in
// the directory mounted as its output: links that would lead a host write
// elsewhere, directories in place of files, packages, or a receipt claiming
// the run was trusted. The host therefore never reads or writes that
// directory itself. Once the job container has exited, a second container,
// where a planted link can only lead inside that container, keeps the regular
// *.log files, hands back the receipt's text as data, and deletes everything
// else. The host then writes its own receipt next to the directory, marked
// untrusted, with no artifacts.
//
// Run as a script (`node fence.mjs <dir> [uid:gid]`), it is the second
// container's side.

import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The output directory's name, next to the host's receipt. */
export const CONTAINER_DIR = 'container';
const LOG = /^[A-Za-z0-9._-]+\.log$/;
const MAX_RECEIPT = 4 << 20;
// Fields of the container's receipt that the host copies, as reported data.
const REPORTED = [
  'schema',
  'platform',
  'sha',
  'runToken',
  'harness',
  'host',
  'startedAt',
  'finishedAt',
  'toolchain',
  'chrome',
  'ciResult',
  'extraResult',
  'jobs',
];

/**
 * Fences `dir` (the job container's output) in a throwaway container from
 * `image`. Returns the text of the receipt the job container left, or null.
 * Throws when the fence did not run to the end.
 */
export function fenceUntrustedOutput({ dir, image, ciDir, labels = [] }) {
  const owner =
    typeof process.getuid === 'function' ? [`${process.getuid()}:${process.getgid()}`] : [];
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      ...labels,
      '-v',
      `${dir}:/out`,
      '-v',
      `${ciDir}:/ci:ro`,
      image,
      'node',
      '/ci/fence.mjs',
      '/out',
      ...owner,
    ],
    { encoding: 'utf8', maxBuffer: 2 * MAX_RECEIPT }
  );
  if (r.status !== 0)
    throw new Error(`fence container exited ${r.status}: ${`${r.stderr}`.trim()}`);
  const line = `${r.stdout}`.trim().split('\n').at(-1);
  return JSON.parse(line).receipt;
}

/**
 * The host's receipt for an untrusted leg: what the job container reported
 * (`text`, possibly null or not JSON), marked untrusted, with log paths
 * pointing into the output directory and no artifacts.
 */
export function untrustedReceipt(text, { ref }) {
  let reported = null;
  try {
    reported = JSON.parse(text);
  } catch {}
  if (!reported || typeof reported !== 'object' || Array.isArray(reported)) reported = null;
  const receipt = { schema: 1, platform: 'linux', ref };
  for (const k of REPORTED) if (reported && k in reported) receipt[k] = reported[k];
  receipt.jobs = Array.isArray(receipt.jobs)
    ? receipt.jobs
        .filter((j) => j && typeof j === 'object' && !Array.isArray(j))
        .map((j) => ({ ...j, log: typeof j.log === 'string' ? `${CONTAINER_DIR}/${j.log}` : null }))
    : [];
  receipt.untrusted = true;
  receipt.reportedByContainer = reported !== null;
  receipt.artifacts = [];
  return receipt;
}

function fence(dir, owner) {
  let receipt = null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (name === 'receipt.json' && st.isFile() && st.size <= MAX_RECEIPT)
      receipt = readFileSync(p, 'utf8');
    if (st.isFile() && LOG.test(name)) {
      chmodSync(p, 0o644);
      if (owner) chownSync(p, owner[0], owner[1]);
    } else rmSync(p, { recursive: true, force: true });
  }
  chmodSync(dir, 0o755);
  if (owner) chownSync(dir, owner[0], owner[1]);
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, owner] = process.argv.slice(2);
  const receipt = fence(dir, owner ? owner.split(':').map(Number) : null);
  console.log(JSON.stringify({ receipt }));
}
