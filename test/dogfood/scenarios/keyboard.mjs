import { LOG_JS } from '../server.mjs';

// "Deploy preview" is not the first command, so Enter on an empty query runs
// something else: the run has to type into the palette.
export default {
  id: 'keyboard',
  title: 'Use a keyboard shortcut to open a command palette and run a command',
  families: ['press', 'keyboard', 'type'],
  uses: [['press', 'keyboard']],
  maxTurns: 25,
  timeoutSec: 360,
  tokens: () => ({}),
  files: {
    'index.html': `<!doctype html><html><head><title>Console</title>${LOG_JS}
<style>#palette{display:none;border:1px solid #888;padding:8px}#palette.open{display:block}</style></head><body>
<h1>Project console</h1><p>Press Control+K to open the command palette. There are no buttons for commands.</p>
<div id="palette"><input id="q" placeholder="Type a command" autocomplete="off"><ul id="list"></ul></div>
<script>
const cmds = ['Rollback', 'Deploy production', 'Deploy preview'];
const pal = document.getElementById('palette'), q = document.getElementById('q'), list = document.getElementById('list');
function render(){ const v=q.value.toLowerCase(); list.innerHTML = cmds.filter(c=>c.toLowerCase().includes(v)).map(c=>'<li>'+c+'</li>').join(''); }
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.classList.add('open'); q.value=''; render(); q.focus(); __report({type:'palette', trusted: e.isTrusted}); }
});
q.addEventListener('input', render);
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = list.querySelector('li'); if (first) { __report({type:'run', command:first.textContent, query:q.value, trusted: e.isTrusted}); document.body.insertAdjacentHTML('beforeend','<p id="done">Ran: '+first.textContent+'</p>'); pal.classList.remove('open'); } }
});
</script></body></html>`,
  },
  prompt: (base) =>
    `Open ${base}/ . Open the command palette with the Control+K keyboard shortcut, type "preview" into it, and press Enter to run the "Deploy preview" command. ` +
    `Confirm the page says "Ran: Deploy preview". Then close the browser.`,
  check: ({ events }) => {
    const reasons = [];
    if (!events.some((e) => e.type === 'palette' && e.trusted))
      reasons.push('palette was never opened with a real Control+K key press');
    const run = events.filter((e) => e.type === 'run').at(-1);
    if (!run) reasons.push('no command was run');
    else {
      if (run.command !== 'Deploy preview')
        reasons.push(`ran ${JSON.stringify(run.command)} instead of Deploy preview`);
      if (!String(run.query).toLowerCase().includes('preview'))
        reasons.push(
          `palette query was ${JSON.stringify(run.query)}, expected it to include "preview"`
        );
      if (!run.trusted) reasons.push('Enter was dispatched from script, not as a real key press');
    }
    return reasons;
  },
};
