// The candidate browser's only route to the network. Chrome sends every
// request here (AGENT_BROWSER_PROXY, with the `<-loopback>` bypass rule so
// loopback addresses are proxied too), and this proxy forwards only requests
// for the scenario's own origins. Everything else, including the candidate
// daemon's loopback stream server and CDP ports, gets a 403 and is recorded.

import { createServer, request } from 'node:http';

// Hop-by-hop headers (RFC 9110 section 7.6.1) and the proxy's own.
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function pairs(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2)
    if (!HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1]);
  return out;
}

/**
 * Starts a forward proxy on a loopback port that admits only `origins`
 * (like `http://127.0.0.1:5555`). `refused` lists what it turned away.
 */
export async function startProxy(origins) {
  const allowed = new Set(origins);
  const refused = [];
  const refuse = (what, write) => {
    refused.push({ ...what, at: Date.now() });
    write();
  };
  const server = createServer((req, res) => {
    let target = null;
    try {
      target = new URL(req.url);
    } catch {}
    if (!target || !allowed.has(target.origin)) {
      req.resume();
      return refuse({ method: req.method, url: req.url }, () => {
        res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
        res.end('blocked by the dogfood harness proxy\n');
      });
    }
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: pairs(req.rawHeaders),
        setHost: false,
      },
      (up) => {
        res.writeHead(up.statusCode, up.statusMessage, pairs(up.rawHeaders));
        up.pipe(res);
      }
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  // CONNECT tunnels (https, wss) and upgrades lead nowhere the scenarios use.
  server.on('connect', (req, socket) => {
    refuse({ method: 'CONNECT', url: req.url }, () => {
      socket.on('error', () => {});
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
  });
  server.on('upgrade', (req, socket) => {
    refuse({ method: 'UPGRADE', url: req.url }, () => {
      socket.on('error', () => {});
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    refused,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
