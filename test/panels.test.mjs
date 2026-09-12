import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile('web/index.html', 'utf8');
const app = await readFile('web/app.js', 'utf8');

const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

/**
 * The page is hand written HTML driven by hand written JavaScript, so a panel
 * with no tab is invisible and a tab with no panel shows a blank screen. Both
 * look like the dashboard is broken and neither fails anything else.
 */
test('every tab has a panel and every panel has a tab', () => {
  const tabs = all(/data-tab="([a-z-]+)"/g, html).sort();
  const panels = all(/data-panel="([a-z-]+)"/g, html).sort();
  assert.deepEqual(tabs, panels);
});

test('the library panel exists, with the elements the renderer writes into', () => {
  for (const id of ['shorts-summary', 'library', 'library-filter']) {
    assert.ok(html.includes(`id="${id}"`), `web/index.html is missing #${id}`);
    assert.ok(app.includes(`'${id}'`), `web/app.js never renders into #${id}`);
  }
});

test('the refresh button points at the workflow that actually collects', () => {
  const match = /id="refresh"[\s\S]{0,400}?href="([^"]+)"/.exec(html);
  assert.ok(match, 'no refresh button found');
  assert.match(match[1], /actions\/workflows\/collect\.yml$/);
});

test('the refresh button cannot be a write path back into the page', () => {
  // The README promises there is no write path. A button that posted anywhere
  // would need a credential in the bundle and would break that promise.
  assert.ok(!/fetch\((['"`])https:\/\/api\.github\.com/.test(app));
  assert.ok(!/workflow_dispatch/.test(app), 'the page must not dispatch anything itself');
});

test('every renderer the report drives is called when the report renders', () => {
  const render = /function render\(\)[\s\S]*?\n}/.exec(app)?.[0] ?? '';
  for (const fn of ['renderShortsSummary', 'renderLibrary', 'renderMatrix', 'renderSchedule']) {
    assert.ok(render.includes(`${fn}()`), `render() never calls ${fn}()`);
  }
});
