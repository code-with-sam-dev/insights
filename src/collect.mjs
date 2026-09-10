#!/usr/bin/env node
/**
 * Collection entry point. Runs in GitHub Actions on a schedule.
 *
 * The sequence, and the reason for each step:
 *
 *   1. Decrypt the existing report to recover the accumulated history. The
 *      history lives inside the encrypted payload rather than in a plaintext
 *      file beside it, because the history IS the private data.
 *   2. Collect today from the APIs that are open to us, plus the hand-entered
 *      numbers for the platforms that are not.
 *   3. Merge, keeping any metric that failed to collect out of the series
 *      rather than writing a zero into it.
 *   4. Rebuild the report and re-encrypt.
 *
 * A partial failure still commits. A missing day is a hole in every trend line,
 * so getting four platforms is better than getting none.
 *
 * Environment:
 *   INSIGHTS_DATA_KEY          base64 AES-256 key. The only real secret here.
 *   YOUTUBE_API_KEY            Data API v3
 *   YOUTUBE_CHANNEL_ID         the channel to report on
 *   YOUTUBE_OAUTH_CLIENT_ID        optional, unlocks watch hours
 *   YOUTUBE_OAUTH_CLIENT_SECRET    optional
 *   YOUTUBE_OAUTH_REFRESH_TOKEN    optional
 */

import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

import {importDataKey, encryptPayload, decryptPayload} from './crypto.mjs';
import {mergeSnapshot, buildReport} from './history.mjs';
import {collectYouTube} from './youtube.mjs';

const REPORT_PATH = 'web/data/insights.enc.json';
const MANUAL_PATH = 'data/manual.json';

const today = () => new Date().toISOString().slice(0, 10);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The previous report, or an empty history on the first ever run.
 *
 * A decryption failure here is fatal on purpose. It means the key and the file
 * disagree, and carrying on would silently start the history again from zero,
 * destroying every trend with no error anyone would notice.
 */
async function loadHistory(key) {
  const existing = await readJson(REPORT_PATH);
  if (!existing) {
    console.log('No existing report. Starting a new history.');
    return {};
  }
  const report = await decryptPayload(key, existing);
  console.log(`Loaded history generated at ${report.generatedAt}.`);
  return report.history ?? {};
}

async function main() {
  const rawKey = process.env.INSIGHTS_DATA_KEY;
  if (!rawKey) throw new Error('INSIGHTS_DATA_KEY is not set. Nothing can be written.');
  const key = await importDataKey(rawKey);

  let history = await loadHistory(key);
  const date = today();
  const snapshot = {date};
  let content = [];
  const errors = [];

  // YouTube, the only platform with real API access today.
  if (process.env.YOUTUBE_API_KEY && process.env.YOUTUBE_CHANNEL_ID) {
    const youtube = await collectYouTube({
      apiKey: process.env.YOUTUBE_API_KEY,
      channelId: process.env.YOUTUBE_CHANNEL_ID,
      clientId: process.env.YOUTUBE_OAUTH_CLIENT_ID,
      clientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET,
      refreshToken: process.env.YOUTUBE_OAUTH_REFRESH_TOKEN,
    });
    snapshot.youtube = youtube.metrics;
    content = youtube.content;
    errors.push(...youtube.errors);
    console.log(`YouTube: ${JSON.stringify(youtube.metrics)}`);
  } else {
    errors.push('YouTube skipped: YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID missing.');
    console.warn('YouTube credentials missing. Skipping.');
  }

  // Hand-entered numbers for the platforms whose APIs are gated.
  const manual = await readJson(MANUAL_PATH);
  if (manual) {
    const {_comment, date: readOn, ...platforms} = manual;
    // Dated by when the numbers were READ, not when this job ran. Otherwise a
    // manual file nobody has updated for a month would report a fresh reading
    // every day, and the flat line would read as a real stall rather than as
    // one old measurement repeated.
    history = mergeSnapshot(history, {date: readOn ?? date, ...platforms});
  }

  const merged = mergeSnapshot(history, snapshot);
  const report = buildReport(merged, {content, generatedAt: new Date().toISOString()});
  report.errors = errors;

  const box = await encryptPayload(key, report);
  await mkdir(dirname(REPORT_PATH), {recursive: true});
  await writeFile(REPORT_PATH, JSON.stringify(box, null, 2) + '\n');

  console.log(`Wrote ${REPORT_PATH}. ${errors.length} collection error(s).`);
  for (const error of errors) console.log(`  ${error}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
