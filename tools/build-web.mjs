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

/** Modules written to run in both places, copied rather than transformed. */
const SHARED = ['crypto', 'chart'];

for (const name of SHARED) {
  const source = await readFile(`src/${name}.mjs`, 'utf8');
  await writeFile(`web/${name}.js`, HEADER.replace('crypto', name) + source);
  console.log(`web/${name}.js written from src/${name}.mjs`);
}
