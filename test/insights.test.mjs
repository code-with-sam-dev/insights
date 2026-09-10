import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  ratePerDay,
  projectEta,
  evaluatePlatform,
  focusOrder,
  contentRanking,
} from '../src/insights.mjs';

/*
  These tests are the specification for the only part of this project that can
  be quietly wrong: the arithmetic that turns raw counts into "where should the
  next hour go". A dashboard that renders a wrong number is worse than no
  dashboard, because it is acted on.
*/

test('ratePerDay returns 0 when there is not enough history to have a trend', () => {
  assert.equal(ratePerDay([]), 0);
  assert.equal(ratePerDay([{date: '2026-09-01', value: 10}]), 0);
});

test('ratePerDay recovers the slope of a clean linear series', () => {
  const series = [
    {date: '2026-09-01', value: 0},
    {date: '2026-09-02', value: 10},
    {date: '2026-09-03', value: 20},
    {date: '2026-09-04', value: 30},
  ];
  assert.equal(ratePerDay(series), 10);
});

test('ratePerDay fits a trend through noise rather than trusting the endpoints', () => {
  // A single bad final reading must not swing the projection. Endpoint
  // subtraction would report 1/day here; the underlying trend is 10/day.
  const series = [
    {date: '2026-09-01', value: 0},
    {date: '2026-09-02', value: 11},
    {date: '2026-09-03', value: 19},
    {date: '2026-09-04', value: 3},
  ];
  const rate = ratePerDay(series);
  assert.ok(rate > 1, `expected the trend to survive one bad reading, got ${rate}`);
});

test('ratePerDay handles gaps in the series by using real elapsed days', () => {
  const series = [
    {date: '2026-09-01', value: 0},
    {date: '2026-09-11', value: 100},
  ];
  assert.equal(ratePerDay(series), 10);
});

test('ratePerDay reports a negative rate when a metric is falling', () => {
  const series = [
    {date: '2026-09-01', value: 100},
    {date: '2026-09-02', value: 90},
    {date: '2026-09-03', value: 80},
  ];
  assert.equal(ratePerDay(series), -10);
});

test('projectEta is zero once the target is already met', () => {
  assert.equal(projectEta(1000, 1000, 5), 0);
  assert.equal(projectEta(1200, 1000, 5), 0);
});

test('projectEta divides the remaining gap by the current pace', () => {
  assert.equal(projectEta(100, 1000, 10), 90);
});

test('projectEta returns null when the pace will never close the gap', () => {
  // null means "not on track", which the UI must show differently from a long
  // ETA. A stalled metric and a slow metric need different decisions.
  assert.equal(projectEta(100, 1000, 0), null);
  assert.equal(projectEta(100, 1000, -5), null);
});

const YOUTUBE = {
  id: 'youtube',
  name: 'YouTube',
  dataSource: 'api',
  monetisation: {
    name: 'YouTube Partner Programme',
    requirements: [
      {metric: 'subscribers', target: 1000, label: 'subscribers'},
      {metric: 'watchHours', target: 4000, label: 'public watch hours in 12 months'},
    ],
  },
};

test('evaluatePlatform reports every unmet requirement with its own ETA', () => {
  const state = evaluatePlatform(YOUTUBE, {
    subscribers: [
      {date: '2026-09-01', value: 0},
      {date: '2026-09-11', value: 100},
    ],
    watchHours: [
      {date: '2026-09-01', value: 0},
      {date: '2026-09-11', value: 200},
    ],
  });

  assert.equal(state.met, false);
  assert.equal(state.gaps.length, 2);

  const subs = state.gaps.find((g) => g.metric === 'subscribers');
  assert.equal(subs.current, 100);
  assert.equal(subs.remaining, 900);
  assert.equal(subs.perDay, 10);
  assert.equal(subs.etaDays, 90);
});

test('evaluatePlatform takes the slowest requirement as the platform ETA', () => {
  // Monetisation needs ALL requirements, so the binding constraint is the
  // slowest one. Reporting the fastest would promise money that is not coming.
  const state = evaluatePlatform(YOUTUBE, {
    subscribers: [
      {date: '2026-09-01', value: 0},
      {date: '2026-09-11', value: 100},
    ],
    watchHours: [
      {date: '2026-09-01', value: 0},
      {date: '2026-09-11', value: 100},
    ],
  });

  assert.equal(state.gaps.find((g) => g.metric === 'subscribers').etaDays, 90);
  assert.equal(state.gaps.find((g) => g.metric === 'watchHours').etaDays, 390);
  assert.equal(state.etaDays, 390);
});

test('evaluatePlatform reports met when every requirement is satisfied', () => {
  const state = evaluatePlatform(YOUTUBE, {
    subscribers: [{date: '2026-09-11', value: 1500}],
    watchHours: [{date: '2026-09-11', value: 5000}],
  });
  assert.equal(state.met, true);
  assert.deepEqual(state.gaps, []);
  assert.equal(state.etaDays, 0);
});

test('evaluatePlatform marks the platform ETA unknown when any gap is stalled', () => {
  const state = evaluatePlatform(YOUTUBE, {
    subscribers: [
      {date: '2026-09-01', value: 0},
      {date: '2026-09-11', value: 100},
    ],
    watchHours: [
      {date: '2026-09-01', value: 50},
      {date: '2026-09-11', value: 50},
    ],
  });
  assert.equal(state.etaDays, null);
  assert.equal(state.stalled, true);
});

test('evaluatePlatform surfaces a blocked platform instead of inventing numbers', () => {
  // TikTok analytics need a business account, which is blocked. Rendering a
  // confident zero here would read as "no progress" rather than "no data".
  const tiktok = {
    id: 'tiktok',
    name: 'TikTok',
    dataSource: 'blocked',
    blockedReason: 'Creator Rewards needs a business account, which cannot be switched on.',
    monetisation: {name: 'Creator Rewards', requirements: []},
  };
  const state = evaluatePlatform(tiktok, {});
  assert.equal(state.status, 'blocked');
  assert.equal(state.etaDays, null);
  assert.match(state.blockedReason, /business account/);
});

test('evaluatePlatform treats a missing metric series as no data, not as zero', () => {
  const state = evaluatePlatform(YOUTUBE, {subscribers: [{date: '2026-09-11', value: 100}]});
  const watch = state.gaps.find((g) => g.metric === 'watchHours');
  assert.equal(watch.current, null);
  assert.equal(watch.etaDays, null);
});

test('focusOrder puts the platform closest to paying first', () => {
  const states = [
    {id: 'a', etaDays: 400, status: 'tracking'},
    {id: 'b', etaDays: 30, status: 'tracking'},
    {id: 'c', etaDays: 120, status: 'tracking'},
  ];
  assert.deepEqual(focusOrder(states).map((s) => s.id), ['b', 'c', 'a']);
});

test('focusOrder sinks stalled platforms below ones still moving, and blocked below those', () => {
  const states = [
    {id: 'blocked', etaDays: null, status: 'blocked'},
    {id: 'stalled', etaDays: null, status: 'tracking', stalled: true},
    {id: 'slow', etaDays: 900, status: 'tracking'},
  ];
  assert.deepEqual(focusOrder(states).map((s) => s.id), ['slow', 'stalled', 'blocked']);
});

test('focusOrder puts an already monetised platform first of all', () => {
  const states = [
    {id: 'earning', etaDays: 0, status: 'tracking', met: true},
    {id: 'close', etaDays: 10, status: 'tracking'},
  ];
  assert.deepEqual(focusOrder(states).map((s) => s.id), ['earning', 'close']);
});

const CLIPS = [
  {id: 'short-1', title: 'Yes and no', platform: 'tiktok', views: 1000, engagements: 120},
  {id: 'short-2', title: 'Same key', platform: 'tiktok', views: 2000, engagements: 60},
  {id: 'short-3', title: 'Consumer breaks', platform: 'tiktok', views: 900, engagements: 90},
];

test('contentRanking ranks by engagement rate, not by raw views', () => {
  // The most-viewed clip is the least engaging one here. Ranking by views would
  // tell Sam to make more of exactly the wrong thing.
  const {best, worst} = contentRanking(CLIPS, {minViews: 100});
  assert.equal(best[0].id, 'short-1');
  assert.equal(worst[0].id, 'short-2');
});

test('contentRanking sets aside clips with too little data to judge', () => {
  const items = [...CLIPS, {id: 'new', title: 'Fresh', platform: 'x', views: 3, engagements: 3}];
  const {best, insufficient} = contentRanking(items, {minViews: 100});
  assert.equal(insufficient.length, 1);
  assert.equal(insufficient[0].id, 'new');
  assert.ok(!best.some((i) => i.id === 'new'), 'a 3-view clip must not top the chart');
});

test('contentRanking survives a clip with zero views without dividing by zero', () => {
  const {insufficient} = contentRanking([{id: 'z', views: 0, engagements: 0}], {minViews: 1});
  assert.equal(insufficient.length, 1);
  assert.equal(insufficient[0].rate, null);
});

test('contentRanking returns empty results rather than throwing on no data', () => {
  const result = contentRanking([], {minViews: 100});
  assert.deepEqual(result.best, []);
  assert.deepEqual(result.worst, []);
});
