// Negative controls for the dogfood checks: with no browser activity at all,
// every scenario must fail. A check that passes an empty run would let a
// broken candidate through.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkArgs, checkCommand, checkToolInput, installGuard, readBlocked } from './guard.mjs';

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
  const ok = (args) => assert.deepEqual(checkArgs(args, { work }), [], args.join(' '));
  ok(['open', 'http://127.0.0.1:5555/page?x=1']);
  ok(['--session', 'task-1', '--headed', 'open', 'http://127.0.0.1:1/']);
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
  ok(['network', 'route', '/api/status', '--body', '{"status":"maintenance"}']);
  ok(['cookies', 'set', 'session_hint', 'x', '--path', '/']);
  ok(['press', 'Control+k']);
  ok(['skills', 'get', 'core', '--full']);
  ok(['session', 'id', '--scope', 'worktree', '--prefix', 'task']);
  ok(['batch', 'open http://127.0.0.1:1/', 'snapshot -i']);
  ok(['--download-path', join(work, 'dl'), 'open', 'http://127.0.0.1:1/']);
  ok(['--help']);
  ok(['--version']);
});

test('guard: the wrapper refuses every route to another browser, program, or daemon', (t) => {
  const { work, outside } = guardFixture(t);
  const kinds = (args) => kindsOf(checkArgs(args, { work }));
  for (const args of [
    ['open', 'http://127.0.0.1:1/', '--cdp', '9222'],
    ['--cdp=9222', 'open', 'http://127.0.0.1:1/'],
    ['connect', '9222'],
    ['--session', 's', 'connect', '9222'],
    ['open', 'http://127.0.0.1:1/', '--profile', 'Default'],
    ['--auto-connect', 'snapshot'],
    ['--config', 'mine.json', 'open', 'http://127.0.0.1:1/'],
    ['batch', 'open http://127.0.0.1:1/', 'connect 9222'],
  ])
    assert.deepEqual(kinds(args), ['attach'], args.join(' '));
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
    [`--download-path=${outside}`, 'open', 'http://127.0.0.1:1/'],
    ['--download-path', outside, 'open', 'http://127.0.0.1:1/'],
    ['--state', join(outside, 's.json'), 'open', 'http://127.0.0.1:1/'],
    // The CLI splits batch commands with backslash escapes, as in a shell.
    ['batch', `screenshot ${outside.replace(/\\/g, '/')}/x.png`],
  ])
    assert.deepEqual(kinds(args), ['path'], args.join(' '));
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
  ])
    assert.deepEqual(kinds({ ...harnessEnv, ...extra }), ['escape'], JSON.stringify(extra));
  assert.deepEqual(kinds({ AGENT_BROWSER_SOCKET_DIR: harnessEnv.AGENT_BROWSER_SOCKET_DIR }), [
    'escape',
  ]);
});

// The commands the model ran in real dogfood runs that the first guard
// misread as paths outside the working directory.
test('guard: the hook reads shell text without mistaking code, devices, and $(pwd) for paths', (t) => {
  const { work } = guardFixture(t);
  const ctx = { work, cwd: work };
  const session =
    'export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix task)"';
  for (const command of [
    `${session}; agent-browser download @e2 "$(pwd -W)/export.csv"; ls -la; head -5 export.csv`,
    'agent-browser skills get core --full 2>/dev/null | grep -i -n download | head -30',
    `${session}; agent-browser open http://127.0.0.1:64546/ && cat <<'EOF' | agent-browser eval --stdin\nArray.from(document.querySelectorAll("table")).map(t => Array.from(t.rows).map(r => Array.from(r.cells).map(c => c.innerText.trim()).join(" | ")).join("\\n")).join("\\n---\\n")\nEOF`,
    `rm wait.log; ${session}; cat <<'EOF' | agent-browser eval --stdin\nfetch('/export.csv').then(async r => r.status)\nEOF`,
    `cd "${work.replace(/\\/g, '/')}" && export AGENT_BROWSER_SESSION=task-1 && agent-browser upload @e3 "$(pwd -W)/notes.txt" && agent-browser click @e2`,
    'D="$(pwd)/dl"; mkdir -p dl; agent-browser --download-path "$D" open http://127.0.0.1:1/ >/dev/null 2>&1',
    'agent-browser eval "fetch(\'/api/x\')" > out.json && cat out.json',
    'agent-browser open http://127.0.0.1:1/ && agent-browser snapshot -i',
    'sleep 2',
    'printf "%s" "$PWD" && echo done',
  ])
    assert.deepEqual(checkCommand(command, ctx), [], command);
});

test('guard: the hook blocks programs, paths, variables, and settings outside the fence', (t) => {
  const { work, outside } = guardFixture(t);
  const ctx = { work, cwd: work };
  const kinds = (command) => kindsOf(checkCommand(command, ctx));
  const o = outside.replace(/\\/g, '/');
  assert.deepEqual(kinds('agent-browser open http://x --cdp 9222'), ['attach']);
  assert.deepEqual(kinds('agent-browser open file:///etc/hosts'), ['file-url']);
  for (const command of [
    `cat ${o}/secret.txt`,
    'ls ~/.ssh',
    'ls ~',
    'cat $HOME/.bashrc',
    'cat "${USERPROFILE}/x"',
    `agent-browser snapshot > ${o}/x.txt`,
    `agent-browser get text body >> ${o}/x.txt 2>&1`,
    'cp export.csv ../export.csv',
    `sort -o${o}/x export.csv`,
    `head "$(echo ${o})/passwd"`,
    `X=${o} ls`,
    'echo "{}" > .claude/settings.local.json',
    'mkdir -p .claude',
  ])
    assert.ok(kinds(command).includes('path'), `${command}: ${kinds(command)}`);
  for (const command of [
    'curl http://127.0.0.1:1/export.csv',
    'node -e 1',
    "bash -c 'agent-browser open x'",
    "sed 's/a/b/e' x",
    'env AGENT_BROWSER_CDP=9222 agent-browser open x',
    '$(echo agent-browser) open x',
    'echo $ANTHROPIC_AUTH_TOKEN',
    'agent-browser open x; python3 -c 1',
  ])
    assert.ok(kinds(command).includes('command'), `${command}: ${kinds(command)}`);
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
  // Claude Code saves long tool output outside the working directory and
  // tells the model to read it there. Reading is allowed; writing is not.
  const saved = join(outside, 'projects', 'p', 'tool-results', 'b1.txt');
  const withSaved = (tool, input) =>
    kindsOf(checkToolInput(tool, input, { ...ctx, readDirs: [join(outside, 'projects')] }));
  assert.deepEqual(withSaved('Read', { file_path: saved }), []);
  assert.deepEqual(withSaved('Bash', { command: `tail -c 600 "${saved}"` }), []);
  assert.deepEqual(withSaved('Write', { file_path: saved }), ['path']);
  assert.deepEqual(withSaved('Bash', { command: `cp x.txt "${saved}"` }), ['path']);
  assert.deepEqual(withSaved('Bash', { command: `echo x > "${saved}"` }), ['path']);
  assert.deepEqual(withSaved('Read', { file_path: join(outside, 'other.txt') }), ['path']);
  assert.deepEqual(kinds('Glob', { pattern: '**/*.csv' }), []);
  assert.deepEqual(kinds('Grep', { pattern: 'x' }), []);
  if (process.platform === 'win32') {
    // Git Bash spells drive paths /d/...; only the working directory passes.
    const posix = (p) =>
      p
        .replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
        .split('\\')
        .join('/');
    assert.deepEqual(kinds('Bash', { command: `ls ${posix(join(work, 'a.png'))}` }), []);
    assert.deepEqual(kinds('Bash', { command: `ls ${posix(join(outside, 'a.png'))}` }), ['path']);
    assert.deepEqual(kinds('Bash', { command: 'ls /tmp/a.png' }), ['path']);
  }
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
  };
  const fixedEnv = { HOME: join(base, 'home'), PATH: process.env.PATH ?? process.env.Path };
  const g = installGuard({
    dir: join(base, 'guard'),
    work,
    realExe: process.execPath,
    realArgs: [script],
    expectedEnv,
    fixedEnv,
  });
  const wrapper = (args, env = {}, input) => {
    rmSync(record, { force: true });
    const r = spawnSync(
      process.execPath,
      [guardPath, 'exec', join(base, 'guard', 'config.json'), ...args],
      { cwd: work, encoding: 'utf8', input, env: { ...scrubbed(), ...expectedEnv, ...env } }
    );
    return { ...r, ran: existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null };
  };
  let r = wrapper(['open', 'http://127.0.0.1:1/'], {
    FAKE_EXIT: '7',
    AGENT_BROWSER_SESSION: 'task-1',
    HOME: outside,
  });
  assert.equal(r.status, 7, r.stderr);
  assert.deepEqual(r.ran.argv, ['open', 'http://127.0.0.1:1/']);
  assert.equal(r.ran.env.AGENT_BROWSER_SESSION, 'task-1');
  assert.equal(r.ran.env.AGENT_BROWSER_NAMESPACE, 'df-x');
  assert.equal(r.ran.env.HOME, fixedEnv.HOME, 'the model cannot move the candidate home');
  for (const [args, env] of [
    [['mcp'], {}],
    [['open', 'about:blank'], { AGENT_BROWSER_PLUGINS: '[]' }],
    [['--executable-path', join(work, 'evil.sh'), 'open', 'about:blank'], {}],
    [['--namespace', '', 'open', 'about:blank'], {}],
    [['open', 'about:blank'], { AGENT_BROWSER_NAMESPACE: '' }],
    [['open', 'about:blank', '--cdp', '9222'], {}],
    [['screenshot', join(outside, 'x.png')], {}],
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
      ['open', 'http://x/'],
      ['connect', '9222'],
    ])
  );
  assert.equal(r.status, 126);
  assert.equal(r.ran, null);
  r = wrapper(['batch'], {}, 'connect 9222');
  assert.equal(r.status, 126);
  r = wrapper(
    ['batch'],
    {},
    JSON.stringify([
      ['open', 'http://x/'],
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

test('guard: the hook exits 2 for a blocked call, 0 otherwise, and 2 when it fails', (t) => {
  const { base, work, outside } = guardFixture(t);
  installGuard({ dir: join(base, 'guard'), work, realExe: process.execPath, expectedEnv: {} });
  const config = join(base, 'guard', 'config.json');
  const hook = (event, cfg = config, raw) =>
    spawnSync(process.execPath, [guardPath, 'hook', cfg], {
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
  // A guard that cannot read its input or config blocks the call.
  r = hook(null, config, '{not json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /guard error/);
  r = hook({ tool_name: 'Bash', tool_input: { command: 'sleep 1' } }, join(base, 'missing.json'));
  assert.equal(r.status, 2);
  r = spawnSync(process.execPath, [guardPath, 'exec', join(base, 'missing.json'), 'snapshot'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 126);
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
