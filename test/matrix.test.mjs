import {test} from 'node:test';
import assert from 'node:assert/strict';

import {CARRIES, uploadMatrix, coverage} from '../src/matrix.mjs';

/*
  The matrix answers one question Sam asked directly: for everything we made,
  where is it and where is it not.

  The trap it exists to avoid: treating "this platform never takes this kind of
  asset" the same as "this platform has not got it yet". A long-form episode is
  not missing from TikTok. Conflating the two produces a permanent red cell
  nobody can ever clear, and a dashboard with a cell like that gets ignored.
*/

const catalogue = [
  {episode: 2, asset: 'episode', kind: 'episode', title: 'Ep2'},
  {episode: 2, asset: 'short-1', kind: 'short', title: 'S1'},
  {episode: 2, asset: 'post', kind: 'post', title: 'Post'},
];

test('an asset kind maps to exactly the platforms expected to carry it', () => {
  assert.deepEqual(CARRIES.episode, ['youtube']);
  assert.deepEqual(CARRIES.post, ['linkedin', 'x']);
  assert.deepEqual(CARRIES.short, ['youtube', 'tiktok', 'instagram', 'facebook']);
});

test('a platform that never carries a kind reads not-applicable, not pending', () => {
  const {rows} = uploadMatrix(catalogue, []);
  const episode = rows.find((r) => r.asset === 'episode');
  assert.equal(episode.cells.tiktok.status, 'n/a');
  assert.equal(episode.cells.youtube.status, 'pending');
});

test('a published cell carries the URL that proves it', () => {
  const {rows} = uploadMatrix(catalogue, [
    {episode: 2, platform: 'youtube', asset: 'short-1', url: 'https://y/1', at: '2026-09-11'},
  ]);
  const short = rows.find((r) => r.asset === 'short-1');
  assert.equal(short.cells.youtube.status, 'published');
  assert.equal(short.cells.youtube.url, 'https://y/1');
  assert.equal(short.cells.youtube.at, '2026-09-11');
});

test('an entry with no URL is pending however confidently it was recorded', () => {
  // The register's founding rule. A post that reported success but did not
  // save is the dangerous case, so only a URL counts as done.
  const {rows} = uploadMatrix(catalogue, [
    {episode: 2, platform: 'tiktok', asset: 'short-1', at: '2026-09-11'},
  ]);
  assert.equal(rows.find((r) => r.asset === 'short-1').cells.tiktok.status, 'pending');
});

test('a blocked entry stays pending but carries its reason', () => {
  const {rows} = uploadMatrix(catalogue, [
    {episode: 2, platform: 'facebook', asset: 'short-1', blocked: 'Profile suspended'},
  ]);
  const cell = rows.find((r) => r.asset === 'short-1').cells.facebook;
  assert.equal(cell.status, 'blocked');
  assert.equal(cell.blocked, 'Profile suspended');
});

test('rows are ordered newest episode first, and episode before its shorts', () => {
  const many = [
    {episode: 1, asset: 'short-1', kind: 'short'},
    {episode: 2, asset: 'short-1', kind: 'short'},
    {episode: 2, asset: 'episode', kind: 'episode'},
  ];
  const {rows} = uploadMatrix(many, []);
  assert.deepEqual(
    rows.map((r) => `${r.episode}/${r.asset}`),
    ['2/episode', '2/short-1', '1/short-1']
  );
});

test('coverage counts only the cells that could ever be filled', () => {
  // 1 episode cell + 4 short cells + 2 post cells = 7 applicable.
  const {rows} = uploadMatrix(catalogue, [
    {episode: 2, platform: 'youtube', asset: 'episode', url: 'https://y/e'},
  ]);
  const c = coverage(rows);
  assert.equal(c.applicable, 7);
  assert.equal(c.published, 1);
  assert.equal(c.pending, 6);
});

test('an upload recorded for an asset the catalogue does not know is surfaced, not dropped', () => {
  // Silently ignoring it would hide a real mistake: either the catalogue is
  // missing a render, or something was posted under the wrong name.
  const {orphans} = uploadMatrix(catalogue, [
    {episode: 2, platform: 'youtube', asset: 'short-9', url: 'https://y/9'},
  ]);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].asset, 'short-9');
});
