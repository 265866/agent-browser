import { pageScript } from '../server.mjs';

// The menu items only exist after a real hover, so the run has to hover
// before it can click through.
export default {
  id: 'hover',
  title: 'Open a hover menu and click an item inside it',
  families: ['hover', 'click', 'snapshot'],
  uses: [['hover']],
  maxTurns: 25,
  timeoutSec: 360,
  tokens: (r) => ({ SECRET: `S-${r.hex(8)}` }),
  files: {
    'index.html': `<!doctype html><html><head><title>Dashboard</title>
<style>#menu{display:inline-block;padding:6px;border:1px solid #888}#items{min-height:1px}</style></head><body>
<h1>Dashboard</h1>
<nav><div id="menu">Account ▾<div id="items"></div></div></nav>
${pageScript(`
const menu = document.getElementById('menu');
menu.addEventListener('mouseenter', (e) => {
  if (!e.isTrusted || document.getElementById('settings')) return;
  report({ type: 'menu-open' });
  document.getElementById('items').innerHTML = '<a id="profile" href="/profile.html">Profile</a> <a id="settings" href="/settings.html">Settings</a>';
});
`)}
</body></html>`,
    'settings.html': `<!doctype html><html><head><title>Settings</title></head><body><h1>Settings</h1><p>API key: <code>{{SECRET}}</code></p></body></html>`,
    'profile.html': `<!doctype html><html><head><title>Profile</title></head><body><h1>Profile</h1></body></html>`,
  },
  prompt: (base) =>
    `Open ${base}/ . Hover over the "Account" menu to reveal its items, then click "Settings". ` +
    `Write the API key shown on the Settings page (nothing else) to key.txt in the current directory. Then close the browser.`,
  check: ({ events, requests, tokens, file }) => {
    const reasons = [];
    if (!events.some((e) => e.type === 'menu-open'))
      reasons.push('the menu was never opened by a real hover');
    const settings = requests.find((r) => r.path === '/settings.html');
    if (!settings) reasons.push('the Settings page was never opened');
    else if (!String(settings.headers.referer ?? '').match(/\/(index\.html)?$/))
      reasons.push('the Settings page was not reached from the menu');
    const key = file('key.txt')?.trim();
    if (key !== tokens.SECRET)
      reasons.push(`key.txt is ${JSON.stringify(key)}, expected ${tokens.SECRET}`);
    return reasons;
  },
};
