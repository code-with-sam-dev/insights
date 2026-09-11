# Code with Sam: Insights

A private dashboard answering one question: **where should the next hour go.**

Not a reporting tool. Sam is one person with a day job, so the dashboard's job
is to name the platform closest to paying, say what is holding it back, and show
what is working and what is not. A wall of numbers he has to interpret himself
would cost time rather than save it.

## Why the data is encrypted

GitHub Pages serves publicly even from a private repository on the free tier,
so privacy cannot come from access control here.

A password box on a static site is theatre: the check runs in readable
JavaScript, and the data file can be fetched directly at its URL without ever
loading the login page. So the data itself is encrypted, and the page is a
viewer that holds nothing until unlocked. Fetch the file directly and you get
unreadable bytes.

Two ways in, both opening the same key:

| Route | For |
|---|---|
| **Passkey** | Everyday use. Face ID on the phone. Uses the WebAuthn `prf` extension, which makes a credential emit a stable 32 byte secret. Plain WebAuthn only proves identity, which is worthless with no server to prove it to. |
| **Passphrase** | Recovery. Slower on purpose: PBKDF2 at 600,000 iterations, because the ciphertext is downloadable and can be attacked offline at leisure. |

Two costs worth knowing before relying on it. The passphrase must be long, since
length is the only thing protecting it. And a forgotten passphrase cannot be
reset: there is no server. The Action can always rebuild the report, so the data
is recoverable even when the key is not.

## Read only, structurally

There is no write path. No form that writes, no API credential in the browser
bundle, no route back to the repository. The single writer is the scheduled
Action. Worst case, someone holding the phone and the passkey reads stale
numbers; they cannot change a caption or delete a video.

## Layout

    src/crypto.mjs      encryption. Runs unchanged in Node and the browser.
    src/insights.mjs    the arithmetic that turns counts into a decision.
    src/platforms.mjs   what each platform pays for, and when it was checked.
    src/history.mjs     accumulation and report assembly.
    src/youtube.mjs     the one platform with real API access.
    src/collect.mjs     entry point, run by the Action.
    web/                the dashboard and the one-time enrolment page.
    data/manual.json    hand-entered numbers for the gated platforms.

## Running it

Everything runs in Docker, no local Node required.

    docker compose run --rm test      the full suite
    docker compose up web             the dashboard at http://localhost:8080
    docker compose run --rm collect   a real collection run, needs secrets

Locally with Node 22 and no dependencies to install:

    npm test
    npm run collect

`npm test` regenerates `web/crypto.js` from `src/crypto.mjs` and asserts they
match, so a hand edited copy cannot reach the deployed page. That check exists
because a crypto file that silently drifts from its source fails at unlock time,
which is the worst possible moment to find out.

## Trying it before it has any real data

    node tools/demo-data.mjs
    docker compose up web

Writes an invented report into `web/data/` and prints the passphrase to unlock
it. The demo files are marked `"_demo": true` and the generator refuses to
overwrite anything without that marker, so it cannot destroy real keys. Delete
them (`rm web/data/*.json`) before enrolling for real, and do not commit them.

## Setup, once

1. **Enrol.** Open `/enrol` on the deployed site, or `http://localhost:8080/enrol.html`.
   Choose a recovery passphrase, enrol a passkey. It hands back two things.
2. **Commit** the generated `keys.json` to `web/data/keys.json`. Safe to publish:
   it is the data key wrapped twice, and neither wrap opens without the passkey
   or the passphrase.
3. **Add the data key** as the `INSIGHTS_DATA_KEY` repository secret. This one is
   the real secret. It never appears in the repository.
4. **Add the YouTube credentials:**

   | Name | Kind | Gets you |
   |---|---|---|
   | `YOUTUBE_API_KEY` | secret | subscribers, views, per-video stats |
   | `YOUTUBE_CHANNEL_ID` | variable | which channel |
   | `YOUTUBE_OAUTH_CLIENT_ID` | secret, optional | watch hours |
   | `YOUTUBE_OAUTH_CLIENT_SECRET` | secret, optional | watch hours |
   | `YOUTUBE_OAUTH_REFRESH_TOKEN` | secret, optional | watch hours |

   Without the OAuth three, watch hours read as no data. That matters: watch
   hours are one of the two Partner Programme requirements, so the YouTube
   projection is incomplete until they are set.

Re-running enrolment makes a **new** key and orphans every report already
published. Do not run it twice by accident.

## A gotcha when changing the logic

Every judgement (status, gaps, ETAs, rankings) is computed by the **collector**
and baked into the encrypted payload. The page only formats what it is given.

That is deliberate, so the logic lives where it can be tested in Node rather
than in a browser nobody runs tests in. The consequence is easy to miss:
changing how a platform is classified needs a **re-collection**, not just a
deploy. Ship the code, then:

    gh workflow run collect.yml

Otherwise the new page faithfully renders yesterday's verdict and looks broken.

## What the numbers can honestly say

Access differs sharply by platform, and the dashboard is built to admit that
rather than paper over it.

| Platform | Data | Why |
|---|---|---|
| YouTube | API | Data API for counts, Analytics API for watch time |
| TikTok | manual | Analytics need developer approval, tied to a business account that cannot be switched on |
| Instagram | manual | Graph API needs app review |
| Facebook | manual | Graph API needs app review |
| X | manual | API access is paid |
| LinkedIn | manual | Analytics need developer programme approval |

A platform with no data renders as **no data**, never as zero. "No data" and
"no progress" lead to opposite decisions, and a confident zero would quietly
recommend abandoning a platform that is simply unmeasured.

Every monetisation threshold in `src/platforms.mjs` carries the date it was
last checked, and the dashboard shows that date. They are product decisions by
companies that change them without notice. Re-verify before acting on a
projection.
