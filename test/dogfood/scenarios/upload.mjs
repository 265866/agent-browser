// The uploaded file must be created on disk first and reach the server as a
// real multipart form upload with the exact contents.
export default {
  id: 'upload',
  title: 'Create a file and upload it through a file input',
  families: ['upload', 'click'],
  uses: [['upload']],
  maxTurns: 30,
  timeoutSec: 420,
  tokens: (r) => ({ NOTE: `release note ${r.hex(12)}` }),
  files: {
    'index.html': `<!doctype html><html><head><title>Attachments</title></head><body>
<h1>Attach release notes</h1>
<form method="post" action="/upload" enctype="multipart/form-data">
  <label>Notes file <input type="file" name="notes"></label>
  <button type="submit">Upload</button>
</form></body></html>`,
  },
  routes: {
    'POST /upload': () => ({
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><title>Uploaded</title><h1>Upload complete</h1>',
    }),
  },
  prompt: (base, t) =>
    `Create a file named notes.txt in the current directory containing exactly this single line: ${t.NOTE}\n` +
    `Then open ${base}/ , attach notes.txt to the "Notes file" input, and click Upload. Confirm the page says "Upload complete". Then close the browser.`,
  check: ({ requests, tokens }) => {
    const post = requests.filter((r) => r.method === 'POST' && r.path === '/upload').at(-1);
    if (!post) return ['the form was never submitted'];
    const reasons = [];
    if (!String(post.headers['content-type'] ?? '').startsWith('multipart/form-data'))
      reasons.push('the upload was not sent as multipart form data');
    const part = post.body.match(
      /Content-Disposition: form-data; name="notes"; filename="([^"]*)"\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n--/
    );
    if (!part) reasons.push('no file was attached to the notes field');
    else {
      if (part[1] !== 'notes.txt')
        reasons.push(`uploaded file name was ${JSON.stringify(part[1])}`);
      if (part[2].trim() !== tokens.NOTE) reasons.push('uploaded file contents did not match');
    }
    return reasons;
  },
};
