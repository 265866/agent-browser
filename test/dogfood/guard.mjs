// Fences the dogfood model in before anything runs, at two layers:
//
// - A PreToolUse hook (in the settings file passed to `claude --settings`)
//   allows only the tools the scenarios need. The Bash tool may run only
//   agent-browser, a few helpers, and the core skill's shell idioms, in a
//   small grammar the hook checks before bash sees the text (see
//   parseCommands). File tool paths must stay in the scenario's working
//   directory, outside its .claude directory.
// - A wrapper named `agent-browser`, first on PATH in place of the candidate,
//   checks the final argv against an allowlist of subcommands and global
//   flags, checks every file argument and every URL the browser would open,
//   refuses unsafe session names and (on Windows) a session whose daemon port
//   another program holds, refuses agent-browser variables the harness does
//   not allow, and runs the real binary with the harness's settings.
//
// installGuard copies this file next to the wrapper, so a scenario runs the
// guard it started with, and returns the copies' SHA-256. Both layers fail
// closed: when the guard itself fails, the call is blocked and the failure is
// logged as a guard-error. Both log what they block to a file the model
// cannot reach. The transcript audit in run.mjs stays as a third line.
//
//   node guard.mjs exec <config.json> [agent-browser args...]   (the wrapper)
//   node guard.mjs hook <config.json>                           (the hook)

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  realpathSync,
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
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
  session skills confirm deny a11y vitals web-vitals react pushstate`.split(/\s+/)
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
  device: 'uses attached devices',
  clipboard: 'uses the system clipboard',
  webmcp: 'invokes page tools outside the scenarios',
  removeinitscript: 'could remove the init script that disables WebRTC',
};

/**
 * The page init script (AGENT_BROWSER_INIT_SCRIPTS) that leaves pages and
 * their frames no RTCPeerConnection, whose STUN traffic is UDP that the
 * harness proxy never sees. agent-browser registers it on a page-opened
 * window only after that window's first document has started, so
 * window.open, which hands the opener that document, returns null instead.
 */
export const WEBRTC_BLOCK = `(() => {
  const lock = (name, value) => {
    try {
      Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
    } catch {
      globalThis[name] = value;
    }
  };
  const refuse = function () {
    throw new DOMException('WebRTC is disabled in the dogfood harness', 'SecurityError');
  };
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection'])
    if (typeof globalThis[name] === 'function') lock(name, refuse);
  if (typeof globalThis.open === 'function') lock('open', () => null);
})();
`;
// Built-in init scripts `--enable` may load (apply_launch_init_scripts in
// cli/src/native/actions.rs): both inject the bundled React DevTools hook.
const ENABLE_FEATURES = new Set(['react-devtools', 'react']);
const INFO = new Set(['--help', '-h', 'help', '--version', '-V']);

// The CLI's top-level commands (is_top_level_command in cli/src/commands.rs).
// A bare --restore before one of them takes no value.
const TOP_LEVEL = new Set(
  `open goto navigate back forward reload read click dblclick fill type hover focus check uncheck
  select drag upload download press key keydown keyup keyboard scroll scrollintoview scrollinto wait
  screenshot pdf snapshot eval close quit exit inspect auth confirm deny connect stream get is find
  mouse set network storage cookies tab window frame dialog trace profiler record console errors
  highlight clipboard state tap swipe device diff batch react vitals web-vitals a11y pushstate
  removeinitscript session mcp doctor install upgrade profiles skills dashboard plugin plugins chat
  webmcp`.split(/\s+/)
);
// The CLI parses its global flags anywhere in the arguments (clean_args in
// cli/src/flags.rs). --restore takes an optional value and is handled apart.
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
  --quick --fix`.split(/\s+/)
);
// Global flags the model may use. Path-valued ones must stay in the working
// directory. Every other global flag is refused. Restore state lives in the
// scenario's throwaway state directory (the namespace's, on Windows).
const ALLOWED_FLAGS = new Set(
  `--session --headers --user-agent --device --color-scheme --max-output --allowed-domains
  --confirm-actions --input-mode --screenshot-quality --screenshot-format --idle-timeout --json
  --headed --webgpu --no-webmcp --debug --ignore-https-errors --hide-scrollbars --pin-tab
  --no-pin-tab --annotate --content-boundaries --confirm-interactive --no-auto-dialog -v --verbose
  -q --quiet --restore --restore-save --restore-check-url --restore-check-text
  --restore-check-fn --offline --quick --enable`.split(/\s+/)
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
  --ca-cert --no-ca-cert --allow-file-access --session-name`.split(/\s+/)
);

// agent-browser variables the model may set; the core skill recommends
// exporting a session name. The harness's own variables must keep their
// values, and every other one is refused.
const MODEL_VARS = new Set(['AGENT_BROWSER_SESSION']);
// Session and restore names. Stricter than the CLI's (it accepts any Unicode
// alphanumerics), so names hash on Windows exactly as computed here.
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// Proxy variables the CLI and its HTTP clients read. The candidate gets only
// the harness's proxy settings.
const PROXY_VARS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
// Schemes a positional argument may name for the browser to load.
const URL_SCHEME =
  /^(https?|wss?|ftp|data|javascript|blob|filesystem|about|chrome|chrome-extension|chrome-untrusted|devtools|view-source|file):/i;

// Resolves symlinks through the nearest existing ancestor, so one directory
// compares equal however it is spelled (macOS reaches its temp dir through
// /var -> /private/var) even when the path itself does not exist yet.
function canonical(p) {
  const tail = [];
  let head = resolve(p);
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      tail.push(head.slice(parent.length).replace(/^[\\/]+/, ''));
      head = parent;
    }
  }
}

const norm = (p) => {
  const r = canonical(p).replace(/[\\/]+$/, '');
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
function fileProblem(p, ctx) {
  // A URL is not a file (diff url, open-like arguments of file commands). A
  // one-letter scheme is a Windows drive: c://x.png names C:\x.png.
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p) && !FILE_URL.test(p)) return null;
  return pathProblem(p, ctx);
}

/** Why the path `p` is not a file the model may write, or null. */
function pathProblem(p, { work, cwd }) {
  if (/^~/.test(p)) return `${p} is outside the working directory`;
  if (!isInside(work, p, cwd)) return `${p} is outside the working directory`;
  if (isInside(join(work, '.claude'), p, cwd))
    return `${p} is in .claude, Claude Code's settings directory`;
  return null;
}

// What a URL parser sees in `arg`: browsers (WHATWG, GURL) drop leading and
// trailing C0 controls and spaces and every tab and newline, and the CLI's
// read trims Unicode whitespace.
const urlText = (arg) => arg.replace(/^[\s\0-\x20]+|[\s\0-\x20]+$/g, '').replace(/[\t\n\r]/g, '');

// What the CLI makes of a navigation argument (normalize_navigation_url).
function navigationUrl(arg) {
  return /^(https?:\/\/|about:|data:|file:|chrome-extension:\/\/|chrome:\/\/)/i.test(arg)
    ? arg
    : `https://${arg}`;
}

// What the CLI's read fetches for its URL argument (normalize_url in
// cli/src/read.rs), with its own HTTP client rather than the browser.
function readUrl(arg) {
  const t = arg.trim();
  return t.startsWith('http://') || t.startsWith('https://') || t.includes('://')
    ? t
    : `https://${t}`;
}

/** Why the browser may not load `url`, or null: only the scenario's origins. */
function urlProblem(url, origins) {
  if (/^about:blank$/i.test(url)) return null;
  let origin = null;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
  } catch {}
  return origin && origins.includes(origin)
    ? null
    : `${url} is not the scenario's server (${origins.join(', ') || 'none'})`;
}

/**
 * Separates the global flags (with their values) from the command and its
 * arguments, the way the CLI strips them (clean_args in cli/src/flags.rs).
 * The CLI reads no `--flag=value` form but `--restore=`; the others stay in
 * the arguments and are reported with `eq: true`.
 */
export function splitGlobalFlags(args) {
  const flags = [];
  const rest = [];
  let seenCommand = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--restore=')) {
      flags.push({ name: '--restore', value: a.slice('--restore='.length) || null });
      continue;
    }
    const eq = a.match(/^(--[A-Za-z][\w-]*)=/);
    if (
      eq &&
      (GLOBAL_VALUE_FLAGS.has(eq[1]) || GLOBAL_BOOL_FLAGS.has(eq[1]) || eq[1] === '--restore')
    ) {
      flags.push({ name: eq[1], value: a.slice(eq[0].length), eq: true });
      rest.push(a);
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(a)) {
      flags.push({ name: a, value: args[++i] });
    } else if (a === '--restore') {
      const next = args[i + 1];
      const named =
        !seenCommand && next !== undefined && !next.startsWith('-') && !TOP_LEVEL.has(next);
      flags.push({ name: a, value: named ? args[++i] : null });
    } else if (GLOBAL_BOOL_FLAGS.has(a)) {
      const value = ['true', 'false'].includes(args[i + 1]) ? args[++i] : undefined;
      flags.push({ name: a, value });
    } else {
      if (!a.startsWith('-') && TOP_LEVEL.has(a)) seenCommand = true;
      rest.push(a);
    }
  }
  return { flags, rest };
}

/** The session the CLI would use for `args` with the variables in `env`. */
export function sessionOf(args, env = {}) {
  const flag = splitGlobalFlags(args)
    .flags.filter((f) => f.name === '--session' && !f.eq && f.value !== undefined)
    .at(-1);
  return flag?.value ?? env.AGENT_BROWSER_SESSION ?? 'default';
}

/** The URL argument of `read`, which the CLI fetches itself, or undefined. */
function readArg(params) {
  for (let i = 0; i < params.length; i++) {
    if (['--llms', '--filter', '--timeout'].includes(params[i])) i++;
    else if (!params[i].startsWith('--')) return params[i];
  }
  return undefined;
}

/** Arguments the browser would load as a page, by subcommand. */
function navigationArgs(sub, params) {
  if (['open', 'goto', 'navigate', 'vitals', 'web-vitals'].includes(sub)) {
    const url = params.find((a) => !a.startsWith('--'));
    return url === undefined ? [] : [url];
  }
  if (sub === 'a11y') {
    for (let i = 0; i < params.length; i++) {
      if (['--tags', '--selector', '-s'].includes(params[i])) i++;
      else if (!params[i].startsWith('-')) return [params[i]];
    }
    return [];
  }
  if (sub === 'tab' && params[0] === 'new') {
    for (let i = 1; i < params.length; i++) {
      if (params[i] === '--label') i++;
      else if (!params[i].startsWith('--')) return [params[i]];
    }
    return [];
  }
  if (sub === 'diff' && params[0] === 'url') return params.slice(1, 3);
  if (sub === 'record' && ['start', 'restart'].includes(params[0])) {
    const positional = [];
    for (let i = 1; i < params.length; i++) {
      if (['--fps', '--contact-sheet-threshold'].includes(params[i])) i++;
      else if (!params[i].startsWith('-')) positional.push(params[i]);
    }
    return positional.slice(1);
  }
  return [];
}

/**
 * Problems with one agent-browser invocation, as `{ kind, detail }`.
 * `origins` are the only origins the browser may be told to load.
 */
export function checkArgs(
  args,
  { work, cwd = work, env = null, expectedEnv = {}, origins = [], nested = false, windows = isWin }
) {
  const problems = [];
  const add = (kind, detail) => problems.push({ kind, detail });
  const checkFile = (p) => {
    const why = fileProblem(p, { work, cwd });
    if (why) add('path', why);
  };
  const checkName = (what, name) => {
    if (!SESSION_NAME.test(name))
      add('session', `${what} ${JSON.stringify(name)} must be 1-64 letters, digits, - or _`);
  };
  for (const a of args) if (FILE_URL.test(a)) add('file-url', a);

  const split = splitGlobalFlags(args);
  // The CLI also tests some flags by scanning every word (doctor's --fix, in
  // cli/src/main.rs), so a refused flag given as another flag's value, as in
  // `--user-agent --fix`, still takes effect. Any word that names a refused
  // global flag is refused wherever it appears.
  const asFlags = new Set(split.flags.map((f) => f.name));
  for (const a of new Set(args))
    if (
      (GLOBAL_BOOL_FLAGS.has(a) || GLOBAL_VALUE_FLAGS.has(a)) &&
      !ALLOWED_FLAGS.has(a) &&
      !PATH_FLAGS.has(a) &&
      !asFlags.has(a)
    )
      add(ESCAPE_FLAGS.has(a) ? 'escape' : 'command', `${a} is not allowed in the dogfood harness`);
  for (const { name, value, eq } of split.flags) {
    if (ATTACH_FLAGS.has(name)) add('attach', `${name} selects an existing browser or config`);
    else if (eq)
      add('command', `the CLI does not read ${name}=value; pass ${name} and the value separately`);
    else if (PATH_FLAGS.has(name)) {
      if (value === undefined) add('command', `${name} needs a value`);
      else checkFile(value);
    } else if (!ALLOWED_FLAGS.has(name))
      add(
        ESCAPE_FLAGS.has(name) ? 'escape' : 'command',
        `${name} is not allowed in the dogfood harness`
      );
    else if (name === '--restore' && value) checkName('restore name', value);
    else if (name === '--enable') {
      const features = String(value ?? '')
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
      if (!features.length || features.some((f) => !ENABLE_FEATURES.has(f)))
        add('command', `--enable takes only ${[...ENABLE_FEATURES].join(' or ')} here`);
    } else if (name === '--allowed-domains' && !String(value ?? '').replace(/[\s,]/g, ''))
      add('command', '--allowed-domains needs at least one domain');
  }
  // Batch commands reach the CLI's command parser with no global flag
  // handling, so their words are judged as they are.
  const rest = nested ? args : split.rest;
  if (!nested) checkName('session', sessionOf(args, env ?? {}));

  const [sub, ...params] = rest;
  if (sub === undefined) add('command', 'no subcommand');
  else if (INFO.has(sub)) {
    // Help and version output only.
  } else if (ESCAPES[sub]) add(ESCAPES[sub][0], `${sub} ${ESCAPES[sub][1]}`);
  else if (UNNEEDED[sub]) add('command', `${sub} ${UNNEEDED[sub]}; the dogfood harness blocks it`);
  else if (sub === 'doctor') {
    const has = (f) => args.includes(f);
    if (nested) add('command', 'doctor runs only on its own, not inside batch');
    // --fix reinstalls Chrome and purges state; the checks above refuse it
    // wherever it appears, so it needs no second problem here.
    // On Windows the launch test (and --webgpu's probe) start a daemon for a
    // session named after the CLI's pid and the time, whose port derives
    // from that name and cannot be checked for another program in advance.
    else if (windows && (!has('--quick') || has('--webgpu')))
      add(
        'command',
        'on Windows the dogfood harness runs doctor only with --quick and without --webgpu (its launch test picks a daemon port the harness cannot check first)'
      );
  } else if (sub === 'batch') {
    if (nested) add('command', 'batch inside batch');
    for (const c of params.filter((p) => p !== '--bail'))
      problems.push(...checkArgs(shellWords(c), { work, cwd, origins, nested: true }));
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

  // The browser may load only the scenario's server, whether the URL is a
  // navigation (which the CLI completes with https://) or any argument that
  // names a page.
  // `read` fetches with the CLI's own HTTP client, outside the browser and
  // its proxy, so its URL is held to the same origins. Each argument is
  // judged both as written and as a URL parser trims it.
  if (sub !== undefined && !INFO.has(sub)) {
    const urls = new Set();
    for (const a of navigationArgs(sub, params))
      for (const form of new Set([a, urlText(a)])) urls.add(navigationUrl(form));
    const read = sub === 'read' ? readArg(params) : undefined;
    if (read !== undefined && read.trim()) urls.add(readUrl(read));
    if (sub === 'pushstate' && params[0] !== undefined && urlText(params[0]).startsWith('//'))
      urls.add(`http:${urlText(params[0])}`);
    for (const p of params) if (URL_SCHEME.test(urlText(p))) urls.add(urlText(p));
    for (const u of urls) {
      if (FILE_URL.test(u)) add('file-url', u);
      else {
        const why = urlProblem(u, origins);
        if (why) add('url', why);
      }
    }
  }

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

// ---- Windows daemon ports ----

// sanitize_session_component in cli/src/validation.rs.
function sanitizeComponent(value) {
  let out = '';
  let lastSep = false;
  for (const c of value) {
    if (/[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u.test(c)) {
      out += c.toLowerCase();
      lastSep = false;
    } else if (!out || lastSep) continue;
    else {
      out += c === '-' || c === '_' ? c : '-';
      lastSep = true;
    }
  }
  return out.replace(/[-_]+$/, '');
}

/**
 * The port the Windows CLI derives for a session when no .port file names one
 * (get_port_for_session in cli/src/connection.rs).
 */
export function derivedPort(namespace, session) {
  const ns = sanitizeComponent(namespace ?? '');
  const identity = ns ? `${ns}:${session}` : session;
  let hash = 0;
  for (const c of identity) hash = ((hash << 5) - hash + c.codePointAt(0)) | 0;
  return 49152 + (Math.abs(hash) % 16383);
}

/** The CLI's socket directory for the harness's settings (get_socket_dir). */
function socketDir(expectedEnv) {
  const base = expectedEnv.AGENT_BROWSER_SOCKET_DIR;
  const ns = sanitizeComponent(expectedEnv.AGENT_BROWSER_NAMESPACE ?? '');
  return ns ? join(base, 'namespaces', ns, 'run') : base;
}

/** PIDs listening on TCP `port`, from netstat, without connecting to it. */
export function listenersOn(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  const r6 = spawnSync('netstat', ['-ano', '-p', 'TCPv6'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || r6.status !== 0) throw new Error('netstat failed');
  const pids = new Set();
  for (const line of `${r.stdout}\n${r6.stdout}`.split('\n')) {
    // A listening socket's foreign address is 0.0.0.0:0 or [::]:0, in every
    // display language.
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)$/);
    if (m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids];
}

/**
 * On Windows, a session with no .port file connects to a port derived from
 * its name, so a chosen name could point the CLI at another program's port.
 * Refuses when anything but this session's own daemon (its .pid file) listens
 * there.
 */
export function portProblem(session, expectedEnv) {
  const dir = socketDir(expectedEnv);
  if (existsSync(join(dir, `${session}.port`))) return null;
  const port = derivedPort(expectedEnv.AGENT_BROWSER_NAMESPACE, session);
  const pids = listenersOn(port);
  if (!pids.length) return null;
  let own = null;
  try {
    own = Number(readFileSync(join(dir, `${session}.pid`), 'utf8').trim());
  } catch {}
  if (own && pids.every((p) => p === own)) return null;
  return {
    kind: 'collision',
    detail: `session ${session} maps to port ${port}, where another program listens; choose another session name`,
  };
}

// ---- what the model's shell may run ----

// The model's Bash tool may run only agent-browser, a few helpers, and the
// core skill's session idioms. The hook does not try to understand general
// shell: it accepts a small grammar and refuses everything else before bash
// sees it. File work goes through the file tools, whose paths the hook checks.
//
//   agent-browser <words>             words: plain text, '...', "..." (no
//                                     expansion but the session variables)
//   NAME=<value> agent-browser ...    NAME: AGENT_BROWSER_SESSION or SESSION
//   [export] NAME=<value>             value: a session name, a session
//                                     variable, or "$(agent-browser session id ...)"
//   timeout <duration> agent-browser ...
//   cat <<'EOF' | agent-browser ...   the skill's eval --stdin form (quoted
//   agent-browser ... <<'EOF'         delimiter, so the body is literal)
//   sleep <number>, true, wait
//   { <commands>; }                   a group of the above
//
// Commands are joined by `;`, `&&`, `||`, `&` (which runs the one before it
// in the background), or newlines. The redirects are descriptor copies
// (`2>&1`), output to /dev/null, and agent-browser's output (`>`, `>>`,
// `&>`, `2>`) to a file named literally, inside the working directory and
// outside .claude.
const SESSION_VARS = new Set(['AGENT_BROWSER_SESSION', 'SESSION']);
// Characters that mean nothing to bash outside quotes. Everything else
// (globs, braces, tilde, `$`, backslash, `!`, `#` inside a word) is refused
// unquoted.
const PLAIN = /[A-Za-z0-9_@%+=:,./-]/;
const SESSION_TEXT = /^[A-Za-z0-9_-]*$/;
const SESSION_ID = /^agent-browser[ \t]+session[ \t]+id(?:[ \t]+[A-Za-z0-9_./:=-]+)*[ \t]*$/;
const SLEEP_SECONDS = /^\d+(\.\d+)?$/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

class Refusal extends Error {}
const refuse = (why) => {
  throw new Refusal(why);
};

/**
 * Parses `text` with the grammar above into the pipes it runs (one simple
 * command, or two joined by a pipe), with groups flattened. Throws a Refusal
 * for anything else.
 */
export function parseCommands(text) {
  if (/[\r\0]/.test(text)) refuse('carriage returns and NUL characters are not allowed');
  let i = 0;
  const pending = [];
  const at = (s) => text.startsWith(s, i);
  const blanks = () => {
    for (;;) {
      if (text[i] === ' ' || text[i] === '\t') i++;
      else if (at('\\\n')) i += 2;
      else return;
    }
  };
  const comment = () => {
    const end = text.indexOf('\n', i);
    i = end < 0 ? text.length : end;
  };
  // Bash reads heredoc bodies from the line after the command, up to a line
  // that is exactly the delimiter (leading tabs stripped for <<-).
  const bodies = () => {
    while (pending.length) {
      const { delimiter, strip } = pending.shift();
      while (i < text.length) {
        const end = text.indexOf('\n', i);
        const line = text.slice(i, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end + 1;
        if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break;
      }
    }
  };
  const dollar = (quoted, assignment) => {
    if (at('$(')) {
      if (!quoted && !assignment)
        refuse('$(agent-browser session id ...) must be inside double quotes');
      const end = text.indexOf(')', i);
      const inner = end < 0 ? '' : text.slice(i + 2, end);
      if (!SESSION_ID.test(inner))
        refuse('the only command substitution allowed is "$(agent-browser session id ...)"');
      i = end + 1;
      return { kind: 'subst', text: inner };
    }
    const m = text.slice(i).match(/^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/);
    const name = m?.[1] ?? m?.[2];
    if (!name || !SESSION_VARS.has(name))
      refuse('the only variables allowed are $AGENT_BROWSER_SESSION and $SESSION');
    i += m[0].length;
    return { kind: 'var', name };
  };
  const word = (assignment = false) => {
    const start = i;
    const parts = [];
    const lit = (s) => {
      if (parts.at(-1)?.kind === 'lit') parts.at(-1).text += s;
      else parts.push({ kind: 'lit', text: s });
    };
    while (i < text.length) {
      const c = text[i];
      if (PLAIN.test(c)) {
        lit(c);
        i++;
      } else if (c === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) refuse('unterminated single quote');
        lit(text.slice(i + 1, end));
        i = end + 1;
      } else if (c === '"') {
        lit('');
        i++;
        for (;;) {
          if (i >= text.length) refuse('unterminated double quote');
          const d = text[i];
          if (d === '"') break;
          if (d === '\\') {
            const next = text[i + 1];
            if (next === '\n') i += 2;
            else if ('$`"\\'.includes(next)) {
              lit(next);
              i += 2;
            } else {
              lit('\\');
              i++;
            }
          } else if (d === '`') refuse('backquote command substitution is not allowed');
          else if (d === '$') parts.push(dollar(true, assignment));
          else {
            lit(d);
            i++;
          }
        }
        i++;
      } else if (c === '$') parts.push(dollar(false, assignment));
      else if (at('\\\n')) i += 2;
      else break;
    }
    return { raw: text.slice(start, i), parts };
  };
  // A word or redirect ends at a blank, a separator, or the end. Anything
  // glued to it changes what bash reads (<<'EOF'x has the delimiter EOFx).
  const ended = () => {
    const next = text[i];
    if (next !== undefined && !' \t\n;|&<>'.includes(next))
      refuse(`${JSON.stringify(next)} is not allowed outside quotes`);
  };
  // Redirects that point output at the terminal, each other, nowhere, or a
  // file named literally (agent-browser only; statementProblem and
  // checkCommand judge those), and heredocs with a quoted delimiter.
  const redirect = (cmd) => {
    const m = text.slice(i).match(/^(\d*)(<<<|<<-|<<|>>|>&|<&|>\||&>>|&>|>|<)/);
    if (!m) return false;
    const [op, fd, kind] = m;
    i += op.length;
    if (kind === '<<' || kind === '<<-') {
      if (fd) refuse('heredocs must feed standard input');
      blanks();
      const d = text.slice(i).match(/^(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\([A-Za-z_]\w*))/);
      if (!d) refuse("heredoc delimiters must be quoted, as in <<'EOF', so the body is literal");
      i += d[0].length;
      ended();
      if (cmd.heredoc) refuse('one heredoc per command');
      cmd.heredoc = true;
      pending.push({ delimiter: d[1] ?? d[2] ?? d[3], strip: kind === '<<-' });
      return true;
    }
    if (kind === '>&') {
      const target = text.slice(i).match(/^\d+/);
      if (!target) refuse(`${op} is not allowed; only 2>&1-style redirects`);
      i += target[0].length;
      ended();
      return true;
    }
    if (kind === '>' || kind === '>>' || kind === '&>' || kind === '&>>') {
      blanks();
      const target = word();
      ended();
      if (!target.raw) refuse(`${op} needs a file name`);
      if (target.parts.some((p) => p.kind !== 'lit'))
        refuse('output may go only to /dev/null or a file named literally');
      const path = target.parts.map((p) => p.text).join('');
      if (path !== '/dev/null') cmd.files.push(path);
      return true;
    }
    refuse(`${op} redirects are not allowed`);
  };
  const simple = () => {
    const cmd = { assignments: [], words: [], heredoc: false, files: [] };
    for (;;) {
      blanks();
      const c = text[i];
      if (
        c === undefined ||
        c === '\n' ||
        c === ';' ||
        c === '|' ||
        (c === '&' && text[i + 1] !== '>')
      )
        break;
      // Every word starts after a blank or a separator, where # starts a comment.
      if (c === '#') {
        comment();
        break;
      }
      if (redirect(cmd)) continue;
      const assignment = cmd.words.length === 0 && /^[A-Za-z_]\w*=/.test(text.slice(i));
      const w = word(assignment || cmd.words[0]?.raw === 'export');
      if (!w.raw) refuse(`${JSON.stringify(c)} is not allowed outside quotes`);
      ended();
      (assignment ? cmd.assignments : cmd.words).push(w);
    }
    return cmd;
  };
  // A `{ ...; }` group, or one or two simple commands joined by a pipe.
  const pipeline = () => {
    if (text[i] === '{' && /^[ \t\n]$/.test(text[i + 1] ?? '')) {
      i++;
      return { group: list(true) };
    }
    const pipe = [simple()];
    if (text[i] === '|' && text[i + 1] !== '|') {
      i++;
      pipe.push(simple());
    }
    return { pipe };
  };
  const list = (inGroup) => {
    const items = [];
    for (;;) {
      blanks();
      if (i >= text.length) {
        if (inGroup) refuse('unterminated { group');
        return items;
      }
      if (text[i] === '#') {
        comment();
        continue;
      }
      if (text[i] === '\n') {
        i++;
        bodies();
        continue;
      }
      // Bash reads } as the end of a group only where a command could start.
      if (inGroup && text[i] === '}') {
        if (!items.length) refuse('a { } group needs a command');
        i++;
        ended();
        return items;
      }
      items.push(pipeline());
      blanks();
      if (i >= text.length || text[i] === '\n') continue;
      if (text[i] === '#') comment();
      else if (at('&&') || at('||')) i += 2;
      else if (text[i] === ';' && text[i + 1] !== ';') i++;
      else if (text[i] === '&') i++;
      else
        refuse(
          `${JSON.stringify(text.slice(i, i + 2))} is not allowed; join commands with ;, &&, ||, & or newlines`
        );
    }
  };
  const items = list(false);
  bodies();
  const flat = [];
  const visit = (xs) => {
    for (const x of xs) {
      if (x.group) visit(x.group);
      else
        flat.push(
          x.pipe.map((cmd) => ({
            ...cmd,
            program: cmd.words[0] && literal(cmd.words[0]) ? cmd.words[0].raw : null,
          }))
        );
    }
  };
  visit(items);
  return flat;
}

/** Why a variable assignment is not one of the session idioms, or null. */
function assignmentProblem(w) {
  const name = w.raw.match(/^[A-Za-z_]\w*/)[0];
  if (!SESSION_VARS.has(name))
    return `only AGENT_BROWSER_SESSION and SESSION may be set, not ${name}`;
  const parts = [...w.parts];
  parts[0] = { kind: 'lit', text: parts[0].text.slice(name.length + 1) };
  if (parts.some((p) => p.kind === 'lit' && !SESSION_TEXT.test(p.text)))
    return `${name} must be a session name (letters, digits, - and _)`;
  return null;
}

/** True when `cmd` runs agent-browser, directly or under `timeout <duration>`. */
function runsAgentBrowser(cmd) {
  if (cmd.program === 'agent-browser') return true;
  const [, duration, program] = cmd.words;
  return (
    cmd.program === 'timeout' &&
    duration !== undefined &&
    literal(duration) &&
    DURATION.test(duration.raw) &&
    program !== undefined &&
    literal(program) &&
    program.raw === 'agent-browser'
  );
}

/** Why one parsed pipe is not allowed, or null. */
function statementProblem(pipe) {
  const [first, second] = pipe;
  if (second) {
    const catHeredoc =
      first.program === 'cat' &&
      first.words.length === 1 &&
      first.heredoc &&
      first.assignments.length === 0 &&
      first.files.length === 0;
    if (!catHeredoc || !runsAgentBrowser(second) || second.heredoc)
      return "the only pipe allowed is cat <<'EOF' | agent-browser ...";
    return statementProblem([second]);
  }
  const cmd = first;
  for (const a of cmd.assignments) {
    const why = assignmentProblem(a);
    if (why) return why;
  }
  if (cmd.program === null && cmd.words.length) return 'a computed command is not allowed';
  if (cmd.files.length && !runsAgentBrowser(cmd))
    return 'only agent-browser output may go to a file; use the Write tool for files';
  if (cmd.words.length === 0) return cmd.heredoc ? 'a heredoc needs agent-browser' : null;
  if (runsAgentBrowser(cmd)) return null;
  if (cmd.program === 'timeout') return 'timeout takes a duration and an agent-browser command';
  if (cmd.heredoc) return "heredocs may feed only agent-browser or cat <<'EOF' | agent-browser";
  if (cmd.program === 'true' || cmd.program === 'wait')
    return cmd.words.length === 1 && cmd.assignments.length === 0
      ? null
      : `${cmd.program} takes no arguments here`;
  if (cmd.program === 'sleep') {
    if (cmd.assignments.length) return 'sleep takes no variables';
    return cmd.words.length === 2 && literal(cmd.words[1]) && SLEEP_SECONDS.test(cmd.words[1].raw)
      ? null
      : 'sleep takes one number of seconds';
  }
  if (cmd.program === 'export') {
    if (cmd.assignments.length || cmd.words.length < 2)
      return 'export takes NAME=value for a session variable';
    for (const w of cmd.words.slice(1)) {
      if (!/^[A-Za-z_]\w*=/.test(w.raw)) return 'export takes NAME=value for a session variable';
      const why = assignmentProblem(w);
      if (why) return why;
    }
    return null;
  }
  return `${cmd.program} is not allowed; the shell runs only agent-browser (also under timeout), sleep, true, and wait (use the Read and Write tools for files)`;
}

const literal = (w) => w.parts.every((p) => p.kind === 'lit') && w.raw === w.parts[0]?.text;

/**
 * Problems with a Bash command line, checked as text before it runs. Files
 * that agent-browser output is redirected to must be inside `work`.
 */
export function checkCommand(command, { work, cwd = work } = {}) {
  const problems = [];
  const add = (kind, detail) => problems.push({ kind, detail });
  if (ATTACH_PATTERN.test(command))
    add('attach', 'attaching to an existing browser is not allowed');
  if (FILE_URL.test(command)) add('file-url', 'file: URLs are not allowed');
  let statements = [];
  try {
    statements = parseCommands(command);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    add('command', err.message);
  }
  for (const pipe of statements) {
    const why = statementProblem(pipe);
    if (why) add('command', why);
    for (const f of pipe.flatMap((cmd) => cmd.files)) {
      const where = work ? pathProblem(f, { work, cwd }) : `${f}: no working directory to check`;
      if (where) add('path', where);
    }
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
  if (tool === 'Bash') return checkCommand(String(input?.command ?? ''), { work, cwd });
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

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Writes the wrapper, the hook settings, their config, and a copy of this
 * guard into `dir`, which must be outside `work` so the model's tools cannot
 * change them. Returns the directory to put first on PATH, the settings file
 * for `claude --settings`, the block log, and the SHA-256 of each file the
 * scenario runs. `expectedEnv` holds the harness's agent-browser variables,
 * which must keep their values; `fixedEnv` holds other variables (PATH, HOME,
 * temp and app data directories) that the wrapper resets for the candidate.
 * `origins` are the only origins the browser may be told to load. `realArgs`
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
  origins = [],
  readDirs = [],
  node = process.execPath,
}) {
  const fwd = (p) => p.replace(/\\/g, '/');
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  // The scenario runs this copy, so edits to the source tree during a run
  // cannot change the guard it started with.
  const guard = join(dir, 'guard.mjs');
  copyFileSync(fileURLToPath(import.meta.url), guard);
  const config = join(dir, 'config.json');
  const log = join(dir, 'blocked.jsonl');
  writeFileSync(
    config,
    JSON.stringify(
      { work, readDirs, realExe, realArgs, expectedEnv, fixedEnv, origins, log },
      null,
      2
    )
  );
  // A shell script, not a .cmd: Claude Code's Bash tool runs Git Bash on
  // Windows, which runs extensionless scripts that start with #!.
  const wrapper = join(binDir, 'agent-browser');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${fwd(node)}" "${fwd(guard)}" exec "${fwd(config)}" "$@"\n`
  );
  if (!isWin) chmodSync(wrapper, 0o755);
  const settingsFile = join(dir, 'settings.json');
  const hook = `"${fwd(node)}" "${fwd(guard)}" hook "${fwd(config)}"`;
  writeFileSync(
    settingsFile,
    JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hook }] }] } },
      null,
      2
    )
  );
  const sha256 = Object.fromEntries(
    [guard, wrapper, settingsFile, config].map((p) => [fwd(p.slice(dir.length + 1)), sha256File(p)])
  );
  return { binDir, settingsFile, log, sha256 };
}

/** The bash Claude Code's Bash tool runs: Git Bash on Windows. */
export function findBash(env = process.env) {
  if (!isWin) return 'bash';
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return env.CLAUDE_CODE_GIT_BASH_PATH;
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true })
    .stdout?.split(/\r?\n/)[0]
    ?.trim();
  const beside = git && join(dirname(dirname(git)), 'bin', 'bash.exe');
  return beside && existsSync(beside) ? beside : 'C:\\Program Files\\Git\\bin\\bash.exe';
}

/**
 * Checks, before the model starts, that the installed hook blocks a known-bad
 * call and allows a good one, that the wrapper reports the candidate's
 * `version` and refuses a known-bad argument, and that `agent-browser` in the
 * model's shell is the wrapper. A guard that silently does nothing (as when
 * it did not recognise itself through a symlinked path) or a PATH that puts
 * another agent-browser first would otherwise go unnoticed. Returns what
 * misbehaved (empty when all is well) and what each probe saw, and clears
 * the probes' own entries from the block log.
 */
export function probeGuard({
  guard,
  env,
  cwd,
  version,
  bash = findBash(env),
  shell = env.SHELL,
  // Claude Code sources this into its shell snapshot (aliases and functions
  // included) from os.homedir(), which is USERPROFILE on Windows.
  rcFile = join(isWin ? homedir() : (env.HOME ?? homedir()), '.bashrc'),
}) {
  const problems = [];
  const seen = {};
  const wrapper = join(guard.binDir, 'agent-browser');
  const spawnOpts = (input) => ({
    cwd,
    env,
    input: input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const run = (name, program, args, input) => {
    const r = spawnSync(program, args, spawnOpts(input));
    seen[name] = {
      status: r.status,
      stdout: String(r.stdout ?? '').slice(0, 500),
      stderr: String(r.stderr ?? r.error?.message ?? '').slice(0, 500),
    };
    return { ...r, stdout: String(r.stdout ?? '').trim() };
  };
  // Git Bash prints its own spelling of a path (/tmp/..., /d/...); cygpath
  // turns it into one Windows reads. An alias or function prints no path.
  const which = `p=$(command -v agent-browser) || exit 1; case "$p" in /*) if [ -x /usr/bin/cygpath ]; then /usr/bin/cygpath -m "$p"; else printf '%s\\n' "$p"; fi;; *) printf '%s\\n' "$p";; esac`;
  const isWrapper = (p) => isAbsolute(p) && norm(p) === norm(wrapper);

  const hook = JSON.parse(readFileSync(guard.settingsFile, 'utf8')).hooks.PreToolUse[0].hooks[0]
    .command;
  const event = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
  let r = run('hook-bad', bash, ['-c', hook], event('echo dogfood-guard-probe'));
  if (r.status !== 2) problems.push(`the hook let a refused command through (exit ${r.status})`);
  r = run('hook-good', bash, ['-c', hook], event('agent-browser --version'));
  if (r.status !== 0) problems.push(`the hook blocked agent-browser --version (exit ${r.status})`);

  // Claude Code's Bash tool exports, before each command, the PATH of a login
  // shell on Windows and its own PATH elsewhere.
  let modelPath = env.PATH;
  if (isWin) {
    r = run('login-path', bash, ['-lc', 'echo "$PATH"']);
    modelPath = r.status === 0 ? r.stdout : '';
    if (!modelPath) problems.push('a login shell reported no PATH');
  }
  // What the snapshot sets up: the rc file's aliases and functions, then PATH.
  const inModelShell = (name, script) =>
    run(name, bash, [
      '-c',
      'shopt -s expand_aliases; if [ -f "$2" ]; then source "$2" </dev/null >/dev/null 2>&1; fi; export PATH="$1"; eval "$3"',
      'probe',
      modelPath ?? '',
      rcFile,
      script,
    ]);
  r = inModelShell('resolve', which);
  if (r.status !== 0 || !isWrapper(r.stdout))
    problems.push(
      `agent-browser in the model's shell is ${r.stdout || 'not found'}, not the guard's wrapper`
    );
  // Login shells may reorder PATH (/etc/profile, path_helper, ~/bin): none
  // may find another agent-browser first.
  const logins = [bash];
  if (!isWin && shell && basename(shell) !== 'bash' && existsSync(shell)) logins.push(shell);
  for (const sh of logins) {
    r = run(`login-resolve:${basename(sh)}`, sh, ['-lc', which]);
    if (r.status === 0 && r.stdout && !isWrapper(r.stdout))
      problems.push(`${basename(sh)} -lc finds ${r.stdout} before the guard's wrapper`);
  }
  r = inModelShell('version', 'agent-browser --version');
  // A silent wrapper would match an empty version.
  if (!version) problems.push('the candidate itself reported no version');
  else if (r.status !== 0 || r.stdout !== version)
    problems.push(
      `agent-browser --version through the wrapper gave ${JSON.stringify(r.stdout)} (exit ${r.status}), not ${JSON.stringify(version)}`
    );
  r = inModelShell('wrapper-bad', 'agent-browser frobnicate-dogfood-guard-probe');
  if (r.status !== 126)
    problems.push(`the wrapper let a refused argument through (exit ${r.status})`);

  const logged = readBlocked(guard.log);
  seen.logged = logged.map((b) => `${b.layer} ${b.kind}`);
  for (const layer of ['hook', 'wrapper'])
    if (!logged.some((b) => b.layer === layer && b.kind === 'command'))
      problems.push(`the ${layer} did not log the call it should have blocked`);
  writeFileSync(guard.log, '');
  return { problems, seen };
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

function record(log, layer, problems, what) {
  for (const p of problems)
    appendFileSync(
      log,
      `${JSON.stringify({ at: new Date().toISOString(), layer, ...p, what: String(what).slice(0, 500) })}\n`
    );
}

function describe(problems) {
  return [...new Set(problems.map((p) => `${p.kind}: ${p.detail}`))].join('; ');
}

/**
 * The candidate's environment: the caller's, without agent-browser and proxy
 * variables other than the model's session, with the harness's values put
 * back.
 */
export function candidateEnv(env, { expectedEnv = {}, fixedEnv = {} }) {
  const fixed = { ...fixedEnv, ...expectedEnv };
  const fixedKeys = new Set(Object.keys(fixed).map((k) => k.toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const key = k.toUpperCase();
    if (fixedKeys.has(key) || PROXY_VARS.has(key)) continue;
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
    origins: config.origins ?? [],
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
        problems.push(
          ...checkArgs(c.map(String), {
            work: ctx.work,
            cwd: ctx.cwd,
            origins: ctx.origins,
            nested: true,
          })
        );
  }
  if (!problems.length && isWin && !INFO.has(rest[0])) {
    const collision = portProblem(sessionOf(args, process.env), config.expectedEnv);
    if (collision) problems.push(collision);
  }
  if (problems.length) {
    record(config.log, 'wrapper', problems, args.join(' '));
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
  record(config.log, 'hook', problems, JSON.stringify(event.tool_input ?? {}));
  // Exit code 2 blocks the tool call and shows stderr to the model.
  console.error(`Blocked by the dogfood harness: ${describe(problems)}`);
  process.exit(2);
}

// Compare real paths: on macOS the scenario dir is reached through the
// /var -> /private/var symlink, so argv[1] and import.meta.url differ.
function startedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsScript()) {
  const [mode, configPath, ...rest] = process.argv.slice(2);
  // Fail closed: a guard that cannot decide blocks the call. For the hook,
  // only exit code 2 blocks; any other failure would let the call through.
  try {
    if (mode !== 'exec' && mode !== 'hook') throw new Error(`unknown mode ${mode}`);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (mode === 'exec') await mainExec(config, rest);
    else mainHook(config);
  } catch (err) {
    // The log sits next to the config; run.mjs makes a guard error a
    // scenario error.
    try {
      record(
        join(dirname(resolve(String(configPath))), 'blocked.jsonl'),
        mode === 'exec' ? 'wrapper' : 'hook',
        [{ kind: 'guard-error', detail: String(err?.stack ?? err).slice(0, 2000) }],
        rest.join(' ')
      );
    } catch {}
    console.error(
      mode === 'exec'
        ? `agent-browser: blocked by the dogfood harness (guard error: ${err.message})`
        : `Blocked by the dogfood harness (guard error: ${err.message})`
    );
    process.exit(mode === 'exec' ? 126 : 2);
  }
}
