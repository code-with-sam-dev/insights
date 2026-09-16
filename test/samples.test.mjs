import {test} from 'node:test';
import assert from 'node:assert/strict';

import {mergeSnapshot, hourOf} from '../src/history.mjs';
import {ratePerHour, rateBars} from '../src/chart.mjs';
import {splitViews} from '../src/youtube.mjs';

/*
  The incremental record.

  Sam asked for graphs that accrue rather than being recomputed from whatever
  today happens to look like. The daily series cannot do that job: it keys on
  the date and replaces a same-day reading, so ninety-six collection runs
  collapse into one point and nothing about the shape of a launch survives.
  Nothing thrown away can be recovered later, which is why these tests exist
  before the first chart that needs them.
*/

const at = (iso) => ({at: iso});

test('a second run in the same hour replaces rather than appends', () => {
  let history = mergeSnapshot({}, {date: '2026-09-16', youtube: {views: 100}}, {
    at: '2026-09-16T08:05:00.000Z',
  });
  history = mergeSnapshot(history, {date: '2026-09-16', youtube: {views: 140}}, {
    at: '2026-09-16T08:50:00.000Z',
  });

  const series = history.samples.youtube.views;
  assert.equal(series.length, 1, 'four runs an hour must not draw four points');
  assert.equal(series[0].value, 140, 'the later reading wins');
  assert.equal(series[0].at, '2026-09-16T08:00:00.000Z');
});

test('a run in the next hour appends, so the history grows', () => {
  let history = mergeSnapshot({}, {date: '2026-09-16', youtube: {views: 100}}, {
    at: '2026-09-16T08:05:00.000Z',
  });
  history = mergeSnapshot(history, {date: '2026-09-16', youtube: {views: 180}}, {
    at: '2026-09-16T09:05:00.000Z',
  });

  assert.deepEqual(
    history.samples.youtube.views.map((p) => p.value),
    [100, 180]
  );
});

test('the daily series still collapses the same day, exactly as before', () => {
  let history = mergeSnapshot({}, {date: '2026-09-16', youtube: {views: 100}}, {
    at: '2026-09-16T08:05:00.000Z',
  });
  history = mergeSnapshot(history, {date: '2026-09-16', youtube: {views: 180}}, {
    at: '2026-09-16T09:05:00.000Z',
  });

  assert.deepEqual(history.youtube.views, [{date: '2026-09-16', value: 180}]);
});

/*
  The one that matters most on the day this shipped. Every reading before it
  exists only as a daily point, and a chart that started from the deploy would
  throw away the entire launch. Seeding puts those points on the hourly axis at
  the same place the daily charts already draw them.
*/
test('the hourly series is seeded from the daily history, so it runs from launch', () => {
  const existing = {
    youtube: {
      views: [
        {date: '2026-09-10', value: 10},
        {date: '2026-09-11', value: 25},
      ],
    },
  };

  const history = mergeSnapshot(existing, {date: '2026-09-12', youtube: {views: 60}}, {
    at: '2026-09-12T08:30:00.000Z',
  });

  assert.deepEqual(
    history.samples.youtube.views.map((p) => [p.at, p.value]),
    [
      ['2026-09-10T00:00:00.000Z', 10],
      ['2026-09-11T00:00:00.000Z', 25],
      ['2026-09-12T08:00:00.000Z', 60],
    ]
  );
});

test('a backfilled point is marked, because it is a day averaged not an hour measured', () => {
  const existing = {youtube: {views: [{date: '2026-09-10', value: 10}]}};
  const history = mergeSnapshot(existing, {date: '2026-09-11', youtube: {views: 20}}, {
    at: '2026-09-11T08:00:00.000Z',
  });

  assert.equal(history.samples.youtube.views[0].daily, true);
  assert.equal(history.samples.youtube.views[1].daily, undefined);
});

test('a failed reading leaves the hourly series untouched, same as the daily one', () => {
  const history = mergeSnapshot({}, {date: '2026-09-16', youtube: {views: null, subscribers: 12}}, {
    at: '2026-09-16T08:00:00.000Z',
  });

  assert.equal(history.samples.youtube.views, undefined, 'a zero here would read as a collapse');
  assert.equal(history.samples.youtube.subscribers.length, 1);
});

test('samples cannot be mistaken for a platform', () => {
  const history = mergeSnapshot({}, {date: '2026-09-16', youtube: {views: 1}}, {
    at: '2026-09-16T08:00:00.000Z',
  });
  // Everything that walks the history reads history[platform.id]. A platform
  // called samples would collide; none is, and none may be added.
  assert.ok(history.samples);
  assert.ok(history.youtube);
});

test('hourOf floors to the hour in UTC', () => {
  assert.equal(hourOf('2026-09-16T08:59:59.999Z'), '2026-09-16T08:00:00.000Z');
});

/* ---------- the rate ---------- */

test('a rate is divided by the real gap, not by one step', () => {
  const [day, hour] = ratePerHour([
    at('2026-09-14T00:00:00.000Z'),
    at('2026-09-15T00:00:00.000Z'),
    at('2026-09-15T01:00:00.000Z'),
  ].map((p, i) => ({...p, value: [100, 340, 355][i]})));

  // 240 views across a day is 10 an hour, not 240 an hour. Treating each step
  // as one hour would draw the launch week as a wall of spikes.
  assert.equal(day.perHour, 10);
  assert.equal(day.coarse, true);
  assert.equal(hour.perHour, 15);
  assert.equal(hour.coarse, false);
});

test('a downward revision stays negative rather than being floored', () => {
  const [only] = ratePerHour([
    {at: '2026-09-16T08:00:00.000Z', value: 500},
    {at: '2026-09-16T09:00:00.000Z', value: 480},
  ]);
  assert.equal(only.perHour, -20);
});

test('one reading draws nothing rather than throwing', () => {
  assert.deepEqual(ratePerHour([{at: '2026-09-16T08:00:00.000Z', value: 1}]), []);
  assert.deepEqual(ratePerHour(undefined), []);
});

test('a bar spans the interval it measured, so an overnight gap draws wide and low', () => {
  const rates = ratePerHour([
    {at: '2026-09-14T00:00:00.000Z', value: 100},
    {at: '2026-09-15T00:00:00.000Z', value: 340},
    {at: '2026-09-15T01:00:00.000Z', value: 355},
  ]);
  const [wide, narrow] = rateBars(rates, {width: 250, height: 100});

  assert.ok(wide.width > narrow.width * 10, 'the day must not draw as one thin spike');
  assert.ok(narrow.height > wide.height, 'the faster hour is the taller bar');
  assert.ok(wide.x >= 0 && narrow.x + narrow.width <= 250.5, 'bars stay inside the plot');
});

test('a flat series draws bars of zero height rather than vanishing', () => {
  const rates = ratePerHour([
    {at: '2026-09-16T08:00:00.000Z', value: 10},
    {at: '2026-09-16T09:00:00.000Z', value: 10},
  ]);
  const [bar] = rateBars(rates, {width: 100, height: 100});
  assert.ok(Number.isFinite(bar.y) && Number.isFinite(bar.height));
});

/* ---------- the split ---------- */

test('views split by duration, using the same rule as the content library', () => {
  const split = splitViews([
    {views: 1000, durationSeconds: 45, url: 'https://www.youtube.com/shorts/a'},
    {views: 20, durationSeconds: 900, url: 'https://www.youtube.com/watch?v=b'},
    {views: 700, durationSeconds: 58, url: 'https://www.youtube.com/shorts/c'},
  ]);

  // The real shape of this channel, and the reason the split exists: the
  // episode drew 20 while its Shorts drew 1,700. One total would show neither.
  assert.deepEqual(split, {viewsLongForm: 20, viewsShorts: 1700});
});

test('a video with no readable view count is left out of both sides', () => {
  const split = splitViews([
    {views: null, durationSeconds: 30},
    {views: 5, durationSeconds: 30},
  ]);
  assert.deepEqual(split, {viewsLongForm: 0, viewsShorts: 5});
});
