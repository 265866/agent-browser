// The login cookie is HttpOnly, so it can only reach the second browser
// through agent-browser's state save/load, not through page script.
export default {
  id: 'state-save-load',
  title: 'Log in, save browser state, start a fresh browser from that state',
  families: ['state', 'cookies', 'fill', 'click', 'close'],
  uses: [['state']],
  maxTurns: 35,
  timeoutSec: 480,
  tokens: (r) => ({ SESSION: r.hex(16), PASSWORD: `pw-${r.hex(6)}` }),
  files: {
    'index.html': `<!doctype html><html><head><title>Login</title></head><body><h1>Sign in</h1>
<form method="post" action="/login"><label>Username <input name="user"></label><label>Password <input name="pass" type="password"></label><button>Sign in</button></form></body></html>`,
  },
  routes: {
    'POST /login': ({ body, ctx }) => {
      const f = Object.fromEntries(new URLSearchParams(body));
      if (f.user !== 'dogfood' || f.pass !== ctx.tokens.PASSWORD)
        return {
          status: 401,
          headers: { 'content-type': 'text/html' },
          body: '<h1>Wrong username or password</h1>',
        };
      return {
        status: 302,
        headers: {
          location: '/account',
          'set-cookie': `sid=${ctx.tokens.SESSION}; HttpOnly; Path=/; Max-Age=3600`,
        },
        body: '',
      };
    },
    'GET /account': ({ req, ctx }) => {
      const ok = String(req.headers.cookie ?? '')
        .split(/;\s*/)
        .includes(`sid=${ctx.tokens.SESSION}`);
      return {
        headers: { 'content-type': 'text/html' },
        body: ok
          ? '<title>Account</title><h1>Welcome back, dogfood</h1>'
          : '<title>Account</title><h1>Please sign in</h1>',
      };
    },
  },
  prompt: (base, t) =>
    `Open ${base}/ and sign in with username "dogfood" and password "${t.PASSWORD}". After signing in, save the browser state (cookies and storage) to state.json in the current directory using agent-browser. ` +
    `Then close the browser completely. Start a new browser session that loads state.json, open ${base}/account, and confirm it says "Welcome back". Then close the browser.`,
  check: async ({ requests, tokens, file, path, base, agentBrowser }) => {
    const reasons = [];
    const login = requests.findIndex(
      (r) =>
        r.method === 'POST' &&
        r.path === '/login' &&
        new URLSearchParams(r.body).get('pass') === tokens.PASSWORD
    );
    if (login < 0) reasons.push('never logged in with the right password');
    const state = file('state.json');
    if (state === null) reasons.push('state.json was not saved');
    else if (!state.includes(tokens.SESSION))
      reasons.push('state.json does not contain the session cookie');
    // Server logs cannot tell the model's restored browser from its first one,
    // so the harness proves the saved file works by restoring it itself.
    if (state !== null) {
      // Independently confirm the saved file restores the login in a brand-new
      // browser started by the harness, not by the model.
      const before = requests.length;
      const r = await agentBrowser([
        '--session',
        'harness-verify',
        '--state',
        path('state.json'),
        'open',
        `${base}/account`,
      ]);
      await agentBrowser(['--session', 'harness-verify', 'close']);
      const visit = requests.slice(before).find((q) => q.path === '/account');
      if (r.code !== 0)
        reasons.push(`harness could not open with --state: ${r.stderr.trim().slice(0, 300)}`);
      else if (!visit || !String(visit.headers.cookie ?? '').includes(`sid=${tokens.SESSION}`))
        reasons.push('state.json did not restore the login in a fresh browser');
    }
    return reasons;
  },
};
