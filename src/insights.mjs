/**
 * The arithmetic that turns raw counts into a decision.
 *
 * This module exists because the dashboard's job is not reporting, it is
 * answering one question: where should the next hour go. Sam is one person
 * with a day job. A wall of numbers he has to interpret himself would be a
 * worse tool than no dashboard, because it would cost time instead of saving
 * it.
 *
 * Three rules run through everything here:
 *
 *   Never invent a number. A metric with no data reads as null, never as zero.
 *   "No data" and "no progress" lead to opposite decisions.
 *
 *   Never rank by raw volume. The most-viewed clip is often the least engaging
 *   one, and ranking by views would recommend making more of the wrong thing.
 *
 *   Never promise money that is not coming. Monetisation needs every
 *   requirement met, so the binding constraint is the slowest one.
 */

const DAY_MS = 86400000;

const days = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY_MS;

/**
 * Growth per day, as a least-squares slope over the series.
 *
 * The obvious implementation is (last - first) / elapsed. It is also wrong in
 * the case that matters: one bad final reading, which APIs do produce, swings
 * the whole projection. A regression keeps the trend when a single point lies.
 *
 * Returns 0 for fewer than two points, which reads as "no trend yet" and
 * correctly produces a null ETA rather than a confident guess.
 */
export function ratePerDay(series) {
  if (!Array.isArray(series) || series.length < 2) return 0;

  const origin = series[0].date;
  const points = series.map((p) => ({x: days(origin, p.date), y: p.value}));
  const n = points.length;

  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.x - meanX) * (p.y - meanY);
    denominator += (p.x - meanX) ** 2;
  }

  // Every reading on the same day: no elapsed time, so no rate.
  if (denominator === 0) return 0;

  return numerator / denominator;
}

/**
 * Days until `current` reaches `target` at `perDay`.
 *
 * null means "not on track at this pace", which the UI must render differently
 * from a long ETA. A stalled metric and a slow metric need different decisions:
 * one needs a change of approach, the other needs patience.
 */
export function projectEta(current, target, perDay) {
  if (current === null || current === undefined) return null;
  if (current >= target) return 0;
  if (!Number.isFinite(perDay) || perDay <= 0) return null;
  return (target - current) / perDay;
}

const latest = (series) =>
  Array.isArray(series) && series.length > 0 ? series[series.length - 1].value : null;

/**
 * Where one platform stands against its own monetisation bar.
 *
 * `history` maps metric name to a series of {date, value}.
 */
export function evaluatePlatform(platform, history = {}) {
  if (platform.dataSource === 'blocked') {
    return {
      ...platform,
      status: 'blocked',
      met: false,
      gaps: [],
      etaDays: null,
      blockedReason: platform.blockedReason ?? 'No analytics access.',
    };
  }

  const requirements = platform.monetisation?.requirements ?? [];

  const gaps = [];
  for (const req of requirements) {
    const series = history[req.metric];
    const current = latest(series);
    if (current !== null && current >= req.target) continue;

    const perDay = ratePerDay(series);
    gaps.push({
      metric: req.metric,
      label: req.label ?? req.metric,
      current,
      target: req.target,
      remaining: current === null ? null : req.target - current,
      perDay,
      etaDays: projectEta(current, req.target, perDay),
    });
  }

  const met = requirements.length > 0 && gaps.length === 0;

  // Every requirement has to be met, so the platform ETA is the slowest gap.
  // Any gap with no route to the target makes the whole platform unknown.
  const stalled = gaps.some((g) => g.etaDays === null);
  const etaDays = met ? 0 : stalled ? null : Math.max(...gaps.map((g) => g.etaDays));

  return {
    ...platform,
    status: 'tracking',
    met,
    gaps,
    stalled,
    etaDays: gaps.length === 0 && !met ? null : etaDays,
  };
}

/**
 * Platforms in the order Sam should care about them.
 *
 * Already earning first, because protecting income beats chasing it. Then
 * soonest to pay. Then stalled, which still deserves a decision. Then blocked,
 * which deserves none until the block lifts.
 */
export function focusOrder(states) {
  const rank = (s) => {
    if (s.met) return 0;
    if (s.status === 'blocked') return 3;
    if (s.etaDays === null) return 2;
    return 1;
  };

  return [...states].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.etaDays === null || b.etaDays === null) return 0;
    return a.etaDays - b.etaDays;
  });
}

/**
 * What is working and what is not.
 *
 * Ranked by engagement rate rather than views, and anything without enough
 * views to judge is set aside instead of being ranked on noise. A clip with
 * three views and three likes is not the best thing on the channel.
 */
export function contentRanking(items, {minViews = 100} = {}) {
  const scored = items.map((item) => ({
    ...item,
    rate: item.views > 0 ? item.engagements / item.views : null,
  }));

  const judgeable = scored.filter((i) => i.views >= minViews && i.rate !== null);
  const insufficient = scored.filter((i) => i.views < minViews || i.rate === null);

  const byRate = [...judgeable].sort((a, b) => b.rate - a.rate);

  return {
    best: byRate,
    worst: [...byRate].reverse(),
    insufficient,
  };
}
