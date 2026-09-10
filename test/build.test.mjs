import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

/*
  The browser and the GitHub Action must run the same crypto. If web/crypto.js
  is edited by hand and drifts from src/crypto.mjs, nothing fails at build time
  and nothing fails at encrypt time. It fails when Sam tries to unlock, which is
  the worst possible moment to find out.
*/
test('the web crypto bundle is a verbatim copy of the source module', async () => {
  const source = await readFile('src/crypto.mjs', 'utf8');
  const bundled = await readFile('web/crypto.js', 'utf8');
  assert.ok(
    bundled.endsWith(source),
    'web/crypto.js is out of date or was hand edited. Run: npm run build'
  );
});

/** Comments are prose and may legitimately name the things the code avoids. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the source crypto module does not depend on anything Node-only', async () => {
  // It has to run in the browser too, so Buffer, node: imports and process are
  // all out. Catching this here beats catching it on Sam's phone.
  const code = stripComments(await readFile('src/crypto.mjs', 'utf8'));
  assert.ok(!/\bBuffer\b/.test(code), 'Buffer does not exist in the browser');
  assert.ok(!/from ['"]node:/.test(code), 'node: imports do not resolve in the browser');
  assert.ok(!/\bprocess\./.test(code), 'process does not exist in the browser');
});

test('the comment stripper does not hide a real violation', () => {
  // A test that can only pass is not a test. This proves the stripper removes
  // prose without also removing the code it is meant to be checking.
  assert.ok(/\bBuffer\b/.test(stripComments('/* about Buffer */ const x = Buffer.from(1);')));
  assert.ok(!/\bBuffer\b/.test(stripComments('/* about Buffer */ const x = 1;')));
  assert.ok(!/\bBuffer\b/.test(stripComments('// about Buffer\nconst x = 1;')));
});
