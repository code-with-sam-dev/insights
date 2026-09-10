import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

/*
  The browser and the GitHub Action must run the same crypto. If web/crypto.js
  is edited by hand and drifts from src/crypto.mjs, nothing fails at build time
  and nothing fails at encrypt time. It fails when Sam tries to unlock, which is
  the worst possible moment to find out.
*/
const SHARED = ['crypto', 'chart'];

test('every web bundle is a verbatim copy of its source module', async () => {
  for (const name of SHARED) {
    const source = await readFile(`src/${name}.mjs`, 'utf8');
    const bundled = await readFile(`web/${name}.js`, 'utf8');
    assert.ok(
      bundled.endsWith(source),
      `web/${name}.js is out of date or was hand edited. Run: npm run build`
    );
  }
});

/** Comments are prose and may legitimately name the things the code avoids. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no shared module depends on anything Node-only', async () => {
  // They have to run in the browser too, so Buffer, node: imports and process
  // are all out. Catching this here beats catching it on Sam's phone.
  for (const name of SHARED) {
    const code = stripComments(await readFile(`src/${name}.mjs`, 'utf8'));
    assert.ok(!/\bBuffer\b/.test(code), `${name}: Buffer does not exist in the browser`);
    assert.ok(!/from ['"]node:/.test(code), `${name}: node: imports do not resolve in the browser`);
    assert.ok(!/\bprocess\./.test(code), `${name}: process does not exist in the browser`);
  }
});

test('the comment stripper does not hide a real violation', () => {
  // A test that can only pass is not a test. This proves the stripper removes
  // prose without also removing the code it is meant to be checking.
  assert.ok(/\bBuffer\b/.test(stripComments('/* about Buffer */ const x = Buffer.from(1);')));
  assert.ok(!/\bBuffer\b/.test(stripComments('/* about Buffer */ const x = 1;')));
  assert.ok(!/\bBuffer\b/.test(stripComments('// about Buffer\nconst x = 1;')));
});

test('the demo generator refuses to overwrite real keys', async () => {
  // web/data holds the demo files and, once configured, the real ones. Running
  // the generator by accident against real keys would orphan every report ever
  // published, and nothing would say so until the next unlock failed.
  const source = await readFile('tools/demo-data.mjs', 'utf8');
  assert.match(source, /_demo !== true/, 'the guard must check the marker');
  assert.match(source, /Refusing to overwrite/, 'and must refuse rather than warn');
});

test('web/data is not ignored, because the deployed page needs what lives there', async () => {
  // An earlier version ignored it, which would have silently kept keys.json and
  // the encrypted report out of the repository and deployed a page that could
  // never unlock.
  const ignore = await readFile('.gitignore', 'utf8');
  const rules = ignore.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(
    !rules.some((r) => r.trim().replace(/\/$/, '') === 'web/data'),
    'web/data must stay tracked'
  );
});
