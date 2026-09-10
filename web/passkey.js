/**
 * Passkey unlock, using the WebAuthn prf extension.
 *
 * Plain WebAuthn only proves who you are, which is useless here: there is no
 * server to prove it to, and the encrypted file can be fetched directly at its
 * URL without ever loading this page. The prf extension is what makes a passkey
 * usable as a decryption key. It asks the authenticator to evaluate a
 * pseudo-random function over a fixed input and hand back 32 stable bytes.
 * Those bytes never leave the device unless Face ID succeeds, and they are the
 * same every time, which is exactly what a key needs to be.
 *
 * The credential is created as discoverable (`residentKey: required`) so any
 * device holding the synced passkey can unlock with no credential id stored
 * anywhere. Nothing identifying is committed to the repository.
 */

/** Fixed salt, so the same credential always yields the same key. */
const PRF_SALT = new TextEncoder().encode('codewithsam-insights-v1');

const RP_NAME = 'Code with Sam Insights';

export const passkeysSupported = () =>
  typeof PublicKeyCredential !== 'undefined' &&
  typeof navigator.credentials?.create === 'function';

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * One-time enrolment. Returns the 32 byte secret to wrap the data key under.
 *
 * Chrome will not return a prf result on create() in every version, so the
 * enrolment page immediately does a get() to read the secret rather than
 * trusting the creation response.
 */
export async function enrolPasskey({userName = 'insights'} = {}) {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: {name: RP_NAME},
      user: {
        id: randomBytes(16),
        name: userName,
        displayName: RP_NAME,
      },
      pubKeyCredParams: [
        {type: 'public-key', alg: -7}, // ES256
        {type: 'public-key', alg: -257}, // RS256
      ],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      extensions: {prf: {}},
    },
  });

  if (!credential) throw new Error('Passkey creation was cancelled.');

  const supported = credential.getClientExtensionResults()?.prf?.enabled;
  if (supported === false) {
    throw new Error(
      'This authenticator does not support the prf extension, so it cannot hold a key. ' +
        'Use the recovery passphrase, or enrol a passkey from a device that does.'
    );
  }

  return readSecret();
}

/** Everyday unlock. Prompts for the passkey and returns the same 32 bytes. */
export async function readSecret() {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      userVerification: 'required',
      extensions: {prf: {eval: {first: PRF_SALT}}},
    },
  });

  if (!assertion) throw new Error('Passkey unlock was cancelled.');

  const first = assertion.getClientExtensionResults()?.prf?.results?.first;
  if (!first) {
    throw new Error(
      'The passkey did not return a key. This browser or authenticator does not ' +
        'support the prf extension. Use the recovery passphrase.'
    );
  }

  return new Uint8Array(first);
}
