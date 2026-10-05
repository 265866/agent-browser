// Negative controls for the dogfood checks: with no browser activity at all,
// every scenario must fail. A check that passes an empty run would let a
// broken candidate through.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
const rng = { hex: (n) => 'a'.repeat(n), int: () => 1 };

for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
  const s = (await import(pathToFileURL(join(dir, file)).href)).default;

  test(`${s.id}: shape`, () => {
    assert.equal(`${s.id}.mjs`, file);
    for (const k of ['title', 'prompt', 'check', 'tokens', 'files'])
      assert.ok(s[k], `missing ${k}`);
    assert.ok(s.families.length > 0);
    assert.ok(s.maxTurns > 0 && s.timeoutSec > 0);
    assert.ok(s.files['index.html'], 'scenarios start at index.html');
    assert.equal(typeof s.prompt('http://127.0.0.1:1', s.tokens(rng)), 'string');
  });

  test(`${s.id}: an empty run fails the check`, async () => {
    const reasons = await s.check({
      events: [],
      requests: [],
      tokens: s.tokens(rng),
      base: 'http://127.0.0.1:1',
      file: () => null,
      path: (name) => join('nonexistent-dogfood-dir', name),
      agentBrowser: async () => ({
        code: 1,
        stdout: '',
        stderr: 'not available in negative control',
      }),
    });
    assert.ok(
      Array.isArray(reasons) && reasons.length > 0,
      'check passed with no browser activity'
    );
  });
}
