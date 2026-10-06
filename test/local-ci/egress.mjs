// Network fence for --untrusted Linux runs.
//
// On Docker Desktop a container on the default network reaches the host's
// loopback services through host.docker.internal (measured: a listener bound
// to the host's 127.0.0.1 answered). Untrusted jobs therefore run on a per-run
// internal Docker network, which has no route anywhere, and reach the
// internet only through this HTTP proxy. The proxy runs in its own container
// (attached to the internal network and the default bridge), resolves each
// destination itself, and refuses loopback, private, link-local, and other
// non-public addresses, plus every address of the Docker host. Code in the job
// container runs as root but has no CAP_NET_ADMIN, so it cannot add a route
// around the proxy.
//
// Run as a script (`node egress.mjs --serve`), it is the proxy.

import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { BlockList, connect, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const PROXY_PORT = 3128;
const READY = 'egress proxy listening';

const NON_PUBLIC_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const NON_PUBLIC_V6 = [
  ['::', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

/** A deny list of every non-public address range plus `extra` addresses. */
export function denyList(extra = []) {
  const list = new BlockList();
  for (const [a, p] of NON_PUBLIC_V4) list.addSubnet(a, p, 'ipv4');
  for (const [a, p] of NON_PUBLIC_V6) list.addSubnet(a, p, 'ipv6');
  for (const ip of extra) {
    const family = isIP(ip);
    if (family) list.addAddress(ip, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** True when `ip` must not be reached. Anything that is not an IP literal is denied. */
export function isDenied(list, ip) {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return list.check(mapped[1], 'ipv4');
  const family = isIP(ip);
  if (!family) return true;
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Resolves `host` and returns the first public address. The caller connects
 * to that address, never to the name again, so a second DNS answer cannot
 * redirect the connection to a denied address.
 */
export async function vetHost(list, host, resolve = lookup) {
  const name = host.replace(/^\[(.*)\]$/, '$1');
  const addresses = isIP(name)
    ? [{ address: name }]
    : await resolve(name, { all: true, order: 'ipv4first' }).catch((err) => {
        throw new Error(`cannot resolve ${name}: ${err.code ?? err.message}`);
      });
  const ok = addresses.find((a) => !isDenied(list, a.address));
  if (!ok)
    throw new Error(
      `${name} resolves only to non-public or host addresses (${addresses.map((a) => a.address).join(', ')})`
    );
  return ok.address;
}

/** Starts the proxy: CONNECT tunnels and absolute-form plain HTTP requests. */
export function startProxy({ port = PROXY_PORT, host = '0.0.0.0', deny = [], log = console.log }) {
  const list = denyList(deny);
  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end('local-ci egress proxy: expected an absolute http:// URL\n');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end('local-ci egress proxy: use CONNECT for https\n');
      return;
    }
    let ip;
    try {
      ip = await vetHost(list, url.hostname);
    } catch (err) {
      log(`deny ${req.method} ${url.host}: ${err.message}`);
      res.writeHead(403).end(`local-ci egress proxy: ${err.message}\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = request(
      {
        host: ip,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.rawHeaders);
        up.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`local-ci egress proxy: ${err.message}\n`);
    });
    req.pipe(upstream);
  });
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const m = req.url.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let ip;
    try {
      ip = await vetHost(list, m[1]);
    } catch (err) {
      log(`deny CONNECT ${req.url}: ${err.message}`);
      client.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nlocal-ci egress proxy: ${err.message}\n`
      );
      return;
    }
    const upstream = connect({ host: ip, port: Number(m[2]) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (err) => {
      if (client.writable) client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}\n`);
    });
    client.on('close', () => upstream.destroy());
  });
  server.on('clientError', (_err, sock) => sock.destroy());
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => {
      log(`${READY} on ${host}:${server.address().port}`);
      res(server);
    });
  });
}

/** Every address of this host, which the proxy also refuses. */
export function hostAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal)
    .map((a) => a.address.replace(/%.*$/, ''));
}

/**
 * Creates the internal network and the proxy container for one run. Returns
 * the `docker run` arguments that put a job container behind the proxy, and
 * stop(logFile), which saves the proxy's log and removes both. `labels` are
 * extra `docker` arguments (owner labels) for both resources.
 */
export async function startEgress({ id, image, ciDir, labels = [], platform = 'linux/amd64' }) {
  const network = `${id}-net`;
  const proxy = `${id}-egress`;
  const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });
  const stop = (logFile) => {
    if (logFile) {
      const r = docker(['logs', proxy]);
      if (r.status === 0) writeFileSync(logFile, `${r.stdout}${r.stderr}`);
    }
    docker(['rm', '-f', proxy]);
    docker(['network', 'rm', network]);
  };
  try {
    let r = docker([
      'network',
      'create',
      '--internal',
      // No address on the bridge, so the Docker VM itself is not a peer.
      '-o',
      'com.docker.network.bridge.inhibit_ipv4=true',
      ...labels,
      network,
    ]);
    if (r.status !== 0) throw new Error(`docker network create: ${r.stderr.trim()}`);
    r = docker([
      'run',
      '-d',
      '--rm',
      '--name',
      proxy,
      ...labels,
      '--platform',
      platform,
      '--user',
      '65534:65534',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-v',
      `${ciDir}:/ci:ro`,
      image,
      'node',
      '/ci/egress.mjs',
      '--serve',
      '--deny',
      hostAddresses().join(','),
    ]);
    if (r.status !== 0) throw new Error(`start egress proxy: ${r.stderr.trim()}`);
    r = docker(['network', 'connect', network, proxy]);
    if (r.status !== 0) throw new Error(`docker network connect: ${r.stderr.trim()}`);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const logs = docker(['logs', proxy]);
      if (`${logs.stdout}`.includes(READY)) break;
      if (Date.now() > deadline)
        throw new Error(`egress proxy did not start: ${logs.stdout}${logs.stderr}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    stop();
    throw err;
  }
  const url = `http://${proxy}:${PROXY_PORT}`;
  const env = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    // Node's own fetch and http clients ignore the variables above otherwise.
    NODE_USE_ENV_PROXY: '1',
    LOCAL_CI_EGRESS_PROXY: url,
  };
  return {
    network,
    proxy,
    url,
    dockerArgs: [
      '--network',
      network,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ],
    stop,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      serve: { type: 'boolean', default: false },
      port: { type: 'string', default: String(PROXY_PORT) },
      deny: { type: 'string', default: '' },
    },
  });
  if (!values.serve) {
    console.error('usage: node egress.mjs --serve [--port N] [--deny ip,ip]');
    process.exit(2);
  }
  await startProxy({ port: Number(values.port), deny: values.deny.split(',').filter(Boolean) });
}
