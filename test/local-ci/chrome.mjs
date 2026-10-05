// Downloads a Chrome for Testing build into a cache directory and returns the
// browser binary path. Local CI and dogfood runs pin this binary through
// AGENT_BROWSER_EXECUTABLE_PATH so they never launch a system Chrome install.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INDEX =
  'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
const LATEST =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

export function cftPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'win64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux') return 'linux64';
  throw new Error(`no Chrome for Testing build for ${platform}/${arch}`);
}

function binaryIn(dir, plat) {
  const root = join(dir, `chrome-${plat}`);
  if (plat === 'win64') return join(root, 'chrome.exe');
  if (plat.startsWith('mac'))
    return join(
      root,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    );
  return join(root, 'chrome');
}

/** @param {{ cacheDir: string, version?: string }} opts version defaults to the current Stable. */
export async function ensureChrome({ cacheDir, version }) {
  const plat = cftPlatform();
  let url;
  if (!version || version === 'stable') {
    const latest = await (await fetch(LATEST)).json();
    const stable = latest.channels.Stable;
    version = stable.version;
    url = stable.downloads.chrome.find((d) => d.platform === plat)?.url;
  }
  const dir = join(cacheDir, 'chrome', version);
  const bin = binaryIn(dir, plat);
  if (existsSync(bin)) return { version, path: bin };

  if (!url) {
    const all = await (await fetch(INDEX)).json();
    url = all.versions
      .find((v) => v.version === version)
      ?.downloads.chrome?.find((d) => d.platform === plat)?.url;
    if (!url) throw new Error(`Chrome for Testing ${version} has no ${plat} download`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const staging = `${dir}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const zip = join(staging, 'chrome.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const unzip =
    process.platform === 'win32'
      ? spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), [
          '-xf',
          zip,
          '-C',
          staging,
        ])
      : process.platform === 'darwin'
        ? spawnSync('ditto', ['-x', '-k', zip, staging])
        : spawnSync('unzip', ['-q', zip, '-d', staging]);
  if (unzip.status !== 0) throw new Error(`extract ${zip} failed: ${unzip.stderr}`);
  rmSync(zip);
  if (existsSync(dir)) rmSync(staging, { recursive: true, force: true });
  else renameSync(staging, dir);
  if (!existsSync(bin)) throw new Error(`expected ${bin} after extracting ${url}`);
  return { version, path: bin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cacheDir = process.argv[2];
  if (!cacheDir) {
    console.error('usage: node chrome.mjs <cache-dir> [version|stable]');
    process.exit(2);
  }
  const r = await ensureChrome({ cacheDir, version: process.argv[3] });
  console.log(JSON.stringify(r));
}
