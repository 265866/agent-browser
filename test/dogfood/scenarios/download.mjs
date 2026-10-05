// The export is large and random, so it cannot be typed out, and it must be
// fetched by a browser navigation (the download), not by a script fetch.
export default {
  id: 'download',
  title: 'Download a file triggered by a button and save it to a given path',
  families: ['download', 'click'],
  maxTurns: 25,
  timeoutSec: 360,
  tokens: (r) => ({ ROWS: Array.from({ length: 2000 }, (_, i) => `${i},${r.hex(32)}`).join('\n') }),
  files: {
    'index.html': `<!doctype html><html><head><title>Exports</title></head><body>
<h1>Exports</h1><button onclick="location.href='/export.csv'">Export CSV</button></body></html>`,
  },
  routes: {
    'GET /export.csv': ({ ctx }) => ({
      headers: {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="export.csv"',
      },
      body: `id,value\n${ctx.tokens.ROWS}\n`,
    }),
  },
  prompt: (base) =>
    `Open ${base}/ and click "Export CSV", which downloads a CSV file. Save the downloaded file as export.csv in the current directory. Then close the browser.`,
  check: ({ requests, tokens, file }) => {
    const reasons = [];
    const req = requests.filter((r) => r.path === '/export.csv');
    if (req.length === 0) reasons.push('export was never requested');
    else if (!req.some((r) => r.headers['sec-fetch-mode'] === 'navigate'))
      reasons.push('export was fetched by script, not downloaded by the browser');
    const csv = file('export.csv');
    if (csv === null) reasons.push('export.csv was not saved in the working directory');
    else if (csv.replace(/\r\n/g, '\n').trim() !== `id,value\n${tokens.ROWS}`)
      reasons.push('export.csv does not match the downloaded content');
    return reasons;
  },
};
