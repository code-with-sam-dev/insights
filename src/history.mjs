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
 * The hour a reading belongs to, as an ISO string: 2026-09-16T08:00:00.000Z.
 *
 * Collection runs every fifteen minutes, so four readings land in the same
 * hour. Keeping all four would quadruple the payload for resolution nobody
 * asked for, and quarter-hour noise on a view count is not a signal. The last
 * reading in an hour wins, which is the same rule the daily series already
 * uses for the last reading in a day.
 */
export function hourOf(when) {
  const t = new Date(when);
  t.setUTCMinutes(0, 0, 0);
  return t.toISOString();
}

/**
 * The hourly sample series, which is what makes the graphs incremental.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE DAILY SERIES. The daily series keys on
 * the date and REPLACES a same-day reading, so ninety-six runs a day collapse
 * into one point and the shape of a launch is lost: a video that takes four
 * thousand views in its first evening looks identical to one that took them
 * over a week. Nothing that was thrown away can be recovered later, so the
 * fine-grained series has to start accruing before it is needed, not when
 * someone finally asks for the chart.
 *
 * It is kept BESIDE the daily series rather than replacing it, because every
 * projection, every target line and every stall check on this dashboard is
 * written against the daily shape, and because the daily points are the only
 * record that exists for everything before this was added.
 *
 * Stored under history.samples, a key no platform will ever be called, and one
 * that nothing which walks the history by platform id will pick up.
 */
export function mergeSamples(history, platformId, metric, value, at) {
  const samples = history.samples ??= {};
  const forPlatform = samples[platformId] ??= {};
  let series = forPlatform[metric] ?? [];

  // Seed from the daily series the first time a metric is sampled, so the
  // chart runs from launch rather than from the day this was deployed. A
  // backfilled point sits at midnight, exactly where the daily charts already
  // draw it, so the two cannot disagree about the same reading.
  const hour = hourOf(at);

  if (series.length === 0) {
    // The daily series has ALREADY been updated with this reading by the time
    // this runs, and that point is the same measurement about to be written at
    // its real hour. Seeding it as well would draw today twice: once at
    // midnight, where nothing was measured, and once where it was.
    const day = hour.slice(0, 10);
    series = (history[platformId]?.[metric] ?? [])
      .filter((p) => p.date !== day)
      .map((p) => ({at: hourOf(`${p.date}T00:00:00Z`), value: p.value, daily: true}));
  }

  const existing = series.findIndex((p) => p.at === hour);
  const point = {at: hour, value};
  if (existing >= 0) series[existing] = point;
  else series.push(point);

  series.sort((a, b) => a.at.localeCompare(b.at));
  forPlatform[metric] = series;
}

/**
 * Fold one day's snapshot into the accumulated history.
 *
 * Snapshot shape: {date, <platformId>: {<metric>: value | null}}.
 * Returns a new object; the input is never mutated.
 */
export function mergeSnapshot(history, snapshot, {at} = {}) {
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

      // The incremental record. Stamped with the moment of collection when
      // there is one. The hand-entered numbers have no such moment, so they
      // fall back to midnight on the date they were READ: stamping a reading
      // that is three weeks old with this hour would invent a measurement
      // nobody took, and the flat line since would read as a stall.
      mergeSamples(merged, platformId, metric, value, at ?? `${date}T00:00:00Z`);
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
