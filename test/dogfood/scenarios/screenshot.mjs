import { readFileSync } from 'node:fs';

export default {
  id: 'screenshot',
  title: 'Take a full-page screenshot of a tall page to a given path',
  families: ['screenshot'],
  maxTurns: 15,
  timeoutSec: 300,
  tokens: () => ({}),
  files: {
    'index.html': `<!doctype html><html><head><title>Tall report</title><style>body{margin:0}section{height:1000px;display:flex;align-items:center;justify-content:center;font:48px sans-serif}</style></head><body>
<section style="background:#e0f0ff">Part one</section><section style="background:#ffe8d0">Part two</section><section style="background:#e0ffe0">Part three</section>
</body></html>`,
  },
  prompt: (base) =>
    `Open ${base}/ and save a screenshot of the entire page (the full scrollable height, not just the visible viewport) as a PNG file named page.png in the current directory. Then close the browser.`,
  check: ({ path }) => {
    let buf;
    try {
      buf = readFileSync(path('page.png'));
    } catch {
      return ['page.png was not written'];
    }
    if (buf.length < 24 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a')
      return ['page.png is not a PNG'];
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    // The page is 3000 CSS px tall; allow device-scale variations but require
    // clearly more than one viewport.
    const reasons = [];
    if (width < 300) reasons.push(`width ${width} too small`);
    if (height < 2500 || height / width < 1.5)
      reasons.push(`height ${height} (width ${width}) is not a full-page capture`);
    return reasons;
  },
};
