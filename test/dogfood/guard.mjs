// Fences the dogfood model in before anything runs, at two layers:
//
// - A PreToolUse hook (in the settings file passed to `claude --settings`)
//   rejects Bash commands that try to attach to an existing browser, use a
//   file:// URL, or name a path outside the scenario's working directory, and
//   file tool calls whose path is outside that directory.
// - A wrapper named `agent-browser`, first on PATH in place of the candidate,
//   checks the final argv (after the shell expanded variables such as $HOME)
//   and the agent-browser environment, then runs the real binary.
//
// Both log what they block to a file the model cannot reach. The transcript
// audit in run.mjs stays as a third line.
//
//   node guard.mjs exec <config.json> [agent-browser args...]   (the wrapper)
//   node guard.mjs hook <config.json>                           (the hook)

import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';

// Ways the candidate could attach to a browser the harness did not start, or
// load a config that does. The transcript audit uses this pattern too.
export const ATTACH_PATTERN =
  /--auto-connect|--cdp\b|--profile\b|--config\b|agent-browser\b[^|;&\n]*\sconnect\b|AGENT_BROWSER_(CDP|AUTO_CONNECT|PROFILE|CONFIG)/;
const ATTACH_FLAG = /(?:^|[\s"'=,])--(?:cdp|auto-connect|profile|config)(?=$|[\s"'=,])/;
const ATTACH_VARS = /^AGENT_BROWSER_(?:CDP|AUTO_CONNECT|PROFILE|CONFIG)$/i;
const FILE_URL = /file:/i;
const DELIMS = /[\s"'=,;|&<>()`]+/;
// Shell variables that expand to directories outside the scenario.
const DIR_VARS =
  /\$\{?(?:HOME|USERPROFILE|TMPDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|OLDPWD|PWD)\b|%[A-Za-z_]+%/;

const norm = (p) => {
  const r = resolve(p).replace(/[\\/]+$/, '');
  return isWin ? r.toLowerCase() : r;
};

/** True when `p` (absolute, or relative to `cwd`) is `dir` or inside it. */
export function isInside(dir, p, cwd = dir) {
  let mapped = p;
  // Git Bash spells D:\x as /d/x.
  if (isWin) mapped = mapped.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
  const d = norm(dir);
  const x = norm(resolve(cwd, mapped));
  return x === d || x.startsWith(`${d}${sep}`);
}

/** Path-like tokens in `text` that resolve outside `work`. */
export function outsidePaths(text, { work, cwd = work }) {
  const bad = [];
  for (const token of String(text).split(DELIMS)) {
    if (!token) continue;
    const absolute =
      /^\/[A-Za-z0-9._~$-]/.test(token) ||
      /^[A-Za-z]:[\\/]/.test(token) ||
      /^[\\/]{2}/.test(token) ||
      (isWin && /^\\[^\\]/.test(token));
    const home = /^~[A-Za-z0-9._-]*(?:[\\/]|$)/.test(token) && token !== '~';
    const parent = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(token);
    if (home) bad.push(token);
    else if ((absolute || parent) && !isInside(work, token, cwd)) bad.push(token);
  }
  return bad;
}

// The first words that could be the subcommand: a bare word right after a
// flag may be that flag's value, so the next bare word is a candidate too.
function subcommandCandidates(args) {
  const out = [];
  let afterFlag = false;
  for (const a of args) {
    if (a.startsWith('-')) {
      afterFlag = !a.includes('=');
      continue;
    }
    out.push(a);
    if (!afterFlag) break;
    afterFlag = false;
  }
  return out;
}

/** Problems with one agent-browser invocation, as `{ kind, detail }`. */
export function checkArgs(args, { work, cwd = work, env = {}, expectedEnv = {} }) {
  const problems = [];
  const sub = subcommandCandidates(args);
  if (sub.includes('connect'))
    problems.push({ kind: 'attach', detail: 'the connect command attaches to a running browser' });
  const batch = sub.includes('batch');
  for (const a of args) {
    if (ATTACH_FLAG.test(a))
      problems.push({ kind: 'attach', detail: `${a} selects an existing browser or config` });
    if (batch && /^\s*connect(?:\s|$)/.test(a))
      problems.push({
        kind: 'attach',
        detail: `batch command "${a}" attaches to a running browser`,
      });
    if (FILE_URL.test(a)) problems.push({ kind: 'file-url', detail: a });
    for (const p of outsidePaths(a, { work, cwd }))
      problems.push({ kind: 'path', detail: `${p} is outside the working directory` });
  }
  // The harness's own settings (socket dir, namespace, config, browser,
  // downloads) must stay as set: changing them can reach another daemon or
  // load another config. Other variables, such as AGENT_BROWSER_SESSION,
  // which the core skill recommends exporting, are the model's to set, as
  // long as they do not attach or name a path outside the working directory.
  for (const k of Object.keys(expectedEnv))
    if (env[k] !== expectedEnv[k])
      problems.push({ kind: 'attach', detail: `${k} differs from the harness setting` });
  for (const [k, v] of Object.entries(env)) {
    if (!/^AGENT_BROWSER_/i.test(k) || k in expectedEnv) continue;
    if (ATTACH_VARS.test(k))
      problems.push({ kind: 'attach', detail: `${k} selects an existing browser or config` });
    if (FILE_URL.test(v)) problems.push({ kind: 'file-url', detail: `${k}=${v}` });
    for (const p of outsidePaths(v, { work, cwd }))
      problems.push({ kind: 'path', detail: `${k}: ${p} is outside the working directory` });
  }
  return problems;
}

/** Problems with a Bash command line, checked as text before it runs. */
export function checkCommand(command, { work, cwd = work }) {
  const problems = [];
  if (ATTACH_PATTERN.test(command))
    problems.push({ kind: 'attach', detail: 'attaching to an existing browser is not allowed' });
  if (FILE_URL.test(command))
    problems.push({ kind: 'file-url', detail: 'file: URLs are not allowed' });
  if (DIR_VARS.test(command))
    problems.push({
      kind: 'path',
      detail: 'variables naming directories outside the working directory',
    });
  for (const p of outsidePaths(command, { work, cwd }))
    problems.push({ kind: 'path', detail: `${p} is outside the working directory` });
  return problems;
}

const PATH_FIELDS = ['file_path', 'path', 'notebook_path'];

/** Problems with a non-Bash tool call: every path it names stays in `work`. */
export function checkToolInput(tool, input, { work, cwd = work }) {
  if (tool === 'Bash') return checkCommand(String(input?.command ?? ''), { work, cwd });
  const problems = [];
  const paths = PATH_FIELDS.map((f) => input?.[f]).filter((v) => typeof v === 'string' && v);
  if (tool === 'Glob' && typeof input?.pattern === 'string') paths.push(input.pattern);
  for (const p of paths) {
    if (FILE_URL.test(p)) problems.push({ kind: 'file-url', detail: p });
    else if (/^~/.test(p) || !isInside(work, p, cwd))
      problems.push({ kind: 'path', detail: `${p} is outside the working directory` });
  }
  return problems;
}

/**
 * Writes the wrapper, the hook settings, and their config into `dir`, which
 * must be outside `work` so the model's tools cannot change them. Returns the
 * directory to put first on PATH and the settings file for `claude --settings`.
 */
export function installGuard({ dir, work, realExe, expectedEnv, node = process.execPath }) {
  const fwd = (p) => p.replace(/\\/g, '/');
  const guard = fwd(fileURLToPath(import.meta.url));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const config = join(dir, 'config.json');
  const log = join(dir, 'blocked.jsonl');
  writeFileSync(config, JSON.stringify({ work, realExe, expectedEnv, log }, null, 2));
  // A shell script, not a .cmd: Claude Code's Bash tool runs Git Bash on
  // Windows, which runs extensionless scripts that start with #!.
  const wrapper = join(binDir, 'agent-browser');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${fwd(node)}" "${guard}" exec "${fwd(config)}" "$@"\n`);
  if (!isWin) chmodSync(wrapper, 0o755);
  const settingsFile = join(dir, 'settings.json');
  const hook = `"${fwd(node)}" "${guard}" hook "${fwd(config)}"`;
  writeFileSync(
    settingsFile,
    JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hook }] }] } },
      null,
      2
    )
  );
  return { binDir, settingsFile, log };
}

/** Reads what the guard blocked during a scenario. */
export function readBlocked(log) {
  try {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function record(config, layer, problems, what) {
  for (const p of problems)
    appendFileSync(
      config.log,
      `${JSON.stringify({ at: new Date().toISOString(), layer, ...p, what: String(what).slice(0, 500) })}\n`
    );
}

function describe(problems) {
  return [...new Set(problems.map((p) => `${p.kind}: ${p.detail}`))].join('; ');
}

async function mainExec(config, args) {
  const ctx = {
    work: config.work,
    cwd: process.cwd(),
    env: process.env,
    expectedEnv: config.expectedEnv,
  };
  const problems = checkArgs(args, ctx);
  let input = null;
  // `batch` with no command arguments reads its commands from stdin.
  const sub = subcommandCandidates(args);
  if (
    sub.includes('batch') &&
    args.slice(args.indexOf('batch') + 1).every((a) => a.startsWith('-'))
  ) {
    input = readFileSync(0);
    const text = input.toString('utf8');
    problems.push(...checkCommand(text, ctx));
    if (/"connect"/.test(text))
      problems.push({ kind: 'attach', detail: 'batch input contains the connect command' });
  }
  if (problems.length) {
    record(config, 'wrapper', problems, args.join(' '));
    console.error(`agent-browser: blocked by the dogfood harness (${describe(problems)})`);
    process.exit(126);
  }
  const child = spawn(config.realExe, args, {
    stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
  });
  if (input) child.stdin.end(input);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
  child.on('error', (err) => {
    console.error(`agent-browser: ${err.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

function mainHook(config) {
  const event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const problems = checkToolInput(event.tool_name, event.tool_input, {
    work: config.work,
    cwd: event.cwd || config.work,
  });
  if (!problems.length) process.exit(0);
  record(config, 'hook', problems, JSON.stringify(event.tool_input ?? {}));
  // Exit code 2 blocks the tool call and shows stderr to the model.
  console.error(`Blocked by the dogfood harness: ${describe(problems)}`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, configPath, ...rest] = process.argv.slice(2);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (mode === 'exec') await mainExec(config, rest);
  else if (mode === 'hook') mainHook(config);
  else {
    console.error('usage: guard.mjs exec|hook <config.json> [args...]');
    process.exit(2);
  }
}
