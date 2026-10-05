import { LOG_JS } from '../server.mjs';

export default {
  id: 'iframe',
  title: 'Interact with controls inside an iframe',
  families: ['frame', 'fill', 'click', 'snapshot'],
  uses: [['fill', 'type'], ['click']],
  maxTurns: 30,
  timeoutSec: 420,
  tokens: (r) => ({ CODE: `${r.int(900000) + 100000}` }),
  files: {
    'index.html': `<!doctype html><html><head><title>Billing portal</title></head><body>
<h1>Billing portal</h1><p>Use the embedded payment widget below.</p>
<iframe src="/widget.html" title="Payment widget" width="500" height="200"></iframe></body></html>`,
    'widget.html': `<!doctype html><html><head><title>Widget</title>${LOG_JS}</head><body>
<label>Coupon code <input id="coupon"></label>
<button onclick="__report({type:'apply', coupon: document.getElementById('coupon').value, framed: window.top !== window, trusted: event.isTrusted})">Apply coupon</button>
</body></html>`,
  },
  prompt: (base, t) =>
    `Open ${base}/ . Inside the embedded "Payment widget" iframe, type the coupon code ${t.CODE} into the "Coupon code" field and click "Apply coupon". Then close the browser.`,
  check: ({ events, tokens }) => {
    const e = events.filter((x) => x.type === 'apply').at(-1);
    if (!e) return ['Apply coupon was never clicked'];
    const reasons = [];
    if (e.coupon !== tokens.CODE)
      reasons.push(`coupon ${JSON.stringify(e.coupon)}, expected ${tokens.CODE}`);
    if (!e.framed)
      reasons.push('the widget was opened top-level instead of used inside the iframe');
    if (!e.trusted) reasons.push('Apply coupon was clicked from script, not a real click');
    return reasons;
  },
};
