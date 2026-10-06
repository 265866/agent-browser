// Behavior tests for isolation.mjs using real processes and directories.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
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
  removeOwnWorktree,
  scrubbedEnv,
  sweepOrphans,
} from './isolation.mjs';
import { denyList, isDenied, startEgress, startProxy, vetHost } from './egress.mjs';
import { OWNER_LABEL, sweepDeadDocker } from './util.mjs';

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
  await assert.rejects(acquireLock(lock, { timeoutMs: 1500 }), /already holds|timed out/);
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
  await assert.rejects(acquireLock(lock, { timeoutMs: 60_000 }), /is used by another program/);
  assert.ok(Date.now() - t0 < 10_000);
}

test('acquireLock refuses a port another program listens on', (t) =>
  assertForeignRefused(t, '127.0.0.1'));

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
  // does one whose recorded listener does not answer even though its pid is
  // alive (a reused pid cannot keep a dead lease alive).
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
    const sock = connect({
      port: target.address().port,
      host: '127.0.0.1',
      localAddress: '127.0.0.1',
      localPort: port,
    });
    await new Promise((res, rej) => {
      sock.once('connect', res);
      sock.once('error', rej);
    });
    t.after(() => {
      sock.destroy();
      target.close();
    });
    const t0 = Date.now();
    await assert.rejects(
      acquireLock(lock, { timeoutMs: 1500 }),
      /bound to the port but not listening/
    );
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

test("a held lease puts back its own lease file while the directory is the harness's", async (t) => {
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
  for (const name of ['1000000000000-5', '-x', '0-1', '1e3-foo', `${Date.now()}-7`])
    mkdirSync(join(q, name), { recursive: true });
  const lease = await acquireProfileLease({ dir: join(root, '.agent-browser'), quarantine: q });
  await lease.release();
  const left = readdirSync(q).sort();
  assert.ok(!left.includes('1000000000000-5'));
  for (const name of ['-x', '0-1', '1e3-foo']) assert.ok(left.includes(name), name);
});

test(
  'acquireLock gives up on a program that keeps accepting and dropping connections',
  { timeout: 120_000 },
  async (t) => {
    const lock = `host:iso-test-dropper-${process.pid}`;
    const { port } = lockPortFor(lock);
    const dropper = createServer((s) => s.destroy());
    await new Promise((res) => dropper.listen({ port, host: '127.0.0.1' }, res));
    t.after(() => dropper.close());
    await assert.rejects(
      acquireLock(lock, { timeoutMs: 60 * 60_000 }),
      /is used by another program/
    );
  }
);

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

// Writes a lease line into a fresh harness-owned directory, releases a lease
// of this process, and reports whether that line survived the scan.
async function leaseSurvives(t, line) {
  const root = mkdtempSync(join(tmpdir(), 'iso-lease-judge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agent-browser');
  const lease = await acquireProfileLease({ dir, quarantine: join(root, 'q') });
  writeFileSync(join(dir, '.harness-leases', '7'), line);
  await lease.release();
  return existsSync(join(dir, '.harness-leases', '7'));
}

test('leases are judged by their listener, their pid, or their legacy format', async (t) => {
  // A listener that greets with another token belongs to someone else.
  const other = createServer((s) => s.end('agent-browser-harness-lock 1 not-the-token\n'));
  await new Promise((res) => other.listen({ port: 0, host: '127.0.0.1' }, res));
  t.after(() => other.close());
  assert.equal(await leaseSurvives(t, `${process.pid} 1 ${other.address().port} the-token`), false);
  // A silent listener counts only while the lease's pid is alive.
  const silent = createServer(() => {});
  await new Promise((res) => silent.listen({ port: 0, host: '127.0.0.1' }, res));
  t.after(() => silent.close());
  assert.equal(await leaseSurvives(t, `${process.pid} 1 ${silent.address().port} tok`), true);
  assert.equal(await leaseSurvives(t, `999999 1 ${silent.address().port} tok`), false);
  // Legacy lines count while their pid is alive.
  assert.equal(await leaseSurvives(t, `${process.pid} 1 host:profile-lease-1-abc`), true);
  assert.equal(await leaseSurvives(t, `999999 1 host:profile-lease-1-abc`), false);
  assert.equal(await leaseSurvives(t, `${process.pid} 1`), true);
});

test('a held lease comes back once a harness run restores the directory marker', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iso-lease-resume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agent-browser');
  const lease = await acquireProfileLease({ dir, quarantine: join(root, 'q'), refreshMs: 100 });
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 400));
  mkdirSync(dir);
  writeFileSync(join(dir, '.created-by-agent-browser-test-harness'), 'x');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(existsSync(join(dir, '.harness-leases', String(process.pid))));
  await lease.release();
});

test('removeOwnWorktree removes its worktree and leaves a missing user worktree registered', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'iso-wt-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }));
  const repo = join(base, 'repo');
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  mkdirSync(repo);
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const user = join(base, 'user-wt');
  const own = join(base, 'own-wt');
  git('worktree', 'add', '-q', '--detach', user);
  git('worktree', 'add', '-q', '--detach', own);
  // The user's worktree is on a drive that is not mounted right now.
  const away = join(base, 'user-wt-away');
  renameSync(user, away);
  removeOwnWorktree(repo, own);
  const listed = git('worktree', 'list', '--porcelain');
  const has = (p) => listed.toLowerCase().includes(p.split('\\').join('/').toLowerCase());
  assert.equal(existsSync(own), false);
  assert.equal(has(own), false, 'own worktree metadata should be gone');
  assert.equal(has(user), true, 'a missing user worktree must stay registered');
  renameSync(away, user);
});

test('the egress deny list covers every non-public and host address', () => {
  const list = denyList(['203.0.114.7']);
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.17.0.1',
    '172.31.255.255',
    '192.168.127.254',
    '192.168.65.254',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:7f00:1',
    '::ffff:0:a00:1',
    '2002:7f00:1::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '64:ff9b::a00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    // A public IPv6 address too: the proxy has no IPv6 route.
    '2606:4700::1111',
    '203.0.114.7',
    'not-an-ip',
  ])
    assert.equal(isDenied(list, ip), true, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '151.101.1.1', '172.32.0.1'])
    assert.equal(isDenied(list, ip), false, ip);
});

test('the egress proxy connects only to a vetted public address of a name', async () => {
  const list = denyList();
  const fake = (answers) => async () => answers.map((address) => ({ address }));
  assert.equal(
    await vetHost(list, 'x.test', fake(['127.0.0.1', '93.184.215.14'])),
    '93.184.215.14'
  );
  await assert.rejects(
    vetHost(list, 'host.docker.internal', fake(['192.168.127.254'])),
    /non-public or host addresses/
  );
  await assert.rejects(vetHost(list, '[::1]'), /non-public/);
  await assert.rejects(vetHost(list, '10.0.0.1'), /non-public/);
  // A name with only IPv6 answers, even public ones, is refused.
  await assert.rejects(
    vetHost(list, 'v6.test', fake(['2606:4700::1111', '::ffff:93.184.215.14'])),
    /non-public/
  );
});

test('the egress proxy refuses loopback targets without connecting to them', async (t) => {
  let reached = 0;
  const target = createServer((s) => {
    reached++;
    s.end('TARGET\n');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => target.close());
  const port = target.address().port;
  const logs = [];
  const proxy = await startProxy({ port: 0, host: '127.0.0.1', log: (l) => logs.push(l) });
  t.after(() => proxy.close());
  const proxyPort = proxy.address().port;
  const exchange = (text) =>
    new Promise((res) => {
      const s = connect({ port: proxyPort, host: '127.0.0.1' }, () => s.write(text));
      let data = '';
      s.on('data', (d) => (data += d));
      s.on('close', () => res(data));
      s.on('error', () => res(data));
      setTimeout(() => s.destroy(), 5000);
    });
  const tunnel = await exchange(
    `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`
  );
  assert.match(tunnel, /^HTTP\/1\.1 403/);
  const plain = await exchange(
    `GET http://localhost:${port}/ HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`
  );
  assert.match(plain, /^HTTP\/1\.1 403/);
  assert.equal(reached, 0, 'the proxy must not open a connection to a denied target');
  assert.equal(logs.filter((l) => l.startsWith('deny')).length, 2);
});

const dockerAvailable =
  spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
    .status === 0;

test(
  'sweepDeadDocker removes resources of a dead owner on this host only',
  { skip: !dockerAvailable && 'docker is not available' },
  async (t) => {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((r) => dead.on('exit', r));
    const label = (owner) => ['--label', `${OWNER_LABEL}=${owner}`];
    const names = {
      dead: `iso-sweep-dead-${process.pid}`,
      live: `iso-sweep-live-${process.pid}`,
      otherHost: `iso-sweep-other-${process.pid}`,
    };
    const owners = {
      dead: `${hostname()}/${process.platform}/${dead.pid}`,
      live: `${hostname()}/${process.platform}/${process.pid}`,
      otherHost: `not-${hostname()}/${process.platform}/${dead.pid}`,
    };
    t.after(() => {
      for (const n of Object.values(names))
        spawnSync('docker', ['network', 'rm', n], { stdio: 'ignore' });
    });
    for (const k of Object.keys(names)) {
      const r = spawnSync('docker', ['network', 'create', ...label(owners[k]), names[k]], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
    }
    const log = sweepDeadDocker();
    const exists = (n) =>
      spawnSync('docker', ['network', 'inspect', n], { stdio: 'ignore' }).status === 0;
    assert.match(log, new RegExp(`removed ${names.dead}`));
    assert.equal(exists(names.dead), false);
    assert.equal(exists(names.live), true);
    assert.equal(exists(names.otherHost), true);
  }
);

// The Linux image local CI builds from linux.Dockerfile, when it is present.
function linuxImage() {
  const dockerfile = join(dirname(fileURLToPath(import.meta.url)), 'linux.Dockerfile');
  const tag = `abci-linux:${createHash('sha256').update(readFileSync(dockerfile)).digest('hex').slice(0, 12)}`;
  return spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0
    ? tag
    : null;
}

test(
  'untrusted job containers cannot send raw packets and the egress proxy forwards none',
  { skip: (!dockerAvailable || !linuxImage()) && 'docker or the local CI image is not available' },
  async (t) => {
    const image = linuxImage();
    const labels = ['--label', `${OWNER_LABEL}=${hostname()}/${process.platform}/${process.pid}`];
    const egress = await startEgress({
      id: `iso-egress-${process.pid}`,
      image,
      ciDir: dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/'),
      labels,
    });
    t.after(() => egress.stop());
    const forwarding = spawnSync(
      'docker',
      [
        'exec',
        egress.proxy,
        'cat',
        '/proc/sys/net/ipv4/ip_forward',
        '/proc/sys/net/ipv6/conf/all/forwarding',
      ],
      { encoding: 'utf8' }
    );
    assert.equal(forwarding.status, 0, forwarding.stderr);
    assert.deepEqual(forwarding.stdout.split(/\s+/).filter(Boolean), ['0', '0']);
    const probe = `grep CapEff /proc/self/status
python3 -c 'import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW)' 2>&1 | tail -1
python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)' 2>&1 | tail -1`;
    const job = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--platform',
        'linux/amd64',
        ...labels,
        ...egress.dockerArgs,
        image,
        'sh',
        '-c',
        probe,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(job.status, 0, job.stderr);
    const capEff = BigInt(`0x${job.stdout.match(/CapEff:\s*([0-9a-f]+)/)[1]}`);
    const has = (bit) => (capEff & (1n << BigInt(bit))) !== 0n;
    assert.equal(has(12), false, 'CAP_NET_ADMIN');
    assert.equal(has(13), false, 'CAP_NET_RAW');
    assert.equal(has(27), false, 'CAP_MKNOD');
    assert.equal(job.stdout.match(/Operation not permitted/g)?.length, 2, job.stdout);
  }
);
