/**
 * The dashboard.
 *
 * Read only, structurally. There is no form that writes, no API credential in
 * this bundle, and no path back to the repository. It fetches one encrypted
 * file, decrypts it in memory, and renders. The only writer in the whole system
 * is the scheduled GitHub Action.
 *
 * All the deciding happens in the collector, so this file does no arithmetic
 * beyond formatting. That keeps the logic under test in Node rather than in a
 * browser nobody runs tests in.
 */

import {
  decryptPayload,
  unwrapWithPassphrase,
  unwrapWithSecret,
} from './crypto.js';
import {passkeysSupported, readSecret} from './passkey.js';

const $ = (id) => document.getElementById(id);

const REPORT_URL = './data/insights.enc.json';
const KEYS_URL = './data/keys.json';

async function fetchJson(url) {
  const response = await fetch(url, {cache: 'no-store'});
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function fail(message) {
  const box = $('lock-error');
  box.textContent = message;
  box.hidden = false;
}

async function unlock(getDataKey) {
  $('lock-error').hidden = true;
  try {
    const [keys, box] = await Promise.all([fetchJson(KEYS_URL), fetchJson(REPORT_URL)]);
    const dataKey = await getDataKey(keys);
    const report = await decryptPayload(dataKey, box);
    render(report);
  } catch (error) {
    fail(describe(error));
  }
}

/** Turn a crypto failure into something that says what to do next. */
function describe(error) {
  const message = String(error?.message ?? error);
  if (/operation-specific reason|OperationError|decrypt/i.test(message)) {
    return 'That did not open the data. Wrong passphrase, or a passkey that is not the enrolled one.';
  }
  if (/404/.test(message)) {
    return 'No report has been published yet. The collection workflow has not run.';
  }
  return message;
}

$('unlock-passkey').addEventListener('click', async () => {
  if (!passkeysSupported()) {
    fail('This browser cannot use passkeys. Use the recovery passphrase.');
    return;
  }
  const button = $('unlock-passkey');
  button.disabled = true;
  await unlock(async (keys) => {
    if (!keys.passkey) throw new Error('No passkey is enrolled yet. Use the passphrase.');
    return unwrapWithSecret(keys.passkey, await readSecret());
  });
  button.disabled = false;
});

$('passphrase-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  // The KDF is deliberately slow, so say so rather than looking frozen.
  button.textContent = 'Deriving key...';
  await unlock((keys) => unwrapWithPassphrase(keys.passphrase, $('passphrase').value));
  button.disabled = false;
  button.textContent = 'Unlock';
});

/* ---------- rendering ---------- */

const nf = new Intl.NumberFormat('en-GB');
const num = (v) => (v === null || v === undefined ? 'no data' : nf.format(Math.round(v)));

/**
 * Days as something a person can act on. "412 days" is a number; "about 14
 * months" is a decision.
 */
function humanEta(days) {
  if (days === null || days === undefined) return 'not on this trajectory';
  if (days === 0) return 'met';
  if (days < 14) return `about ${Math.ceil(days)} days`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks`;
  if (days < 730) return `about ${Math.round(days / 30)} months`;
  return `about ${(days / 365).toFixed(1)} years`;
}

function statusOf(platform) {
  if (platform.met) return 'earning';
  if (platform.status === 'blocked') return 'blocked';
  if (platform.stalled || platform.etaDays === null) return 'stalled';
  return 'tracking';
}

/**
 * The one line worth reading if nothing else gets read.
 *
 * It names a single platform rather than summarising all six, because the
 * dashboard exists to answer "where does the next hour go" and a summary of
 * everything answers nothing.
 */
function verdict(report) {
  const live = report.platforms.filter((p) => p.status !== 'blocked');
  const earning = live.filter((p) => p.met);
  const moving = live.filter((p) => !p.met && p.etaDays !== null);
  const stalled = live.filter((p) => !p.met && p.etaDays === null);

  if (moving.length === 0) {
    return {
      headline: 'Nothing is on track to pay yet.',
      body:
        stalled.length > 0
          ? `${stalled.map((p) => p.name).join(', ')} ${stalled.length === 1 ? 'has' : 'have'} data but no upward trend. That is a signal about the work, not about the numbers: the current output is not compounding anywhere.`
          : 'There is not enough history yet to see a trend. Come back after a few more days of collection.',
    };
  }

  const next = moving[0];
  const gap = next.gaps.reduce((slowest, g) =>
    (g.etaDays ?? Infinity) > (slowest.etaDays ?? Infinity) ? g : slowest
  );

  return {
    headline: `${next.name} is the closest thing to money.`,
    body:
      `${humanEta(next.etaDays)} away at the current pace, and the thing holding it back is ` +
      `${gap.label}: ${num(gap.current)} of ${num(gap.target)}, moving ${gap.perDay > 0 ? gap.perDay.toFixed(1) : '0'} a day. ` +
      (earning.length > 0
        ? `${earning.map((p) => p.name).join(' and ')} already qualifies, so protect that first.`
        : 'Nothing qualifies yet, so this is the one to push.'),
  };
}

function gapRow(gap) {
  const pct =
    gap.current === null || gap.target === 0
      ? 0
      : Math.min(100, (gap.current / gap.target) * 100);

  const el = document.createElement('div');
  el.className = 'gap';
  el.innerHTML = `
    <div class="line">
      <span>${gap.label}</span>
      <span>${num(gap.current)} / ${num(gap.target)}</span>
    </div>
    <div class="bar"><span style="width:${pct}%"></span></div>
    <div class="eta">${
      gap.current === null
        ? 'no data collected for this metric yet'
        : `${humanEta(gap.etaDays)} at ${gap.perDay > 0 ? gap.perDay.toFixed(1) : '0'} a day`
    }</div>`;
  return el;
}

function platformCard(platform) {
  const status = statusOf(platform);
  const card = document.createElement('article');
  card.className = 'card';

  const label = {
    earning: 'earning',
    tracking: 'on track',
    stalled: 'stalled',
    blocked: 'blocked',
  }[status];

  card.innerHTML = `
    <h3>${platform.name} <span class="tag ${status}">${label}</span></h3>
    <p class="role">${platform.role ?? ''}</p>`;

  if (status === 'blocked') {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = platform.blockedReason;
    card.append(note);
    return card;
  }

  if (platform.met) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = `${platform.monetisation.name}: every requirement met.`;
    card.append(note);
    return card;
  }

  for (const gap of platform.gaps) card.append(gapRow(gap));

  if (platform.monetisation?.note) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = platform.monetisation.note;
    card.append(note);
  }

  return card;
}

function contentTable(items, {rateLabel = 'engagement'} = {}) {
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'Nothing here yet.';
    return empty;
  }

  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Clip</th><th>Where</th>
          <th class="num">Views</th><th class="num">${rateLabel}</th>
        </tr>
      </thead>
      <tbody>
        ${items
          .slice(0, 5)
          .map(
            (i) => `<tr>
              <td>${i.title ?? i.id}</td>
              <td>${i.platform ?? ''}</td>
              <td class="num">${num(i.views)}</td>
              <td class="num">${i.rate === null ? 'n/a' : (i.rate * 100).toFixed(1) + '%'}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
  return wrap;
}

function render(report) {
  $('lock').hidden = true;
  $('report').hidden = false;

  const {headline, body} = verdict(report);
  $('verdict').innerHTML = `<strong>${headline}</strong><span>${body}</span>`;

  const list = $('platforms');
  list.replaceChildren(...report.platforms.map(platformCard));

  $('content-best').replaceChildren(contentTable(report.content.best));
  $('content-worst').replaceChildren(contentTable(report.content.worst));
  $('content-thin').replaceChildren(
    contentTable(report.content.insufficient, {rateLabel: 'rate'})
  );

  const collected = new Date(report.generatedAt);
  const ageDays = Math.floor((Date.now() - collected.getTime()) / 86400000);

  const meta = [
    `<p>Collected ${collected.toLocaleString('en-GB')}${ageDays > 2 ? ` (${ageDays} days ago, so the workflow may have stopped running)` : ''}.</p>`,
    `<p>Monetisation thresholds last verified ${report.thresholdsVerified}. Platforms change these without notice, so re-check before acting on a projection.</p>`,
  ];
  if (report.errors?.length) {
    meta.push(
      `<p>${report.errors.length} metric(s) failed to collect: ${report.errors.join('; ')}</p>`
    );
  }
  $('meta').innerHTML = meta.join('');
}
