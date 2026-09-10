/**
 * Chart maths.
 *
 * Hand-written rather than pulled from a charting library, for one reason that
 * matters more than convenience: this page holds a decryption key in memory,
 * and every third-party script on it is a script that could read that key. A
 * few dozen lines of SVG path arithmetic is a smaller risk than a dependency
 * tree, and it is fully testable, which a library's rendering is not.
 *
 * Runs unchanged in Node and the browser, same as the crypto module, so the
 * maths can be tested in the suite rather than eyeballed in a browser.
 */

const DAY_MS = 86400000;

/**
 * Maps a value from one range onto another.
 *
 * A zero-width domain returns the midpoint of the range rather than NaN. Flat
 * series are common early on, when there is one reading repeated, and NaN
 * coordinates are silently dropped by SVG, so the chart would simply vanish
 * with no error anywhere.
 */
export function linearScale([d0, d1], [r0, r1]) {
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/**
 * An SVG path for a time series.
 *
 * The y axis is baselined at **zero**, not at the data's own minimum. Scaling
 * to the minimum makes 990 to 1000 look like a tenfold rise, and on a dashboard
 * whose whole purpose is deciding where to spend effort, that is the single
 * most misleading thing a chart can do.
 */
export function seriesPath(series, {width, height, padding = 2}) {
  if (!Array.isArray(series) || series.length < 2) return '';

  const times = series.map((p) => Date.parse(p.date));
  const values = series.map((p) => p.value);

  const x = linearScale([Math.min(...times), Math.max(...times)], [0, width]);
  const y = linearScale([0, Math.max(...values)], [height - padding, padding]);

  return series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(Date.parse(p.date)).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ');
}

/** Where the current trend meets the target, or null if it never does. */
export function projectionPoint({current, target, perDay}) {
  if (current === null || current === undefined) return null;
  if (!Number.isFinite(perDay) || perDay <= 0) return null;
  if (current >= target) return {days: 0, value: current};
  return {days: (target - current) / perDay, value: target};
}

/**
 * The trailing `days` of a series.
 *
 * Widens the window rather than returning a single point, because one point
 * draws nothing and an empty chart reads as a bug rather than as a narrow
 * filter. The caller is expected to say when it has done this.
 */
export function filterSince(series, days, now = new Date()) {
  if (!Array.isArray(series) || series.length === 0) return [];
  if (!days) return series;

  const cutoff = now.getTime() - days * DAY_MS;
  const kept = series.filter((p) => Date.parse(p.date) >= cutoff);

  if (kept.length >= 2) return kept;
  return series.slice(-2);
}

/** Round axis labels covering the data. */
export function niceTicks(min, max, count = 4) {
  if (max <= min) return [min, min + 1];

  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? magnitude * 10;

  const ticks = [];
  for (let t = Math.floor(min / step) * step; t < max + step; t += step) {
    ticks.push(Number(t.toFixed(10)));
    if (ticks.length > 8) break;
  }
  return ticks;
}
