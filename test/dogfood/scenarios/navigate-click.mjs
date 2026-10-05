import { LOG_JS } from '../server.mjs';

export default {
  id: 'navigate-click',
  title: 'Open a page, find a product link in the snapshot, click it, read a value',
  families: ['open', 'snapshot', 'click', 'get'],
  maxTurns: 25,
  timeoutSec: 360,
  tokens: (r) => ({ SKU: `SKU-${r.hex(6).toUpperCase()}`, DECOY: `SKU-${r.hex(6).toUpperCase()}` }),
  files: {
    'index.html': `<!doctype html><html><head><title>Acme Store</title>${LOG_JS}</head><body>
<h1>Acme Store</h1>
<ul>
  <li><a href="/product-basic.html">Widget Basic</a></li>
  <li><a href="/product-pro.html">Widget Pro</a></li>
  <li><a href="/product-max.html">Widget Max</a></li>
</ul></body></html>`,
    'product-basic.html': `<!doctype html><html><head><title>Widget Basic</title></head><body><h1>Widget Basic</h1><p>SKU: <span id="sku">{{DECOY}}</span></p></body></html>`,
    'product-pro.html': `<!doctype html><html><head><title>Widget Pro</title></head><body><h1>Widget Pro</h1><p>SKU: <span id="sku">{{SKU}}</span></p></body></html>`,
    'product-max.html': `<!doctype html><html><head><title>Widget Max</title></head><body><h1>Widget Max</h1><p>SKU: <span id="sku">SKU-000000</span></p></body></html>`,
  },
  prompt: (base) =>
    `Open ${base}/ in the browser. On that store page, click the "Widget Pro" link (navigate by clicking it, do not type its URL). ` +
    `On the product page, read the SKU and write exactly that SKU (nothing else) to a file named sku.txt in the current directory. Then close the browser.`,
  check: ({ requests, tokens, file }) => {
    const reasons = [];
    const pro = requests.find((r) => r.method === 'GET' && r.path === '/product-pro.html');
    if (!pro) reasons.push('product-pro.html was never requested');
    else if (!String(pro.headers.referer ?? '').match(/\/(index\.html)?$/))
      reasons.push(
        `product page was not reached by clicking from the index (referer: ${pro.headers.referer ?? 'none'})`
      );
    const sku = file('sku.txt')?.trim();
    if (sku !== tokens.SKU)
      reasons.push(`sku.txt is ${JSON.stringify(sku)}, expected ${tokens.SKU}`);
    return reasons;
  },
};
