import { LOG_JS } from '../server.mjs';

export default {
  id: 'tabs',
  title: 'Follow a link that opens a new tab, read it, switch back, and use the value',
  families: ['tab', 'click', 'fill', 'get'],
  uses: [['tab']],
  maxTurns: 30,
  timeoutSec: 420,
  tokens: (r) => ({ CODE: r.hex(6).toUpperCase() }),
  files: {
    'index.html': `<!doctype html><html><head><title>Verify</title>${LOG_JS}</head><body>
<h1>Verify your device</h1>
<p><a href="/code.html" target="_blank">Show my verification code</a> (opens in a new tab)</p>
<label>Verification code <input id="code"></label>
<button id="confirm" onclick="__report({type:'confirm', code: document.getElementById('code').value, page: location.pathname, trusted: event.isTrusted, opened: window.__opened || 0})">Confirm</button>
<script>document.querySelector('a').addEventListener('click', (e) => { if (e.isTrusted) window.__opened = (window.__opened || 0) + 1; });</script>
</body></html>`,
    'code.html': `<!doctype html><html><head><title>Your code</title></head><body><h1>Your code</h1><p>Code: <strong id="c">{{CODE}}</strong></p></body></html>`,
  },
  prompt: (base) =>
    `Open ${base}/ . Click "Show my verification code"; it opens a new tab. Read the code in that new tab, switch back to the original tab, ` +
    `type the code into the "Verification code" field and click Confirm. Then close the browser.`,
  check: ({ events, requests, tokens }) => {
    const reasons = [];
    const codeReq = requests.find((r) => r.path === '/code.html');
    if (!codeReq) reasons.push('code page was never opened');
    else if (!String(codeReq.headers.referer ?? '').match(/\/(index\.html)?$/))
      reasons.push('code page was not opened from the link on the first page');
    const confirm = events.filter((e) => e.type === 'confirm').at(-1);
    if (!confirm) reasons.push('Confirm was never clicked');
    else {
      if (confirm.code !== tokens.CODE)
        reasons.push(`confirmed code ${JSON.stringify(confirm.code)}, expected ${tokens.CODE}`);
      if (confirm.page !== '/' && confirm.page !== '/index.html')
        reasons.push(`confirm came from ${confirm.page}`);
      if (!confirm.trusted) reasons.push('Confirm was clicked from script, not a real click');
      if (!confirm.opened)
        reasons.push('the original tab was reloaded or replaced instead of switched back to');
    }
    return reasons;
  },
};
