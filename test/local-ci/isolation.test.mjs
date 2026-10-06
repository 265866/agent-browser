// Behavior tests for isolation.mjs using real processes and directories.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireLock,
  claimDir,
  isAlive,
  isStale,
  killProcessesUnder,
  scrubbedEnv,
  sweepOrphans,
} from './isolation.mjs';

const isolationUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'isolation.mjs')
).href;
const sleeper = (...args) =>
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args], { stdio: 'ignore' });
const waitExit = (child, ms) =>
  new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    child.on('exit', () => {
      clearTimeout(t);
      res(true);
    });
  });

test('killProcessesUnder stops a process that names the directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-kill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = sleeper(join(dir, 'marker'));
  await new Promise((r) => setTimeout(r, 300));
  killProcessesUnder([dir]);
  assert.equal(await waitExit(child, 10_000), true, 'child should have been stopped');
});

test('killProcessesUnder spares the calling process even when its argv names the directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-self-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sibling = sleeper(dir);
  t.after(() => sibling.kill());
  await new Promise((r) => setTimeout(r, 300));
  const script = `import(${JSON.stringify(isolationUrl)}).then((m) => { m.killProcessesUnder([process.argv[1]]); console.log('survived'); })`;
  const r = spawnSync(process.execPath, ['-e', script, dir], { encoding: 'utf8', timeout: 60_000 });
  assert.match(r.stdout, /survived/, `caller was stopped: ${r.stderr}`);
  assert.equal(await waitExit(sibling, 10_000), true, 'sibling should have been stopped');
});

test('killProcessesUnder matches whole directory names only', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'iso-prefix-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const other = sleeper(join(`${base}-10`, 'x'));
  t.after(() => other.kill());
  await new Promise((r) => setTimeout(r, 300));
  killProcessesUnder([`${base}-1`]);
  assert.equal(await waitExit(other, 1500), false, 'a longer sibling name must not match');
});

test('acquireLock excludes a second holder, releases idempotently, and breaks stale locks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, 'l.lock');
  const release = await acquireLock(lock, { timeoutMs: 1000 });
  await assert.rejects(acquireLock(lock, { timeoutMs: 2500 }), /timed out/);
  release();
  release();
  const again = await acquireLock(lock, { timeoutMs: 1000 });
  again();
  // A lock whose owner pid is gone is broken.
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), `999999 ${Date.now()}`);
  const stolen = await acquireLock(lock, { timeoutMs: 5000 });
  stolen();
  assert.equal(existsSync(lock), false);
});

test('acquireLock treats an unreadable owner file as live, not stale', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lock-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, 'l.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), '');
  await assert.rejects(acquireLock(lock, { timeoutMs: 2500 }), /timed out/);
  assert.equal(isStale(join(lock, 'owner')), false);
});

const OWNER = '.agent-browser-harness-owner';

test('sweepOrphans removes only harness directories of dead owners', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-sweep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = join(root, 'abdf-live');
  claimDir(live);
  const dead = join(root, 'abdf-dead');
  mkdirSync(dead);
  writeFileSync(join(dead, OWNER), `999999 ${Date.now()}`);
  // Half-written marker: not parseable, so not provably dead.
  const torn = join(root, 'abdf-torn');
  mkdirSync(torn);
  writeFileSync(join(torn, OWNER), '');
  // Another program's directory with its own ".owner" file, and a dead marker
  // outside the prefix: both must be left alone.
  const foreign = join(root, 'abdf-foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, '.owner'), 'someone else');
  const otherPrefix = join(root, 'other-dead');
  mkdirSync(otherPrefix);
  writeFileSync(join(otherPrefix, OWNER), `999999 ${Date.now()}`);
  const removed = [];
  sweepOrphans(root, ['abdf-'], (d) => removed.push(d));
  assert.deepEqual(removed, [dead]);
  for (const d of [live, torn, foreign, otherPrefix]) assert.equal(existsSync(d), true, d);
});

test('killProcessesUnder images match the executable, not the command line', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-image-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }));
  const copy = join(dir, process.platform === 'win32' ? 'node-copy.exe' : 'node-copy');
  copyFileSync(process.execPath, copy);
  if (process.platform !== 'win32') chmodSync(copy, 0o755);
  // Runs from the directory: must be stopped.
  const inside = spawn(copy, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  // Only mentions the directory on its command line: must survive.
  const mentions = sleeper(join(dir, 'whatever'));
  t.after(() => mentions.kill());
  await new Promise((r) => setTimeout(r, 500));
  killProcessesUnder([], { images: [dir] });
  assert.equal(
    await waitExit(inside, 10_000),
    true,
    'process running from the dir was not stopped'
  );
  assert.equal(await waitExit(mentions, 1500), false, 'a mere mention must not match');
});

test('scrubbedEnv drops agent-browser settings and credentials', () => {
  const env = scrubbedEnv({
    PATH: '/bin',
    AGENT_BROWSER_AUTO_CONNECT: '1',
    ANTHROPIC_AUTH_TOKEN: 'x',
    GITHUB_TOKEN: 'x',
    MY_API_KEY: 'x',
    SSH_AUTH_SOCK: '/tmp/agent',
    HOME: '/home/u',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

test('isAlive reports this process and rejects invalid pids', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(NaN), false);
});
