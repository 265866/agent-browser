// Negative controls for the dogfood checks: with no browser activity at all,
// every scenario must fail. A check that passes an empty run would let a
// broken candidate through.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  candidateEnv,
  checkArgs,
  checkCommand,
  checkToolInput,
  isInside,
  derivedPort,
  installGuard,
  readBlocked,
  sessionOf,
  splitGlobalFlags,
} from './guard.mjs';
import { startProxy } from './proxy.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
const rng = { hex: (n) => 'a'.repeat(n), int: () => 1 };

for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
  const s = (await import(pathToFileURL(join(dir, file)).href)).default;

  test(`${s.id}: shape`, () => {
    assert.equal(`${s.id}.mjs`, file);
    for (const k of ['title', 'prompt', 'check', 'tokens', 'files'])
      assert.ok(s[k], `missing ${k}`);
    assert.ok(s.families.length > 0);
    assert.ok(s.maxTurns > 0 && s.timeoutSec > 0);
    assert.ok(s.files['index.html'], 'scenarios start at index.html');
    assert.equal(typeof s.prompt('http://127.0.0.1:1', s.tokens(rng)), 'string');
  });

  test(`${s.id}: an empty run fails the check`, async () => {
    const reasons = await s.check({
      events: [],
      requests: [],
      tokens: s.tokens(rng),
      base: 'http://127.0.0.1:1',
      file: () => null,
      path: (name) => join('nonexistent-dogfood-dir', name),
      agentBrowser: async () => ({
        code: 1,
        stdout: '',
        stderr: 'not available in negative control',
      }),
    });
    assert.ok(
      Array.isArray(reasons) && reasons.length > 0,
      'check passed with no browser activity'
    );
  });
}

// ---- the guard that fences the model in before anything runs ----

const here = dirname(fileURLToPath(import.meta.url));
const guardPath = join(here, 'guard.mjs');
// The scenario's server, the only origin the browser may load.
const O = 'http://127.0.0.1:5555';
const origins = [O];

function guardFixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'df-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = join(base, 'work');
  mkdirSync(work);
  return { base, work, outside: join(base, 'outside') };
}

const kindsOf = (problems) => [...new Set(problems.map((p) => p.kind))];

test('guard: the wrapper allows the subcommands and flags the scenarios use', (t) => {
  const { work } = guardFixture(t);
  const ok = (args) => assert.deepEqual(checkArgs(args, { work, origins }), [], args.join(' '));
  ok(['open', `${O}/page?x=1`]);
  ok(['open']);
  ok(['open', 'about:blank']);
  ok(['--session', 'task-1', '--headed', 'open', `${O}/`]);
  ok(['snapshot', '-i']);
  ok(['screenshot', 'shot.png']);
  ok(['screenshot', '--full', join(work, 'sub', 'a.png')]);
  ok(['state', 'save', './sub/state.json']);
  ok(['download', '@e2', 'export.csv']);
  ok(['upload', '@e3', 'notes.txt']);
  ok(['wait', '--download', 'export.csv']);
  ok(['wait', '--text', 'Upload complete']);
  ok(['fill', '@e1', '/home/user typed into a field']);
  ok(['eval', "fetch('/export.csv').then((r) => r.status)"]);
  ok(['eval', '/paid/i.test(document.body.innerText)']);
  ok(['find', 'text', 'Sign in', 'click']);
  ok(['get', 'count', 'h1 ~ p']);
  ok(['network', 'route', '**/api/status', '--body', '{"status":"maintenance"}']);
  ok(['network', 'route', `${O}/api/status`, '--body', '{}']);
  ok(['cookies', 'set', 'session_hint', 'x', '--path', '/']);
  ok(['press', 'Control+k']);
  ok(['tab', 'new', `${O}/other`]);
  ok(['tab', 'new', '--label', 'docs', `${O}/docs`]);
  ok(['skills', 'get', 'core', '--full']);
  ok(['session', 'id', '--scope', 'worktree', '--prefix', 'task']);
  ok(['batch', `open ${O}/`, 'snapshot -i']);
  ok(['--download-path', join(work, 'dl'), 'open', `${O}/`]);
  // The core skill's persistence idiom, and named restore keys.
  ok(['--session', 'task-1', '--restore', 'open', `${O}/`]);
  ok(['--session', 'task-1', '--restore', '--restore-save', 'auto', 'open', `${O}/`]);
  ok(['--session', 'task-1', '--restore', '--restore-check-text', 'Dashboard', 'open', `${O}/`]);
  ok(['--restore', 'saved-login', 'open', `${O}/`]);
  ok(['--restore=saved-login', 'open', `${O}/`]);
  ok(['--restore-check-url', '**/account', '--restore-check-fn', 'window.ok', 'open', `${O}/`]);
  ok(['--help']);
  ok(['--version']);
});

test('guard: the wrapper reads --restore and its value the way the CLI does', () => {
  const split = (args) => splitGlobalFlags(args);
  assert.deepEqual(split(['--restore', 'open', 'x']).rest, ['open', 'x']);
  assert.deepEqual(split(['--restore', 'mykey', 'open', 'x']).rest, ['open', 'x']);
  assert.deepEqual(split(['--restore', 'mykey', 'open', 'x']).flags, [
    { name: '--restore', value: 'mykey' },
  ]);
  // A value that names a command is the command (key is one).
  assert.deepEqual(split(['--restore', 'key', 'Enter']).flags, [
    { name: '--restore', value: null },
  ]);
  // After the command, a bare --restore takes nothing.
  assert.deepEqual(split(['open', '--restore', 'x']).rest, ['open', 'x']);
  assert.deepEqual(split(['--restore', '--json', 'open']).rest, ['open']);
  // --flag=value forms stay with the command (the CLI does not read them).
  assert.deepEqual(split(['open', '--session=x', 'y']).rest, ['open', '--session=x', 'y']);
  assert.equal(sessionOf(['--session', 'a', '--session', 'b', 'open']), 'b');
  assert.equal(sessionOf(['open', '--session=a']), 'default');
  assert.equal(sessionOf(['open'], { AGENT_BROWSER_SESSION: 'env-s' }), 'env-s');
  assert.equal(
    sessionOf(['--session', 'flag-s', 'open'], { AGENT_BROWSER_SESSION: 'e' }),
    'flag-s'
  );
});

test('guard: the wrapper refuses every route to another browser, program, or daemon', (t) => {
  const { work, outside } = guardFixture(t);
  const kinds = (args) => kindsOf(checkArgs(args, { work, origins }));
  for (const args of [
    ['open', `${O}/`, '--cdp', '9222'],
    ['connect', '9222'],
    ['--session', 's', 'connect', '9222'],
    ['open', `${O}/`, '--profile', 'Default'],
    ['--auto-connect', 'snapshot'],
    ['--config', 'mine.json', 'open', `${O}/`],
    ['batch', `open ${O}/`, 'connect 9222'],
  ])
    assert.deepEqual(kinds(args), ['attach'], args.join(' '));
  assert.ok(kinds(['--cdp=9222', 'open', `${O}/`]).includes('attach'));
  for (const args of [
    ['mcp'],
    ['plugins', 'list'],
    ['plugin', 'run', 'x'],
    ['chat', 'hello'],
    ['install'],
    ['upgrade'],
    ['--executable-path', 'evil.sh', 'open', 'about:blank'],
    ['--namespace', '', 'open', 'about:blank'],
    ['-p', 'kernel', 'open', 'about:blank'],
    ['--provider', 'x', 'open', 'about:blank'],
    ['--engine', 'lightpanda', 'open', 'about:blank'],
    ['--extension', 'ext', 'open', 'about:blank'],
    ['--args', '--remote-debugging-port=9222', 'open', 'about:blank'],
    ['--allow-file-access', 'open', 'about:blank'],
    ['--proxy', 'http://127.0.0.1:8080', 'open', 'about:blank'],
    ['--proxy-bypass', '<loopback>', 'open', 'about:blank'],
    ['--session-name', 'x', 'open', 'about:blank'],
    ['batch', 'mcp'],
  ])
    assert.ok(kinds(args).includes('escape'), `${args.join(' ')}: ${kinds(args)}`);
  // Not needed by the scenarios: blocked and noted, but not a fence escape.
  for (const args of [
    ['dashboard', 'start'],
    ['stream', 'enable'],
    ['inspect'],
    ['profiles'],
    ['auth', 'list'],
    ['doctor', '--offline', '--quick'],
    ['clipboard', 'read'],
    ['frobnicate'],
    // The CLI would pass these to the command instead of reading the flag.
    [`--download-path=${outside}`, 'open', `${O}/`],
    ['open', `--session=x`, `${O}/`],
    [],
  ])
    assert.deepEqual(kinds(args), ['command'], args.join(' '));
  assert.deepEqual(kinds(['open', 'file:///etc/passwd']), ['file-url']);
  assert.deepEqual(kinds(['open', 'FILE:///C:/Windows/win.ini']), ['file-url']);
  for (const args of [
    ['screenshot', join(outside, 'x.png')],
    ['state', 'save', join('..', 'state.json')],
    ['upload', '@e1', '~/.ssh/id_rsa'],
    ['download', '@e2', join(outside, 'x.csv')],
    ['wait', '--download', join(outside, 'x.csv')],
    ['cookies', 'set', '--curl', join(outside, 'cookies.txt')],
    ['network', 'har', 'stop', join(outside, 'x.har')],
    ['screenshot', join('.claude', 'settings.json')],
    ['--download-path', outside, 'open', `${O}/`],
    ['--state', join(outside, 's.json'), 'open', `${O}/`],
    // The CLI splits batch commands with backslash escapes, as in a shell.
    ['batch', `screenshot ${outside.replace(/\\/g, '/')}/x.png`],
  ])
    assert.deepEqual(kinds(args), ['path'], args.join(' '));
});

test('guard: the wrapper lets the browser load only the scenario server', (t) => {
  const { work } = guardFixture(t);
  const kinds = (args) => kindsOf(checkArgs(args, { work, origins }));
  for (const args of [
    // The candidate's own loopback servers (stream server, CDP) and others.
    ['open', 'http://127.0.0.1:61234/api/command'],
    ['open', '127.0.0.1:61234'],
    ['goto', 'http://localhost:5555/'],
    ['navigate', 'https://example.com/'],
    ['open', 'http://127.0.0.1:5555.evil.test/'],
    ['open', 'data:text/html,<script>fetch("http://127.0.0.1:1")</script>'],
    ['open', 'javascript:alert(1)'],
    ['open', 'chrome://version'],
    ['--session', 's', 'open', '--headers', '{}', 'http://127.0.0.1:9222/json'],
    ['tab', 'new', 'http://127.0.0.1:9222/json'],
    ['tab', 'new', '--label', 'x', 'ws://127.0.0.1:9222/devtools/browser/x'],
    ['diff', 'url', `${O}/`, 'http://127.0.0.1:9222/'],
    ['record', 'start', 'out.webm', 'http://127.0.0.1:9222/'],
    ['batch', 'open http://127.0.0.1:9222/'],
    // Batch commands do not strip global flags: the URL is the first word
    // that is not a --flag.
    ['batch', 'open --session http://127.0.0.1:9222/'],
    ['fill', '@e1', 'http://127.0.0.1:9222/'],
  ])
    assert.ok(kinds(args).includes('url'), `${args.join(' ')}: ${kinds(args)}`);
  // Page script can still try; the harness proxy refuses those requests.
  assert.deepEqual(kinds(['eval', "location.href = 'http://127.0.0.1:9222/'"]), []);
});

test('guard: the wrapper refuses session and restore names the CLI would hash or misread', (t) => {
  const { work } = guardFixture(t);
  const kinds = (args, env) => kindsOf(checkArgs(args, { work, origins, env }));
  for (const name of ['a b', '../x', 'x/y', 'naïve', '', 'x'.repeat(65), 'a:b'])
    assert.deepEqual(kinds(['--session', name, 'snapshot']), ['session'], JSON.stringify(name));
  assert.deepEqual(kinds(['snapshot'], { AGENT_BROWSER_SESSION: 'x y' }), ['session']);
  assert.deepEqual(kinds(['--restore', 'a.b', 'open', `${O}/`]), ['session']);
  assert.deepEqual(kinds(['--restore=../x', 'open', `${O}/`]), ['session']);
  assert.deepEqual(kinds(['snapshot'], { AGENT_BROWSER_SESSION: 'task-1a2b' }), []);
});

test('guard: the wrapper allows only the session variable besides the harness settings', (t) => {
  const { work, outside } = guardFixture(t);
  const harnessEnv = {
    AGENT_BROWSER_SOCKET_DIR: join(work, '..', 'sock'),
    AGENT_BROWSER_NAMESPACE: 'df-x',
  };
  const kinds = (env) => kindsOf(checkArgs(['snapshot'], { work, env, expectedEnv: harnessEnv }));
  assert.deepEqual(kinds({ ...harnessEnv, PATH: '/bin' }), []);
  assert.deepEqual(kinds({ ...harnessEnv, AGENT_BROWSER_SESSION: 'task-abc' }), []);
  assert.deepEqual(kinds({ ...harnessEnv, AGENT_BROWSER_CDP: '9222' }), ['attach']);
  for (const extra of [
    { AGENT_BROWSER_PLUGINS: '[{"name":"x","command":"./evil.sh"}]' },
    { AGENT_BROWSER_PROVIDER: 'x' },
    { AGENT_BROWSER_EXECUTABLE_PATH: './evil.sh' },
    { AGENT_BROWSER_STATE: join(outside, 's.json') },
    { AGENT_BROWSER_SOCKET_DIR: outside },
    { AGENT_BROWSER_NAMESPACE: '' },
    { AGENT_BROWSER_PROXY: 'http://127.0.0.1:1' },
  ])
    assert.deepEqual(kinds({ ...harnessEnv, ...extra }), ['escape'], JSON.stringify(extra));
  assert.deepEqual(kinds({ AGENT_BROWSER_SOCKET_DIR: harnessEnv.AGENT_BROWSER_SOCKET_DIR }), [
    'escape',
  ]);
});

test('guard: the candidate gets no proxy variables but the harness settings', () => {
  const env = candidateEnv(
    {
      PATH: '/model/path',
      HTTP_PROXY: 'http://evil:1',
      https_proxy: 'http://evil:1',
      ALL_PROXY: 'socks5://evil:1',
      no_proxy: '*',
      AGENT_BROWSER_SESSION: 's',
      AGENT_BROWSER_PROVIDER: 'x',
      KEEP: '1',
    },
    { expectedEnv: { AGENT_BROWSER_PROXY: 'http://127.0.0.1:2' }, fixedEnv: { PATH: '/p' } }
  );
  assert.deepEqual(env, {
    AGENT_BROWSER_SESSION: 's',
    KEEP: '1',
    PATH: '/p',
    AGENT_BROWSER_PROXY: 'http://127.0.0.1:2',
  });
});

// The Bash commands the model ran in real dogfood runs, rewritten to the
// grammar the hook allows where they used other programs.
const SESSION_IDIOM =
  'export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix task)"';

test('guard: the hook allows agent-browser, sleep, and the core skill session idioms', () => {
  for (const command of [
    SESSION_IDIOM,
    `${SESSION_IDIOM}; agent-browser open ${O}/ && agent-browser snapshot -i`,
    `${SESSION_IDIOM}\nagent-browser download @e2 export.csv`,
    'SESSION="$(agent-browser session id --scope worktree --prefix my-app)"\nagent-browser --session "$SESSION" --restore open https://app.example.com',
    `cat <<'EOF' | agent-browser eval --stdin\nconst rows = document.querySelectorAll("table tbody tr");\nArray.from(rows).map(r => ({ name: r.cells[0].innerText, x: \`$\{1}\` }));\nEOF`,
    `${SESSION_IDIOM}; agent-browser open ${O}/ && cat <<'EOF' | agent-browser eval --stdin\n$(rm -rf /) \`id\` $HOME\nEOF\nagent-browser close`,
    "agent-browser eval --stdin <<'JS'\n1 + 1\nJS",
    'agent-browser batch <<-"EOF"\n\t[["snapshot"]]\n\tEOF',
    'export AGENT_BROWSER_SESSION=task-1853f50cd339; agent-browser fill @e5 "Ada d6c9" && agent-browser select @e7 "Team"',
    'AGENT_BROWSER_SESSION=task-545c068bb72d agent-browser close',
    'agent-browser --session "$AGENT_BROWSER_SESSION" eval \'document.title\' # check the title',
    'agent-browser --session "${AGENT_BROWSER_SESSION}" snapshot',
    'agent-browser --session "$(agent-browser session id --scope worktree --prefix task)" close',
    'agent-browser network route "**/api/status" --body \'{"status":"maintenance"}\'',
    'agent-browser eval "document.querySelector(\\"h1\\").textContent"',
    'agent-browser snapshot 2>&1',
    'agent-browser close >/dev/null 2>&1; sleep 2',
    'agent-browser skills get core --full 2>/dev/null',
    'sleep 0.5 && agent-browser wait --text "Report ready" --timeout 60000',
    'agent-browser press Control+k',
    'agent-browser open \\\n  http://127.0.0.1:1/',
    '# just a comment',
  ])
    assert.deepEqual(checkCommand(command), [], command);
});

test('guard: the hook refuses all other shell before bash sees it', () => {
  const refused = (command) => {
    const kinds = kindsOf(checkCommand(command));
    assert.ok(kinds.includes('command'), `${command}: ${kinds}`);
  };
  // ANSI-C and locale quoting, brace expansion, globs, tilde.
  for (const command of [
    "agent-browser eval $'\\x63at'",
    'agent-browser eval $"x"',
    'agent-browser screenshot {a,b}.png',
    'agent-browser screenshot x{1..3}',
    'agent-browser upload @e1 *.txt',
    'agent-browser upload @e1 notes.tx?',
    'agent-browser upload @e1 [n]otes.txt',
    'agent-browser upload @e1 ~/.ssh/id_rsa',
    'agent-browser open @(x)',
  ])
    refused(command);
  // File helpers and other programs.
  for (const command of [
    'cat notes.txt',
    'cp export.csv ../x.csv',
    'mv a b',
    'rm -rf ..',
    'mkdir -p .claude',
    'echo hi',
    'printf x',
    'ls',
    'head -5 export.csv',
    'curl http://127.0.0.1:1/export.csv',
    'node -e 1',
    "bash -c 'agent-browser open x'",
    'env AGENT_BROWSER_CDP=9222 agent-browser open x',
    'cd .. && agent-browser snapshot',
    '"agent-browser" open x',
    'a\\gent-browser open x',
    'agent-browser open x; python3 -c 1',
    'time agent-browser snapshot',
    'sleep $SESSION',
    'sleep 1 2',
    'cat <<EOF',
  ])
    refused(command);
  // Redirects to files, pipes into other programs, and other operators.
  for (const command of [
    'agent-browser snapshot > out.txt',
    'agent-browser snapshot >> out.txt',
    'agent-browser snapshot >| out.txt',
    'agent-browser snapshot &> out.txt',
    'agent-browser snapshot 2> err.txt',
    'agent-browser snapshot >&out.txt',
    'agent-browser snapshot >/dev/null#x',
    'agent-browser eval --stdin < code.js',
    'agent-browser eval --stdin <<< "1"',
    'agent-browser snapshot | tail -3',
    'agent-browser snapshot | agent-browser eval --stdin',
    "cat <<'EOF' | agent-browser eval --stdin | head\nx\nEOF",
    'agent-browser open x & agent-browser close',
    'agent-browser open x || true',
    'agent-browser open x;; true',
    '(agent-browser open x)',
    '{ agent-browser open x; }',
    'agent-browser open x\r\nrm y',
  ])
    refused(command);
  // Heredocs: only quoted delimiters, and nothing glued to the delimiter
  // (bash would read <<'EOF'x as the delimiter EOFx and run what follows).
  for (const command of [
    'cat <<EOF | agent-browser eval --stdin\n$(id)\nEOF',
    "cat <<'EOF'x | agent-browser eval --stdin\nEOF\nrm -rf x\nEOFx",
    "cat <<'EOF' <<'END' | agent-browser eval --stdin\nx\nEOF\ny\nEND",
    "cat 0<<'EOF' | agent-browser eval --stdin\nx\nEOF",
    "cat x <<'EOF' | agent-browser eval --stdin\nx\nEOF",
    "cat <<'EOF'\nx\nEOF",
  ])
    refused(command);
  // Command substitution and variables other than the session idioms.
  for (const command of [
    'agent-browser open "$(pwd)/x"',
    'agent-browser eval `id`',
    'agent-browser eval "`id`"',
    'agent-browser eval "$(agent-browser session id) $(id)"',
    'agent-browser eval $(agent-browser session id)',
    'agent-browser open $HOME',
    'agent-browser eval "$ANTHROPIC_AUTH_TOKEN"',
    'agent-browser eval "${AGENT_BROWSER_SESSION:-x}"',
    'agent-browser eval "$((1+1))"',
    'agent-browser eval "$1 $? $$"',
    'export PATH=/tmp',
    'export AGENT_BROWSER_SESSION',
    'export AGENT_BROWSER_SESSION="a b"',
    "export AGENT_BROWSER_SESSION='*'",
    'export AGENT_BROWSER_CDP=9222',
    'X=1 agent-browser open x',
    'SESSION="$(agent-browser session id; id)"',
    'SESSION="$(agent-browser connect 9222)"',
  ])
    refused(command);
  assert.ok(kindsOf(checkCommand('agent-browser open x --cdp 9222')).includes('attach'));
  assert.ok(kindsOf(checkCommand('agent-browser open file:///etc/hosts')).includes('file-url'));
});

test('guard: the hook allows only the scenario tools, inside the working directory', (t) => {
  const { work, outside } = guardFixture(t);
  const ctx = { work, cwd: work };
  const kinds = (tool, input) => kindsOf(checkToolInput(tool, input, ctx));
  for (const tool of ['PowerShell', 'Monitor', 'WebFetch', 'Agent', 'Task', 'CronCreate'])
    assert.deepEqual(kinds(tool, { command: 'Get-Content C:/x' }), ['tool'], tool);
  assert.deepEqual(kinds('Write', { file_path: join(outside, 'a.txt') }), ['path']);
  assert.deepEqual(kinds('Write', { file_path: join(work, '.claude', 'settings.json') }), ['path']);
  assert.deepEqual(kinds('Edit', { file_path: '.claude/settings.local.json' }), ['path']);
  assert.deepEqual(kinds('Read', { file_path: '~/.bashrc' }), ['path']);
  assert.deepEqual(kinds('Glob', { pattern: `${outside}/*` }), ['path']);
  assert.deepEqual(kinds('Write', { file_path: join(work, 'answer.txt') }), []);
  assert.deepEqual(kinds('Write', { file_path: 'answer.txt' }), []);
  assert.deepEqual(kinds('Read', { file_path: join(work, 'page.png') }), []);
  // Claude Code saves long tool output outside the working directory and
  // tells the model to read it there. Reading is allowed; writing is not.
  const saved = join(outside, 'projects', 'p', 'tool-results', 'b1.txt');
  const withSaved = (tool, input) =>
    kindsOf(checkToolInput(tool, input, { ...ctx, readDirs: [join(outside, 'projects')] }));
  assert.deepEqual(withSaved('Read', { file_path: saved }), []);
  assert.deepEqual(withSaved('Grep', { pattern: 'x', path: saved }), []);
  assert.deepEqual(withSaved('Write', { file_path: saved }), ['path']);
  assert.deepEqual(withSaved('Bash', { command: `tail -c 600 "${saved}"` }), ['command']);
  assert.deepEqual(withSaved('Read', { file_path: join(outside, 'other.txt') }), ['path']);
  assert.deepEqual(kinds('Glob', { pattern: '**/*.csv' }), []);
  assert.deepEqual(kinds('Grep', { pattern: 'x' }), []);
});

// A stand-in candidate that records how it was started.
function fakeCandidate(base) {
  const script = join(base, 'candidate.mjs');
  const record = join(base, 'ran.json');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`
  );
  return { script, record };
}

test('guard: the wrapper starts the candidate only for allowed calls, with the harness settings', (t) => {
  const { base, work, outside } = guardFixture(t);
  mkdirSync(outside);
  const { script, record } = fakeCandidate(base);
  const expectedEnv = {
    AGENT_BROWSER_NAMESPACE: 'df-x',
    AGENT_BROWSER_CONFIG: join(base, 'c.json'),
    AGENT_BROWSER_SOCKET_DIR: join(base, 'sock'),
  };
  const fixedEnv = { HOME: join(base, 'home'), PATH: process.env.PATH ?? process.env.Path };
  const g = installGuard({
    dir: join(base, 'guard'),
    work,
    realExe: process.execPath,
    realArgs: [script],
    expectedEnv,
    fixedEnv,
    origins,
  });
  const wrapper = (args, env = {}, input) => {
    rmSync(record, { force: true });
    const r = spawnSync(
      process.execPath,
      [join(base, 'guard', 'guard.mjs'), 'exec', join(base, 'guard', 'config.json'), ...args],
      {
        cwd: work,
        encoding: 'utf8',
        input,
        env: { ...scrubbed(), ...expectedEnv, ...env },
      }
    );
    return { ...r, ran: existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null };
  };
  let r = wrapper(['open', `${O}/`], {
    FAKE_EXIT: '7',
    AGENT_BROWSER_SESSION: 'task-1',
    HOME: outside,
    HTTPS_PROXY: 'http://127.0.0.1:1',
  });
  assert.equal(r.status, 7, r.stderr);
  assert.deepEqual(r.ran.argv, ['open', `${O}/`]);
  assert.equal(r.ran.env.AGENT_BROWSER_SESSION, 'task-1');
  assert.equal(r.ran.env.AGENT_BROWSER_NAMESPACE, 'df-x');
  assert.equal(r.ran.env.HOME, fixedEnv.HOME, 'the model cannot move the candidate home');
  assert.equal(r.ran.env.HTTPS_PROXY, undefined);
  for (const [args, env] of [
    [['mcp'], {}],
    [['open', 'about:blank'], { AGENT_BROWSER_PLUGINS: '[]' }],
    [['--executable-path', join(work, 'evil.sh'), 'open', 'about:blank'], {}],
    [['--namespace', '', 'open', 'about:blank'], {}],
    [['open', 'about:blank'], { AGENT_BROWSER_NAMESPACE: '' }],
    [['open', 'about:blank', '--cdp', '9222'], {}],
    [['screenshot', join(outside, 'x.png')], {}],
    [['open', 'http://127.0.0.1:9222/json'], {}],
    [['--session', 'a b', 'snapshot'], {}],
  ]) {
    r = wrapper(args, env);
    assert.equal(r.status, 126, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /blocked by the dogfood harness/);
    assert.equal(r.ran, null, `${args.join(' ')} must not start the candidate`);
  }
  // batch reads a JSON array of commands from stdin.
  r = wrapper(
    ['batch'],
    {},
    JSON.stringify([
      ['open', `${O}/`],
      ['connect', '9222'],
    ])
  );
  assert.equal(r.status, 126);
  assert.equal(r.ran, null);
  r = wrapper(['batch'], {}, JSON.stringify([['open', 'http://127.0.0.1:9222/']]));
  assert.equal(r.status, 126);
  r = wrapper(['batch'], {}, 'connect 9222');
  assert.equal(r.status, 126);
  r = wrapper(
    ['batch'],
    {},
    JSON.stringify([
      ['open', `${O}/`],
      ['snapshot', '-i'],
    ])
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ran.argv, ['batch']);
  // The word batch as an argument is text, not a batch reading stdin.
  r = wrapper(['fill', '@e1', 'batch'], {}, '');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ran.argv, ['fill', '@e1', 'batch']);
  assert.deepEqual(
    readBlocked(g.log).map((b) => b.layer),
    readBlocked(g.log).map(() => 'wrapper')
  );
  // The generated script is what the model's shell runs.
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
  if (existsSync(bash)) {
    rmSync(record, { force: true });
    const viaShell = spawnSync(bash, [join(g.binDir, 'agent-browser'), 'snapshot'], {
      cwd: work,
      env: { ...scrubbed(), ...expectedEnv, FAKE_EXIT: '5' },
    });
    assert.equal(viaShell.status, 5);
  }
});

test('guard: each scenario runs its own copy of the guard, with recorded hashes', (t) => {
  const { base, work } = guardFixture(t);
  const dir = join(base, 'guard');
  const g = installGuard({ dir, work, realExe: process.execPath, expectedEnv: {} });
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  assert.deepEqual(Object.keys(g.sha256).sort(), [
    'bin/agent-browser',
    'config.json',
    'guard.mjs',
    'settings.json',
  ]);
  assert.equal(g.sha256['guard.mjs'], sha(guardPath));
  for (const [f, h] of Object.entries(g.sha256)) assert.equal(sha(join(dir, f)), h, f);
  const copy = join(dir, 'guard.mjs').replace(/\\/g, '/');
  assert.ok(readFileSync(join(dir, 'bin', 'agent-browser'), 'utf8').includes(copy));
  assert.ok(readFileSync(g.settingsFile, 'utf8').includes(copy));
});

test('guard: a guard failure blocks the call and is logged as a guard error', (t) => {
  const { base, work, outside } = guardFixture(t);
  const g = installGuard({
    dir: join(base, 'guard'),
    work,
    realExe: process.execPath,
    expectedEnv: {},
  });
  const config = join(base, 'guard', 'config.json');
  const copy = join(base, 'guard', 'guard.mjs');
  const hook = (event, cfg = config, raw) =>
    spawnSync(process.execPath, [copy, 'hook', cfg], {
      input: raw ?? JSON.stringify({ cwd: work, ...event }),
      encoding: 'utf8',
    });
  let r = hook({ tool_name: 'Bash', tool_input: { command: 'agent-browser open x --cdp 9222' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Blocked by the dogfood harness: attach/);
  r = hook({ tool_name: 'Write', tool_input: { file_path: join(outside, 'a.txt'), content: 'x' } });
  assert.equal(r.status, 2);
  r = hook({ tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem ~' } });
  assert.equal(r.status, 2);
  r = hook({ tool_name: 'Write', tool_input: { file_path: join(work, 'a.txt'), content: 'x' } });
  assert.equal(r.status, 0, r.stderr);
  r = hook({ tool_name: 'Bash', tool_input: { command: 'agent-browser snapshot -i' } });
  assert.equal(r.status, 0, r.stderr);
  // A guard that cannot read its input or config blocks the call and says so
  // in the log, which run.mjs turns into a scenario error.
  r = hook(null, config, '{not json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /guard error/);
  writeFileSync(config, '{broken');
  r = spawnSync(process.execPath, [copy, 'exec', config, 'snapshot'], { encoding: 'utf8' });
  assert.equal(r.status, 126);
  assert.match(r.stderr, /guard error/);
  const errors = readBlocked(g.log).filter((b) => b.kind === 'guard-error');
  assert.deepEqual(
    errors.map((b) => b.layer),
    ['hook', 'wrapper']
  );
  r = spawnSync(process.execPath, [copy, 'hook', join(base, 'missing', 'c.json')], {
    input: '{}',
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
});

test('guard: derived Windows daemon ports match the CLI', () => {
  // Vectors from test_get_port_for_session in cli/src/connection.rs.
  assert.equal(derivedPort(undefined, 'default'), 50838);
  assert.equal(derivedPort(undefined, 'my-session'), 63105);
  assert.equal(derivedPort(undefined, 'work'), 51184);
  assert.equal(derivedPort(undefined, ''), 49152);
  // The namespace is sanitized before hashing, as the CLI does.
  assert.equal(derivedPort('Worktree: One', 'work'), derivedPort('worktree-one', 'work'));
  assert.notEqual(derivedPort('Worktree: One', 'work'), derivedPort('Worktree: Two', 'work'));
});

test(
  'guard: on Windows, a session whose derived port another program holds is refused without connecting',
  { skip: process.platform !== 'win32' && 'Windows only: Unix daemons use sockets' },
  async (t) => {
    const { base, work } = guardFixture(t);
    const { script, record } = fakeCandidate(base);
    const namespace = 'df-collide';
    let connections = 0;
    const listener = createServer((s) => {
      connections++;
      s.destroy();
    });
    t.after(() => listener.close());
    // A session name chosen so the CLI would connect to a port another
    // program listens on.
    let name = null;
    for (let i = 0; !name && i < 1000; i++) {
      const port = derivedPort(namespace, `s${i}`);
      const bound = await new Promise((r) => {
        listener.once('error', () => r(false));
        listener.listen(port, '127.0.0.1', () => r(true));
      });
      if (bound) name = `s${i}`;
    }
    assert.ok(name, 'found a free derived port to listen on');
    const sock = join(base, 'sock');
    const run = join(sock, 'namespaces', namespace, 'run');
    mkdirSync(run, { recursive: true });
    const expectedEnv = { AGENT_BROWSER_NAMESPACE: namespace, AGENT_BROWSER_SOCKET_DIR: sock };
    const g = installGuard({
      dir: join(base, 'guard'),
      work,
      realExe: process.execPath,
      realArgs: [script],
      expectedEnv,
      origins,
    });
    const wrapper = (args) => {
      rmSync(record, { force: true });
      return spawnSync(
        process.execPath,
        [join(base, 'guard', 'guard.mjs'), 'exec', join(base, 'guard', 'config.json'), ...args],
        {
          cwd: work,
          encoding: 'utf8',
          env: { ...scrubbed(), ...expectedEnv },
        }
      );
    };
    let r = wrapper(['--session', name, 'close']);
    assert.equal(r.status, 126, r.stderr);
    assert.match(r.stderr, /collision: session s\d+ maps to port \d+/);
    assert.equal(existsSync(record), false, 'the candidate must not start');
    assert.equal(connections, 0, 'the guard must not connect to the port');
    assert.equal(readBlocked(g.log).at(-1).kind, 'collision');
    // The session's own daemon (its .pid file names the listener) is fine,
    // and so is a session whose daemon wrote a .port file.
    writeFileSync(join(run, `${name}.pid`), String(process.pid));
    assert.equal(wrapper(['--session', name, 'close']).status, 0);
    writeFileSync(join(run, `${name}.pid`), '1');
    assert.equal(wrapper(['--session', name, 'close']).status, 126);
    writeFileSync(join(run, `${name}.port`), '50000');
    assert.equal(wrapper(['--session', name, 'close']).status, 0);
    assert.equal(connections, 0);
  }
);

test('proxy: forwards only the scenario origin and records what it refuses', async (t) => {
  const seen = [];
  const upstream = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url, host: req.headers.host, cookie: req.headers.cookie, body });
      res.writeHead(200, [
        'set-cookie',
        'a=1',
        'set-cookie',
        'b=2',
        'content-disposition',
        'attachment; filename="x.csv"',
      ]);
      res.end('hello');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await startProxy([origin]);
  t.after(() => proxy.close());
  const p = new URL(proxy.url);
  const viaProxy = (method, url, body) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: p.hostname,
          port: p.port,
          method,
          path: url,
          headers: { cookie: 'sid=1', ...(/^http/.test(url) && { host: new URL(url).host }) },
        },
        (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  let r = await viaProxy('POST', `${origin}/upload?x=1`, 'payload');
  assert.equal(r.status, 200);
  assert.equal(r.text, 'hello');
  assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);
  assert.equal(r.headers['content-disposition'], 'attachment; filename="x.csv"');
  assert.deepEqual(seen, [
    { url: '/upload?x=1', host: new URL(origin).host, cookie: 'sid=1', body: 'payload' },
  ]);
  for (const url of [
    'http://127.0.0.1:9/api/command',
    `${origin.replace('127.0.0.1', 'localhost')}/`,
    'http://example.com/',
    '/relative',
  ]) {
    r = await viaProxy('GET', url);
    assert.equal(r.status, 403, url);
  }
  const tunnel = await new Promise((resolve) => {
    const s = connect(Number(p.port), p.hostname, () =>
      s.write('CONNECT 127.0.0.1:9222 HTTP/1.1\r\nHost: 127.0.0.1:9222\r\n\r\n')
    );
    let text = '';
    s.on('data', (d) => (text += d));
    s.on('close', () => resolve(text));
    s.on('error', () => resolve(text));
  });
  assert.match(tunnel, /^HTTP\/1\.1 403/);
  assert.equal(seen.length, 1);
  assert.deepEqual(
    proxy.refused.map((x) => `${x.method} ${x.url}`),
    [
      'GET http://127.0.0.1:9/api/command',
      `GET ${origin.replace('127.0.0.1', 'localhost')}/`,
      'GET http://example.com/',
      'GET /relative',
      'CONNECT 127.0.0.1:9222',
    ]
  );
});

// ---- which packages dogfood accepts ----

const runMjs = join(here, 'run.mjs');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test('dogfood accepts a tarball only with trusted provenance', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'df-prov-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  const receipt = (dir, r) => put(join(dir, 'receipt.json'), JSON.stringify(r));
  // An unknown --platform stops the run right after the package check.
  const dogfood = (pkg, extra = []) =>
    spawnSync(
      process.execPath,
      [runMjs, '--package', pkg, '--platform', 'none', '--out', join(base, 'df-out'), ...extra],
      {
        encoding: 'utf8',
        env: {
          ...scrubbed(),
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          ANTHROPIC_AUTH_TOKEN: 'x',
        },
      }
    );
  const accepted = (r) => /unknown --platform none/.test(r.stderr);

  const trusted = join(base, 'trusted');
  const good = put(join(trusted, 'artifacts', 'agent-browser-1.0.0.tgz'), 'good');
  receipt(trusted, {
    untrusted: false,
    artifacts: [{ file: 'agent-browser-1.0.0.tgz', sha256: sha256('good') }],
  });
  let r = dogfood(good);
  assert.ok(accepted(r), r.stderr);

  const swapped = join(base, 'swapped');
  const other = put(join(swapped, 'artifacts', 'agent-browser-1.0.0.tgz'), 'other');
  receipt(swapped, {
    untrusted: false,
    artifacts: [{ file: 'agent-browser-1.0.0.tgz', sha256: sha256('good') }],
  });
  r = dogfood(other);
  assert.match(r.stderr, /not listed with its SHA-256/);

  // A receipt from before hashes were recorded, vouched for by hand.
  const old = join(base, 'old');
  const oldPkg = put(join(old, 'artifacts', 'agent-browser-1.0.0.tgz'), 'old');
  receipt(old, { ciResult: 'pass' });
  r = dogfood(oldPkg);
  assert.match(r.stderr, new RegExp(`--package-sha256 ${sha256('old')}`));
  assert.ok(accepted(dogfood(oldPkg, ['--package-sha256', sha256('old')])));
  assert.match(dogfood(oldPkg, ['--package-sha256', sha256('x')]).stderr, /does not match/);

  // Code under test planted a package and a receipt claiming trust in its
  // own output directory, below the host's untrusted receipt.
  const untrusted = join(base, 'untrusted');
  receipt(untrusted, { untrusted: true });
  const planted = put(join(untrusted, 'container', 'artifacts', 'agent-browser-1.0.0.tgz'), 'p');
  receipt(join(untrusted, 'container'), {
    untrusted: false,
    artifacts: [{ file: 'agent-browser-1.0.0.tgz', sha256: sha256('p') }],
  });
  r = dogfood(planted);
  assert.match(r.stderr, /inside the output of an --untrusted local CI run/);
  r = dogfood(planted, ['--package-sha256', sha256('p')]);
  assert.match(r.stderr, /inside the output of an --untrusted local CI run/);
});

// The wrapper compares agent-browser variables with the harness's, so tests
// start it without the host's.
function scrubbed() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^AGENT_BROWSER_/i.test(k))
  );
}

// macOS reaches its temp dir through the /var -> /private/var symlink, so the
// guard must recognise itself when started through a linked path; otherwise
// both the wrapper and the hook silently exit 0 without checking anything.
test('guard: still runs, and fails closed, when started through a linked directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'df-guard-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  mkdirSync(real);
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs'), join(real, 'guard.mjs'));
  const linked = join(root, 'linked');
  symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const missing = join(root, 'no-such-config.json');
  const hook = spawnSync(process.execPath, [join(linked, 'guard.mjs'), 'hook', missing], {
    input: '{}',
    encoding: 'utf8',
  });
  assert.equal(hook.status, 2, hook.stderr);
  const wrapper = spawnSync(
    process.execPath,
    [join(linked, 'guard.mjs'), 'exec', missing, 'snapshot'],
    {
      encoding: 'utf8',
    }
  );
  assert.equal(wrapper.status, 126, wrapper.stderr);
});

test('guard: a directory is the same however it is reached, and links out of it are outside', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'df-guard-canon-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'real', 'work');
  mkdirSync(work, { recursive: true });
  const linkedRoot = join(root, 'linked');
  symlinkSync(join(root, 'real'), linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedWork = join(linkedRoot, 'work');
  // Both spellings, for files that exist and that do not exist yet.
  writeFileSync(join(work, 'a.txt'), 'x');
  for (const [dir, p] of [
    [work, join(linkedWork, 'a.txt')],
    [linkedWork, join(work, 'a.txt')],
    [linkedWork, join(work, 'new', 'b.txt')],
    [work, 'relative.txt'],
  ])
    assert.equal(isInside(dir, p, linkedWork), true, `${p} in ${dir}`);
  assert.equal(isInside(work, join(root, 'real', 'other.txt'), work), false);
  // A link inside the work directory that leads out of it is outside.
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(work, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(isInside(work, join(work, 'escape', 'x.txt'), work), false);
});
