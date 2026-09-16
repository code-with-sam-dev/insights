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

const HOUR_MS = 3600000;

/**
 * Turn a cumulative series into the rate it grew at, per hour.
 *
 * WHY A RATE AND NOT THE RUNNING TOTAL. A cumulative view count only ever goes
 * up, so its chart is a line that slopes gently upward forever and every day
 * looks like every other day. The question the dashboard is actually for is
 * WHEN something moved: which evening a Short was picked up, whether a
 * publish did anything, whether the channel is still growing this week. That
 * is the derivative, and it is invisible in the total.
 *
 * DIVIDED BY THE REAL GAP, not by one. Readings are fifteen minutes apart now
 * and were a day apart before that, and a run that fails leaves a gap of
 * whatever length. Treating every step as one hour would turn a day's growth
 * into a spike a hundred times the truth, which is the exact failure that
 * would make the chart worse than no chart.
 *
 * A reading BELOW the one before it is kept as a negative rather than clamped.
 * YouTube does revise counts down when it strips inauthentic views, and a
 * dashboard that quietly floors that at zero is hiding the one movement its
 * owner would most want to see.
 */
export function ratePerHour(series) {
  if (!Array.isArray(series) || series.length < 2) return [];

  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    const from = Date.parse(series[i - 1].at ?? series[i - 1].date);
    const to = Date.parse(series[i].at ?? series[i].date);
    const hours = (to - from) / HOUR_MS;
    if (!Number.isFinite(hours) || hours <= 0) continue;

    out.push({
      at: series[i].at ?? series[i].date,
      from,
      to,
      hours,
      perHour: (series[i].value - series[i - 1].value) / hours,
      // True where the two readings either side were a day or more apart, so
      // the rate is a daily average spread over its hours rather than a real
      // hourly measurement. The chart says so instead of pretending.
      coarse: hours >= 24,
    });
  }
  return out;
}

/**
 * Bar geometry for a rate series, laid out on a real time axis.
 *
 * Each bar spans the interval it was measured over, so an overnight gap draws
 * one wide low bar rather than one narrow tall one, and the eye reads area as
 * volume the way it expects to.
 */
export function rateBars(rates, {width, height, pxPerHour = 6, minWidth = 2, domain} = {}) {
  if (!Array.isArray(rates) || rates.length === 0) return [];

  const t0 = domain?.[0] ?? Math.min(...rates.map((r) => r.from));
  const t1 = domain?.[1] ?? Math.max(...rates.map((r) => r.to));
  const span = width ?? Math.max(360, ((t1 - t0) / HOUR_MS) * pxPerHour);

  const x = linearScale([t0, t1], [0, span]);
  // The value axis is passed in when two series share a chart. Scaling each to
  // its own maximum would draw a Short's quiet week at the same height as an
  // episode's launch night, which is the one thing a reader of this chart must
  // never be led to believe.
  const top = domain?.[3] ?? Math.max(...rates.map((r) => r.perHour), 0);
  const floor = domain?.[2] ?? Math.min(...rates.map((r) => r.perHour), 0);
  const y = linearScale([floor, top || 1], [height, 0]);
  const zero = y(0);

  return rates.map((r) => {
    const left = x(r.from);
    const w = Math.max(minWidth, x(r.to) - left);
    const value = y(r.perHour);
    return {
      x: left,
      width: w,
      y: Math.min(value, zero),
      height: Math.max(1, Math.abs(zero - value)),
      rate: r,
    };
  });
}

/**
 * A rate series as points on a line, rather than as bars.
 *
 * WHERE THE POINT SITS, and it is not a detail. A rate is measured ACROSS an
 * interval, not at an instant, so the point goes at the MIDDLE of the interval
 * it came from. Putting it at the end would shift every reading later than it
 * happened, and on the backfilled part of the history, where an interval is a
 * whole day wide, that error is twelve hours.
 *
 * Returned as runs rather than one list, split wherever the resolution changes.
 * A day-averaged stretch and a truly hourly one are different measurements and
 * the line has to be able to say so, which a single path cannot. Each run
 * repeats the previous run's last point so the segments join rather than
 * leaving a gap at the changeover.
 */
export function rateRuns(rates, {width, height, domain} = {}) {
  if (!Array.isArray(rates) || rates.length === 0) return [];

  const t0 = domain?.[0] ?? Math.min(...rates.map((r) => r.from));
  const t1 = domain?.[1] ?? Math.max(...rates.map((r) => r.to));
  const floor = domain?.[2] ?? Math.min(...rates.map((r) => r.perHour), 0);
  const top = domain?.[3] ?? Math.max(...rates.map((r) => r.perHour), 0);

  const x = linearScale([t0, t1], [0, width]);
  const y = linearScale([floor, top || 1], [height, 0]);

  const points = rates.map((r) => ({
    x: x(r.from + (r.to - r.from) / 2),
    y: y(r.perHour),
    coarse: r.coarse,
    rate: r,
  }));

  const runs = [];
  for (const point of points) {
    const last = runs.at(-1);
    if (last && last.coarse === point.coarse) {
      last.points.push(point);
    } else {
      // Carry the joining point across, or the line breaks at every change of
      // resolution and reads as missing data rather than as a change of pace.
      const bridge = last ? [last.points.at(-1)] : [];
      runs.push({coarse: point.coarse, points: [...bridge, point]});
    }
  }

  return runs;
}

/** An SVG path through laid-out points. */
export function pathOf(points) {
  if (!Array.isArray(points) || points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
}
