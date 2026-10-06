// Behavior tests for isolation.mjs using real processes and directories.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireLock,
  acquireProfileLease,
  claimDir,
  isAlive,
  killProcessesUnder,
  lockPortFor,
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

test('acquireLock excludes a second holder and releases idempotently', async (t) => {
  const lock = join(tmpdir(), `iso-lock-${process.pid}-a.lock`);
  const release = await acquireLock(lock, { timeoutMs: 1000 });
  await assert.rejects(
    acquireLock(lock, { timeoutMs: 1500 }),
    /already holds|timed out/
  );
  release();
  release();
  const again = await acquireLock(lock, { timeoutMs: 5000 });
  again();
});

// A child process takes the lock and reports it; returns the child.
async function holdInChild(lock) {
  const script = `
    const { acquireLock } = await import(${JSON.stringify(isolationUrl)});
    await acquireLock(process.argv[1], { timeoutMs: 10000 });
    console.log('held');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => {
    child.stdout.on('data', (d) => String(d).includes('held') && res());
    child.on('exit', (code) => rej(new Error(`holder exited ${code}`)));
  });
  return child;
}

test('a lock held by another process excludes this one and frees when that process is killed', async (t) => {
  const lock = join(tmpdir(), `iso-lock-${process.pid}-b.lock`);
  const child = await holdInChild(lock);
  t.after(() => child.kill('SIGKILL'));
  await assert.rejects(
    acquireLock(lock, { timeoutMs: 1500 }),
    new RegExp(`held by harness pid ${child.pid}`)
  );
  // A hard kill skips every handler; the kernel still frees the lock.
  child.kill('SIGKILL');
  assert.equal(await waitExit(child, 10_000), true);
  const t0 = Date.now();
  const release = await acquireLock(lock, { timeoutMs: 10_000 });
  release();
  assert.ok(Date.now() - t0 < 5000);
});

// Another program on a lock port makes acquireLock fail at once instead of
// waiting for the deadline or binding beside it.
async function assertForeignRefused(t, host) {
  const lock = `host:iso-test-foreign-${process.pid}-${host}`;
  const { port } = lockPortFor(lock);
  const foreign = createServer((s) => s.end('hello\n'));
  await new Promise((res) => foreign.listen({ port, host }, res));
  t.after(() => foreign.close());
  const t0 = Date.now();
  await assert.rejects(acquireLock(lock, { timeoutMs: 60_000 }), /another program listens on port/);
  assert.ok(Date.now() - t0 < 10_000);
}

test('acquireLock refuses a port another program listens on', (t) => assertForeignRefused(t, '127.0.0.1'));

// A wildcard listen on Windows can raise a firewall prompt, so this runs on
// Linux and macOS (the Linux leg runs these self-tests).
test(
  'acquireLock refuses a port another program listens on for all interfaces',
  { skip: process.platform === 'win32' },
  (t) => assertForeignRefused(t, '0.0.0.0')
);

test('lock ports are stable per path and stay in the reserved-free range', () => {
  const a = lockPortFor(join(tmpdir(), 'x', 'slot-1.lock'));
  assert.deepEqual(lockPortFor(join(tmpdir(), 'x', '.', 'slot-1.lock')), a);
  assert.deepEqual(lockPortFor(join(tmpdir(), 'x', 'y', '..', 'slot-1.lock')), a);
  if (process.platform === 'win32')
    assert.equal(lockPortFor(join(tmpdir(), 'X', 'SLOT-1.LOCK')).port, a.port);
  assert.notEqual(lockPortFor('host:real-home').port, lockPortFor('host:profile-lease').port);
  const base = Number(process.env.AGENT_BROWSER_HARNESS_LOCK_PORT_BASE) || 20_000;
  for (let i = 0; i < 200; i++) {
    const { port } = lockPortFor(join(tmpdir(), `p${i}.lock`));
    assert.ok(port >= base && port < base + 12_000);
  }
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

test('profile leases create, share, and remove a harness-owned directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agent-browser');
  const quarantine = join(root, 'quarantine');
  const first = await acquireProfileLease({ dir, quarantine });
  assert.equal(first.userOwned, false);
  assert.ok(existsSync(join(dir, '.created-by-agent-browser-test-harness')));
  // A live lease from another process keeps the directory.
  const script = `
    const { acquireProfileLease } = await import(${JSON.stringify(isolationUrl)});
    await acquireProfileLease({ dir: process.argv[1], quarantine: process.argv[2] });
    console.log('held');
    setInterval(() => {}, 1000);`;
  const other = spawn(process.execPath, ['--input-type=module', '-e', script, dir, quarantine], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => other.kill('SIGKILL'));
  await new Promise((res) => other.stdout.on('data', (d) => String(d).includes('held') && res()));
  // A lease file of a dead process does not count and is removed, and so
  // does one whose lock nobody holds even though its pid is alive (a reused
  // pid cannot keep a dead lease alive).
  writeFileSync(join(dir, '.harness-leases', '999999'), `999999 ${Date.now()}`);
  writeFileSync(join(dir, '.harness-leases', '1'), `${process.pid} ${Date.now()} 1 nobody`);
  assert.equal(await first.release(), '');
  assert.ok(existsSync(dir));
  assert.equal(existsSync(join(dir, '.harness-leases', '999999')), false);
  assert.equal(existsSync(join(dir, '.harness-leases', '1')), false);
  // Once the other holder is gone, the last release removes the directory.
  other.kill('SIGKILL');
  assert.equal(await waitExit(other, 10_000), true);
  const last = await acquireProfileLease({ dir, quarantine });
  writeFileSync(join(dir, 'written-meanwhile.json'), '{}');
  assert.match(await last.release(), /moved harness-owned/);
  assert.equal(existsSync(dir), false);
  // Anything written into it meanwhile stays recoverable in the quarantine.
  const [parked] = readdirSync(quarantine);
  assert.ok(existsSync(join(quarantine, parked, 'written-meanwhile.json')));
});

test('profile leases never touch a directory the user owns', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lease-user-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agent-browser');
  mkdirSync(dir);
  writeFileSync(join(dir, 'user-state.json'), '{}');
  const lease = await acquireProfileLease({ dir, quarantine: join(root, 'q') });
  assert.equal(lease.userOwned, true);
  assert.equal(await lease.release(), '');
  assert.deepEqual(readdirSync(dir), ['user-state.json']);
});

test('host lock names map to the same port whatever the working directory and temp dir', () => {
  const other = mkdtempSync(join(tmpdir(), 'iso-host-'));
  try {
    const script = `const { lockPortFor } = await import(${JSON.stringify(isolationUrl)}); console.log(lockPortFor('host:real-home').port);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: other,
      env: { ...process.env, TEMP: other, TMP: other, TMPDIR: other },
      encoding: 'utf8',
    });
    assert.equal(Number(r.stdout.trim()), lockPortFor('host:real-home').port);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test('a waiter takes the lock when a blocked holder releases it', async (t) => {
  const lock = `host:iso-test-release-${process.pid}`;
  // The holder blocks its event loop (as a synchronous cleanup step does), so
  // the waiter's probe connects but is closed without a greeting on release.
  const script = `
    const { acquireLock } = await import(${JSON.stringify(isolationUrl)});
    const release = await acquireLock(process.argv[1], { timeoutMs: 10000 });
    console.log('held');
    setTimeout(() => {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {}
      release();
    }, 1000);
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((res) => child.stdout.on('data', (d) => String(d).includes('held') && res()));
  const release = await acquireLock(lock, { timeoutMs: 20_000 });
  release();
});

// Windows refuses to listen on a port that a connected socket uses as its
// local port; elsewhere SO_REUSEADDR lets the listener bind, which is harmless.
test(
  'acquireLock reports a bound but non-listening socket instead of spinning',
  { skip: process.platform !== 'win32', timeout: 30_000 },
  async (t) => {
    const lock = `host:iso-test-bound-${process.pid}`;
    const { port } = lockPortFor(lock);
    const target = createServer(() => {});
    await new Promise((res) => target.listen({ port: 0, host: '127.0.0.1' }, res));
    const sock = connect({ port: target.address().port, host: '127.0.0.1', localAddress: '127.0.0.1', localPort: port });
    await new Promise((res, rej) => {
      sock.once('connect', res);
      sock.once('error', rej);
    });
    t.after(() => {
      sock.destroy();
      target.close();
    });
    const t0 = Date.now();
    await assert.rejects(acquireLock(lock, { timeoutMs: 1500 }), /bound to the port but not listening/);
    assert.ok(Date.now() - t0 < 10_000);
  }
);

test('a held lease never recreates a profile directory someone removed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lease-gone-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agent-browser');
  const lease = await acquireProfileLease({ dir, quarantine: join(root, 'q'), refreshMs: 100 });
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(existsSync(dir), false);
  assert.equal(await lease.release(), '');
  assert.equal(existsSync(dir), false);
});

test('a held lease puts back its own lease file while the directory is the harness\'s', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lease-file-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agent-browser');
  const lease = await acquireProfileLease({ dir, quarantine: join(root, 'q'), refreshMs: 100 });
  rmSync(join(dir, '.harness-leases'), { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(existsSync(join(dir, '.harness-leases', String(process.pid))));
  assert.match(await lease.release(), /moved harness-owned/);
});

test('quarantine purge removes only old harness-named entries', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lease-purge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const q = join(root, 'q');
  for (const name of ['1000000000000-5', '-x', '0-1', '1e3-foo', `${Date.now()}-7`]) mkdirSync(join(q, name), { recursive: true });
  const lease = await acquireProfileLease({ dir: join(root, '.agent-browser'), quarantine: q });
  await lease.release();
  const left = readdirSync(q).sort();
  assert.ok(!left.includes('1000000000000-5'));
  for (const name of ['-x', '0-1', '1e3-foo']) assert.ok(left.includes(name), name);
});

test('acquireLock gives up on a program that keeps accepting and dropping connections', { timeout: 120_000 }, async (t) => {
  const lock = `host:iso-test-dropper-${process.pid}`;
  const { port } = lockPortFor(lock);
  const dropper = createServer((s) => s.destroy());
  await new Promise((res) => dropper.listen({ port, host: '127.0.0.1' }, res));
  t.after(() => dropper.close());
  await assert.rejects(acquireLock(lock, { timeoutMs: 60 * 60_000 }), /another program listens on port/);
});

test('a held lease refreshes its file and records a listener that answers with its token', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lease-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agent-browser');
  const lease = await acquireProfileLease({ dir, quarantine: join(root, 'q'), refreshMs: 100 });
  const file = join(dir, '.harness-leases', String(process.pid));
  const first = readFileSync(file, 'utf8');
  await new Promise((r) => setTimeout(r, 400));
  const later = readFileSync(file, 'utf8');
  assert.notEqual(later, first);
  const [, , port, token] = later.trim().split(' ');
  const greeting = await new Promise((res) => {
    const sock = connect({ port: Number(port), host: '127.0.0.1' });
    let text = '';
    sock.on('data', (d) => (text += d));
    sock.on('close', () => res(text));
    sock.on('error', () => res(''));
  });
  assert.ok(greeting.trim().endsWith(token));
  await lease.release();
});
