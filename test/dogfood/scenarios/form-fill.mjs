export default {
  id: 'form-fill',
  title: 'Fill a form with text, select, checkbox, radio, textarea and submit it',
  families: ['fill', 'select', 'check', 'click', 'snapshot'],
  maxTurns: 30,
  timeoutSec: 420,
  tokens: (r) => ({ NAME: `Ada ${r.hex(4)}`, NOTE: `ref ${r.hex(8)}` }),
  files: {
    'index.html': `<!doctype html><html><head><title>Signup</title></head><body>
<h1>Create account</h1>
<form method="post" action="/submit">
  <label>Full name <input name="fullname" type="text"></label><br>
  <label>Email <input name="email" type="email"></label><br>
  <label>Plan <select name="plan"><option value="">Choose…</option><option value="basic">Basic</option><option value="pro">Pro</option><option value="team">Team</option></select></label><br>
  <fieldset><legend>Billing</legend>
    <label><input type="radio" name="billing" value="monthly" checked> Monthly</label>
    <label><input type="radio" name="billing" value="yearly"> Yearly</label>
  </fieldset>
  <label><input type="checkbox" name="newsletter" value="yes"> Send me the newsletter</label><br>
  <label><input type="checkbox" name="terms" value="accepted"> I accept the terms</label><br>
  <label>Notes <textarea name="notes"></textarea></label><br>
  <button type="submit">Create account</button>
</form></body></html>`,
  },
  routes: {
    'POST /submit': () => ({
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><title>Done</title><h1>Account created</h1>',
    }),
  },
  prompt: (base, t) =>
    `Open ${base}/ and complete the signup form with: full name "${t.NAME}", email "ada@example.test", plan "Team", billing "Yearly", ` +
    `accept the terms (leave the newsletter unchecked), notes "${t.NOTE}". Submit the form and confirm the page says the account was created. Then close the browser.`,
  check: ({ requests, tokens }) => {
    const posts = requests.filter((r) => r.method === 'POST' && r.path === '/submit');
    if (posts.length === 0) return ['form was never submitted'];
    const f = Object.fromEntries(new URLSearchParams(posts.at(-1).body));
    const want = {
      fullname: tokens.NAME,
      email: 'ada@example.test',
      plan: 'team',
      billing: 'yearly',
      terms: 'accepted',
      notes: tokens.NOTE,
    };
    const reasons = [];
    for (const [k, v] of Object.entries(want))
      if (f[k] !== v) reasons.push(`${k}=${JSON.stringify(f[k])}, expected ${JSON.stringify(v)}`);
    if ('newsletter' in f) reasons.push('newsletter should be unchecked');
    return reasons;
  },
};
