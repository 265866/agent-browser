import { LOG_JS } from '../server.mjs';

export default {
  id: 'network-mock',
  title: 'Mock an API response with network routing and observe it in the page',
  families: ['network'],
  maxTurns: 30,
  timeoutSec: 420,
  tokens: (r) => ({ BUILD: r.hex(6) }),
  files: {
    'index.html': `<!doctype html><html><head><title>Status</title>${LOG_JS}</head><body>
<h1>Service status</h1><div id="s">loading…</div><button onclick="load()">Refresh status</button>
<script>
async function load(){
  const j = await (await fetch('/api/status', {cache:'no-store'})).json();
  document.getElementById('s').textContent = 'Status: ' + j.status;
  __report({ type: 'status', status: j.status });
}
load();
</script></body></html>`,
  },
  routes: {
    'GET /api/status': () => ({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    }),
  },
  prompt: (base) =>
    `Open ${base}/ . The page fetches ${base}/api/status. Use agent-browser's network routing to make that request return the JSON body {"status":"maintenance"} ` +
    `(mock it in the browser; do not modify the server). Then click "Refresh status" and confirm the page shows "Status: maintenance". Then close the browser.`,
  check: ({ events }) => {
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.status);
    return statuses.includes('maintenance')
      ? []
      : [`page never received the mocked status; saw ${JSON.stringify(statuses)}`];
  },
};
