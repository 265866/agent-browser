// Fences the dogfood model in before anything runs, at two layers:
//
// - A PreToolUse hook (in the settings file passed to `claude --settings`)
//   allows only the tools the scenarios need. It parses each Bash command
//   into simple commands, allows only agent-browser, sleep, and a few helpers
//   that read or arrange files, and rejects attach attempts, file: URLs,
//   paths outside the scenario's working directory, variables that name such
//   directories, and writes to the working directory's .claude directory.
//   File tool paths must stay in the working directory too.
// - A wrapper named `agent-browser`, first on PATH in place of the candidate,
//   checks the final argv (after the shell expanded variables such as $HOME)
//   against an allowlist of subcommands and global flags, checks every file
//   argument, refuses agent-browser variables the harness does not allow, and
//   runs the real binary with the harness's settings.
//
// Both fail closed: when the guard itself fails, the call is blocked. Both log
// what they block to a file the model cannot reach. The transcript audit in
// run.mjs stays as a third line.
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
const FILE_URL = /(?<![A-Za-z])file:/i;

// ---- what the candidate may run ----

// Subcommands the scenarios and the core skill's browsing workflow need. Their
// positional arguments are selectors, text, URLs, keys, or code, never files.
const BROWSING = new Set(
  `open goto navigate back forward reload read click dblclick fill type hover focus check uncheck
  select drag press key keydown keyup keyboard scroll scrollintoview scrollinto snapshot eval close
  quit exit get is find mouse set storage tab window frame dialog console errors highlight tap swipe
  session skills confirm deny a11y vitals web-vitals react pushstate removeinitscript`.split(/\s+/)
);
// Subcommands whose arguments may name files: every argument must stay in the
// working directory.
const FILE_COMMANDS = new Set(
  'screenshot pdf download upload state trace profiler record diff'.split(' ')
);
// Subcommands where only some arguments are files.
const FILE_FLAGS = { cookies: ['--curl'], wait: ['--download', '-d'] };
// `network har start|stop [path]` writes a file; other network arguments are
// URL patterns and JSON bodies.
const NETWORK_FILES_AFTER = 'har';
// Subcommands that leave the fence by attaching to other browsers or running
// other programs. A try makes the scenario an error.
const ESCAPES = {
  connect: ['attach', 'attaches to a running browser'],
  mcp: ['escape', 'its tools can attach to other browsers'],
  plugin: ['escape', 'runs plugin programs'],
  plugins: ['escape', 'runs plugin programs'],
  chat: ['escape', 'runs an AI agent with its own tools'],
  install: ['escape', 'downloads and runs installers'],
  upgrade: ['escape', 'replaces the installation'],
};
// Subcommands the scenarios do not need, which change or inspect the host,
// start servers, or use host resources. A try is blocked and noted.
const UNNEEDED = {
  dashboard: 'starts a server',
  stream: 'starts a server',
  inspect: 'starts a server',
  profiles: "lists the user's browser profiles",
  auth: 'uses the credential vault',
  doctor: 'inspects and repairs the host',
  device: 'uses attached devices',
  clipboard: 'uses the system clipboard',
  webmcp: 'invokes page tools outside the scenarios',
};
const INFO = new Set(['--help', '-h', 'help', '--version', '-V']);

// The CLI parses its global flags anywhere in the arguments (cli/src/flags.rs).
const GLOBAL_VALUE_FLAGS = new Set(
  `--session --restore-save --restore-check-url --restore-check-text --restore-check-fn --namespace
  --headers --executable-path --cdp --extension --init-script --enable --profile --state --proxy
  --proxy-bypass --args --user-agent -p --provider --device --session-name --color-scheme
  --download-path --max-output --allowed-domains --action-policy --confirm-actions --config --engine
  --input-mode --screenshot-dir --screenshot-quality --screenshot-format --idle-timeout --ca-cert
  --model`.split(/\s+/)
);
const GLOBAL_BOOL_FLAGS = new Set(
  `--json --headed --webgpu --no-webmcp --debug --ignore-https-errors --allow-file-access
  --hide-scrollbars --auto-connect --pin-tab --no-pin-tab --no-ca-cert --annotate
  --content-boundaries --confirm-interactive --no-auto-dialog -v --verbose -q --quiet --offline
  --quick --fix --restore`.split(/\s+/)
);
// Global flags the model may use. Path-valued ones must stay in the working
// directory. Every other global flag is refused.
const ALLOWED_FLAGS = new Set(
  `--session --headers --user-agent --device --color-scheme --max-output --allowed-domains
  --confirm-actions --input-mode --screenshot-quality --screenshot-format --idle-timeout --json
  --headed --webgpu --no-webmcp --debug --ignore-https-errors --hide-scrollbars --pin-tab
  --no-pin-tab --annotate --content-boundaries --confirm-interactive --no-auto-dialog -v --verbose
  -q --quiet`.split(/\s+/)
);
const PATH_FLAGS = new Set(
  '--download-path --screenshot-dir --state --init-script --action-policy'.split(' ')
);
const ATTACH_FLAGS = new Set(['--cdp', '--auto-connect', '--profile', '--config']);
// Refused flags that select another browser, daemon, program, or network
// path, or load outside state. A try makes the scenario an error; any other
// refused flag is noted.
const ESCAPE_FLAGS = new Set(
  `--executable-path --namespace --extension --args -p --provider --engine --proxy --proxy-bypass
  --ca-cert --no-ca-cert --allow-file-access --enable --session-name --restore --restore-save
  --restore-check-url --restore-check-text --restore-check-fn`.split(/\s+/)
);

// agent-browser variables the model may set; the core skill recommends
// exporting a session name. The harness's own variables must keep their
// values, and every other one is refused.
const MODEL_VARS = new Set(['AGENT_BROWSER_SESSION']);

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

/** Why the file argument `p` is not allowed, or null. */
function fileProblem(p, { work, cwd }) {
  if (/^~/.test(p)) return `${p} is outside the working directory`;
  // A URL is not a file (diff url, open-like arguments of file commands).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !FILE_URL.test(p)) return null;
  if (!isInside(work, p, cwd)) return `${p} is outside the working directory`;
  if (isInside(join(work, '.claude'), p, cwd))
    return `${p} is in .claude, Claude Code's settings directory`;
  return null;
}

/**
 * Separates the global flags (with their values) from the command and its
 * arguments, the way the CLI strips them (clean_args in cli/src/flags.rs).
 * `--flag=value` forms of global flags are reported too, although the CLI
 * passes them to the command.
 */
export function splitGlobalFlags(args) {
  const flags = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.match(/^(--?[A-Za-z][\w-]*)=(.*)$/s);
    const name = eq ? eq[1] : a;
    if (!GLOBAL_VALUE_FLAGS.has(name) && !GLOBAL_BOOL_FLAGS.has(name)) {
      rest.push(a);
      continue;
    }
    const value = eq
      ? eq[2]
      : GLOBAL_VALUE_FLAGS.has(name)
        ? args[++i]
        : ['true', 'false'].includes(args[i + 1])
          ? args[++i]
          : undefined;
    flags.push({ name, value });
  }
  return { flags, rest };
}

/** Problems with one agent-browser invocation, as `{ kind, detail }`. */
export function checkArgs(
  args,
  { work, cwd = work, env = null, expectedEnv = {}, nested = false }
) {
  const problems = [];
  const add = (kind, detail) => problems.push({ kind, detail });
  const checkFile = (p) => {
    const why = fileProblem(p, { work, cwd });
    if (why) add('path', why);
  };
  for (const a of args) if (FILE_URL.test(a)) add('file-url', a);

  const { flags, rest } = splitGlobalFlags(args);
  for (const { name, value } of flags) {
    if (ATTACH_FLAGS.has(name)) add('attach', `${name} selects an existing browser or config`);
    else if (PATH_FLAGS.has(name)) {
      if (value === undefined) add('command', `${name} needs a value`);
      else checkFile(value);
    } else if (!ALLOWED_FLAGS.has(name))
      add(
        ESCAPE_FLAGS.has(name) ? 'escape' : 'command',
        `${name} is not allowed in the dogfood harness`
      );
  }

  const [sub, ...params] = rest;
  if (sub === undefined) add('command', 'no subcommand');
  else if (INFO.has(sub)) {
    // Help and version output only.
  } else if (ESCAPES[sub]) add(ESCAPES[sub][0], `${sub} ${ESCAPES[sub][1]}`);
  else if (UNNEEDED[sub]) add('command', `${sub} ${UNNEEDED[sub]}; the dogfood harness blocks it`);
  else if (sub === 'batch') {
    if (nested) add('command', 'batch inside batch');
    for (const c of params.filter((p) => p !== '--bail'))
      problems.push(...checkArgs(shellWords(c), { work, cwd, nested: true }));
  } else if (FILE_COMMANDS.has(sub)) {
    for (const p of params) checkFile(p.replace(/^--?[\w-]+=/, ''));
  } else if (sub === 'network') {
    const har = params.indexOf(NETWORK_FILES_AFTER);
    if (har >= 0) for (const p of params.slice(har + 1)) checkFile(p);
  } else if (FILE_FLAGS[sub] || BROWSING.has(sub)) {
    for (const flag of FILE_FLAGS[sub] ?? []) {
      const at = params.indexOf(flag);
      const value = params[at + 1];
      if (at >= 0 && value !== undefined && !value.startsWith('-')) checkFile(value);
    }
  } else add('command', `${sub} is not a subcommand the dogfood scenarios use`);

  if (env) {
    const expected = new Map(Object.entries(expectedEnv).map(([k, v]) => [k.toUpperCase(), v]));
    const seen = new Set();
    for (const [k, v] of Object.entries(env)) {
      const key = k.toUpperCase();
      if (!key.startsWith('AGENT_BROWSER_')) continue;
      seen.add(key);
      if (expected.has(key)) {
        if (v !== expected.get(key)) add('escape', `${k} differs from the harness setting`);
      } else if (!MODEL_VARS.has(key)) {
        add(
          /^AGENT_BROWSER_(CDP|AUTO_CONNECT|PROFILE|CONFIG)$/.test(key) ? 'attach' : 'escape',
          `${k} is not a variable the dogfood harness allows`
        );
      }
    }
    for (const k of expected.keys())
      if (!seen.has(k)) add('escape', `${k} differs from the harness setting`);
  }
  return problems;
}

/** Splits a batch command string into words exactly as the CLI does (shell_words_split). */
export function shellWords(s) {
  const words = [];
  let current = '';
  let double = false;
  let single = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && !single) {
      if (i + 1 < s.length) current += s[++i];
    } else if (c === '"' && !single) double = !double;
    else if (c === "'" && !double) single = !single;
    else if (c === ' ' && !double && !single) {
      if (current) words.push(current);
      current = '';
    } else current += c;
  }
  if (current) words.push(current);
  return words;
}

// ---- what the model's shell may run ----

// Programs the model may run in Bash: the candidate, sleep, and helpers that
// read or arrange files (their paths are checked). Anything that runs other
// programs (env, xargs, find -exec, sed's e command, interpreters) or reaches
// the network (curl) is not here.
const PROGRAMS = new Set(
  `agent-browser sleep cd pwd ls cat head tail wc grep sort uniq cut tr echo printf test [ true
  false : export unset set mkdir rm rmdir mv cp cmp diff file od stat basename dirname cygpath
  sha256sum md5sum base64`.split(/\s+/)
);
// Variables that name directories outside the working directory, and the
// model gateway credentials.
const OUTSIDE_VARS =
  /^(HOME|USERPROFILE|TMPDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|OLDPWD|CLAUDE_CONFIG_DIR|XDG_\w+)$/;
const SECRET_VARS = /^(ANTHROPIC|CLAUDE_CODE)_/;
const DEVICES = /^\/dev\/(null|stdin|stdout|stderr|fd\/\d+)$/;

/**
 * Splits shell text into simple commands the way bash would, closely enough
 * to find each command's program, words, and redirect targets. Heredoc and
 * here-string bodies are input data and are skipped. `$(pwd)`, `$(pwd -W)`,
 * and `$PWD` become `cwd`; any other expansion makes its word dynamic, with
 * NUL marking where the value goes. Command substitutions are returned as
 * commands of their own.
 */
export function parseShell(text, cwd) {
  const commands = [];
  const heredocs = [];
  let cmd = { words: [], redirects: [] };
  let word = null;
  let redirect = null;
  let i = 0;
  const add = (s, vars) => {
    word ??= { text: '', dynamic: false, vars: [] };
    word.text += s;
    if (vars) {
      word.dynamic = true;
      word.vars.push(...vars);
    }
  };
  const endWord = () => {
    if (word === null) return;
    if (redirect === 'target') cmd.redirects.push(word);
    else if (redirect === null) cmd.words.push(word);
    redirect = null;
    word = null;
  };
  const endCmd = () => {
    endWord();
    redirect = null;
    if (cmd.words.length || cmd.redirects.length) commands.push(cmd);
    cmd = { words: [], redirects: [] };
  };
  const closing = (j, open, close) => {
    let depth = 1;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '\\') j++;
      else if (c === "'") {
        j = text.indexOf("'", j + 1);
        if (j < 0) return text.length;
      } else if (c === open) depth++;
      else if (c === close && --depth === 0) return j;
    }
    return text.length;
  };
  const substitution = (inner) => {
    if (/^\s*pwd(\s+-[LPW]+)*\s*$/.test(inner)) add(cwd);
    else {
      add('\0', ['$(...)']);
      commands.push(...parseShell(inner, cwd));
    }
  };
  const dollar = () => {
    const next = text[i + 1];
    if (next === '(') {
      const end = closing(i + 2, '(', ')');
      if (text[i + 2] === '(') add('\0', ['$((...))']);
      else substitution(text.slice(i + 2, end));
      i = end + 1;
      return;
    }
    let name = null;
    if (next === '{') {
      const end = closing(i + 2, '{', '}');
      name = text.slice(i + 2, end).match(/^[#!]?([A-Za-z_]\w*|\d+|[@*#?$!-])/)?.[1] ?? '';
      i = end + 1;
    } else {
      name = text.slice(i + 1).match(/^([A-Za-z_]\w*|\d|[@*#?$!-])/)?.[1] ?? null;
      if (name === null) {
        add('$');
        i++;
        return;
      }
      i += 1 + name.length;
    }
    if (name === 'PWD') add(cwd);
    else add('\0', [name]);
  };
  const backtick = () => {
    let end = i + 1;
    while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
    substitution(text.slice(i + 1, end));
    i = end + 1;
  };
  const skipHeredocBodies = () => {
    while (heredocs.length) {
      const delimiter = heredocs.shift();
      while (i < text.length) {
        const end = text.indexOf('\n', i);
        const line = text.slice(i, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end + 1;
        if (line.replace(/^\t+/, '') === delimiter) break;
      }
    }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] !== '\n') add(text[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      add(text.slice(i + 1, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end + 1;
    } else if (c === '"') {
      add('');
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && '"\\$`'.includes(text[i + 1])) {
          add(text[i + 1]);
          i += 2;
        } else if (text[i] === '$') dollar();
        else if (text[i] === '`') backtick();
        else add(text[i++]);
      }
      i++;
    } else if (c === '$') dollar();
    else if (c === '`') backtick();
    else if (c === '#' && word === null) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (c === '\n') {
      endCmd();
      i++;
      skipHeredocBodies();
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '&' && text[i + 1] === '>') {
      endWord();
      i += text[i + 2] === '>' ? 3 : 2;
      redirect = 'target';
    } else if (';|&()'.includes(c)) {
      endCmd();
      i++;
    } else if (c === '<' || c === '>') {
      // A number right before the operator is a file descriptor.
      if (word && !word.dynamic && /^\d+$/.test(word.text)) word = null;
      else endWord();
      if (text.startsWith('<<<', i)) {
        i += 3;
        redirect = 'data';
      } else if (text.startsWith('<<', i)) {
        i += text[i + 2] === '-' ? 3 : 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        let delimiter = '';
        while (i < text.length && !/[\s;|&<>()]/.test(text[i])) delimiter += text[i++];
        heredocs.push(delimiter.replace(/['"\\]/g, ''));
      } else {
        i++;
        if (text[i] === '>' || text[i] === '|') i++;
        if (text[i] === '&' && /[\d-]/.test(text[i + 1] ?? '')) {
          i++;
          redirect = 'data';
        } else {
          if (text[i] === '&') i++;
          redirect = 'target';
        }
      }
    } else add(text[i++]);
  }
  endCmd();
  return commands;
}

/**
 * Why one piece of a shell word names a path the model may not use, or null.
 * Paths in `readDirs` are allowed too (for read-only programs).
 */
function shellPathProblem(piece, { work, cwd, readDirs = [] }) {
  let p = piece;
  // A value glued to a short option, as in -o/tmp/x.
  if (/^-[A-Za-z](?=[/~]|[A-Za-z]:[\\/])/.test(p)) p = p.slice(2);
  if (!p || DEVICES.test(p)) return null;
  const absolute =
    /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p) || /^~/.test(p);
  const parent = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p);
  if (!/^~/.test(p) && readDirs.some((d) => isInside(d, p, cwd))) return null;
  if (/^~/.test(p) || ((absolute || parent) && !isInside(work, p, cwd)))
    return `${p} is outside the working directory`;
  if (isInside(join(work, '.claude'), p, cwd))
    return `${p} is in .claude, Claude Code's settings directory`;
  return null;
}

// Helpers that only read their file arguments. They may also read
// `readDirs` (where Claude Code saves long tool output for the model).
const READERS = new Set(
  'ls cat head tail wc grep sort uniq cut tr file od stat cmp diff sha256sum md5sum base64'.split(
    ' '
  )
);

/**
 * Problems with a Bash command line, checked as text before it runs.
 * `readDirs` are directories outside `work` that read-only helpers may read.
 */
export function checkCommand(command, { work, cwd = work, readDirs = [] }) {
  const problems = [];
  const add = (kind, detail) => problems.push({ kind, detail });
  if (ATTACH_PATTERN.test(command))
    add('attach', 'attaching to an existing browser is not allowed');
  if (FILE_URL.test(command)) add('file-url', 'file: URLs are not allowed');
  const checkWord = (w, reads) => {
    for (const v of w.vars) {
      if (OUTSIDE_VARS.test(v))
        add('path', `$${v} names a directory outside the working directory`);
      if (SECRET_VARS.test(v)) add('command', `$${v} holds the model gateway settings`);
    }
    for (const piece of w.text.split(/[=\0]/)) {
      const why = shellPathProblem(piece, { work, cwd, readDirs: reads ? readDirs : [] });
      if (why) add('path', why);
    }
  };
  for (const c of parseShell(command, cwd)) {
    let k = 0;
    while (k < c.words.length && /^[A-Za-z_]\w*=/.test(c.words[k].text)) k++;
    if (c.words[k]?.text === 'time') k++;
    const program = c.words[k];
    if (program && (program.dynamic || !PROGRAMS.has(program.text)))
      add(
        'command',
        `${program.dynamic ? 'a computed command' : program.text} is not allowed; the shell may run agent-browser, sleep, and simple file helpers`
      );
    // The wrapper checks agent-browser's own arguments after expansion.
    const words =
      program?.text === 'agent-browser' && !program.dynamic ? c.words.slice(0, k) : c.words;
    const reads = READERS.has(program?.text) && !program.dynamic;
    for (const w of words) checkWord(w, reads);
    for (const w of c.redirects) checkWord(w, false);
  }
  return problems;
}

// Tools the scenarios need. run.mjs also limits Claude Code to these.
const TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'];

/**
 * Problems with one tool call: allowed tools only, every path in `work`, or
 * in `readDirs` for tools that only read.
 */
export function checkToolInput(tool, input, { work, cwd = work, readDirs = [] }) {
  if (!TOOLS.has(tool)) return [{ kind: 'tool', detail: `the ${tool} tool is not allowed` }];
  if (tool === 'Bash') return checkCommand(String(input?.command ?? ''), { work, cwd, readDirs });
  const problems = [];
  const paths = PATH_FIELDS.map((f) => input?.[f]).filter((v) => typeof v === 'string' && v);
  if (tool === 'Glob' && typeof input?.pattern === 'string') paths.push(input.pattern);
  const readable = (p) =>
    !WRITE_TOOLS.has(tool) && !/^~/.test(p) && readDirs.some((d) => isInside(d, p, cwd));
  for (const p of paths) {
    if (FILE_URL.test(p)) problems.push({ kind: 'file-url', detail: p });
    else if (readable(p)) continue;
    else if (/^~/.test(p) || !isInside(work, p, cwd))
      problems.push({ kind: 'path', detail: `${p} is outside the working directory` });
    else if (WRITE_TOOLS.has(tool) && isInside(join(work, '.claude'), p, cwd))
      problems.push({
        kind: 'path',
        detail: `${p} is in .claude, Claude Code's settings directory`,
      });
  }
  return problems;
}

/**
 * Writes the wrapper, the hook settings, and their config into `dir`, which
 * must be outside `work` so the model's tools cannot change them. Returns the
 * directory to put first on PATH and the settings file for `claude --settings`.
 * `expectedEnv` holds the harness's agent-browser variables, which must keep
 * their values; `fixedEnv` holds other variables (PATH, HOME, temp and app
 * data directories) that the wrapper resets for the candidate. `realArgs`
 * come before the model's arguments (tests run a stand-in candidate script).
 * `readDirs` are directories outside `work` that read-only tools may read.
 */
export function installGuard({
  dir,
  work,
  realExe,
  realArgs = [],
  expectedEnv,
  fixedEnv = {},
  readDirs = [],
  node = process.execPath,
}) {
  const fwd = (p) => p.replace(/\\/g, '/');
  const guard = fwd(fileURLToPath(import.meta.url));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const config = join(dir, 'config.json');
  const log = join(dir, 'blocked.jsonl');
  writeFileSync(
    config,
    JSON.stringify({ work, readDirs, realExe, realArgs, expectedEnv, fixedEnv, log }, null, 2)
  );
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

/**
 * The candidate's environment: the caller's, without agent-browser variables
 * other than the model's own, with the harness's values put back.
 */
export function candidateEnv(env, { expectedEnv = {}, fixedEnv = {} }) {
  const fixed = { ...fixedEnv, ...expectedEnv };
  const fixedKeys = new Set(Object.keys(fixed).map((k) => k.toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const key = k.toUpperCase();
    if (fixedKeys.has(key)) continue;
    if (key.startsWith('AGENT_BROWSER_') && !MODEL_VARS.has(key)) continue;
    out[k] = v;
  }
  return Object.assign(out, fixed);
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
  // `batch` with no command arguments reads a JSON array of commands from stdin.
  const { rest } = splitGlobalFlags(args);
  if (rest[0] === 'batch' && rest.slice(1).every((a) => a === '--bail')) {
    input = readFileSync(0);
    let commands = null;
    try {
      commands = JSON.parse(input.toString('utf8'));
    } catch {}
    if (!Array.isArray(commands) || !commands.every((c) => Array.isArray(c)))
      problems.push({ kind: 'command', detail: 'batch input must be a JSON array of commands' });
    else
      for (const c of commands)
        problems.push(...checkArgs(c.map(String), { work: ctx.work, cwd: ctx.cwd, nested: true }));
  }
  if (problems.length) {
    record(config, 'wrapper', problems, args.join(' '));
    console.error(`agent-browser: blocked by the dogfood harness (${describe(problems)})`);
    process.exit(126);
  }
  const child = spawn(config.realExe, [...(config.realArgs ?? []), ...args], {
    stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    env: candidateEnv(process.env, config),
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
  const event = JSON.parse(readFileSync(0, 'utf8'));
  const problems = checkToolInput(event.tool_name, event.tool_input, {
    work: config.work,
    cwd: event.cwd || config.work,
    readDirs: config.readDirs ?? [],
  });
  if (!problems.length) process.exit(0);
  record(config, 'hook', problems, JSON.stringify(event.tool_input ?? {}));
  // Exit code 2 blocks the tool call and shows stderr to the model.
  console.error(`Blocked by the dogfood harness: ${describe(problems)}`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, configPath, ...rest] = process.argv.slice(2);
  // Fail closed: a guard that cannot decide blocks the call. For the hook,
  // only exit code 2 blocks; any other failure would let the call through.
  try {
    if (mode !== 'exec' && mode !== 'hook') throw new Error(`unknown mode ${mode}`);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (mode === 'exec') await mainExec(config, rest);
    else mainHook(config);
  } catch (err) {
    console.error(
      mode === 'exec'
        ? `agent-browser: blocked by the dogfood harness (guard error: ${err.message})`
        : `Blocked by the dogfood harness (guard error: ${err.message})`
    );
    process.exit(mode === 'exec' ? 126 : 2);
  }
}
