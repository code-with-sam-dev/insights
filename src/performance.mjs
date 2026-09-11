/**
 * Which post did well, which did badly, and on which platform.
 *
 * Sam asked for the best and worst per platform, plus most liked and most
 * commented, because those three disagree and the disagreement is the useful
 * part: the most watched clip is often not the one people liked, and almost
 * never the one they commented on.
 *
 * The rule this shares with the rest of the project: a platform we cannot
 * measure reads as awaiting data, never as a bad result. Ranking a platform on
 * an invented zero would put a real clip at the bottom of a list and change
 * what Sam makes next.
 */

import {PLATFORMS} from './platforms.mjs';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Likes plus comments over views. Zero views is 0, not a division by zero. */
export function engagementRate({views, likes = 0, comments = 0} = {}) {
  const v = num(views);
  if (!v) return 0;
  return ((num(likes) ?? 0) + (num(comments) ?? 0)) / v;
}

const decorate = (post) => ({
  id: post.id,
  platform: post.platform,
  title: post.title ?? null,
  url: post.url ?? null,
  views: num(post.views) ?? 0,
  likes: num(post.likes) ?? 0,
  comments: num(post.comments) ?? 0,
  publishedAt: post.publishedAt ?? null,
  engagementRate: engagementRate(post),
});

const topBy = (list, pick) =>
  list.reduce((best, p) => (best === null || pick(p) > pick(best) ? p : best), null);

export function performanceByPlatform(posts = []) {
  const byPlatform = {};

  for (const {id} of PLATFORMS) {
    // A post with no view count is not measured. Treating a missing number as
    // zero would invent a worst performer out of a gap in collection.
    const mine = posts.filter((p) => p.platform === id && num(p.views) !== null).map(decorate);

    if (mine.length === 0) {
      byPlatform[id] = {
        status: 'awaiting',
        measured: 0,
        best: null,
        worst: null,
        mostLiked: null,
        mostCommented: null,
        totals: {views: 0, likes: 0, comments: 0},
        posts: [],
      };
      continue;
    }

    const sorted = [...mine].sort((a, b) => b.views - a.views);

    byPlatform[id] = {
      status: 'measured',
      measured: mine.length,
      best: sorted[0],
      // One post is not a ranking. Calling the only clip on a platform its
      // worst is technically true, useless, and reads as a verdict on the clip.
      worst: sorted.length > 1 ? sorted[sorted.length - 1] : null,
      mostLiked: topBy(mine, (p) => p.likes),
      mostCommented: topBy(mine, (p) => p.comments),
      totals: {
        views: mine.reduce((t, p) => t + p.views, 0),
        likes: mine.reduce((t, p) => t + p.likes, 0),
        comments: mine.reduce((t, p) => t + p.comments, 0),
      },
      posts: sorted,
    };
  }

  const measured = Object.values(byPlatform).flatMap((p) => p.posts);

  return {
    byPlatform,
    leader: topBy(measured, (p) => p.views),
    mostLiked: topBy(measured, (p) => p.likes),
    mostCommented: topBy(measured, (p) => p.comments),
  };
}
