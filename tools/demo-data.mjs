/**
 * Generates a throwaway encrypted report so the dashboard can be exercised
 * locally, including the unlock path, before any real credentials exist.
 *
 * Development only. The passphrase is printed on purpose and the output is
 * gitignored, because this data is invented and protecting it would be
 * theatre. Never point this at the real repository.
 */
import {writeFile, mkdir, readFile} from 'node:fs/promises';

import {generateDataKey, exportDataKey, encryptPayload, wrapWithPassphrase} from '../src/crypto.mjs';
import {mergeSnapshot, buildReport} from '../src/history.mjs';

const PASSPHRASE = 'demo passphrase for local testing';

/**
 * Refuses to overwrite real keys.
 *
 * web/data holds both the demo files and, in a configured repository, the real
 * ones. Running this by accident against real keys would orphan every report
 * ever published, and nothing would say so until the next unlock failed.
 */
async function assertSafeToOverwrite() {
  let existing;
  try {
    existing = JSON.parse(await readFile('web/data/keys.json', 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (existing._demo !== true) {
    throw new Error(
      'web/data/keys.json holds real keys, not demo ones. Refusing to overwrite. ' +
        'Delete it deliberately first if you really mean to start again.'
    );
  }
}

await assertSafeToOverwrite();

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

let history = {};
for (let i = 29; i >= 0; i -= 1) {
  const t = 29 - i;
  history = mergeSnapshot(history, {
    date: day(i),
    youtube: {
      subscribers: Math.round(4 + t * 1.6 + Math.sin(t / 3) * 2),
      watchHours: Math.round(2 + t * 2.4),
      views: Math.round(120 + t * 45),
    },
    x: {followers: Math.round(t * 0.7)},
    tiktok: {followers: Math.round(t * 1.1), views30d: Math.round(t * 130)},
    instagram: {followers: Math.round(t * 0.4)},
    facebook: {followers: Math.round(t * 0.25)},
  });
}

/*
  The demo uses the REAL catalogue and the REAL upload register, and only fakes
  the numbers. The matrix and the schedule are the parts most likely to be
  quietly wrong, and feeding them invented rows would hide exactly the bug
  worth catching: a shape mismatch between what the collector writes and what
  the page reads.
*/
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const catalogue = (await json('data/catalogue.json')).assets;
const uploads = (await json('data/uploads.json')).entries;

const report = buildReport(history, {
  catalogue,
  uploads,
  // Real video ids and real durations, invented numbers. The ids matter: the
  // content library joins measurements to the register by id, so demo data with
  // made up ids would exercise none of that join and would show every clip as
  // unregistered. Durations matter for the same reason on the Shorts split.
  content: [
    {id: 'eu6UFlFn6t0', title: 'Does Kafka guarantee ordering? Yes, and no.', platform: 'youtube', views: 1840, likes: 190, comments: 31, engagements: 221, publishedAt: '2026-09-10T12:00:00Z', durationSeconds: 42},
    {id: '4ehpY9ZJzZo', title: 'How do you keep Kafka events in order?', platform: 'youtube', views: 3120, likes: 88, comments: 6, engagements: 94, publishedAt: '2026-09-10T12:30:00Z', durationSeconds: 38},
    {id: 'Oa9vjdg232g', title: 'Kafka Ordering Explained', platform: 'youtube', views: 940, likes: 55, comments: 6, engagements: 61, publishedAt: '2026-09-10T09:00:00Z', durationSeconds: 372},
    {id: 'BTEAzv90W4E', title: 'Kafka Partitions Explained', platform: 'youtube', views: 610, likes: 41, comments: 4, engagements: 45, publishedAt: '2026-09-11T09:00:00Z', durationSeconds: 338},
    {id: 'fdrbDnkAruU', title: 'Design a Digital Wallet: The $100 Transfer That Disappears', platform: 'youtube', views: 402, likes: 27, comments: 5, engagements: 32, publishedAt: '2026-09-12T09:00:00Z', durationSeconds: 818},
    {id: 'K1jAVd3M_l8', title: 'Your API just charged them twice', platform: 'youtube', views: 2610, likes: 143, comments: 19, engagements: 162, publishedAt: '2026-09-12T10:00:00Z', durationSeconds: 31},
    {id: 'JpWDt7XTRd4', title: 'Both writes succeeded. The money vanished.', platform: 'youtube', views: 1180, likes: 76, comments: 11, engagements: 87, publishedAt: '2026-09-12T10:20:00Z', durationSeconds: 32},
    {id: 'mYygHIg4SOs', title: 'Your p95 dashboard is lying to you', platform: 'youtube', views: 340, likes: 12, comments: 1, engagements: 13, publishedAt: '2026-09-12T10:40:00Z', durationSeconds: 33},
    // Deliberately absent from data/uploads.json, to exercise the case Sam
    // asked for: something uploaded that nobody wrote down must still appear.
    {id: 'nOtInReg1st', title: 'Posted an hour ago, not yet registered', platform: 'youtube', views: 12, likes: 4, comments: 0, engagements: 4, publishedAt: '2026-09-13T08:00:00Z', durationSeconds: 44},
  ],
});
report.errors = ['watchHours: OAuth not configured, so the YouTube projection is incomplete.'];

const dataKey = await generateDataKey();

await mkdir('web/data', {recursive: true});
await writeFile('web/data/insights.enc.json', JSON.stringify(await encryptPayload(dataKey, report), null, 2));
await writeFile(
  'web/data/keys.json',
  JSON.stringify(
    {
      v: 1,
      _demo: true,
      createdAt: new Date().toISOString(),
      passphrase: await wrapWithPassphrase(dataKey, PASSPHRASE),
    },
    null,
    2
  )
);

console.log('Demo data written to web/data/.');
console.log(`Passphrase: ${PASSPHRASE}`);
console.log(`Data key:   ${await exportDataKey(dataKey)}`);
