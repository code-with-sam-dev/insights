import {test} from 'node:test';
import assert from 'node:assert/strict';

import {performanceByPlatform, engagementRate} from '../src/performance.mjs';

/*
  Sam asked for the best and worst performer per platform, and which post has
  the most likes and the most comments.

  The failure this has to avoid is the one the rest of this project keeps
  hitting: a platform with no data must read as "no data", never as a worst
  performer. Ranking a platform we cannot measure would put a real clip at the
  bottom of a list on the strength of a zero we invented, and Sam would stop
  making that kind of clip.
*/

const posts = [
  {id: 'a', platform: 'youtube', title: 'A', views: 500, likes: 10, comments: 2},
  {id: 'b', platform: 'youtube', title: 'B', views: 100, likes: 1, comments: 9},
  {id: 'c', platform: 'youtube', title: 'C', views: 900, likes: 3, comments: 0},
  {id: 'd', platform: 'tiktok', title: 'D', views: 40, likes: 4, comments: 1},
];

test('best and worst are by views, per platform, independently', () => {
  const {byPlatform} = performanceByPlatform(posts);
  assert.equal(byPlatform.youtube.best.id, 'c');
  assert.equal(byPlatform.youtube.worst.id, 'b');
  assert.equal(byPlatform.tiktok.best.id, 'd');
});

test('most liked and most commented are tracked separately from most viewed', () => {
  // They disagree here on purpose. The most watched clip has middling likes and
  // no comments, and that difference is the whole reason to show all three.
  const {byPlatform} = performanceByPlatform(posts);
  assert.equal(byPlatform.youtube.mostLiked.id, 'a');
  assert.equal(byPlatform.youtube.mostCommented.id, 'b');
  assert.notEqual(byPlatform.youtube.best.id, byPlatform.youtube.mostLiked.id);
});

test('a platform with a single post is not given a worst performer', () => {
  // Calling the only clip on a platform its "worst" is technically true and
  // useless, and it reads as a judgement on the clip.
  const {byPlatform} = performanceByPlatform(posts);
  assert.equal(byPlatform.tiktok.worst, null);
});

test('a platform with no measurable posts reports no data, not zero', () => {
  const {byPlatform} = performanceByPlatform(posts);
  assert.equal(byPlatform.instagram.status, 'awaiting');
  assert.equal(byPlatform.instagram.best, null);
  assert.equal(byPlatform.youtube.status, 'measured');
});

test('posts missing a view count are excluded rather than counted as zero', () => {
  const {byPlatform} = performanceByPlatform([
    ...posts,
    {id: 'e', platform: 'tiktok', title: 'E'},
  ]);
  assert.equal(byPlatform.tiktok.measured, 1);
  assert.equal(byPlatform.tiktok.best.id, 'd');
});

test('engagement rate is likes plus comments over views, and survives zero views', () => {
  assert.equal(engagementRate({views: 100, likes: 8, comments: 2}), 0.1);
  assert.equal(engagementRate({views: 0, likes: 5, comments: 5}), 0);
});

test('the overall leader is the single best post across every platform', () => {
  const {leader} = performanceByPlatform(posts);
  assert.equal(leader.id, 'c');
});

test('totals are summed per platform so a small platform is not flattered by one hit', () => {
  const {byPlatform} = performanceByPlatform(posts);
  assert.equal(byPlatform.youtube.totals.views, 1500);
  assert.equal(byPlatform.youtube.totals.likes, 14);
  assert.equal(byPlatform.youtube.totals.comments, 11);
});
