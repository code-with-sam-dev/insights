/**
 * Everything that has been uploaded, anywhere, with how it is doing.
 *
 * Sam's ask: one page showing all uploaded content across all platforms, and
 * it must fill itself in as soon as something is uploaded rather than waiting
 * for a human to edit a JSON file.
 *
 * That second half decides the design. The library is built from what is
 * MEASURED first and from the register second, not the other way round. A video
 * published an hour ago is in the YouTube API response long before anyone adds
 * it to data/uploads.json, so it appears here on the next collection run,
 * flagged as not yet registered. The register then adds the things an API
 * cannot know: which episode an asset belongs to, and why a platform is blocked.
 *
 * The rule the rest of this project runs on holds here too: a number we could
 * not collect is null, never zero. "No data" and "no views" lead to opposite
 * decisions, and only one of them means the clip failed.
 */

import {engagementRate} from './performance.mjs';

/** YouTube's own cut-off. At or under three minutes is a Short. */
const SHORT_MAX_SECONDS = 180;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Short or long.
 *
 * Duration decides it when we have one. A `/shorts/` URL is the fallback,
 * because that path only exists for Shorts. Failing both, the answer is
 * `unknown`: guessing from a title would put real clips in the wrong bucket and
 * quietly corrupt the comparison this whole module exists to make.
 */
export function formatOf({durationSeconds, url, kind} = {}) {
  // A written announcement has no duration and never will. It is not an
  // unmeasured video, and must not sit in the bucket the Shorts split reads.
  if (kind === 'post') return 'post';

  const seconds = num(durationSeconds);
  if (seconds !== null) return seconds <= SHORT_MAX_SECONDS ? 'short' : 'long';
  if (typeof url === 'string' && url.includes('/shorts/')) return 'short';
  if (kind === 'short') return 'short';
  if (kind === 'episode') return 'long';
  return 'unknown';
}

/** The id inside a YouTube URL, in any of the three shapes YouTube uses. */
const youtubeId = (url = '') => {
  const match = String(url).match(/(?:youtu\.be\/|\/shorts\/|[?&]v=)([A-Za-z0-9_-]{6,})/);
  return match ? match[1] : null;
};

const measure = (post) =>
  post
    ? {
        status: 'measured',
        views: num(post.views) ?? 0,
        likes: num(post.likes) ?? 0,
        comments: num(post.comments) ?? 0,
        engagementRate: engagementRate(post),
        durationSeconds: num(post.durationSeconds),
      }
    : {status: 'awaiting', views: null, likes: null, comments: null, engagementRate: null, durationSeconds: null};

/**
 * One row per piece of content, per platform it went to.
 *
 * `posts` is what the collectors measured. `uploads` is the register of
 * attempts. `catalogue` supplies titles and episode numbers for things the
 * platforms do not name usefully.
 */
export function contentLibrary({catalogue = [], uploads = [], posts = []} = {}) {
  const titleFor = new Map(catalogue.map((a) => [`${a.episode}/${a.asset}`, a]));

  // Index the measured posts by id so a register row can find its numbers, and
  // keep track of which ones got claimed. Whatever is left over is content that
  // went out without ever being written down, which is exactly what must not
  // disappear from this page.
  const byId = new Map();
  for (const post of posts) {
    const id = post.id ?? youtubeId(post.url);
    if (id) byId.set(id, post);
  }
  const claimed = new Set();

  const rows = [];

  for (const entry of uploads) {
    const asset = titleFor.get(`${entry.episode}/${entry.asset}`);
    const id = youtubeId(entry.url);
    const post = id ? byId.get(id) : null;
    if (post) claimed.add(id);

    const measured = entry.url ? measure(post) : measure(null);

    rows.push({
      episode: entry.episode ?? null,
      asset: entry.asset ?? null,
      kind: asset?.kind ?? null,
      title: asset?.title ?? post?.title ?? null,
      platform: entry.platform,
      url: entry.url ?? null,
      at: entry.at ?? null,
      publishedAt: post?.publishedAt ?? null,
      unregistered: false,
      // A platform we are locked out of is not a clip that failed. It keeps its
      // reason and is never ranked against measured content.
      ...(entry.url ? measured : {...measured, status: entry.blocked ? 'blocked' : 'pending'}),
      ...(entry.blocked ? {blocked: entry.blocked} : {}),
      format: formatOf({durationSeconds: post?.durationSeconds, url: entry.url, kind: asset?.kind}),
    });
  }

  // Anything measured that no register row claimed. This is the half that makes
  // the page keep itself up to date.
  for (const [id, post] of byId) {
    if (claimed.has(id)) continue;
    rows.push({
      episode: null,
      asset: null,
      kind: null,
      title: post.title ?? null,
      platform: post.platform,
      url: post.url ?? null,
      at: post.publishedAt ?? null,
      publishedAt: post.publishedAt ?? null,
      unregistered: true,
      ...measure(post),
      format: formatOf(post),
    });
  }

  // Newest first. Nobody scrolls to the bottom of this kind of page.
  return rows.sort((a, b) =>
    String(b.publishedAt ?? b.at ?? '').localeCompare(String(a.publishedAt ?? a.at ?? ''))
  );
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const summarise = (rows) => {
  const measured = rows.filter((r) => r.status === 'measured' && num(r.views) !== null);
  if (measured.length === 0) {
    return {
      status: 'awaiting', measured: 0, views: 0, likes: 0, comments: 0,
      meanViews: null, medianViews: null, engagementRate: null, best: null, worst: null,
    };
  }

  const views = measured.map((r) => r.views);
  const total = views.reduce((a, b) => a + b, 0);
  const likes = measured.reduce((a, r) => a + (num(r.likes) ?? 0), 0);
  const comments = measured.reduce((a, r) => a + (num(r.comments) ?? 0), 0);
  const byViews = [...measured].sort((a, b) => b.views - a.views);

  return {
    status: 'measured',
    measured: measured.length,
    views: total,
    likes,
    comments,
    meanViews: Math.round(total / measured.length),
    // The median matters more than the mean here. One clip that happens to get
    // picked up drags the mean above anything the channel will repeat, and a
    // target nobody can hit again is worse than no target.
    medianViews: median(views),
    engagementRate: total > 0 ? (likes + comments) / total : 0,
    best: byViews[0] ?? null,
    worst: byViews[byViews.length - 1] ?? null,
  };
};

/** Shorts against long form, kept apart because they are not comparable. */
export function shortsPerformance(rows = []) {
  return {
    shorts: summarise(rows.filter((r) => r.format === 'short')),
    long: summarise(rows.filter((r) => r.format === 'long')),
    unknown: summarise(rows.filter((r) => r.format === 'unknown')),
  };
}
