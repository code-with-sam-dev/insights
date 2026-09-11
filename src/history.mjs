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
export function buildReport(history, {content = [], generatedAt, uploads = []} = {}) {
  const states = PLATFORMS.map((platform) =>
    evaluatePlatform(platform, history[platform.id] ?? {})
  );

  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    thresholdsVerified: THRESHOLDS_VERIFIED,
    platforms: focusOrder(states),
    content: contentRanking(content, {minViews: 100}),
    // What actually went out, and what did not. The register is the durable
    // record of a distribution run; a chat transcript is not.
    uploads: uploadRegister(uploads),
    history,
  };
}
