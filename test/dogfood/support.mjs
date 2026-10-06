// Pieces of the dogfood runner (run.mjs) that tests exercise directly: the
// candidate's environment and the run's verdict.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyProfileCheck, scrubbedEnv } from '../local-ci/isolation.mjs';

const isWin = process.platform === 'win32';
export const GATEWAY_VARS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
// Proxy variables the candidate must not inherit (the CLI and its HTTP clients
// read them). The model process keeps the host's, to reach the gateway.
export const PROXY_VARS = /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;

// Starts from the host environment minus anything agent-browser would read or
// that looks like a credential, then adds back only the model gateway
// variables and points every state location at the run's throwaway dirs,
// including AGENT_BROWSER_HOME when `dirs` has an `agent-browser-home`.
export function isolatedEnv(
  { dirs, sockDir, chromePath, namespace, proxy, initScripts = [] },
  source = process.env
) {
  const env = scrubbedEnv(source);
  for (const k of Object.keys(env)) if (PROXY_VARS.test(k)) delete env[k];
  for (const k of GATEWAY_VARS) if (source[k]) env[k] = source[k];
  delete env.Path;
  const sep = isWin ? ';' : ':';
  env.PATH = [dirs.bin, source.PATH ?? source.Path ?? ''].filter(Boolean).join(sep);
  env.TMPDIR = env.TMP = env.TEMP = dirs.tmp;
  if (isWin) {
    // Chrome profile discovery reads LOCALAPPDATA. HOME has no effect on
    // where an older agent-browser keeps state on Windows (see isolation.mjs),
    // but Git Bash login shells, whose PATH Claude Code's Bash tool uses
    // there, put $HOME/bin first.
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

/**
 * The run's verdict: every selected scenario must have run and passed, and a
 * profile check (scenarios with their own homes on Windows) must not have
 * failed. Returns the result and what the receipt keeps of the check.
 */
export function runResult({ selected, results, check = null }) {
  const ranAll =
    results.length === selected.length && selected.every((id) => results.some((r) => r.id === id));
  const status = ranAll && results.every((r) => r.status === 'pass') ? 'pass' : 'fail';
  if (!check) return { result: status, profileCheck: null };
  const applied = applyProfileCheck({ status, failedStep: null }, check);
  return { result: applied.status, profileCheck: applied.profileCheck };
}
