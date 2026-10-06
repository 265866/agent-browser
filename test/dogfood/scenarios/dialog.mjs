import { pageScript } from '../server.mjs';

// confirm() and prompt() are not auto-dismissed, so the run has to answer
// them through agent-browser's dialog handling.
export default {
  id: 'dialog',
  title: 'Accept a confirm dialog and answer a prompt dialog',
  families: ['dialog', 'click'],
  uses: [['dialog']],
  maxTurns: 30,
  timeoutSec: 420,
  tokens: (r) => ({ NAME: `proj-${r.hex(6)}` }),
  files: {
    'index.html': `<!doctype html><html><head><title>Projects</title></head><body>
<h1>Project {{NAME}}</h1>
<button id="del">Delete project</button>
<p id="status"></p>
${pageScript(`
document.getElementById('del').addEventListener('click', (e) => {
  const sure = confirm('Delete this project? This cannot be undone.');
  if (!sure) { report({ type: 'cancelled', trusted: e.isTrusted }); document.getElementById('status').textContent = 'Cancelled'; return; }
  const typed = prompt('Type the project name to confirm');
  report({ type: 'delete', confirmed: sure, typed, trusted: e.isTrusted });
  document.getElementById('status').textContent = typed === document.querySelector('h1').textContent.replace('Project ', '') ? 'Project deleted' : 'Name did not match';
});
`)}
</body></html>`,
  },
  prompt: (base, t) =>
    `Open ${base}/ and click "Delete project". Accept the confirmation dialog, and when it asks for the project name, answer ${t.NAME}. ` +
    `Confirm the page says "Project deleted". Then close the browser.`,
  check: ({ events, tokens }) => {
    const del = events.filter((e) => e.type === 'delete').at(-1);
    if (!del) return ['the deletion was never confirmed'];
    const reasons = [];
    if (del.typed !== tokens.NAME)
      reasons.push(
        `prompt was answered with ${JSON.stringify(del.typed)}, expected ${tokens.NAME}`
      );
    if (!del.trusted) reasons.push('Delete project was clicked from script, not a real click');
    return reasons;
  },
};
