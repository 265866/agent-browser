// Negative controls for the dogfood checks: with no browser activity at all,
// every scenario must fail. A check that passes an empty run would let a
// broken candidate through.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkArgs, checkToolInput, installGuard, readBlocked } from './guard.mjs';

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

const guardPath = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs');

function guardFixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'df-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = join(base, 'work');
  mkdirSync(work);
  return { base, work, outside: join(base, 'outside') };
}

test('guard: agent-browser arguments that attach, use file: URLs, or leave the working directory are blocked', (t) => {
  const { work, outside } = guardFixture(t);
  const ctx = { work, cwd: work };
  const kinds = (args, extra = {}) => [
    ...new Set(checkArgs(args, { ...ctx, ...extra }).map((p) => p.kind)),
  ];
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
  const harnessEnv = { AGENT_BROWSER_SOCKET_DIR: join(work, '..', 'sock') };
  const withEnv = (env) => kinds(['snapshot'], { env, expectedEnv: harnessEnv });
  assert.deepEqual(withEnv({ ...harnessEnv, AGENT_BROWSER_CDP: '9222' }), ['attach']);
  assert.deepEqual(withEnv({ AGENT_BROWSER_SOCKET_DIR: outside }), ['attach']);
  assert.deepEqual(withEnv({}), ['attach']);
  assert.deepEqual(withEnv({ ...harnessEnv, AGENT_BROWSER_STATE: join(outside, 's.json') }), [
    'path',
  ]);
  // The core skill tells agents to export a session name.
  assert.deepEqual(withEnv({ ...harnessEnv, AGENT_BROWSER_SESSION: 'task-abc' }), []);
  assert.deepEqual(kinds(['open', 'file:///etc/passwd']), ['file-url']);
  assert.deepEqual(kinds(['open', 'FILE:///C:/Windows/win.ini']), ['file-url']);
  for (const args of [
    ['screenshot', join(outside, 'x.png')],
    ['state', 'save', join('..', 'state.json')],
    ['upload', '@e1', '~/.ssh/id_rsa'],
    [`--download-path=${outside}`, 'open', 'http://127.0.0.1:1/'],
    ['--args', `--user-data-dir=${outside}`, 'open', 'http://127.0.0.1:1/'],
  ])
    assert.deepEqual(kinds(args), ['path'], args.join(' '));
  for (const args of [
    ['open', 'http://127.0.0.1:5555/page?x=1'],
    ['screenshot', 'shot.png'],
    ['screenshot', join(work, 'sub', 'a.png')],
    ['state', 'save', './sub/state.json'],
    ['fill', '@e1', 'hello world'],
    ['eval', 'document.title.length / 2'],
    ['find', 'text', 'Sign in', 'click'],
    ['get', 'count', 'h1 ~ p'],
    ['wait', '2000'],
  ])
    assert.deepEqual(kinds(args, { env: {}, expectedEnv: {} }), [], args.join(' '));
});

test('guard: the hook checks Bash command text and file tool paths', (t) => {
  const { work, outside } = guardFixture(t);
  const ctx = { work, cwd: work };
  const kinds = (tool, input) => [...new Set(checkToolInput(tool, input, ctx).map((p) => p.kind))];
  assert.deepEqual(kinds('Bash', { command: 'agent-browser open http://x --cdp 9222' }), [
    'attach',
  ]);
  assert.deepEqual(kinds('Bash', { command: 'agent-browser open file:///etc/hosts' }), [
    'file-url',
  ]);
  assert.deepEqual(kinds('Bash', { command: 'agent-browser screenshot $HOME/x.png' }), ['path']);
  assert.deepEqual(
    kinds('Bash', { command: `agent-browser screenshot "${join(outside, 'x.png')}"` }),
    ['path']
  );
  assert.deepEqual(
    kinds('Bash', {
      command: 'agent-browser open http://127.0.0.1:1/ && agent-browser snapshot -i',
    }),
    []
  );
  assert.deepEqual(kinds('Bash', { command: 'sleep 2' }), []);
  assert.deepEqual(kinds('Write', { file_path: join(outside, 'a.txt') }), ['path']);
  assert.deepEqual(kinds('Read', { file_path: '~/.bashrc' }), ['path']);
  assert.deepEqual(kinds('Glob', { pattern: `${outside}/*` }), ['path']);
  assert.deepEqual(kinds('Write', { file_path: join(work, 'answer.txt') }), []);
  assert.deepEqual(kinds('Write', { file_path: 'answer.txt' }), []);
  assert.deepEqual(kinds('Glob', { pattern: '**/*.csv' }), []);
  assert.deepEqual(kinds('Grep', { pattern: 'x' }), []);
  if (process.platform === 'win32') {
    // Git Bash spells drive paths /d/...; only the working directory passes.
    const posix = (p) =>
      p
        .replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
        .split('\\')
        .join('/');
    assert.deepEqual(
      kinds('Bash', { command: `agent-browser screenshot ${posix(join(work, 'a.png'))}` }),
      []
    );
    assert.deepEqual(
      kinds('Bash', { command: `agent-browser screenshot ${posix(join(outside, 'a.png'))}` }),
      ['path']
    );
    assert.deepEqual(kinds('Bash', { command: 'agent-browser screenshot /tmp/a.png' }), ['path']);
  }
});

test('guard: the wrapper never starts the real binary for a blocked call and passes others through', (t) => {
  const { base, work, outside } = guardFixture(t);
  mkdirSync(outside);
  // The "real binary" is node itself, so a call that got through would run.
  const g = installGuard({
    dir: join(base, 'guard'),
    work,
    realExe: process.execPath,
    expectedEnv: {},
  });
  const wrapper = (args, env = {}) =>
    spawnSync(process.execPath, [guardPath, 'exec', join(base, 'guard', 'config.json'), ...args], {
      cwd: work,
      encoding: 'utf8',
      env: { ...scrubbed(), ...env },
    });
  assert.equal(wrapper(['-e', 'process.exit(7)']).status, 7);
  const target = join(outside, 'written.txt');
  const r = wrapper(['-e', `require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`]);
  assert.equal(r.status, 126);
  assert.match(r.stderr, /blocked by the dogfood harness/);
  assert.equal(existsSync(target), false, 'the blocked call must not run');
  assert.equal(wrapper(['open', 'about:blank', '--cdp', '9222']).status, 126);
  assert.equal(wrapper(['-e', 'process.exit(0)'], { AGENT_BROWSER_CDP: '9222' }).status, 126);
  const blocked = readBlocked(g.log);
  assert.deepEqual(
    blocked.map((b) => b.kind),
    ['path', 'attach', 'attach']
  );
  assert.ok(blocked.every((b) => b.layer === 'wrapper'));
  // The generated script is what the model's shell runs.
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
  if (existsSync(bash)) {
    const viaShell = spawnSync(bash, [join(g.binDir, 'agent-browser'), '-e', 'process.exit(5)'], {
      cwd: work,
      env: scrubbed(),
    });
    assert.equal(viaShell.status, 5);
  }
});

test('guard: the hook exits 2 for a blocked tool call and 0 otherwise', (t) => {
  const { base, work, outside } = guardFixture(t);
  installGuard({ dir: join(base, 'guard'), work, realExe: process.execPath, expectedEnv: {} });
  const hook = (event) =>
    spawnSync(process.execPath, [guardPath, 'hook', join(base, 'guard', 'config.json')], {
      input: JSON.stringify({ cwd: work, ...event }),
      encoding: 'utf8',
    });
  let r = hook({ tool_name: 'Bash', tool_input: { command: 'agent-browser open x --cdp 9222' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Blocked by the dogfood harness: attach/);
  r = hook({ tool_name: 'Write', tool_input: { file_path: join(outside, 'a.txt'), content: 'x' } });
  assert.equal(r.status, 2);
  r = hook({ tool_name: 'Write', tool_input: { file_path: join(work, 'a.txt'), content: 'x' } });
  assert.equal(r.status, 0);
  r = hook({ tool_name: 'Bash', tool_input: { command: 'agent-browser snapshot -i' } });
  assert.equal(r.status, 0);
});

// The wrapper compares agent-browser variables with the harness's, so tests
// start it without the host's.
function scrubbed() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^AGENT_BROWSER_/i.test(k))
  );
}
