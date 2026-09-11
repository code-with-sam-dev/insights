import {test} from 'node:test';
import assert from 'node:assert/strict';

import {reportChanged} from '../src/history.mjs';

/*
  Collection moved from once a day to every fifteen minutes so the dashboard
  reads as live. That is ninety-six runs a day, and without this check it is
  also ninety-six commits a day of a file whose contents did not move.

  The ciphertext cannot be compared: AES-GCM uses a fresh IV every time, so
  encrypting identical data twice produces different bytes. The comparison has
  to happen on the plaintext report, before encryption.
*/

const base = {
  generatedAt: '2026-09-11T10:00:00.000Z',
  platforms: [{id: 'youtube', subscribers: 12}],
  history: {youtube: {subscribers: [{date: '2026-09-11', value: 12}]}},
};

test('a report identical but for its timestamp has not changed', () => {
  const later = {...structuredClone(base), generatedAt: '2026-09-11T10:15:00.000Z'};
  assert.equal(reportChanged(base, later), false);
});

test('a moved number is a change', () => {
  const next = structuredClone(base);
  next.platforms[0].subscribers = 13;
  assert.equal(reportChanged(base, next), true);
});

test('a new day appended to the history is a change', () => {
  const next = structuredClone(base);
  next.history.youtube.subscribers.push({date: '2026-09-12', value: 12});
  assert.equal(reportChanged(base, next), true);
});

test('no previous report at all is always a change', () => {
  // First run of a fresh repo. Nothing to compare against, so write.
  assert.equal(reportChanged(null, base), true);
});

test('collection errors changing is a change, because the page shows them', () => {
  const next = {...structuredClone(base), errors: ['YouTube quota exceeded']};
  assert.equal(reportChanged(base, next), true);
});
