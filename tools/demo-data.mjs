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
  content: [
    {id: 's1', title: 'Kafka guarantees ordering... right?', platform: 'youtube', views: 1840, likes: 190, comments: 31, engagements: 221},
    {id: 's2', title: 'Same key, same partition', platform: 'youtube', views: 3120, likes: 88, comments: 6, engagements: 94},
    {id: 's3', title: 'Kafka kept the order. Your app did not.', platform: 'youtube', views: 2260, likes: 297, comments: 43, engagements: 340},
    {id: 's4', title: 'Full episode: Kafka ordering', platform: 'youtube', views: 940, likes: 55, comments: 6, engagements: 61},
    {id: 's5', title: 'Just posted', platform: 'youtube', views: 12, likes: 4, comments: 0, engagements: 4},
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
