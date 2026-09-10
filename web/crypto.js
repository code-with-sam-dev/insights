/* GENERATED from src/crypto.mjs by tools/build-web.mjs. Do not edit. */
/**
 * Encryption for the published dashboard.
 *
 * The dashboard lives at a public GitHub Pages URL, because Pages serves
 * publicly even from a private repository on the free tier. So privacy cannot
 * come from access control; it has to come from the data being unreadable.
 * A password box would be theatre here: the check would run in readable
 * JavaScript, and the data file could be fetched directly at its URL without
 * ever loading the login page. Encrypting the payload is what makes the same
 * experience actually private.
 *
 * Shape of the scheme:
 *
 *   data key            random AES-256-GCM key. Encrypts the payload. Lives
 *                       only as a GitHub Actions secret and, briefly, in the
 *                       browser's memory after an unlock.
 *   passkey wrap        the data key encrypted under a secret derived from the
 *                       WebAuthn prf extension. This is the everyday route.
 *   passphrase wrap     the same data key encrypted under PBKDF2 over a
 *                       passphrase. This is the recovery route.
 *
 * Two wraps of one key, so either route opens the data alone. Losing the phone
 * must not lose the data, and forgetting the passphrase must not lock out the
 * phone. There is no server that can reset either.
 *
 * Everything runs on WebCrypto, which is identical in Node 22 and in the
 * browser, so the Action encrypts and the phone decrypts with this same file
 * rather than with two implementations that can drift apart.
 */

/**
 * Deliberately expensive. The ciphertext is downloadable, so a passphrase is
 * attackable offline at leisure; the only defence is making each guess cost.
 * OWASP's floor for PBKDF2-SHA256 at the time of writing.
 */
export const PBKDF2_ITERATIONS = 600000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/*
  btoa and atob rather than Buffer, so this exact file runs unchanged in the
  browser as well as in the Action. Node has had both as globals since v16.
  One implementation means the encryptor and the decryptor cannot drift apart,
  which for a scheme with no server to fall back on is worth more than the
  slight awkwardness of the conversion.
*/
const b64 = (bytes) => {
  const view = new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer ?? bytes);
  let binary = '';
  // Chunked, because spreading a large array into fromCharCode blows the stack.
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Fresh 12 bytes. AES-GCM leaks plaintext relationships if a nonce repeats. */
const nonce = () => crypto.getRandomValues(new Uint8Array(12));

export async function generateDataKey() {
  return crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function exportDataKey(key) {
  return b64(await crypto.subtle.exportKey('raw', key));
}

export async function importDataKey(base64) {
  return crypto.subtle.importKey('raw', unb64(base64), {name: 'AES-GCM'}, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptPayload(key, payload) {
  const iv = nonce();
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    enc.encode(JSON.stringify(payload))
  );
  return {v: 1, iv: b64(iv), ciphertext: b64(ciphertext)};
}

export async function decryptPayload(key, box) {
  const plain = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: unb64(box.iv)},
    key,
    unb64(box.ciphertext)
  );
  return JSON.parse(dec.decode(plain));
}

/** Wrapping keys never leave this module, so they are non-extractable. */
async function keyFromPassphrase(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {name: 'PBKDF2', salt, iterations, hash: 'SHA-256'},
    material,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * HKDF rather than a raw import, so the passkey's prf output is domain
 * separated. The same credential could be used for another purpose later; the
 * info string keeps those keys distinct.
 */
async function keyFromSecret(secret) {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: enc.encode('codewithsam-insights/datakey/v1'),
    },
    material,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapUnder(wrappingKey, dataKey, extra) {
  const iv = nonce();
  const raw = await crypto.subtle.exportKey('raw', dataKey);
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, wrappingKey, raw);
  return {v: 1, iv: b64(iv), ciphertext: b64(ciphertext), ...extra};
}

async function unwrapUnder(wrappingKey, wrapped) {
  const raw = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: unb64(wrapped.iv)},
    wrappingKey,
    unb64(wrapped.ciphertext)
  );
  return crypto.subtle.importKey('raw', raw, {name: 'AES-GCM'}, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function wrapWithPassphrase(dataKey, passphrase, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await keyFromPassphrase(passphrase, salt, iterations);
  return wrapUnder(wrappingKey, dataKey, {
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: b64(salt),
  });
}

export async function unwrapWithPassphrase(wrapped, passphrase) {
  const wrappingKey = await keyFromPassphrase(
    passphrase,
    unb64(wrapped.salt),
    wrapped.iterations
  );
  return unwrapUnder(wrappingKey, wrapped);
}

/** `secret` is the raw bytes handed back by the WebAuthn prf extension. */
export async function wrapWithSecret(dataKey, secret) {
  return wrapUnder(await keyFromSecret(secret), dataKey, {kdf: 'HKDF-SHA256'});
}

export async function unwrapWithSecret(wrapped, secret) {
  return unwrapUnder(await keyFromSecret(secret), wrapped);
}
