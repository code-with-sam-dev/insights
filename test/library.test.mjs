import {test} from 'node:test';
import assert from 'node:assert/strict';

import {contentLibrary, shortsPerformance, formatOf} from '../src/library.mjs';

const catalogue = [
  {episode: 3, asset: 'episode', kind: 'episode', title: 'Design a Digital Wallet', createdAt: '2026-09-12'},
  {episode: 3, asset: 'short-1', kind: 'short', title: 'Charged them twice', createdAt: '2026-09-12'},
];

const uploads = [
  {episode: 3, platform: 'youtube', asset: 'episode', url: 'https://youtu.be/fdrbDnkAruU', at: '2026-09-12'},
  {episode: 3, platform: 'youtube', asset: 'short-1', url: 'https://youtube.com/shorts/K1jAVd3M_l8', at: '2026-09-12'},
  {episode: 3, platform: 'tiktok', asset: 'short-1', at: '2026-09-12', blocked: 'no business account'},
];

const posts = [
  {id: 'fdrbDnkAruU', platform: 'youtube', title: 'Design a Digital Wallet', url: 'https://www.youtube.com/watch?v=fdrbDnkAruU',
   views: 400, likes: 20, comments: 4, publishedAt: '2026-09-12T10:00:00Z', durationSeconds: 818},
  {id: 'K1jAVd3M_l8', platform: 'youtube', title: 'Charged them twice', url: 'https://www.youtube.com/watch?v=K1jAVd3M_l8',
   views: 1000, likes: 50, comments: 10, publishedAt: '2026-09-12T11:00:00Z', durationSeconds: 31},
];

test('a short is told from a long video by its duration, not by its title', () => {
  assert.equal(formatOf({durationSeconds: 31}), 'short');
  assert.equal(formatOf({durationSeconds: 818}), 'long');
  // YouTube's own cut-off is three minutes.
  assert.equal(formatOf({durationSeconds: 180}), 'short');
  assert.equal(formatOf({durationSeconds: 181}), 'long');
});

test('a /shorts/ url is a short even when no duration was collected', () => {
  assert.equal(formatOf({url: 'https://youtube.com/shorts/K1jAVd3M_l8'}), 'short');
});

test('format is unknown rather than guessed when there is nothing to go on', () => {
  assert.equal(formatOf({}), 'unknown');
});

test('a written announcement is a post, not an unknown video', () => {
  // It has no duration and never will. Leaving it as unknown put LinkedIn and
  // X announcements into the bucket the Shorts comparison reads from.
  assert.equal(formatOf({kind: 'post'}), 'post');
});

test('every published upload appears in the library', () => {
  const rows = contentLibrary({catalogue, uploads, posts});
  const urls = rows.filter((r) => r.url).map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('fdrbDnkAruU')));
  assert.ok(urls.some((u) => u.includes('K1jAVd3M_l8')));
});

test('measured numbers are attached to the row they belong to', () => {
  const rows = contentLibrary({catalogue, uploads, posts});
  const short = rows.find((r) => r.url?.includes('K1jAVd3M_l8'));
  assert.equal(short.views, 1000);
  assert.equal(short.likes, 50);
  assert.equal(short.comments, 10);
  assert.equal(short.status, 'measured');
});

test('an upload nobody can measure reads as awaiting, never as zero views', () => {
  const rows = contentLibrary({catalogue, uploads, posts: []});
  const any = rows.find((r) => r.url);
  assert.equal(any.status, 'awaiting');
  assert.equal(any.views, null, 'a missing number must stay missing');
});

test('a blocked platform is carried with its reason rather than dropped', () => {
  const rows = contentLibrary({catalogue, uploads, posts});
  const tiktok = rows.find((r) => r.platform === 'tiktok');
  assert.equal(tiktok.status, 'blocked');
  assert.equal(tiktok.blocked, 'no business account');
});

// The property Sam asked for: the page must fill itself in when something is
// uploaded, without anyone remembering to edit a JSON file by hand.
test('a video that was uploaded but never registered still shows up', () => {
  const surprise = {
    id: 'brandNewId', platform: 'youtube', title: 'Something published an hour ago',
    url: 'https://www.youtube.com/watch?v=brandNewId', views: 12, likes: 1, comments: 0,
    publishedAt: '2026-09-13T09:00:00Z', durationSeconds: 45,
  };
  const rows = contentLibrary({catalogue, uploads, posts: [...posts, surprise]});
  const found = rows.find((r) => r.url?.includes('brandNewId'));

  assert.ok(found, 'a new upload must appear without being added to the catalogue');
  assert.equal(found.unregistered, true, 'and it must be visibly not in the register');
  assert.equal(found.format, 'short');
  assert.equal(found.views, 12);
});

test('the newest content is first, because that is what gets looked at', () => {
  const rows = contentLibrary({catalogue, uploads, posts});
  const dates = rows.map((r) => r.publishedAt ?? r.at).filter(Boolean);
  const sorted = [...dates].sort().reverse();
  assert.deepEqual(dates, sorted);
});

test('shorts and long videos are measured separately, not averaged together', () => {
  const rows = contentLibrary({catalogue, uploads, posts});
  const summary = shortsPerformance(rows);

  assert.equal(summary.shorts.measured, 1);
  assert.equal(summary.shorts.views, 1000);
  assert.equal(summary.long.measured, 1);
  assert.equal(summary.long.views, 400);
});

test('shorts performance reports the median as well as the mean', () => {
  // One viral clip drags a mean far above anything the channel actually does
  // again. The median is what the next Short should be expected to do.
  const rows = [
    {platform: 'youtube', format: 'short', status: 'measured', views: 10, likes: 0, comments: 0},
    {platform: 'youtube', format: 'short', status: 'measured', views: 20, likes: 0, comments: 0},
    {platform: 'youtube', format: 'short', status: 'measured', views: 9000, likes: 0, comments: 0},
  ];
  const {shorts} = shortsPerformance(rows);
  assert.equal(shorts.medianViews, 20);
  assert.equal(shorts.meanViews, 3010);
});

test('nothing measured reads as awaiting rather than a channel doing zero views', () => {
  const {shorts} = shortsPerformance([{platform: 'youtube', format: 'short', status: 'awaiting', views: null}]);
  assert.equal(shorts.measured, 0);
  assert.equal(shorts.status, 'awaiting');
  assert.equal(shorts.meanViews, null);
});

test('the best and worst short are named, so there is something to act on', () => {
  const rows = [
    {platform: 'youtube', format: 'short', status: 'measured', title: 'Winner', views: 900, likes: 0, comments: 0},
    {platform: 'youtube', format: 'short', status: 'measured', title: 'Loser', views: 4, likes: 0, comments: 0},
  ];
  const {shorts} = shortsPerformance(rows);
  assert.equal(shorts.best.title, 'Winner');
  assert.equal(shorts.worst.title, 'Loser');
});
