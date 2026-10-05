import { LOG_JS } from '../server.mjs';

export default {
  id: 'cookies-storage',
  title: 'Set a cookie and a localStorage value, reload, and have the page observe both',
  families: ['cookies', 'storage', 'reload'],
  uses: [['cookies'], ['storage']],
  maxTurns: 25,
  timeoutSec: 360,
  tokens: (r) => ({ HINT: r.hex(10) }),
  files: {
    'index.html': `<!doctype html><html><head><title>Preferences</title>${LOG_JS}</head><body>
<h1>Preferences</h1><div id="out"></div>
<script>
const seen = { type: 'load', cookie: document.cookie, theme: localStorage.getItem('theme') };
document.getElementById('out').textContent = JSON.stringify(seen);
__report(seen);
</script></body></html>`,
  },
  prompt: (base, t) =>
    `Open ${base}/ . Using the browser, set a cookie named session_hint with value ${t.HINT} for this site, and set the localStorage key theme to dark for this site. ` +
    `Then reload the page so it can read them, and confirm the page shows both values. Then close the browser.`,
  check: ({ events, requests, tokens }) => {
    const reasons = [];
    // The reload must carry the cookie to the server, not only expose it to
    // page script.
    const sent = requests.some(
      (r) =>
        r.method === 'GET' &&
        (r.path === '/' || r.path === '/index.html') &&
        String(r.headers.cookie ?? '')
          .split(/;\s*/)
          .includes(`session_hint=${tokens.HINT}`)
    );
    if (!sent) reasons.push('no page request carried the session_hint cookie to the server');
    const ok = events
      .filter((e) => e.type === 'load')
      .some((e) => {
        const cookies = Object.fromEntries(
          String(e.cookie)
            .split(/;\s*/)
            .filter(Boolean)
            .map((c) => c.split('='))
        );
        return cookies.session_hint === tokens.HINT && e.theme === 'dark';
      });
    if (!ok)
      reasons.push(
        `no page load observed both values; loads: ${JSON.stringify(events.filter((e) => e.type === 'load').map((e) => ({ cookie: e.cookie, theme: e.theme })))}`
      );
    return reasons;
  },
};
