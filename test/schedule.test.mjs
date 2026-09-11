import {test} from 'node:test';
import assert from 'node:assert/strict';

import {DAILY_CAP, postingPlan} from '../src/schedule.mjs';
import {uploadMatrix} from '../src/matrix.mjs';

/*
  The plan turns "these cells are empty" into "do this, there, today".

  Two rules it must not break, both paid for already:

  1. TikTok gets one clip a day. Three in five minutes from a low-follower
     account reads as spam to its early distribution and they get throttled
     together instead of each getting its own cold-start test. That rule was
     broken once, on 2026-09-11, deliberately and with Sam's agreement; the
     plan should not make breaking it the default.
  2. A blocked item is not scheduled. Putting an item on a date when the
     platform will refuse it teaches Sam to ignore the dates.
*/

const catalogue = [
  {episode: 2, asset: 'short-1', kind: 'short', title: 'S1', createdAt: '2026-09-11'},
  {episode: 2, asset: 'short-2', kind: 'short', title: 'S2', createdAt: '2026-09-11'},
  {episode: 2, asset: 'short-3', kind: 'short', title: 'S3', createdAt: '2026-09-11'},
];

const plan = (entries, today = '2026-09-12') =>
  postingPlan(uploadMatrix(catalogue, entries).rows, {today});

test('nothing pending means nothing to do', () => {
  const entries = [];
  for (const asset of ['short-1', 'short-2', 'short-3']) {
    for (const platform of ['youtube', 'tiktok', 'instagram', 'facebook']) {
      entries.push({episode: 2, platform, asset, url: `https://x/${platform}/${asset}`});
    }
  }
  assert.deepEqual(plan(entries).items, []);
});

test('TikTok is paced one a day, so three clips take three days', () => {
  assert.equal(DAILY_CAP.tiktok, 1);
  const items = plan([]).items.filter((i) => i.platform === 'tiktok');
  assert.deepEqual(
    items.map((i) => i.date),
    ['2026-09-12', '2026-09-13', '2026-09-14']
  );
});

test('different platforms share a day rather than queueing behind each other', () => {
  // Pacing is a per-platform concern. Nothing is gained by making Instagram
  // wait for TikTok.
  const firstDay = plan([]).items.filter((i) => i.date === '2026-09-12');
  const platforms = new Set(firstDay.map((i) => i.platform));
  assert.ok(platforms.has('tiktok'));
  assert.ok(platforms.has('instagram'));
});

test('a blocked cell is never given a date, and is reported separately', () => {
  const result = plan([
    {episode: 2, platform: 'facebook', asset: 'short-1', blocked: 'Page unreachable'},
  ]);
  assert.equal(
    result.items.some((i) => i.platform === 'facebook' && i.asset === 'short-1'),
    false
  );
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].blocked, 'Page unreachable');
});

test('the oldest waiting asset goes first, so nothing rots at the bottom', () => {
  const mixed = [
    {episode: 2, asset: 'short-1', kind: 'short', title: 'new', createdAt: '2026-09-11'},
    {episode: 1, asset: 'short-1', kind: 'short', title: 'old', createdAt: '2026-09-10'},
  ];
  const {items} = postingPlan(uploadMatrix(mixed, []).rows, {today: '2026-09-12'});
  const tiktok = items.filter((i) => i.platform === 'tiktok');
  assert.equal(tiktok[0].episode, 1);
  assert.equal(tiktok[0].date, '2026-09-12');
});

test('Facebook items are flagged as Sam doing them by hand', () => {
  // Facebook is excluded from the automated run on Sam's instruction, so the
  // plan has to say who is doing it or the row is not actionable.
  const fb = plan([]).items.find((i) => i.platform === 'facebook');
  assert.equal(fb.manual, true);
  const tt = plan([]).items.find((i) => i.platform === 'tiktok');
  assert.equal(tt.manual, false);
});

test('the plan says what is due today, which is the only part read most days', () => {
  const result = plan([]);
  assert.ok(result.today.length > 0);
  assert.ok(result.today.every((i) => i.date === '2026-09-12'));
});
