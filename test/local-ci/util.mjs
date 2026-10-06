// Small helpers shared by the local CI and dogfood entry points.

import { spawn } from 'node:child_process';

// Detect a dropped connection instead of waiting on it forever.
export const SSH_OPTS = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4'];

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
    'export GIT_TERMINAL_PROMPT=0',
    ...setup.map((s) => `${s} || exit $?`),
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
