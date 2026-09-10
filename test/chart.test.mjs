import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  linearScale,
  seriesPath,
  projectionPoint,
  filterSince,
  niceTicks,
} from '../src/chart.mjs';

/*
  Chart maths is tested for the same reason the projections are: a chart that
  is subtly wrong is read as fact. A line that slopes the wrong way, or an axis
  that starts at a non-zero baseline without saying so, misinforms more
  effectively than a table ever could.
*/

test('linearScale maps the domain onto the range', () => {
  const scale = linearScale([0, 100], [0, 500]);
  assert.equal(scale(0), 0);
  assert.equal(scale(50), 250);
  assert.equal(scale(100), 500);
});

test('linearScale handles an inverted range, which is what SVG y axes need', () => {
  // SVG y grows downward, so the largest value maps to the smallest coordinate.
  const y = linearScale([0, 10], [100, 0]);
  assert.equal(y(0), 100);
  assert.equal(y(10), 0);
});

test('linearScale does not divide by zero when every value is identical', () => {
  // A flat series is common early on: one reading repeated. It must render as
  // a flat line rather than as NaN, which SVG silently drops.
  const scale = linearScale([5, 5], [0, 100]);
  assert.ok(Number.isFinite(scale(5)), `expected a finite value, got ${scale(5)}`);
});

const SERIES = [
  {date: '2026-09-01', value: 0},
  {date: '2026-09-02', value: 5},
  {date: '2026-09-03', value: 10},
];

test('seriesPath produces one move and one line per remaining point', () => {
  const path = seriesPath(SERIES, {width: 100, height: 50});
  assert.match(path, /^M/);
  assert.equal((path.match(/L/g) ?? []).length, 2);
});

test('seriesPath puts the first point on the left and the last on the right', () => {
  const path = seriesPath(SERIES, {width: 100, height: 50});
  const coords = path.match(/-?[\d.]+,-?[\d.]+/g).map((p) => p.split(',').map(Number));
  assert.equal(coords[0][0], 0);
  assert.equal(coords.at(-1)[0], 100);
});

test('seriesPath draws a rising series as rising, in SVG coordinates', () => {
  const path = seriesPath(SERIES, {width: 100, height: 50});
  const ys = path.match(/-?[\d.]+,(-?[\d.]+)/g).map((p) => Number(p.split(',')[1]));
  assert.ok(ys[0] > ys.at(-1), 'a growing metric must climb, meaning smaller y in SVG');
});

test('seriesPath returns an empty path rather than throwing on no data', () => {
  assert.equal(seriesPath([], {width: 100, height: 50}), '');
  assert.equal(seriesPath([{date: '2026-09-01', value: 3}], {width: 100, height: 50}), '');
});

test('seriesPath baselines at zero so growth is not visually exaggerated', () => {
  // Scaling to the data's own minimum makes 990 to 1000 look like a tenfold
  // rise. On a dashboard about deciding where to spend effort, that is the
  // single most misleading thing a chart can do.
  const flatish = [
    {date: '2026-09-01', value: 990},
    {date: '2026-09-02', value: 1000},
  ];
  const path = seriesPath(flatish, {width: 100, height: 100});
  const ys = path.match(/-?[\d.]+,(-?[\d.]+)/g).map((p) => Number(p.split(',')[1]));
  assert.ok(ys[0] - ys[1] < 5, `expected a nearly flat line, got a rise of ${ys[0] - ys[1]}`);
});

test('projectionPoint extends the trend to where it meets the target', () => {
  const point = projectionPoint({current: 100, target: 200, perDay: 10});
  assert.equal(point.days, 10);
  assert.equal(point.value, 200);
});

test('projectionPoint returns null when there is no trend to extend', () => {
  assert.equal(projectionPoint({current: 100, target: 200, perDay: 0}), null);
  assert.equal(projectionPoint({current: 100, target: 200, perDay: -1}), null);
});

test('filterSince keeps only points inside the window', () => {
  const series = [
    {date: '2026-09-01', value: 1},
    {date: '2026-09-05', value: 5},
    {date: '2026-09-10', value: 10},
  ];
  const kept = filterSince(series, 7, new Date('2026-09-10T00:00:00Z'));
  assert.deepEqual(kept.map((p) => p.date), ['2026-09-05', '2026-09-10']);
});

test('filterSince with no window returns everything', () => {
  const series = [{date: '2026-09-01', value: 1}];
  assert.equal(filterSince(series, null).length, 1);
});

test('filterSince never returns a single point that would render as an empty chart', () => {
  // A window that catches only one reading draws nothing. Better to widen it
  // and say so than to show an empty box that looks like a bug.
  const series = [
    {date: '2026-09-01', value: 1},
    {date: '2026-09-09', value: 9},
    {date: '2026-09-10', value: 10},
  ];
  const kept = filterSince(series, 1, new Date('2026-09-10T00:00:00Z'));
  assert.ok(kept.length >= 2, `expected at least two points, got ${kept.length}`);
});

test('niceTicks produces round numbers spanning the data', () => {
  const ticks = niceTicks(0, 1000, 4);
  assert.ok(ticks.length >= 2 && ticks.length <= 6);
  assert.equal(ticks[0], 0);
  assert.ok(ticks.at(-1) >= 1000);
  for (const t of ticks) assert.equal(t, Math.round(t), 'ticks should be whole numbers here');
});

test('niceTicks copes with a zero range', () => {
  const ticks = niceTicks(0, 0, 4);
  assert.ok(ticks.length >= 2, 'a flat chart still needs an axis');
});
