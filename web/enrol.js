/**
 * One-time enrolment.
 *
 * Everything here happens in the browser and nothing is transmitted. The data
 * key is generated locally, wrapped twice, and shown to Sam to place by hand:
 * the wraps go into the repository as a committed file, the raw key goes into
 * the repository secrets. That split is the whole design. The public file can
 * only be opened by something Sam holds; the secret only ever exists inside
 * GitHub Actions and inside this page for as long as the tab is open.
 */

import {generateDataKey, exportDataKey, wrapWithPassphrase, wrapWithSecret} from './crypto.js';
import {enrolPasskey, passkeysSupported} from './passkey.js';

const $ = (id) => document.getElementById(id);

/**
 * The passphrase is the recovery route and the ciphertext is downloadable, so
 * it can be attacked offline for as long as an attacker likes. Short is fatal
 * here in a way it is not behind a login that can rate limit.
 */
const MIN_PASSPHRASE = 16;

function say(message) {
  const status = $('status');
  status.textContent = message;
  status.hidden = false;
}

$('enrol-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('status').hidden = true;

  const passphrase = $('passphrase').value;
  if (passphrase !== $('passphrase2').value) return say('The passphrases do not match.');
  if (passphrase.length < MIN_PASSPHRASE) {
    return say(
      `Use at least ${MIN_PASSPHRASE} characters. This one is attackable offline, ` +
        'so length is the only thing protecting it.'
    );
  }
  if (!passkeysSupported()) {
    return say('This browser cannot create passkeys. Try Chrome or Safari, or use your phone.');
  }

  const button = event.target.querySelector('button');
  button.disabled = true;
  button.textContent = 'Working...';

  try {
    const dataKey = await generateDataKey();

    // Passkey first: it is the step that can fail or be cancelled, and doing it
    // before the slow key derivation means a cancel costs nothing.
    const secret = await enrolPasskey();

    const keys = {
      v: 1,
      createdAt: new Date().toISOString(),
      passkey: await wrapWithSecret(dataKey, secret),
      passphrase: await wrapWithPassphrase(dataKey, passphrase),
    };

    $('keys').value = JSON.stringify(keys, null, 2);
    $('datakey').value = await exportDataKey(dataKey);
    $('output').hidden = false;
    $('enrol-form').hidden = true;
  } catch (error) {
    say(String(error?.message ?? error));
  } finally {
    button.disabled = false;
    button.textContent = 'Create key and enrol passkey';
  }
});
