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

test('the collect workflow deploys as well as collecting', async () => {
  /*
    A push made with GITHUB_TOKEN does not trigger other workflows; GitHub
    blocks that to prevent loops. So a collect job that only commits leaves the
    published page serving a stale report forever, and nothing anywhere reports
    a failure. This caught us once already. The fix is that the same job which
    writes the report also publishes it.
  */
  const workflow = await readFile('.github/workflows/collect.yml', 'utf8');
  assert.match(workflow, /actions\/deploy-pages/, 'collect must publish what it wrote');
  assert.match(workflow, /pages: write/, 'and needs the permission to do it');
});

/*
  The page and the script agree on element ids only by convention, and a
  mismatch fails in the least useful way there is: $('missing') returns null,
  the renderer throws mid-run, and everything below the failure silently stops
  rendering. Nobody runs a browser in CI, so this is the only place it gets
  caught.

  Added 2026-09-11, when the page was reorganised into tabs and half the hosts
  moved or were renamed.
*/
test('every element the dashboard writes to exists in the page', async () => {
  const app = await readFile('web/app.js', 'utf8');
  const html = await readFile('web/index.html', 'utf8');

  const ids = new Set(
    [...stripComments(app).matchAll(/\$\('([a-z0-9-]+)'\)/gi)].map((m) => m[1])
  );
  assert.ok(ids.size > 10, 'expected the dashboard to address many elements');

  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `app.js writes to ids the page does not define: ${missing}`);
});

test('every tab button has a panel, and every panel has a button', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]).sort();
  const panels = [...html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tabs, panels, 'a tab without a panel shows an empty screen');
});

test('the dashboard never writes a credential to storage', async () => {
  // The data key is held in memory for the refresh loop. Persisting it would
  // turn "private while the tab is open" into "private until somebody opens
  // this browser", which is a different and much weaker promise.
  const app = stripComments(await readFile('web/app.js', 'utf8'));
  for (const sink of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.equal(app.includes(sink), false, `app.js must not use ${sink}`);
  }
});
