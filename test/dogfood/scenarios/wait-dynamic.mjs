export default {
  id: 'wait-dynamic',
  title: 'Wait for content that appears after a delay, then extract it',
  families: ['wait', 'click', 'get', 'snapshot'],
  maxTurns: 25,
  timeoutSec: 360,
  tokens: (r) => ({ REPORT: `R-${r.hex(8)}`, DELAY: 4000 + r.int(3000) }),
  files: {
    'index.html': `<!doctype html><html><head><title>Reports</title></head><body>
<h1>Quarterly report</h1>
<button id="gen" onclick="generate()">Generate report</button>
<div id="status">Not started</div>
<script>
function generate(){
  document.getElementById('status').textContent='Generating… (Report ID: pending)';
  setTimeout(()=>{ document.getElementById('status').innerHTML='<b>Report ready</b>. Report ID: <code id="rid">{{REPORT}}</code>'; }, {{DELAY}});
}
</script></body></html>`,
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
