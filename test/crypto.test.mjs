import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  generateDataKey,
  encryptPayload,
  decryptPayload,
  wrapWithPassphrase,
  unwrapWithPassphrase,
  wrapWithSecret,
  unwrapWithSecret,
} from '../src/crypto.mjs';

/*
  The dashboard is published at a public URL. The encryption is the only thing
  making it private, so it gets tested like a load-bearing wall.

  Everything here runs on WebCrypto, which exists identically in Node 22 and in
  the browser, so the same module encrypts in the GitHub Action and decrypts on
  Sam's phone. One implementation, not two that can drift apart.
*/

const PAYLOAD = {youtube: {subscribers: 12}, note: 'private'};

test('a payload survives an encrypt and decrypt round trip', async () => {
  const key = await generateDataKey();
  const box = await encryptPayload(key, PAYLOAD);
  assert.deepEqual(await decryptPayload(key, box), PAYLOAD);
});

test('the ciphertext does not contain the plaintext', async () => {
  const key = await generateDataKey();
  const box = await encryptPayload(key, PAYLOAD);
  assert.ok(!JSON.stringify(box).includes('private'));
  assert.ok(!JSON.stringify(box).includes('subscribers'));
});

test('every encryption uses a fresh nonce', async () => {
  // Reusing a nonce with AES-GCM leaks the plaintext relationship between two
  // messages. Two encryptions of the same data must not be byte-identical.
  const key = await generateDataKey();
  const a = await encryptPayload(key, PAYLOAD);
  const b = await encryptPayload(key, PAYLOAD);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('decrypting with the wrong key fails instead of returning rubbish', async () => {
  const box = await encryptPayload(await generateDataKey(), PAYLOAD);
  const otherKey = await generateDataKey();
  await assert.rejects(() => decryptPayload(otherKey, box));
});

test('a tampered ciphertext is rejected rather than silently altered', async () => {
  // AES-GCM authenticates. Someone editing the committed file must not be able
  // to change a number Sam then acts on.
  const key = await generateDataKey();
  const box = await encryptPayload(key, PAYLOAD);
  const bytes = Buffer.from(box.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  await assert.rejects(() =>
    decryptPayload(key, {...box, ciphertext: bytes.toString('base64')})
  );
});

test('a passphrase wraps and unwraps the data key', async () => {
  const key = await generateDataKey();
  const wrapped = await wrapWithPassphrase(key, 'a long correct horse passphrase');
  const recovered = await unwrapWithPassphrase(wrapped, 'a long correct horse passphrase');

  // Prove it is really the same key by using it, not by comparing objects.
  const box = await encryptPayload(key, PAYLOAD);
  assert.deepEqual(await decryptPayload(recovered, box), PAYLOAD);
});

test('the wrong passphrase fails to unwrap', async () => {
  const key = await generateDataKey();
  const wrapped = await wrapWithPassphrase(key, 'right passphrase');
  await assert.rejects(() => unwrapWithPassphrase(wrapped, 'wrong passphrase'));
});

test('each wrap uses its own salt, so two wraps of one key differ', async () => {
  const key = await generateDataKey();
  const a = await wrapWithPassphrase(key, 'same passphrase');
  const b = await wrapWithPassphrase(key, 'same passphrase');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('the passphrase wrap records a deliberately slow iteration count', async () => {
  // The ciphertext is downloadable, so a weak KDF turns the passphrase into a
  // few hours of offline guessing. This asserts the cost stays high.
  const wrapped = await wrapWithPassphrase(await generateDataKey(), 'passphrase');
  assert.equal(wrapped.kdf, 'PBKDF2-SHA256');
  assert.ok(wrapped.iterations >= 600000, `iterations too low: ${wrapped.iterations}`);
});

test('a raw secret from a passkey wraps and unwraps the data key', async () => {
  // The WebAuthn prf extension hands back 32 bytes. This is the path Sam's
  // phone actually uses; the passphrase is only the fallback.
  const key = await generateDataKey();
  const prfOutput = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrapWithSecret(key, prfOutput);
  const recovered = await unwrapWithSecret(wrapped, prfOutput);

  const box = await encryptPayload(key, PAYLOAD);
  assert.deepEqual(await decryptPayload(recovered, box), PAYLOAD);
});

test('a different passkey secret cannot unwrap the data key', async () => {
  const key = await generateDataKey();
  const wrapped = await wrapWithSecret(key, crypto.getRandomValues(new Uint8Array(32)));
  const otherSecret = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(() => unwrapWithSecret(wrapped, otherSecret));
});

test('both wraps of one key open the same data, so either route works alone', async () => {
  // This is the recovery guarantee: losing the phone must not lose the data,
  // and forgetting the passphrase must not lock out the phone.
  const key = await generateDataKey();
  const prfOutput = crypto.getRandomValues(new Uint8Array(32));

  const viaPass = await unwrapWithPassphrase(
    await wrapWithPassphrase(key, 'the recovery passphrase'),
    'the recovery passphrase'
  );
  const viaPasskey = await unwrapWithSecret(await wrapWithSecret(key, prfOutput), prfOutput);

  const box = await encryptPayload(key, PAYLOAD);
  assert.deepEqual(await decryptPayload(viaPass, box), PAYLOAD);
  assert.deepEqual(await decryptPayload(viaPasskey, box), PAYLOAD);
});
