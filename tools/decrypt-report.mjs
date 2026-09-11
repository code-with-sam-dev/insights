#!/usr/bin/env node
/**
 * Prints the published report as plaintext, for rotation and for debugging.
 *
 * Needs INSIGHTS_DATA_KEY. Writes to stdout so it can be redirected to a file
 * and never lands on disk by accident.
 */
import {readFile} from 'node:fs/promises';
import {importDataKey, decryptPayload} from '../src/crypto.mjs';

const raw = process.env.INSIGHTS_DATA_KEY;
if (!raw) {
  console.error('INSIGHTS_DATA_KEY is not set.');
  process.exit(1);
}

const box = JSON.parse(await readFile('web/data/insights.enc.json', 'utf8'));
const report = await decryptPayload(await importDataKey(raw), box);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
