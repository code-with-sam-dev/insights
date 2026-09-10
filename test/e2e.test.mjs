import {test} from 'node:test';
import assert from 'node:assert/strict';

import {generateDataKey, encryptPayload, decryptPayload, wrapWithSecret, unwrapWithSecret} from '../src/crypto.mjs';
import {mergeSnapshot, buildReport} from '../src/history.mjs';

/*
  The whole pipeline in one test: days of collection accumulate, a report is
  built, encrypted the way the Action encrypts it, and opened the way the
  browser opens it. Every module in this project is exercised together here,
  because each one passing alone does not prove they agree with each other.
*/

test('a week of collection ends up readable on the other side of the key', async () => {
  // Seven days of real-shaped growth.
  let history = {};
  for (let day = 1; day <= 7; day += 1) {
    history = mergeSnapshot(history, {
      date: `2026-09-0${day}`,
      youtube: {subscribers: 4 + day * 3, watchHours: day * 6},
      x: {followers: day * 2},
    });
  }

  const report = buildReport(history, {
    content: [
      {id: 'short-1', title: 'Yes and no', platform: 'youtube', views: 800, engagements: 96},
      {id: 'short-2', title: 'Same key', platform: 'youtube', views: 1200, engagements: 24},
      {id: 'short-3', title: 'Too new', platform: 'youtube', views: 4, engagements: 2},
    ],
  });

  // Encrypt as the Action does, unlock as the phone does.
  const dataKey = await generateDataKey();
  const prfSecret = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrapWithSecret(dataKey, prfSecret);
  const box = await encryptPayload(dataKey, report);

  const opened = await decryptPayload(await unwrapWithSecret(wrapped, prfSecret), box);

  // The verdict the page leads with has to survive the round trip intact.
  const youtube = opened.platforms.find((p) => p.id === 'youtube');
  assert.equal(youtube.met, false);
  assert.equal(youtube.gaps.find((g) => g.metric === 'subscribers').current, 25);
  assert.ok(youtube.etaDays > 0, 'a growing channel must have a finite ETA');

  // Ranking survives, and still refuses to crown a four-view clip.
  assert.equal(opened.content.best[0].id, 'short-1');
  assert.equal(opened.content.worst[0].id, 'short-2');
  assert.deepEqual(opened.content.insufficient.map((i) => i.id), ['short-3']);

  // Every platform is present, including ones with nothing collected yet.
  assert.equal(opened.platforms.length, 6);
});

test('the slowest requirement is what the page reports, end to end', async () => {
  // Subscribers race ahead while watch hours crawl. The channel ETA must
  // follow the crawl, or the dashboard promises money that is not coming.
  let history = {};
  for (let day = 1; day <= 5; day += 1) {
    history = mergeSnapshot(history, {
      date: `2026-09-0${day}`,
      youtube: {subscribers: day * 50, watchHours: day * 1},
    });
  }

  const report = buildReport(history, {content: []});
  const youtube = report.platforms.find((p) => p.id === 'youtube');
  const subs = youtube.gaps.find((g) => g.metric === 'subscribers');
  const watch = youtube.gaps.find((g) => g.metric === 'watchHours');

  assert.ok(watch.etaDays > subs.etaDays, 'watch hours are the binding constraint here');
  assert.equal(youtube.etaDays, watch.etaDays);
});
