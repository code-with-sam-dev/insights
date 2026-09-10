/**
 * Copies the shared crypto module into the web bundle.
 *
 * src/crypto.mjs is written to run unchanged in both Node and the browser, so
 * this is a verbatim copy rather than a transform. It exists as a build step,
 * and is checked by a test, because a hand-copied crypto file that silently
 * drifts from its source is a failure mode with no visible symptom until
 * something cannot be decrypted.
 */
import {readFile, writeFile} from 'node:fs/promises';

const HEADER =
  '/* GENERATED from src/crypto.mjs by tools/build-web.mjs. Do not edit. */\n';

const source = await readFile('src/crypto.mjs', 'utf8');
await writeFile('web/crypto.js', HEADER + source);
console.log('web/crypto.js written from src/crypto.mjs');
