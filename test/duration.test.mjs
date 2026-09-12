import {test} from 'node:test';
import assert from 'node:assert/strict';

import {parseDuration} from '../src/youtube.mjs';

// YouTube returns ISO 8601 durations. Without this, every video's format has
// to be guessed from its URL, and a Short posted as a normal watch link would
// be counted as long form and quietly spoil the comparison.
test('a short clip parses to seconds', () => {
  assert.equal(parseDuration('PT31S'), 31);
  assert.equal(parseDuration('PT1M2S'), 62);
});

test('a long episode parses to seconds', () => {
  assert.equal(parseDuration('PT13M38S'), 818);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
});

test('a missing or unreadable duration is null, never zero', () => {
  // Zero would classify every unmeasured video as a Short.
  assert.equal(parseDuration(undefined), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('nonsense'), null);
});
