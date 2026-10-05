// Rows are generated per run so the expected sum cannot be guessed.
function rows(r) {
  const out = [];
  for (let i = 1; i <= 40; i++)
    out.push({
      id: i,
      amount: 10 + r.int(990),
      status: r.int(3) === 0 ? 'refunded' : r.int(2) ? 'paid' : 'pending',
    });
  return out;
}

export default {
  id: 'eval-table',
  title: 'Aggregate data from a long table (eval or extraction)',
  families: ['eval', 'get', 'snapshot'],
  maxTurns: 20,
  timeoutSec: 300,
  tokens: (r) => {
    const data = rows(r);
    return {
      TABLE: data
        .map((d) => `<tr><td>${d.id}</td><td>${d.status}</td><td>${d.amount}</td></tr>`)
        .join(''),
      SUM: data.filter((d) => d.status === 'paid').reduce((a, d) => a + d.amount, 0),
    };
  },
  files: {
    'index.html': `<!doctype html><html><head><title>Invoices</title></head><body><h1>Invoices</h1>
<table id="inv"><thead><tr><th>ID</th><th>Status</th><th>Amount</th></tr></thead><tbody>{{TABLE}}</tbody></table></body></html>`,
  },
  prompt: (base) =>
    `Open ${base}/ . Compute the sum of the Amount column for invoices whose Status is "paid". Write only the number to sum.txt in the current directory. Then close the browser.`,
  check: ({ tokens, file }) => {
    const v = file('sum.txt')?.trim();
    return Number(v) === tokens.SUM
      ? []
      : [`sum.txt is ${JSON.stringify(v)}, expected ${tokens.SUM}`];
  },
};
