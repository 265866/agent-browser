// Small helpers shared by the local CI and dogfood entry points.

import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { isAlive } from './isolation.mjs';

// Detect a dropped connection instead of waiting on it forever, and fail
// instead of prompting for a password or host key.
export const SSH_OPTS = [
  '-o',
  'ServerAliveInterval=30',
  '-o',
  'ServerAliveCountMax=4',
  '-o',
  'BatchMode=yes',
];

// A login shell finds the toolchain; an interactive one would also read
// ~/.zshrc, which may prompt (plugin updates) and hang an unattended run.
export const remoteShell = (cmd) => `zsh -lc ${shq(cmd)}`;

export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function dockerPath(p) {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

// Children started through stream(); signal handlers stop them so an
// interrupted run leaves nothing behind.
export const liveChildren = new Set();

/** Runs a command, prefixing each output line with `[label]`. Resolves to its exit code. */
export function stream(cmd, args, label) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    liveChildren.add(child);
    const pipe = (src, dst) =>
      src.on('data', (d) =>
        dst.write(
          String(d)
            .replace(/\r/g, '')
            .replace(/^(?=.)/gm, `[${label}] `)
        )
      );
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('error', (e) => {
      liveChildren.delete(child);
      console.error(`[${label}] ${e.message}`);
      res(127);
    });
    // Exit, not close: a leaked daemon can hold inherited pipe handles open.
    child.on('exit', (code) => {
      liveChildren.delete(child);
      setTimeout(() => res(code ?? 1), 2000);
    });
  });
}

/**
 * Builds the zsh script for a remote run over `ssh -tt`. A hangup reaches
 * only the session leader (zsh), so the script runs node in the background
 * and forwards SIGHUP/SIGINT/SIGTERM to it as SIGTERM, waits for node's own
 * cleanup, then removes `onSignal` paths. `always` paths are removed on
 * every exit; results that the caller copies back belong in `onSignal` only.
 */
export function supervisedRemoteScript({ setup = [], command, always = [], onSignal = [] }) {
  const rm = (paths) => (paths.length ? `rm -rf ${paths.join(' ')}` : 'true');
  return [
    // A missing credential fails instead of waiting on a prompt nobody sees.
    'export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=false GIT_ASKPASS= SSH_ASKPASS=',
    "export GIT_SSH_COMMAND='ssh -o BatchMode=yes'",
    // Setup runs in the foreground, so a plain trap covers it.
    `trap '${rm([...always, ...onSignal])}; exit 130' HUP INT TERM`,
    ...setup.map((s) => `${s} || { rc=$?; ${rm(always)}; exit $rc; }`),
    `${command} &`,
    'p=$!',
    `trap 'kill -TERM $p 2>/dev/null; wait $p; ${rm([...always, ...onSignal])}; exit 130' HUP INT TERM`,
    'wait $p; rc=$?',
    rm(always),
    'exit $rc',
  ].join('\n');
}

/**
 * Runs `cleanup` once on SIGINT, SIGTERM, or SIGHUP, then exits with 130.
 * Cleanup may be async; a second signal exits immediately.
 */
export function onInterrupt(cleanup) {
  let started = false;
  const handler = async (signal) => {
    if (started) process.exit(130);
    started = true;
    console.error(`received ${signal}; cleaning up`);
    try {
      await cleanup(signal);
    } catch (err) {
      console.error(`cleanup failed: ${err.message}`);
    }
    process.exit(130);
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, handler);
}

/**
 * Judges one platform leg from its exit code and the receipt it left. A
 * receipt counts only when it belongs to this run (same commit and run
 * token), so a receipt left in a reused --out directory, or none at all
 * because the runner died before writing one, makes the leg an error.
 * ciResult is null when the leg ran no ci.yml jobs (only extra checks).
 */
export function legOutcome({ receipt, code, error = null, sha, runToken }) {
  const fresh = Boolean(receipt) && receipt.sha === sha && receipt.runToken === runToken;
  const finished = !error && fresh && Boolean(receipt.finishedAt) && (code === 0 || code === 1);
  return {
    ciResult: finished ? (receipt.ciResult ?? null) : 'error',
    extraResult: finished ? (receipt.extraResult ?? null) : null,
    jobs: fresh ? (receipt.jobs ?? []) : [],
    error:
      error ??
      (receipt && !fresh
        ? 'receipt.json is not from this run'
        : !receipt
          ? `no receipt (exit ${code})`
          : null),
  };
}

/**
 * Combines legs into one verdict. Skipped legs (no selected jobs on that
 * platform) do not count. The exit code is 0 only when every selected job of
 * every leg passed.
 */
export function summarize(legs) {
  const ran = legs.filter((l) => !l.skipped);
  const verdict = (key, bad) =>
    ran.some((l) => bad.includes(l[key]))
      ? 'fail'
      : ran.some((l) => l[key] === 'pass')
        ? 'pass'
        : null;
  const ciResult = verdict('ciResult', ['fail', 'error']);
  const extraResult = verdict('extraResult', ['fail', 'error']);
  const ok =
    ran.length > 0 &&
    ciResult !== 'fail' &&
    extraResult !== 'fail' &&
    (ciResult === 'pass' || extraResult === 'pass');
  return { ciResult, extraResult, exitCode: ok ? 0 : 1 };
}

// Docker resources a run creates carry this label with "<host>/<platform>/<pid>"
// of the run that owns them. A run killed outright (TerminateProcess skips
// every handler) leaves its --rm container running; the next run removes it.
export const OWNER_LABEL = 'agent-browser-harness.owner';

export function ownerLabelArgs() {
  return ['--label', `${OWNER_LABEL}=${hostname()}/${process.platform}/${process.pid}`];
}

/**
 * Removes labeled containers and networks whose owner process on this host is
 * gone. Owners on other hosts, or in another pid namespace (WSL), are left
 * alone. Returns a log of what was removed.
 */
export function sweepDeadDocker() {
  const lines = [];
  const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });
  // Containers first: a network cannot be removed while one is attached.
  for (const [list, name, remove] of [
    [['ps', '-a'], '{{.Names}}', ['rm', '-f']],
    [['network', 'ls'], '{{.Name}}', ['network', 'rm']],
  ]) {
    const r = docker([
      ...list,
      '--filter',
      `label=${OWNER_LABEL}`,
      '--format',
      `${name} {{.Label "${OWNER_LABEL}"}}`,
    ]);
    for (const line of (r.stdout ?? '').split('\n')) {
      const [resource, owner] = line.trim().split(' ');
      const m = owner?.match(/^(.+)\/([a-z0-9]+)\/(\d+)$/);
      if (!m || m[1] !== hostname() || m[2] !== process.platform || isAlive(Number(m[3]))) continue;
      const x = docker([...remove, resource]);
      lines.push(
        x.status === 0
          ? `removed ${resource} (owner pid ${m[3]} is gone)`
          : `could not remove ${resource}: ${x.stderr.trim()}`
      );
    }
  }
  return lines.join('\n');
}
