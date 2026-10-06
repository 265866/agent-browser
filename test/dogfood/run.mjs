#!/usr/bin/env node
// Dogfood harness: a real model (claude -p) uses a candidate agent-browser
// build with Chrome for Testing to complete realistic tasks against local
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
// environment. Run it only on candidates whose diff has been reviewed: the
// candidate runs next to those credentials. See test/dogfood/README.md.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureChrome } from '../local-ci/chrome.mjs';
import {
  acquireProfileLease,
  describeProfileCheck,
  profileStateDir,
  claimDir,
  killProcessesUnder,
  killTree,
  probeStateHome,
  scrubbedEnv,
  snapshotDir,
  sweepOrphans,
  watchProfileDir,
} from '../local-ci/isolation.mjs';
import {
  SSH_OPTS,
  dockerPath,
  liveChildren,
  onInterrupt,
  ownerLabelArgs,
  remoteShell,
  shq,
  stream,
  supervisedRemoteScript,
  sweepDeadDocker,
} from '../local-ci/util.mjs';
import { ATTACH_PATTERN, WEBRTC_BLOCK, installGuard, probeGuard, readBlocked } from './guard.mjs';
import { isLoopback, startProxy } from './proxy.mjs';
import { startServer } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = dirname(HERE);
const isWin = process.platform === 'win32';
const GATEWAY_VARS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
// Proxy variables the candidate must not inherit (the CLI and its HTTP clients
// read them). The model process keeps the host's, to reach the gateway.
const PROXY_VARS = /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;
// Guard block kinds that make a scenario an error rather than a warning.
const ESCAPE_KINDS = new Set(['attach', 'escape']);
// Scenarios in progress, so an interrupt can stop their processes.
const activeScenarios = new Set();
// Set when the candidate keeps its state in AGENT_BROWSER_HOME (see
// probeStateHome): each scenario then gets a home of its own, and on Windows
// the run holds no lease on the real profile directory.
let stateHome = null;
// This run's scenario namespaces, which the profile check counts as its own.
const ownNamespaces = new Set();
let stopping = false;
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const { values: opt } = parseArgs({
  options: {
    platform: { type: 'string', default: 'native' },
    package: { type: 'string' },
    binary: { type: 'string' },
    scenarios: { type: 'string' },
    out: { type: 'string' },
    model: { type: 'string', default: process.env.DOGFOOD_MODEL ?? 'claude-opus-5-5' },
    concurrency: { type: 'string', default: '3' },
    // On Windows the OS temp dir is inside the user profile, which the model's
    // file tools are fenced off from, so there is no default there.
    'work-root': {
      type: 'string',
      default: process.env.DOGFOOD_WORK_ROOT ?? (isWin ? undefined : tmpdir()),
    },
    cache: {
      type: 'string',
      default: process.env.DOGFOOD_CACHE ?? join(tmpdir(), 'abdf-cache'),
    },
    'chrome-version': { type: 'string', default: process.env.LOCAL_CI_CHROME_VERSION ?? 'stable' },
    remote: { type: 'string' },
    'remote-root': { type: 'string', default: '~/abw-zero' },
    'env-file': { type: 'string' },
    // Vouches for a tarball that no trusted local CI receipt lists (see
    // packageProvenance). Parent runs pass it to container and remote runs.
    'package-sha256': { type: 'string' },
    sha: { type: 'string' },
    // Set by a parent run for container and remote runs, whose copy of the
    // harness is outside any repository.
    'harness-sha': { type: 'string' },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (opt.help) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 15)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n')
  );
  process.exit(0);
}
if (opt['env-file']) loadEnvFile(opt['env-file']);
if (!/^\d+$/.test(opt.concurrency) || Number(opt.concurrency) < 1)
  die(`--concurrency must be a whole number of at least 1, not ${JSON.stringify(opt.concurrency)}`);

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
const packageSha256 = packageProvenance(resolve(opt.package));
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
  if (!opt['work-root'])
    die(
      '--work-root (or DOGFOOD_WORK_ROOT) is required on Windows: a directory outside the user profile'
    );
  const workRoot = resolve(opt['work-root']);
  // The model's file tools are fenced off from the real home directory, so
  // working directories inside it would make every file write fail.
  const sep = isWin ? '\\' : '/';
  const norm = (p) => (isWin ? p.toLowerCase() : p);
  if (`${norm(workRoot)}${sep}`.startsWith(`${norm(homedir())}${sep}`))
    die(`--work-root ${workRoot} is inside the home directory; pick a directory outside it`);
  mkdirSync(workRoot, { recursive: true });
  // Remove scenario roots left by runs that were killed outright.
  const orphaned = [];
  sweepOrphans(workRoot, ['abdf-'], (dir) => {
    orphaned.push(dir);
    console.log(`[dogfood] removed leftovers of a dead run: ${dir}`);
  });
  if (!isWin) sweepOrphans('/tmp', ['abdf-']);
  const chrome = await ensureChrome({
    cacheDir: resolve(opt.cache),
    version: opt['chrome-version'],
  });
  // Stage once to read the version and to learn whether the candidate keeps
  // its state in AGENT_BROWSER_HOME; each scenario stages its own copy.
  const probeRoot = mkdtempSync(join(workRoot, 'abdf-probe-'));
  claimDir(probeRoot);
  // Unix socket paths are length-limited, and the state probe's namespace
  // makes them longer.
  const probeSock = isWin ? probeRoot : mkdtempSync('/tmp/abdf-');
  if (!isWin) claimDir(probeSock);
  let version = null;
  let stateProbe = null;
  try {
    const probe = stagePackage(probeRoot);
    const probeDirs = { bin: dirname(probe), tmp: probeRoot, home: probeRoot, claude: probeRoot };
    probeDirs.localappdata = probeDirs.appdata = probeRoot;
    version =
      spawnSync(probe, ['--version'], {
        encoding: 'utf8',
        env: isolatedEnv({
          dirs: probeDirs,
          sockDir: probeRoot,
          chromePath: chrome.path,
          namespace: namespaceFor(probeRoot),
        }),
      }).stdout?.trim() ?? null;
    stateProbe = probeStateHome({
      binary: probe,
      command: [probe],
      // The probe only opens about:blank; the browser gets a proxy that
      // refuses everything.
      env: isolatedEnv({
        dirs: probeDirs,
        sockDir: probeSock,
        chromePath: chrome.path,
        namespace: namespaceFor(probeRoot),
        proxy: 'http://127.0.0.1:9',
      }),
      home: join(probeRoot, 'agent-browser-home'),
    });
  } finally {
    killProcessesUnder([probeRoot, probeSock]);
    rmSync(probeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    rmSync(probeSock, { recursive: true, force: true });
  }
  stateHome = stateProbe.supported;
  console.log(
    `[dogfood] ${stateHome ? 'each scenario gets its own AGENT_BROWSER_HOME' : 'the candidate keeps state in the real profile directory'}: ${stateProbe.reason}`
  );
  const lease = stateHome
    ? { userOwned: false, release: async () => '' }
    : await acquireProfileLease();
  if (lease.userOwned)
    die(
      `${profileStateDir()} belongs to the user (it has no harness marker); scenarios run the real CLI, which can write there, so dogfood does not run on Windows while it exists`
    );
  // Only now is it known that the profile directory is the harness's.
  for (const dir of orphaned) removeNamespaceState(dir);
  // Scenarios with their own homes never touch the real profile directory;
  // watch it for the whole run to show that (isolation.mjs).
  const watcher =
    stateHome && isWin ? await watchProfileDir({ namespace: (ns) => ownNamespaces.has(ns) }) : null;
  onInterrupt(async () => {
    stopping = true;
    for (const ctx of activeScenarios) ctx.abort();
    console.log(`[dogfood] ${await lease.release()}`);
  });
  const receipt = {
    schema: 1,
    platform: process.platform,
    arch: process.arch,
    host: hostname(),
    sha: opt.sha ?? null,
    harness: harnessRevision(),
    package: pkg,
    packageSha256,
    binary: opt.binary ? resolve(opt.binary) : null,
    binaryVersion: version,
    stateHome: stateProbe,
    profileCheck: null,
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

  try {
    const queue = [...scenarios];
    const workers = Array.from({ length: Number(opt.concurrency) }, async () => {
      while (queue.length && !stopping) {
        const s = queue.shift();
        const r = await runScenario(s, chrome.path, workRoot);
        receipt.scenarios.push(r);
        save();
        const warn = r.warnings.length ? ` [warn: ${r.warnings.join('; ')}]` : '';
        console.log(
          `[dogfood] ${r.status.padEnd(5)} ${s.id} (${r.durationSec}s, ${r.claude?.num_turns ?? '?'} turns)${r.reasons.length ? `: ${r.reasons.join('; ')}` : ''}${warn}`
        );
      }
    });
    await Promise.all(workers);
  } finally {
    if (!stopping) {
      const note = await lease.release();
      if (note) console.log(`[dogfood] ${note}`);
    }
  }
  // The interrupt handler owns the exit once a signal has arrived.
  if (stopping) await new Promise(() => {});
  receipt.scenarios.sort((a, b) => a.id.localeCompare(b.id));
  // Every selected scenario must have run and passed.
  const ranAll =
    receipt.scenarios.length === scenarios.length &&
    scenarios.every((s) => receipt.scenarios.some((r) => r.id === s.id));
  receipt.result = ranAll && receipt.scenarios.every((s) => s.status === 'pass') ? 'pass' : 'fail';
  if (watcher) {
    const check = await watcher.stop();
    receipt.profileCheck = {
      status: check.status,
      summary: describeProfileCheck(check),
      leakCount: check.leaks.length,
      unattributedCount: check.unattributed.length,
      leaks: check.leaks.slice(0, 100),
      unattributed: check.unattributed.slice(0, 100),
      writers: check.writers,
    };
    console.log(`[dogfood] profile check: ${receipt.profileCheck.summary}`);
    // The candidate wrote the real profile directory although every scenario
    // had its own home.
    if (check.status === 'leak') receipt.result = 'fail';
  }
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
    const tar = isWin
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
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

async function runScenario(s, chromePath, workRoot) {
  const sout = join(out, s.id);
  mkdirSync(sout, { recursive: true });
  const t0 = Date.now();
  const result = {
    id: s.id,
    families: s.families,
    status: 'fail',
    reasons: [],
    warnings: [],
    durationSec: null,
    claude: null,
    guard: null,
  };
  const root = mkdtempSync(join(workRoot, `abdf-${s.id}-`));
  claimDir(root);
  ownNamespaces.add(namespaceFor(root).toLowerCase());
  // Unix socket paths are length-limited (about 104 bytes on macOS).
  const sockDir = isWin ? join(root, 'sock') : mkdtempSync('/tmp/abdf-');
  if (!isWin) claimDir(sockDir);
  let server = null;
  let proxy = null;
  let exe = null;
  let env = null;
  let guard = null;
  const workDir = join(root, 'work');
  // An interrupt stops this scenario's processes and removes its directories.
  const ctx = {
    abort() {
      for (const step of [
        () => killProcessesUnder([root, sockDir]),
        () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }),
        () => rmSync(sockDir, { recursive: true, force: true }),
        () => removeNamespaceState(root),
      ]) {
        try {
          step();
        } catch {}
      }
    },
  };
  activeScenarios.add(ctx);

  try {
    const dirs = Object.fromEntries(
      ['work', 'home', 'claude', 'tmp', 'appdata', 'localappdata']
        .concat(stateHome ? ['agent-browser-home'] : [])
        .map((d) => [d, join(root, d)])
    );
    result.stateHome = dirs['agent-browser-home'] ?? null;
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    exe = stagePackage(root);

    const rng = {
      hex: (n) =>
        randomBytes(Math.ceil(n / 2))
          .toString('hex')
          .slice(0, n),
      int: (n) => randomInt(n),
    };
    const tokens = s.tokens(rng);
    server = await startServer(s, tokens);
    // The browser reaches the network only through this proxy, which admits
    // the scenario's server and nothing else (proxy.mjs).
    proxy = await startProxy([server.base]);
    // WebRTC's STUN traffic is UDP, which no HTTP proxy sees: a page reached
    // loopback and LAN listeners through it. Pages get no RTCPeerConnection
    // (WEBRTC_BLOCK). The file is outside the working directory.
    const webrtcBlock = join(root, 'webrtc-block.js');
    writeFileSync(webrtcBlock, WEBRTC_BLOCK);
    env = isolatedEnv({
      dirs,
      sockDir,
      chromePath,
      namespace: namespaceFor(root),
      proxy: proxy.url,
      initScripts: [webrtcBlock],
    });
    // The CLI's own HTTP client (read) uses the generic proxy variables, so
    // the candidate gets the harness proxy there too, with no bypass list.
    // The model keeps the host's: it reaches the gateway with them.
    const proxyVars = Object.fromEntries(
      [
        ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map((k) => [k, proxy.url]),
        ['NO_PROXY', ''],
      ].flatMap(([k, v]) =>
        isWin
          ? [[k, v]]
          : [
              [k, v],
              [k.toLowerCase(), v],
            ]
      )
    );
    const candidate = { ...env, ...proxyVars };
    // The model reaches the candidate only through the guard's wrapper, and
    // its tools only through the guard's hook (guard.mjs). Both live outside
    // the working directory, the only place the model can write.
    const guardDir = join(root, 'guard');
    const pathSep = isWin ? ';' : ':';
    const modelEnv = {
      ...env,
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PROXY_VARS.test(k))),
      // Only absolute entries: a relative one would let the shell run a
      // program the model wrote into the working directory.
      PATH: [
        join(guardDir, 'bin'),
        ...(process.env.PATH ?? process.env.Path ?? '').split(pathSep).filter((p) => isAbsolute(p)),
      ].join(pathSep),
    };
    guard = installGuard({
      dir: guardDir,
      work: dirs.work,
      // Claude Code saves long tool output under projects/, and background
      // command output under its temp dir (<TMPDIR>/claude), and tells the
      // model to read them there.
      readDirs: [join(dirs.claude, 'projects'), join(dirs.tmp, 'claude')],
      realExe: exe,
      origins: [server.base],
      expectedEnv: Object.fromEntries(
        Object.entries(env).filter(([k]) => k.startsWith('AGENT_BROWSER_'))
      ),
      // The model's shell may change these; the candidate gets the harness's.
      fixedEnv: Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LOCALAPPDATA', 'APPDATA', 'CLAUDE_CONFIG_DIR']
          .filter((k) => modelEnv[k] !== undefined)
          .map((k) => [k, modelEnv[k]])
          .concat(Object.entries(proxyVars))
      ),
    });
    // The guard files this scenario ran, as copied at its start.
    result.guard = guard.sha256;
    for (const f of Object.keys(guard.sha256))
      cpSync(join(guardDir, f), join(sout, 'guard', f), { recursive: true });
    const agentBrowser = (args, timeoutMs = 60_000) =>
      run(exe, args, { env: candidate, cwd: dirs.work, timeoutMs });

    const skill = await agentBrowser(['skills', 'get', 'core']);
    writeFileSync(join(sout, 'skill.md'), skill.stdout);
    if (skill.code !== 0 || skill.stdout.trim().length < 200) {
      result.status = 'fail';
      result.reasons.push(
        `agent-browser skills get core failed (exit ${skill.code}): ${skill.stderr.slice(0, 300)}`
      );
      return result;
    }
    const skillFile = join(root, 'skill.md');
    writeFileSync(skillFile, skill.stdout);

    // The fence must be shown to work before the model runs in it.
    const version = (await agentBrowser(['--version'])).stdout.trim();
    const probe = probeGuard({ guard, env: modelEnv, cwd: dirs.work, version });
    writeFileSync(join(sout, 'guard-probes.json'), JSON.stringify(probe, null, 2));
    if (probe.problems.length) {
      result.status = 'error';
      result.reasons.push(`guard probe failed: ${probe.problems.join('; ')}`);
      return result;
    }

    const prompt = [
      'You are an AI agent using the agent-browser CLI, which is on PATH as `agent-browser`. Its core skill (usage guide) is in your system prompt; follow it.',
      'Use agent-browser for all browser work. Write any requested files in the current working directory.',
      'In this environment the Bash tool runs only agent-browser commands (also under timeout), sleep, true, and wait; use the Read and Write tools to read and create files.',
      'Always let agent-browser launch its own browser. Never connect to an existing browser: do not use `connect`, `--cdp`, `--auto-connect`, or `--profile`.',
      '',
      `Task: ${s.prompt(server.base, tokens)}`,
    ].join('\n');
    writeFileSync(join(sout, 'prompt.txt'), prompt);
    // Claude Code's file tools are not confined to the working directory by
    // allow rules, and it runs some read-only shell commands that no allow
    // rule names (measured: curl, ls, head). The guard's hook confines both,
    // and deny rules fence off the real home directory as well.
    const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
    const fenced = ['~/**', ...(isWin ? [] : [`/${homedir()}/**`])];
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
      // Only the throwaway CLAUDE_CONFIG_DIR's settings and --settings load.
      // The model can write work/.claude/settings*.json, which the project
      // and local sources would read.
      '--setting-sources',
      'user',
      '--settings',
      guard.settingsFile,
      // Every other built-in tool (PowerShell, Monitor, scheduling, agents,
      // worktrees) is removed; the hook allows only these as well.
      '--tools',
      ['Bash', ...fileTools].join(','),
      '--append-system-prompt-file',
      skillFile,
      '--allowedTools',
      'Bash(agent-browser:*)',
      'Bash(sleep:*)',
      ...fileTools,
      '--disallowedTools',
      ...fileTools.flatMap((t) => fenced.map((p) => `${t}(${p})`)),
      // The guard's wrapper refuses the attach forms it knows (connect,
      // --cdp, --auto-connect, --profile, --config, their variables, and the
      // mcp, plugin, and provider routes) before the candidate starts. These
      // prefix rules and the transcript audit below are further lines.
      'Bash(agent-browser connect:*)',
      'Bash(agent-browser --auto-connect:*)',
      'Bash(agent-browser --cdp:*)',
      'Bash(agent-browser --profile:*)',
      'WebFetch',
      'WebSearch',
      // The subagent tool: "Agent" in current Claude Code, "Task" before.
      'Agent',
      'Task',
    ];
    const c = await run('claude', claudeArgs, {
      env: modelEnv,
      cwd: dirs.work,
      input: prompt,
      timeoutMs: s.timeoutSec * 1000,
    });
    writeFileSync(join(sout, 'transcript.jsonl'), c.stdout);
    writeFileSync(join(sout, 'claude.stderr.txt'), c.stderr);
    const events = c.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const final = events.filter((e) => e.type === 'result').at(-1);
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

    // Verdict: deterministic check of the observed end state only.
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

    // A run that never got a model answer is infrastructure trouble, not a
    // verdict on the candidate (unless the check passed anyway).
    const infraFailure =
      !c.timedOut && (!final || final.subtype === 'error_during_execution' || final.num_turns <= 1);
    if (result.status === 'fail' && infraFailure) {
      result.status = 'error';
      result.reasons.push(
        `model run did not complete (${result.claude.subtype}); stderr: ${c.stderr.slice(0, 300)}`
      );
    }
    result.warnings.push(...commandCoverage(s, events));
    // The guard stopped these before they ran. An attempt to attach or to
    // leave the fence makes the run an error; a stray path, file: URL, or
    // other command is the model's detour, noted.
    const blocked = readBlocked(guard.log);
    writeFileSync(
      join(sout, 'guard-blocked.jsonl'),
      blocked.map((b) => JSON.stringify(b)).join('\n')
    );
    const attach = [
      ...blocked.filter((b) => ESCAPE_KINDS.has(b.kind)).map((b) => b.what),
      ...bashCommands(events).filter((cmd) => ATTACH_PATTERN.test(cmd)),
    ];
    if (attach.length) {
      result.status = 'error';
      result.reasons.push(
        `the model tried to attach to an existing browser or leave the harness's fence: ${attach[0].slice(0, 200)}`
      );
    }
    const guardErrors = blocked.filter((b) => b.kind === 'guard-error');
    if (guardErrors.length) {
      result.status = 'error';
      result.reasons.push(
        `the guard failed ${guardErrors.length} time(s) and blocked those calls: ${guardErrors[0].detail.split('\n')[0].slice(0, 200)}`
      );
    }
    for (const b of blocked.filter((x) => !ESCAPE_KINDS.has(x.kind) && x.kind !== 'guard-error'))
      result.warnings.push(`guard blocked (${b.layer}, ${b.kind}): ${b.detail.slice(0, 200)}`);
  } catch (err) {
    result.status = 'error';
    result.reasons.push(`harness error: ${err.message}`);
  } finally {
    if (server) {
      writeFileSync(join(sout, 'events.json'), JSON.stringify(server.events, null, 2));
      writeFileSync(
        join(sout, 'requests.json'),
        JSON.stringify(
          server.requests.map(({ headers, ...r }) => ({
            ...r,
            referer: headers.referer,
            cookie: headers.cookie,
            fetchMode: headers['sec-fetch-mode'],
          })),
          null,
          2
        )
      );
    }
    if (proxy) {
      writeFileSync(join(sout, 'proxy-refused.json'), JSON.stringify(proxy.refused, null, 2));
      const loopback = proxy.refused.filter((r) => isLoopback(r.url));
      if (loopback.length)
        result.warnings.push(
          `proxy refused ${loopback.length} request(s) to loopback addresses, first ${loopback[0].method} ${loopback[0].url.slice(0, 120)}`
        );
    }
    writeFileSync(join(sout, 'work-files.txt'), listFiles(workDir).join('\n'));
    if (exe && env) {
      await run(exe, ['close', '--all'], { env, cwd: workDir, timeoutMs: 30_000 }).catch(() => {});
    }
    // What the candidate kept in this scenario's own home.
    if (result.stateHome)
      writeFileSync(
        join(sout, 'state-home-files.txt'),
        [...snapshotDir(result.stateHome).keys()].sort().join('\n')
      );
    const stopped = killProcessesUnder([root, sockDir]);
    if (stopped) writeFileSync(join(sout, 'cleanup.txt'), stopped);
    await server?.close();
    await proxy?.close();
    // Cleanup does not judge the candidate. A directory still in use is
    // retried, and one that stays is removed by the next run's sweep.
    for (const issue of await removeScenarioDirs(root, sockDir))
      result.warnings.push(`cleanup: ${issue}`);
    result.durationSec = Math.round((Date.now() - t0) / 1000);
    writeFileSync(join(sout, 'result.json'), JSON.stringify(result, null, 2));
    activeScenarios.delete(ctx);
  }
  return result;
}

// Records, without failing the run, when the model never used the command
// family a scenario exists to exercise (for example it worked around a broken
// command with eval). `uses` is a list of any-of groups of subcommands.
function commandCoverage(s, events) {
  const text = bashCommands(events).join('\n');
  const missing = (s.uses ?? []).filter(
    (group) =>
      !group.some((cmd) => new RegExp(`agent-browser\\s+(?:\\S+\\s+)*?${cmd}\\b`).test(text))
  );
  return missing.map((g) => `never used ${g.join(' or ')}`);
}

function bashCommands(events) {
  const commands = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    for (const c of e.message?.content ?? []) {
      if (c.type === 'tool_use' && c.name === 'Bash') commands.push(String(c.input?.command ?? ''));
    }
  }
  return commands;
}

// Short and unique per scenario root; Unix socket paths have a 103-byte limit.
function namespaceFor(root) {
  return `df-${basename(root).replace(/^abdf-/, '')}`;
}

// Windows keeps namespaced state under the real profile directory unless the
// candidate reads AGENT_BROWSER_HOME; the namespace is unique to one scenario.
function removeNamespaceState(root) {
  if (!isWin || stateHome) return;
  try {
    rmSync(join(profileStateDir(), 'namespaces', namespaceFor(root)), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  } catch {}
}

// Starts from the host environment minus anything agent-browser would read or
// that looks like a credential, then adds back only the model gateway
// variables and points every state location at the run's throwaway dirs.
function isolatedEnv({ dirs, sockDir, chromePath, namespace, proxy, initScripts = [] }) {
  const env = scrubbedEnv();
  for (const k of Object.keys(env)) if (PROXY_VARS.test(k)) delete env[k];
  for (const k of GATEWAY_VARS) if (process.env[k]) env[k] = process.env[k];
  delete env.Path;
  const sep = isWin ? ';' : ':';
  env.PATH = [dirs.bin, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(sep);
  env.TMPDIR = env.TMP = env.TEMP = dirs.tmp;
  if (isWin) {
    // Chrome profile discovery reads LOCALAPPDATA. HOME has no effect on
    // where agent-browser keeps state on Windows (see isolation.mjs), but Git
    // Bash login shells, whose PATH Claude Code's Bash tool uses there, put
    // $HOME/bin first.
    env.LOCALAPPDATA = dirs.localappdata;
    env.APPDATA = dirs.appdata;
  }
  env.HOME = dirs.home;
  env.CLAUDE_CONFIG_DIR = dirs.claude;
  env.AGENT_BROWSER_SOCKET_DIR = sockDir;
  if (dirs['agent-browser-home']) env.AGENT_BROWSER_HOME = dirs['agent-browser-home'];
  // On Windows the daemon port derives from namespace and session name, not
  // the socket dir, so concurrent scenarios need distinct namespaces.
  env.AGENT_BROWSER_NAMESPACE = namespace;
  env.AGENT_BROWSER_EXECUTABLE_PATH = chromePath;
  // An empty config replaces any user config, which could set autoConnect,
  // cdp, or profile.
  env.AGENT_BROWSER_CONFIG = join(dirs.tmp, 'empty-config.json');
  writeFileSync(env.AGENT_BROWSER_CONFIG, '{}\n');
  // Chrome would otherwise save downloads in the user's real Downloads
  // folder on Windows, whatever HOME and LOCALAPPDATA say. They land in the
  // working directory itself, where a user who asked for a file in the
  // current directory would look, and where the checks look.
  env.AGENT_BROWSER_DOWNLOAD_PATH = dirs.work ?? dirs.tmp;
  if (proxy) {
    // Chrome bypasses any proxy for loopback addresses unless the bypass list
    // has <-loopback>, and the fixture server and the candidate's own stream
    // server are both on loopback.
    env.AGENT_BROWSER_PROXY = proxy;
    env.AGENT_BROWSER_PROXY_BYPASS = '<-loopback>';
  }
  if (initScripts.length) {
    env.AGENT_BROWSER_INIT_SCRIPTS = initScripts.join(',');
    // agent-browser registers init scripts only on the page's own session,
    // and Chrome runs a sandboxed iframe in its own process with its own
    // target, so the WebRTC block never ran there: measured, a sandboxed
    // srcdoc iframe sent STUN packets to a loopback UDP listener. Keeping
    // sandboxed iframes in the page's process closes that route (measured on
    // Linux and Windows). The CLI splits this variable at commas, so it can
    // hold only the one feature; Chrome then reads this --disable-features
    // instead of the CLI's Translate, so Translate stays on. Measured, the
    // proxy saw no translate request with or without it.
    env.AGENT_BROWSER_ARGS = '--disable-features=IsolateSandboxedIframes';
  }
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
      detached: !isWin,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      res({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, { group: !isWin });
    }, timeoutMs);
    child.on('error', (e) => {
      stderr += e.message;
      settle(127);
    });
    // Resolve on exit rather than on stream close: a detached daemon that
    // inherited our pipe handles can keep them open long after the command
    // returns. Give buffered output a moment to drain, then stop waiting.
    child.on('exit', (code) => {
      const drain = setTimeout(() => settle(code ?? 1), 2000);
      child.on('close', () => {
        clearTimeout(drain);
        settle(code ?? 1);
      });
    });
  });
}

// The candidate runs next to the model credentials, so a tarball must come
// from a reviewed build. A trusted local CI run saves <out>/artifacts/<tgz>
// and records its SHA-256 in <out>/receipt.json from the host side. Code
// under test in an --untrusted run can write look-alike files inside its own
// output directory, below a receipt the host marks untrusted, so a tarball
// below any untrusted receipt is refused even with a matching hash.
// --package-sha256 vouches for a tarball that no receipt lists. Returns the
// tarball's SHA-256, or null for a source checkout.
function packageProvenance(pkg) {
  if (!pkg.endsWith('.tgz')) return null;
  if (!existsSync(pkg)) die(`package not found: ${pkg}`);
  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  };
  for (let dir = dirname(pkg); ; dir = dirname(dir)) {
    if (readJson(join(dir, 'receipt.json'))?.untrusted === true)
      die(
        `${pkg} is inside the output of an --untrusted local CI run (${dir}); dogfood runs reviewed builds only`
      );
    if (dirname(dir) === dir) break;
  }
  const actual = sha256File(pkg);
  const vouched = opt['package-sha256'];
  if (vouched) {
    if (vouched.toLowerCase() !== actual)
      die(`--package-sha256 ${vouched} does not match ${pkg} (${actual})`);
    return actual;
  }
  const receiptPath = join(dirname(dirname(pkg)), 'receipt.json');
  const receipt = readJson(receiptPath);
  const listed =
    basename(dirname(pkg)) === 'artifacts' &&
    receipt?.untrusted === false &&
    Array.isArray(receipt.artifacts) &&
    receipt.artifacts.some((a) => a?.file === basename(pkg) && a?.sha256 === actual);
  if (!listed)
    die(
      `${pkg} is not listed with its SHA-256 in a trusted local CI receipt (${receiptPath}). If you reviewed the build, pass --package-sha256 ${actual}`
    );
  return actual;
}

// Removes a scenario's directories. On Windows a process that has not exited
// yet keeps its files open (EPERM), so removal is retried while stopping what
// is left. Returns what could not be removed.
async function removeScenarioDirs(root, sockDir) {
  const issues = [];
  for (const [what, attempt] of [
    [root, () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })],
    [sockDir, () => rmSync(sockDir, { recursive: true, force: true })],
    ['namespace state', () => removeNamespaceState(root)],
  ]) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        attempt();
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          issues.push(`${what} was left for the next run to remove (${err.message})`);
          break;
        }
        killProcessesUnder([root, sockDir]);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  return issues;
}

// Remote and container runs take the npm tarball only: it carries the
// platform binary, so nothing else from the host needs to be shipped.
function requireTarball() {
  const pkg = resolve(opt.package);
  if (!pkg.endsWith('.tgz') || !existsSync(pkg))
    die(`--platform ${opt.platform} needs --package <agent-browser-*.tgz>`);
  if (opt.binary) die('--binary is only supported for native runs');
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
    ...(harnessRevision().sha ? ['--harness-sha', harnessRevision().sha] : []),
    // The child's copy of the tarball has no receipt next to it.
    ...(packageSha256 ? ['--package-sha256', packageSha256] : []),
  ];
}

async function runLinux() {
  const pkg = requireTarball();
  const image = ensureImage();
  const swept = sweepDeadDocker();
  if (swept) console.log(`[dogfood] ${swept.replace(/\n/g, '\n[dogfood] ')}`);
  // Named so an interrupt can stop it: it holds the gateway credentials. The
  // owner label lets a later run remove it if this one is killed outright.
  const name = `abdf-${Date.now().toString(36)}`;
  onInterrupt(() => {
    spawnSync('docker', ['stop', '-t', '10', name], { stdio: 'ignore' });
  });
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    name,
    ...ownerLabelArgs(),
    '--platform',
    'linux/amd64',
    '--shm-size=2g',
    '-v',
    `${dockerPath(HARNESS_ROOT)}:/harness:ro`,
    '-v',
    `${dockerPath(pkg)}:/opt/candidate/agent-browser.tgz:ro`,
    '-v',
    `${dockerPath(out)}:/out`,
    // Not shared with local CI, whose volumes untrusted refs can write.
    '-v',
    'abdf-cache:/work/cache',
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
    spawnSync('ssh', [...SSH_OPTS, host, remoteShell(cmd)], { encoding: 'utf8', input });
  let r = ssh(`mkdir -p ${root}/harness/dogfood/scenarios ${root}/harness/local-ci ${root}/out`);
  if (r.status !== 0) die(`ssh ${host}: ${r.stderr}`);
  const scp = (src, dst) => {
    const x = spawnSync('scp', ['-q', ...SSH_OPTS, ...src, `${host}:${dst}`], {
      encoding: 'utf8',
    });
    if (x.status !== 0) die(`scp to ${host}: ${x.stderr}`);
  };
  scp(
    ['chrome.mjs', 'isolation.mjs', 'util.mjs'].map((f) => join(HARNESS_ROOT, 'local-ci', f)),
    `${rel(root)}/harness/local-ci/`
  );
  scp(
    ['run.mjs', 'server.mjs', 'guard.mjs', 'proxy.mjs'].map((f) => join(HERE, f)),
    `${rel(root)}/harness/dogfood/`
  );
  scp(
    readdirSync(join(HERE, 'scenarios')).map((f) => join(HERE, 'scenarios', f)),
    `${rel(root)}/harness/dogfood/scenarios/`
  );
  scp([pkg], `${rel(root)}/agent-browser.tgz`);
  // The gateway credentials travel over ssh stdin into a 0600 file that the
  // remote run deletes as soon as it has read it.
  const envText = GATEWAY_VARS.filter((k) => process.env[k])
    .map((k) => `${k}=${process.env[k]}`)
    .join('\n');
  r = ssh(`umask 077 && cat > ${root}/.env`, envText);
  if (r.status !== 0) die(`could not stage env on ${host}`);
  // An interrupt here kills ssh, which hangs up the remote pty; the remote
  // script forwards that to the remote harness. Then remove the run root.
  onInterrupt(async () => {
    stopping = true;
    for (const child of liveChildren) killTree(child.pid);
    await new Promise((r) => setTimeout(r, 15_000));
    ssh(`rm -rf ${root}`);
  });
  const cmd = supervisedRemoteScript({
    command:
      `node ${root}/harness/dogfood/run.mjs --package ${root}/agent-browser.tgz --env-file ${root}/.env ` +
      `--out ${root}/out --cache ${opt['remote-root']}/abdf-cache ${forwardedArgs().map(shq).join(' ')}`,
    always: [`${root}/harness`, `${root}/agent-browser.tgz`, `${root}/.env`],
    onSignal: [root],
  });
  // -tt gives the remote run a pty, so a dropped connection or an interrupt
  // here delivers SIGHUP to the remote script.
  const code = await stream('ssh', ['-tt', ...SSH_OPTS, host, remoteShell(cmd)], 'macos');
  // The interrupt handler owns cleanup and the exit once a signal arrived.
  if (stopping) await new Promise(() => {});
  const back = spawnSync('scp', ['-q', '-r', ...SSH_OPTS, `${host}:${rel(root)}/out/.`, out], {
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
    {
      stdio: 'inherit',
    }
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

// Reads KEY=VALUE lines into the environment and deletes the file, so the
// credentials never outlive the run that needed them.
function loadEnvFile(p) {
  const text = readFileSync(p, 'utf8');
  unlinkSync(p);
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

// The harness's own revision, recorded in the receipt like local CI's.
function harnessRevision() {
  if (opt['harness-sha']) return { sha: opt['harness-sha'] };
  const git = (args) => spawnSync('git', ['-C', HERE, ...args], { encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) return { sha: null };
  return {
    sha: head.stdout.trim(),
    dirty: git(['status', '--porcelain', '--', '..']).stdout.trim() !== '',
  };
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function die(msg) {
  console.error(`dogfood: ${msg}`);
  process.exit(2);
}
