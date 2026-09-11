/**
 * The upload register: what went out, and what did not.
 *
 * Sam asked for this on 2026-09-11, after an Episode 2 run where YouTube,
 * LinkedIn and X published cleanly and Facebook, Instagram and TikTok did not.
 * Without a register the only record of that is a chat transcript, and the next
 * session begins by guessing.
 *
 * The rule that matters: an entry is published only if it has a URL. Anything
 * else is pending, whether or not something marked it blocked. A half-finished
 * post is the dangerous case, because it feels done and is not.
 */

import {PLATFORMS} from './platforms.mjs';

/** Every platform an episode is expected to reach, in a stable order. */
const ALL = PLATFORMS.map((p) => p.id).sort();

export function uploadRegister(entries = []) {
  const published = entries.filter((e) => Boolean(e.url));
  const pending = entries.filter((e) => !e.url);

  const episodes = [...new Set(entries.map((e) => e.episode))].sort((a, b) => b - a);

  const byEpisode = episodes.map((episode) => {
    const mine = entries.filter((e) => e.episode === episode);
    const reached = new Set(mine.filter((e) => e.url).map((e) => e.platform));
    return {
      episode,
      total: mine.length,
      published: mine.filter((e) => e.url).length,
      pending: mine.filter((e) => !e.url).length,
      // Which platforms this episode never reached at all. The point of the
      // register is that this list is visible without reading a transcript.
      missingPlatforms: ALL.filter((p) => !reached.has(p)),
      entries: mine,
    };
  });

  return {published, pending, byEpisode};
}
