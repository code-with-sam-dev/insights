/**
 * History accumulation and report assembly.
 *
 * The collector sees only today. Every projection needs a series, so the
 * history is carried forward inside the encrypted payload itself rather than
 * kept in a separate plaintext file. The Action holds the data key, so it can
 * decrypt yesterday, append today, and re-encrypt.
 *
 * The rule that matters here: a metric the API failed to return leaves its
 * series untouched. Writing a zero on a failed call would read as a collapse
 * and would poison every trend built on it.
 */

import {PLATFORMS, THRESHOLDS_VERIFIED} from './platforms.mjs';
import {evaluatePlatform, focusOrder, contentRanking} from './insights.mjs';
import {uploadRegister} from './uploads.mjs';
import {uploadMatrix, coverage, COLUMNS} from './matrix.mjs';
import {contentLibrary, shortsPerformance} from './library.mjs';
import {postingPlan} from './schedule.mjs';
import {performanceByPlatform} from './performance.mjs';

/**
 * Fold one day's snapshot into the accumulated history.
 *
 * Snapshot shape: {date, <platformId>: {<metric>: value | null}}.
 * Returns a new object; the input is never mutated.
 */
export function mergeSnapshot(history, snapshot) {
  const {date, ...platforms} = snapshot;
  const merged = structuredClone(history ?? {});

  for (const [platformId, metrics] of Object.entries(platforms)) {
    for (const [metric, value] of Object.entries(metrics ?? {})) {
      // A failed reading is not a reading.
      if (value === null || value === undefined || Number.isNaN(value)) continue;

      merged[platformId] ??= {};
      const series = merged[platformId][metric] ?? [];

      const existing = series.findIndex((p) => p.date === date);
      if (existing >= 0) {
        // Same day, later run. Replace rather than append, or a manual trigger
        // would look like a second day of growth.
        series[existing] = {date, value};
      } else {
        series.push({date, value});
      }

      series.sort((a, b) => a.date.localeCompare(b.date));
      merged[platformId][metric] = series;
    }
  }

  return merged;
}

/** Everything the page needs, already decided. The browser only renders. */
export function buildReport(
  history,
  {content = [], generatedAt, uploads = [], catalogue = [], today} = {}
) {
  const states = PLATFORMS.map((platform) =>
    evaluatePlatform(platform, history[platform.id] ?? {})
  );

  // The join between what was made and where it went. Doing it here rather
  // than in the browser keeps the page a renderer: every decision about what
  // counts as published or pending is made once, in tested code, and the page
  // cannot quietly disagree with the Action about it.
  const {rows, orphans} = uploadMatrix(catalogue, uploads);

  const libraryRows = contentLibrary({catalogue, uploads, posts: content});

  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    thresholdsVerified: THRESHOLDS_VERIFIED,
    platforms: focusOrder(states),
    content: contentRanking(content, {minViews: 100}),
    // Per-post results, split by platform. Best, worst, most liked and most
    // commented disagree with each other, which is the point of showing them.
    performance: performanceByPlatform(content),
    // What actually went out, and what did not. The register is the durable
    // record of a distribution run; a chat transcript is not.
    uploads: uploadRegister(uploads),
    matrix: {columns: COLUMNS, rows, orphans, coverage: coverage(rows)},
    schedule: postingPlan(rows, today ? {today} : {}),
    // Everything uploaded anywhere, with its numbers. Built from what was
    // measured as well as from the register, so a video published since the
    // last edit of data/uploads.json appears here on its own.
    library: {
      rows: libraryRows,
      shorts: shortsPerformance(libraryRows),
    },
    history,
  };
}

/**
 * Did anything actually move since the last run?
 *
 * Collection runs every fifteen minutes so the dashboard reads as live. That
 * is ninety-six runs a day, and committing each one would bury the repository
 * history in noise and push the Pages deploy queue for nothing.
 *
 * The comparison has to be on the plaintext report. Ciphertext is useless here
 * because AES-GCM uses a fresh IV each time, so encrypting the same data twice
 * produces different bytes and every run would look like a change.
 *
 * generatedAt is excluded for the same reason: it is the clock moving, not the
 * data.
 */
export function reportChanged(previous, next) {
  if (!previous) return true;
  const strip = ({generatedAt, ...rest}) => JSON.stringify(rest);
  return strip(previous) !== strip(next);
}
