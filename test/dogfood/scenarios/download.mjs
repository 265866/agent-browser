export default {
  id: 'download',
  title: 'Download a file triggered by a button and save it to a given path',
  families: ['download', 'click'],
  maxTurns: 25,
  timeoutSec: 360,
  tokens: (r) => ({ ROW: `${r.hex(4)}-${r.hex(4)}` }),
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
      body: `id,value\n1,${ctx.tokens.ROW}\n`,
    }),
  },
  prompt: (base) =>
    `Open ${base}/ and click "Export CSV", which downloads a CSV file. Save the downloaded file as export.csv in the current directory. Then close the browser.`,
  check: ({ requests, tokens, file }) => {
    const reasons = [];
    if (!requests.some((r) => r.path === '/export.csv')) reasons.push('export was never requested');
    const csv = file('export.csv');
    if (csv === null) reasons.push('export.csv was not saved in the working directory');
    else if (!csv.includes(tokens.ROW))
      reasons.push('export.csv does not contain the exported row');
    return reasons;
  },
};
