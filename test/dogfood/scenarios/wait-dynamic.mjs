// The report ID is never in the page source: the server releases it only
// after the Generate click has been posted and the delay has elapsed, so
// reading the HTML early or skipping the click cannot produce it.
export default {
  id: 'wait-dynamic',
  title: 'Wait for content that appears after a delay, then extract it',
  families: ['wait', 'click', 'get', 'snapshot'],
  uses: [['wait']],
  maxTurns: 25,
  timeoutSec: 360,
  tokens: (r) => ({ REPORT: `R-${r.hex(8)}`, DELAY: 4000 + r.int(3000) }),
  files: {
    'index.html': `<!doctype html><html><head><title>Reports</title></head><body>
<h1>Quarterly report</h1>
<button id="gen" onclick="generate(event)">Generate report</button>
<div id="status">Not started</div>
<script>
async function generate(e){
  document.getElementById('status').textContent='Generating… (Report ID: pending)';
  await fetch('/api/generate', {method:'POST', body: JSON.stringify({trusted: e.isTrusted})});
  for (;;) {
    const r = await (await fetch('/api/report', {cache:'no-store'})).json();
    if (r.id) { document.getElementById('status').innerHTML='<b>Report ready</b>. Report ID: <code id="rid">'+r.id+'</code>'; return; }
    await new Promise((res) => setTimeout(res, 500));
  }
}
</script></body></html>`,
  },
  routes: {
    'POST /api/generate': ({ body, ctx }) => {
      let trusted = false;
      try {
        trusted = JSON.parse(body).trusted === true;
      } catch {}
      if (trusted && !ctx.generatedAt) ctx.generatedAt = Date.now();
      return { status: 204 };
    },
    'GET /api/report': ({ ctx }) => {
      const ready = ctx.generatedAt && Date.now() - ctx.generatedAt >= ctx.tokens.DELAY;
      return {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ready ? { id: ctx.tokens.REPORT } : { id: null }),
      };
    },
  },
  prompt: (base) =>
    `Open ${base}/ and click "Generate report". The report takes several seconds to be ready. Wait until the page says "Report ready", ` +
    `then write the Report ID (exactly as shown, nothing else) to report.txt in the current directory. Then close the browser.`,
  check: ({ tokens, file }) => {
    const v = file('report.txt')?.trim();
    return v === tokens.REPORT
      ? []
      : [`report.txt is ${JSON.stringify(v)}, expected ${tokens.REPORT}`];
  },
};
