// Network fence for --untrusted Linux runs.
//
// On Docker Desktop a container on the default network reaches the host's
// loopback services through host.docker.internal (measured: a listener bound
// to the host's 127.0.0.1 answered). Untrusted jobs therefore run on a per-run
// internal Docker network, which has no route anywhere, and reach the
// internet only through this HTTP proxy. The proxy runs in its own container
// (attached to the internal network and the default bridge), resolves each
// destination itself, and refuses loopback, private, link-local, and other
// non-public addresses, every IPv6 address, and every address of the Docker
// host. Code in the job container runs as root but has neither CAP_NET_ADMIN
// (to add a route around the proxy) nor CAP_NET_RAW (to hand-craft packets for
// the proxy to forward), and the proxy does not forward packets.
//
// Run as a script (`node egress.mjs --serve`), it is the proxy.

import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createServer, request } from 'node:http';
import { BlockList, connect, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runSteps, writeHostFile } from './util.mjs';

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
/** A deny list of every non-public IPv4 range plus `extra` IPv4 addresses. */
export function denyList(extra = []) {
  const list = new BlockList();
  for (const [a, p] of NON_PUBLIC_V4) list.addSubnet(a, p, 'ipv4');
  for (const ip of extra) if (isIP(ip) === 4) list.addAddress(ip, 'ipv4');
  return list;
}

/**
 * True when `ip` must not be reached. Only public IPv4 addresses pass. Every
 * IPv6 address is denied: several IPv6 ranges embed or reach IPv4 addresses
 * (mapped, 6to4, Teredo, NAT64), and the proxy's networks have no IPv6
 * anyway. Anything that is not an IP literal is denied too.
 */
export function isDenied(list, ip) {
  return isIP(ip) !== 4 || list.check(ip, 'ipv4');
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
 * stop(logFile), which removes both and saves the proxy's log to `logFile`, a
 * path the job container cannot write. stop() attempts every step and returns
 * the errors. `labels` are extra `docker` arguments (owner labels) for both
 * resources.
 */
export async function startEgress({ id, image, ciDir, labels = [], platform = 'linux/amd64' }) {
  const network = `${id}-net`;
  const proxy = `${id}-egress`;
  const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });
  const must = (args) => {
    const r = docker(args);
    if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${`${r.stderr}`.trim()}`);
    return r;
  };
  const stop = (logFile) => {
    let log = null;
    return runSteps([
      ['read the proxy log', () => logFile && (log = must(['logs', proxy]))],
      ['remove the proxy', () => must(['rm', '-f', proxy])],
      ['remove the network', () => must(['network', 'rm', network])],
      ['save the proxy log', () => log && writeHostFile(logFile, `${log.stdout}${log.stderr}`)],
    ]);
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
      // The proxy is on both networks. It relays connections it vetted and
      // never routes packets between them.
      '--sysctl',
      'net.ipv4.ip_forward=0',
      '--sysctl',
      'net.ipv6.conf.all.forwarding=0',
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
      // Raw sockets could address packets to the proxy with an outside
      // destination. No ci.yml step creates device nodes.
      '--cap-drop',
      'NET_RAW',
      '--cap-drop',
      'MKNOD',
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
