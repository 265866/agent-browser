// Fixture HTTP server for one dogfood scenario run.
//
// Serves the scenario's `files` (with {{NAME}} placeholders replaced by the
// run's random tokens), the scenario's custom `routes`, and two harness
// endpoints that fixture pages use to report what they observed:
//   POST /__log     body: JSON event; appended to the run's event list
//   GET  /__events  the event list (for debugging)
// Checks judge the run from these server-side events and from files on disk,
// never from the model's own report.

import { createServer } from 'node:http';

const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv',
};

export function render(text, tokens) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, name) =>
    name in tokens ? String(tokens[name]) : m
  );
}

export async function startServer(scenario, tokens) {
  const events = [];
  const requests = [];
  const ctx = { tokens, events, requests };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = await readBody(req);
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
      at: Date.now(),
    });

    if (url.pathname === '/__log' && req.method === 'POST') {
      try {
        events.push({ ...JSON.parse(body || '{}'), at: Date.now() });
      } catch {
        events.push({ type: 'unparsed', raw: body, at: Date.now() });
      }
      return send(res, 204, {}, '');
    }
    if (url.pathname === '/__events')
      return send(res, 200, { 'content-type': TYPES.json }, JSON.stringify(events));

    const route = scenario.routes?.[`${req.method} ${url.pathname}`];
    if (route) {
      const r = await route({ req, url, body, ctx });
      return send(res, r.status ?? 200, r.headers ?? {}, r.body ?? '');
    }

    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = scenario.files?.[name];
    if (file === undefined) return send(res, 404, { 'content-type': TYPES.txt }, 'not found');
    const ext = name.split('.').pop();
    return send(
      res,
      200,
      { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' },
      render(file, tokens)
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    events,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

/** Inline script fixtures include to report an observation to the server. */
export const LOG_JS = `<script>window.__report=(e)=>fetch('/__log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(e),keepalive:true});</script>`;
