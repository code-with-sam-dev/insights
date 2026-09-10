import {test} from 'node:test';
import assert from 'node:assert/strict';

import {mergeSnapshot, buildReport} from '../src/history.mjs';

/*
  History is append-only and cumulative, and it is the input to every
  projection. A merge bug here does not throw, it quietly bends the trend line
  and changes the advice the dashboard gives.
*/

const HISTORY = {
  youtube: {
    subscribers: [
      {date: '2026-09-09', value: 8},
      {date: '2026-09-10', value: 10},
    ],
  },
};

test('a new day is appended to the series', () => {
  const merged = mergeSnapshot(HISTORY, {
    date: '2026-09-11',
    youtube: {subscribers: 12},
  });
  assert.deepEqual(merged.youtube.subscribers.at(-1), {date: '2026-09-11', value: 12});
  assert.equal(merged.youtube.subscribers.length, 3);
});

test('running twice in one day overwrites rather than double counting', () => {
  // The workflow runs on a schedule and can also be triggered by hand. Two runs
  // on one day must not look like two days of growth.
  const once = mergeSnapshot(HISTORY, {date: '2026-09-11', youtube: {subscribers: 12}});
  const twice = mergeSnapshot(once, {date: '2026-09-11', youtube: {subscribers: 14}});
  assert.equal(twice.youtube.subscribers.length, 3);
  assert.deepEqual(twice.youtube.subscribers.at(-1), {date: '2026-09-11', value: 14});
});

test('a metric that returned no value leaves the series untouched', () => {
  // An API failure must not write a zero. A zero would read as a collapse and
  // would poison every projection built on the series.
  const merged = mergeSnapshot(HISTORY, {
    date: '2026-09-11',
    youtube: {subscribers: null},
  });
  assert.equal(merged.youtube.subscribers.length, 2);
  assert.deepEqual(merged.youtube.subscribers.at(-1), {date: '2026-09-10', value: 10});
});

test('a platform seen for the first time starts its own series', () => {
  const merged = mergeSnapshot(HISTORY, {date: '2026-09-11', x: {followers: 3}});
  assert.deepEqual(merged.x.followers, [{date: '2026-09-11', value: 3}]);
  assert.equal(merged.youtube.subscribers.length, 2, 'existing platforms survive');
});

test('the series stays in date order even if a backfill arrives late', () => {
  const merged = mergeSnapshot(HISTORY, {date: '2026-09-01', youtube: {subscribers: 1}});
  const dates = merged.youtube.subscribers.map((p) => p.date);
  assert.deepEqual(dates, ['2026-09-01', '2026-09-09', '2026-09-10']);
});

test('merging never mutates the history it was given', () => {
  const before = JSON.stringify(HISTORY);
  mergeSnapshot(HISTORY, {date: '2026-09-11', youtube: {subscribers: 12}});
  assert.equal(JSON.stringify(HISTORY), before);
});

test('buildReport carries the generation time and the threshold check date', () => {
  const report = buildReport(HISTORY, {content: [], generatedAt: '2026-09-11T00:00:00Z'});
  assert.equal(report.generatedAt, '2026-09-11T00:00:00Z');
  assert.ok(report.thresholdsVerified, 'the UI has to be able to say how stale the rules are');
});

test('buildReport orders platforms by how close they are to paying', () => {
  const report = buildReport(HISTORY, {content: []});
  assert.ok(Array.isArray(report.platforms));
  assert.equal(report.platforms[0].id, 'youtube', 'the only platform with data leads');
});

test('buildReport includes every platform, including ones with no data yet', () => {
  const report = buildReport(HISTORY, {content: []});
  const ids = report.platforms.map((p) => p.id);
  for (const id of ['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'linkedin']) {
    assert.ok(ids.includes(id), `${id} missing: a silent omission looks like a healthy channel`);
  }
});
