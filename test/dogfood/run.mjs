#!/usr/bin/env node
// Dogfood harness: a real model (claude -p) uses a candidate agent-browser
// binary with Chrome for Testing to complete realistic tasks against local
// fixture pages. A deterministic check per scenario decides pass or fail from
// server-side observations and files on disk; the model's own report is never
// the verdict.
//
//   node test/dogfood/run.mjs --package <agent-browser-*.tgz> [--scenarios a,b] [--out DIR]
//   node test/dogfood/run.mjs --platform linux --package <tgz with the linux binary>
//   node test/dogfood/run.mjs --platform macos --remote <ssh-host> --package <tgz with the darwin binary>
//   node test/dogfood/run.mjs --package <source checkout> --binary <built agent-browser>   (dev builds)
//
// Needs ANTHROPIC_BASE_URL plus ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in the
// environment. See test/dogfood/README.md.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  copyFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureChrome } from '../local-ci/chrome.mjs';
import { startServer } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = dirname(HERE);
const isWin = process.platform === 'win32';
const GATEWAY_VARS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

const { values: opt } = parseArgs({
  options: {
    platform: { type: 'string', default: 'native' },
    package: { type: 'string' },
    binary: { type: 'string' },
    scenarios: { type: 'string' },
    out: { type: 'string' },
    model: { type: 'string', default: process.env.DOGFOOD_MODEL ?? 'claude-opus-5-5' },
    concurrency: { type: 'string', default: '3' },
    cache: { type: 'string', default: process.env.LOCAL_CI_CACHE ?? join(tmpdir(), 'abci-cache') },
    'chrome-version': { type: 'string', default: process.env.LOCAL_CI_CHROME_VERSION ?? 'stable' },
    remote: { type: 'string' },
    'remote-root': { type: 'string', default: '~/abw-zero' },
    'env-file': { type: 'string' },
    sha: { type: 'string' },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (opt.help) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 14)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n')
  );
  process.exit(0);
}
if (opt['env-file']) loadEnvFile(opt['env-file']);

const scenarios = await loadScenarios(opt.scenarios);
if (opt.list) {
  for (const s of scenarios)
    console.log(`${s.id.padEnd(18)} [${s.families.join(', ')}] ${s.title}`);
  process.exit(0);
}
if (!opt.package)
  die('--package is required (npm tarball from local CI, or a source checkout plus --binary)');
if (
  !process.env.ANTHROPIC_BASE_URL ||
  !(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY)
) {
  die('set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY)');
}
const out = resolve(
  opt.out ?? join(tmpdir(), 'agent-browser-dogfood', `${opt.platform}-${Date.now().toString(36)}`)
);
mkdirSync(out, { recursive: true });

let code;
if (opt.platform === 'native') code = await runNative();
else if (opt.platform === 'linux') code = await runLinux();
else if (opt.platform === 'macos') code = await runRemoteMac();
else die(`unknown --platform ${opt.platform}`);
process.exit(code);

// ---------------------------------------------------------------------------

async function runNative() {
  const pkg = resolve(opt.package);
  if (!existsSync(pkg)) die(`package not found: ${pkg}`);
  if (opt.binary && !existsSync(opt.binary)) die(`binary not found: ${opt.binary}`);
  const chrome = await ensureChrome({
    cacheDir: resolve(opt.cache),
    version: opt['chrome-version'],
  });
  // Stage once to read the version; each scenario stages its own copy.
  const probeRoot = mkdtempSync(join(tmpdir(), 'abdf-probe-'));
  const probe = stagePackage(probeRoot);
  const version = spawnSync(probe, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null;
  rmSync(probeRoot, { recursive: true, force: true });
  const receipt = {
    schema: 1,
    platform: process.platform,
    arch: process.arch,
    host: hostname(),
    sha: opt.sha ?? null,
    package: pkg,
    binary: opt.binary ? resolve(opt.binary) : null,
    binaryVersion: version,
    model: opt.model,
    chrome: chrome.version,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    scenarios: [],
  };
  const save = () =>
    writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  save();

  const queue = [...scenarios];
  const workers = Array.from({ length: Math.max(1, Number(opt.concurrency)) }, async () => {
    while (queue.length) {
      const s = queue.shift();
      const r = await runScenario(s, chrome.path);
      receipt.scenarios.push(r);
      save();
      console.log(
        `[dogfood] ${r.status.padEnd(5)} ${s.id} (${r.durationSec}s, ${r.claude?.num_turns ?? '?'} turns)${r.reasons.length ? `: ${r.reasons.join('; ')}` : ''}`
      );
    }
  });
  await Promise.all(workers);
  receipt.scenarios.sort((a, b) => a.id.localeCompare(b.id));
  receipt.result = receipt.scenarios.every((s) => s.status === 'pass') ? 'pass' : 'fail';
  receipt.finishedAt = new Date().toISOString();
  save();
  console.log(
    `[dogfood] ${receipt.result}: ${receipt.scenarios.filter((s) => s.status === 'pass').length}/${receipt.scenarios.length} passed; receipt ${join(out, 'receipt.json')}`
  );
  return receipt.result === 'pass' ? 0 : 1;
}

// Lays out the candidate the way an npm install does (bin/ next to skills/
// and skill-data/) so `skills get` resolves from the package, and returns the
// native binary to run. A directory package is a source checkout; its native
// binary comes from --binary.
function stagePackage(root) {
  const src = resolve(opt.package);
  let pkgRoot;
  if (src.endsWith('.tgz')) {
    const dest = join(root, 'pkg');
    mkdirSync(dest, { recursive: true });
    const tar = isWin ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tar, ['-xzf', src, '-C', dest], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`extract ${src}: ${r.stderr}`);
    pkgRoot = join(dest, 'package');
  } else {
    pkgRoot = join(root, 'pkg');
    for (const d of ['bin', 'skills', 'skill-data'])
      cpSync(join(src, d), join(pkgRoot, d), { recursive: true });
    cpSync(join(src, 'package.json'), join(pkgRoot, 'package.json'));
  }
  const native = join(pkgRoot, 'bin', `agent-browser-${platformKey()}${isWin ? '.exe' : ''}`);
  if (opt.binary) copyFileSync(resolve(opt.binary), native);
  if (!existsSync(native)) throw new Error(`package has no ${basename(native)}; pass --binary`);
  // npm global installs point the agent-browser command at the native binary.
  const exe = join(pkgRoot, 'bin', isWin ? 'agent-browser.exe' : 'agent-browser');
  copyFileSync(native, exe);
  if (!isWin) chmodSync(exe, 0o755);
  return exe;
}

function platformKey() {
  const os = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform];
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

async function runScenario(s, chromePath) {
  const sout = join(out, s.id);
  mkdirSync(sout, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), `abdf-${s.id}-`));
  const dirs = Object.fromEntries(['work', 'home', 'claude', 'tmp'].map((d) => [d, join(root, d)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // Unix socket paths are length-limited (about 104 bytes on macOS).
  const sockDir = isWin ? join(root, 'sock') : mkdtempSync('/tmp/abdf-');
  const exe = stagePackage(root);
  dirs.bin = dirname(exe);

  const rng = {
    hex: (n) =>
      randomBytes(Math.ceil(n / 2))
        .toString('hex')
        .slice(0, n),
    int: (n) => randomInt(n),
  };
  const tokens = s.tokens(rng);
  const server = await startServer(s, tokens);
  const env = isolatedEnv({ dirs, sockDir, chromePath });
  const t0 = Date.now();
  const result = {
    id: s.id,
    families: s.families,
    status: 'fail',
    reasons: [],
    durationSec: null,
    claude: null,
  };

  const agentBrowser = (args, timeoutMs = 60_000) =>
    run(exe, args, { env, cwd: dirs.work, timeoutMs });
  try {
    const skill = await agentBrowser(['skills', 'get', 'core']);
    writeFileSync(join(sout, 'skill.md'), skill.stdout);
    if (skill.code !== 0 || skill.stdout.trim().length < 200) {
      result.status = 'error';
      result.reasons.push(
        `agent-browser skills get core failed (exit ${skill.code}): ${skill.stderr.slice(0, 300)}`
      );
      return result;
    }
    const skillFile = join(root, 'skill.md');
    writeFileSync(skillFile, skill.stdout);

    const prompt = [
      'You are an AI agent using the agent-browser CLI, which is on PATH as `agent-browser`. Its core skill (usage guide) is in your system prompt; follow it.',
      'Use agent-browser for all browser work. Write any requested files in the current working directory.',
      '',
      `Task: ${s.prompt(server.base, tokens)}`,
    ].join('\n');
    writeFileSync(join(sout, 'prompt.txt'), prompt);
    const claudeArgs = [
      '-p',
      '--model',
      opt.model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(s.maxTurns),
      '--no-session-persistence',
      '--strict-mcp-config',
      '--append-system-prompt-file',
      skillFile,
      '--allowedTools',
      'Bash(agent-browser:*)',
      'Bash(sleep:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      '--disallowedTools',
      'WebFetch',
      'WebSearch',
      'Task',
    ];
    const c = await run('claude', claudeArgs, {
      env,
      cwd: dirs.work,
      input: prompt,
      timeoutMs: s.timeoutSec * 1000,
    });
    writeFileSync(join(sout, 'transcript.jsonl'), c.stdout);
    writeFileSync(join(sout, 'claude.stderr.txt'), c.stderr);
    const final = c.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e?.type === 'result')
      .at(-1);
    result.claude = final
      ? {
          subtype: final.subtype,
          is_error: final.is_error,
          num_turns: final.num_turns,
          total_cost_usd: final.total_cost_usd,
          duration_ms: final.duration_ms,
        }
      : { subtype: c.timedOut ? 'timeout' : 'no-result', exit: c.code };
    if (c.timedOut) result.reasons.push(`model run hit the ${s.timeoutSec}s wall-clock limit`);

    // Verdict: deterministic check of observed end state only.
    const file = (name) => {
      const p = join(dirs.work, name);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    };
    const reasons = await s.check({
      events: server.events,
      requests: server.requests,
      tokens,
      base: server.base,
      file,
      path: (name) => join(dirs.work, name),
      agentBrowser,
    });
    result.reasons.push(...reasons);
    result.status = reasons.length === 0 ? 'pass' : 'fail';
    if (c.timedOut && result.status === 'pass') result.reasons.push('(passed despite timeout)');
  } catch (err) {
    result.status = 'error';
    result.reasons.push(`harness error: ${err.message}`);
  } finally {
    writeFileSync(join(sout, 'events.json'), JSON.stringify(server.events, null, 2));
    writeFileSync(
      join(sout, 'requests.json'),
      JSON.stringify(
        server.requests.map(({ headers, ...r }) => ({
          ...r,
          referer: headers.referer,
          cookie: headers.cookie,
        })),
        null,
        2
      )
    );
    writeFileSync(join(sout, 'work-files.txt'), listFiles(dirs.work).join('\n'));
    await run(exe, ['close', '--all'], { env, cwd: dirs.work, timeoutMs: 30_000 }).catch(() => {});
    killProcessesUnder([root, sockDir]);
    await server.close();
    result.durationSec = Math.round((Date.now() - t0) / 1000);
    writeFileSync(join(sout, 'result.json'), JSON.stringify(result, null, 2));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    rmSync(sockDir, { recursive: true, force: true });
  }
  return result;
}

// Starts from the host environment minus anything agent-browser would read,
// then points every state location at the run's throwaway directories.
function isolatedEnv({ dirs, sockDir, chromePath }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('AGENT_BROWSER_') || k.startsWith('CLAUDE_') || k === 'Path') continue;
    env[k] = v;
  }
  const sep = isWin ? ';' : ':';
  env.PATH = `${dirs.bin}${sep}${process.env.PATH ?? process.env.Path ?? ''}`;
  env.TMPDIR = env.TMP = env.TEMP = dirs.tmp;
  if (!isWin) env.HOME = dirs.home;
  env.CLAUDE_CONFIG_DIR = dirs.claude;
  env.AGENT_BROWSER_SOCKET_DIR = sockDir;
  env.AGENT_BROWSER_EXECUTABLE_PATH = chromePath;
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

function run(cmd, args, { env, cwd, input, timeoutMs }) {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(input ?? '');
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      res({ code: 127, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    // Resolve on exit rather than on stream close: a detached daemon that
    // inherited our pipe handles can keep them open long after the command
    // returns. Give buffered output a moment to drain, then stop waiting.
    child.on('exit', (code) => {
      clearTimeout(timer);
      const done = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        res({ code: code ?? 1, stdout, stderr, timedOut });
      };
      const drain = setTimeout(done, 2000);
      child.on('close', () => {
        clearTimeout(drain);
        done();
      });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (isWin) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  else {
    spawnSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' });
    spawnSync('kill', ['-KILL', String(pid)], { stdio: 'ignore' });
  }
}

// Stops leftover daemons and browsers. Every process this run started has one
// of its unique throwaway paths in its image path or command line (the binary
// copy, the socket dir, or the temp profile under TMP).
function killProcessesUnder(paths) {
  if (isWin) {
    const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ps=@(${list}); Get-CimInstance Win32_Process | Where-Object { $c = "$($_.ExecutablePath) $($_.CommandLine)"; $ps | Where-Object { $c.ToLower().Contains($_.ToLower()) } } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore' }
    );
  } else {
    for (const p of paths) spawnSync('pkill', ['-KILL', '-f', p], { stdio: 'ignore' });
  }
}

// Remote and container runs take the npm tarball only: it carries the
// platform binary, so nothing else from the host needs to be shipped.
function requireTarball() {
  const pkg = resolve(opt.package);
  if (!pkg.endsWith('.tgz') || !existsSync(pkg))
    die(`--platform ${opt.platform} needs --package <agent-browser-*.tgz>`);
  if (opt.binary) die(`--binary is only supported for native runs`);
  return pkg;
}

function forwardedArgs() {
  return [
    '--model',
    opt.model,
    '--concurrency',
    opt.concurrency,
    '--chrome-version',
    opt['chrome-version'],
    ...(opt.scenarios ? ['--scenarios', opt.scenarios] : []),
    ...(opt.sha ? ['--sha', opt.sha] : []),
  ];
}

async function runLinux() {
  const pkg = requireTarball();
  const image = ensureImage();
  const args = [
    'run',
    '--rm',
    '--init',
    '--platform',
    'linux/amd64',
    '--shm-size=2g',
    '-v',
    `${dockerPath(HARNESS_ROOT)}:/harness:ro`,
    '-v',
    `${dockerPath(pkg)}:/opt/candidate/agent-browser.tgz:ro`,
    '-v',
    `${dockerPath(out)}:/out`,
    '-v',
    'abci-cache:/work/cache',
    ...GATEWAY_VARS.filter((k) => process.env[k]).flatMap((k) => ['-e', k]),
    image,
    'node',
    '/harness/dogfood/run.mjs',
    '--package',
    '/opt/candidate/agent-browser.tgz',
    '--out',
    '/out',
    '--cache',
    '/work/cache',
    ...forwardedArgs(),
  ];
  return stream('docker', args, 'linux');
}

async function runRemoteMac() {
  const host =
    opt.remote ?? die('--platform macos needs --remote <ssh-host> (or run natively on the Mac)');
  const pkg = requireTarball();
  const id = `df-${Date.now().toString(36)}`;
  const root = `${opt['remote-root']}/${id}`;
  const rel = (p) => p.replace(/^~\//, '');
  const ssh = (cmd, input) =>
    spawnSync('ssh', [host, `zsh -lic ${shq(cmd)}`], { encoding: 'utf8', input });
  let r = ssh(`mkdir -p ${root}/harness/dogfood/scenarios ${root}/harness/local-ci ${root}/out`);
  if (r.status !== 0) die(`ssh ${host}: ${r.stderr}`);
  const scp = (src, dst) => {
    const x = spawnSync('scp', ['-q', ...src, `${host}:${dst}`], { encoding: 'utf8' });
    if (x.status !== 0) die(`scp to ${host}: ${x.stderr}`);
  };
  scp([join(HARNESS_ROOT, 'local-ci', 'chrome.mjs')], `${rel(root)}/harness/local-ci/`);
  scp(
    ['run.mjs', 'server.mjs'].map((f) => join(HERE, f)),
    `${rel(root)}/harness/dogfood/`
  );
  scp(
    readdirSync(join(HERE, 'scenarios')).map((f) => join(HERE, 'scenarios', f)),
    `${rel(root)}/harness/dogfood/scenarios/`
  );
  scp([pkg], `${rel(root)}/agent-browser.tgz`);
  // The gateway credentials travel over ssh stdin into a 0600 file that is
  // deleted with the run directory.
  const envText = GATEWAY_VARS.filter((k) => process.env[k])
    .map((k) => `${k}=${process.env[k]}`)
    .join('\n');
  r = ssh(`umask 077 && cat > ${root}/.env`, envText);
  if (r.status !== 0) die(`could not stage env on ${host}`);
  const cmd = `node ${root}/harness/dogfood/run.mjs --package ${root}/agent-browser.tgz --env-file ${root}/.env --out ${root}/out --cache ${opt['remote-root']}/cache ${forwardedArgs().map(shq).join(' ')}`;
  const code = await stream('ssh', [host, `zsh -lic ${shq(cmd)}`], 'macos');
  const back = spawnSync('scp', ['-q', '-r', `${host}:${rel(root)}/out/.`, out], {
    encoding: 'utf8',
  });
  if (back.status !== 0) console.error(`[dogfood] could not copy results back: ${back.stderr}`);
  ssh(`rm -rf ${root}`);
  return code;
}

function ensureImage() {
  const file = join(HERE, 'linux.Dockerfile');
  const tag = `abdf-linux:${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)}`;
  if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0) return tag;
  const r = spawnSync(
    'docker',
    ['build', '--platform', 'linux/amd64', '-t', tag, '-f', file, HERE],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) die('docker build failed');
  return tag;
}

async function loadScenarios(filter) {
  const dir = join(HERE, 'scenarios');
  const all = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.mjs'))
    .sort()) {
    all.push((await import(pathToFileURL(join(dir, f)).href)).default);
  }
  if (!filter) return all;
  const want = filter.split(',').map((x) => x.trim());
  const missing = want.filter((w) => !all.some((s) => s.id === w));
  if (missing.length) die(`unknown scenarios: ${missing.join(', ')}`);
  return all.filter((s) => want.includes(s.id));
}

function listFiles(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
  );
}

function loadEnvFile(p) {
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

function stream(cmd, args, label) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const pipe = (src, dst) =>
      src.on('data', (d) => dst.write(String(d).replace(/^(?=.)/gm, `[${label}] `)));
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('error', (e) => {
      console.error(e.message);
      res(127);
    });
    // Exit, not close: a leaked daemon can hold inherited pipe handles open.
    child.on('exit', (c) => setTimeout(() => res(c ?? 1), 2000));
  });
}

function dockerPath(p) {
  return isWin ? p.replace(/\\/g, '/') : p;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function die(msg) {
  console.error(`dogfood: ${msg}`);
  process.exit(2);
}
