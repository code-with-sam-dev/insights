# Rotating the key

Do this when the passphrase has been exposed, when a device holding the passkey
is lost, or on any suspicion at all. It is cheap: the history is rebuilt by the
collector, so nothing is lost but the accumulated series, and even that survives
if you decrypt the old report first.

**What rotation can and cannot undo.** It stops future reports being readable
with the old key. It does **not** un-publish what was already public. Anyone who
downloaded `insights.enc.json` before the rotation keeps a copy they can still
attack offline, and forks and archives are outside anyone's control. So rotate
early rather than carefully.

## Steps

1. **Keep the history**, if you want it. With the current data key set in the
   environment, decrypt the published report and save the plaintext locally:

       INSIGHTS_DATA_KEY=<old key> node tools/decrypt-report.mjs > /tmp/history.json

2. **Re-enrol** at `/enrol.html` on the deployed site. Use a passphrase from a
   password manager, generated rather than composed. This is the one place where
   a memorable phrase is the wrong instinct: the ciphertext is downloadable and
   can be attacked offline indefinitely, with no server to slow anyone down.

3. **Never paste the data key into a chat, an issue, or a commit message.** Put
   it straight into the repository secret yourself:

       Settings > Secrets and variables > Actions > INSIGHTS_DATA_KEY

4. **Commit the new `web/data/keys.json`**, which is public by design.

5. **Delete `web/data/insights.enc.json`** and let the workflow write a fresh
   one. The old file is encrypted under the old key and will never open again.

       gh workflow run collect.yml

## The thing that is easy to miss

Both wraps open the **same** data key. A weak passphrase therefore defeats the
passkey as well, because they are two doors into one room rather than two
independent locks. The passkey is only as strong as the passphrase beside it.
