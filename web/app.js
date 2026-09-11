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
import {seriesPath, filterSince, niceTicks, linearScale} from './chart.js';

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
    state.report = await decryptPayload(dataKey, box);
    // Held in memory only, for the refresh loop. It never touches storage: a
    // key in localStorage would outlive the tab and turn "private while I am
    // looking at it" into "private until someone opens this browser".
    state.dataKey = dataKey;
    state.platforms = new Set(state.report.platforms.map((p) => p.id));
    buildFilters();
    render();
    startRefresh();
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

/* ---------- state ---------- */

/**
 * Filters live here rather than in the DOM, so a re-render is a pure function
 * of state. The alternative, reading the current filter back out of the markup
 * that the filter itself produced, is how these pages end up with two sources
 * of truth that disagree.
 */
const state = {
  report: null,
  dataKey: null,
  windowDays: 30,
  platforms: new Set(),
  tab: 'overview',
};

const WINDOWS = [
  {days: 7, label: '7 days'},
  {days: 30, label: '30 days'},
  {days: 90, label: '90 days'},
  {days: null, label: 'All'},
];

function chip(label, pressed, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.textContent = label;
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

function buildFilters() {
  $('window-filter').replaceChildren(
    ...WINDOWS.map((w) =>
      chip(w.label, state.windowDays === w.days, () => {
        state.windowDays = w.days;
        buildFilters();
        render();
      })
    )
  );

  $('platform-filter').replaceChildren(
    ...state.report.platforms.map((platform) =>
      chip(platform.name, state.platforms.has(platform.id), () => {
        // Never let the last one be turned off. An empty page reads as a broken
        // page, and there is no state worth reaching that shows nothing.
        if (state.platforms.has(platform.id) && state.platforms.size > 1) {
          state.platforms.delete(platform.id);
        } else {
          state.platforms.add(platform.id);
        }
        buildFilters();
        render();
      })
    )
  );
}

const visiblePlatforms = () =>
  state.report.platforms.filter((p) => state.platforms.has(p.id));

/* ---------- formatting ---------- */

const nf = new Intl.NumberFormat('en-GB', {notation: 'compact', maximumFractionDigits: 1});
const nfFull = new Intl.NumberFormat('en-GB');
const num = (v) => (v === null || v === undefined ? 'no data' : nfFull.format(Math.round(v)));
const compact = (v) => (v === null || v === undefined ? '-' : nf.format(Math.round(v)));

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
  if (platform.status === 'awaiting') return 'awaiting';
  if (platform.stalled || platform.etaDays === null) return 'stalled';
  return 'tracking';
}

/* ---------- charts ---------- */

const svgNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(svgNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * One metric over time, with its target drawn in where there is one.
 *
 * The target line is the point of the chart. A rising line is pleasant; a
 * rising line a long way below a dashed target is information.
 */
function trendChart(series, {target, width = 560, height = 130}) {
  const pad = {left: 40, right: 10, top: 10, bottom: 18};
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const svg = el('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
  });

  const values = series.map((p) => p.value);
  // The target belongs in the domain, or a distant target is simply off-canvas
  // and the chart quietly stops being about the thing it is measuring.
  const top = Math.max(...values, target ?? 0);
  const ticks = niceTicks(0, top, 3);
  const y = linearScale([0, ticks.at(-1)], [h, 0]);

  const g = el('g', {transform: `translate(${pad.left},${pad.top})`});

  for (const tick of ticks) {
    g.append(el('line', {class: 'grid', x1: 0, x2: w, y1: y(tick), y2: y(tick)}));
    g.append(el('text', {class: 'axis', x: -6, y: y(tick) + 3, 'text-anchor': 'end'}, compact(tick)));
  }

  const path = seriesPath(series, {width: w, height: h, padding: 0});
  if (path) {
    // The area is drawn from the same path, closed along the baseline, so the
    // fill can never disagree with the line.
    g.append(el('path', {class: 'area', d: `${path} L${w},${h} L0,${h} Z`}));
    g.append(el('path', {class: 'line', d: path}));

    const lastY = Number(path.split(' ').at(-1).split(',')[1]);
    g.append(el('circle', {class: 'dot', cx: w, cy: lastY, r: 3.5}));
  }

  if (target && target <= ticks.at(-1)) {
    g.append(el('line', {class: 'target', x1: 0, x2: w, y1: y(target), y2: y(target)}));
    g.append(el('text', {class: 'axis', x: w, y: y(target) - 5, 'text-anchor': 'end'}, `target ${compact(target)}`));
  }

  g.append(el('text', {class: 'axis', x: 0, y: h + 14}, series[0]?.date ?? ''));
  g.append(el('text', {class: 'axis', x: w, y: h + 14, 'text-anchor': 'end'}, series.at(-1)?.date ?? ''));

  svg.append(g);
  return svg;
}

function trendCard(platform, metric, series, target) {
  const card = document.createElement('article');
  card.className = 'card';

  const first = series[0]?.value ?? 0;
  const last = series.at(-1)?.value ?? 0;
  const change = last - first;

  const head = document.createElement('div');
  head.className = 'chart-head';
  head.innerHTML = `
    <h3>${platform.name} ${metric}</h3>
    <div>
      <span class="now">${num(last)}</span>
      <span class="delta ${change > 0 ? 'up' : change < 0 ? 'down' : ''}">
        ${change === 0 ? 'no change' : `${change > 0 ? '+' : ''}${num(change)} in this window`}
      </span>
    </div>`;

  card.append(head, trendChart(series, {target}));
  return card;
}

function renderTrends() {
  const cards = [];
  let widened = false;

  for (const platform of visiblePlatforms()) {
    const metrics = state.report.history?.[platform.id] ?? {};
    for (const [metric, full] of Object.entries(metrics)) {
      const series = filterSince(full, state.windowDays);
      if (series.length < 2) continue;
      if (state.windowDays && series.length === 2 && full.length > 2) widened = true;

      const gap = platform.gaps?.find((g) => g.metric === metric);
      const requirement = platform.monetisation?.requirements?.find((r) => r.metric === metric);
      cards.push(trendCard(platform, gap?.label ?? metric, series, requirement?.target));
    }
  }

  if (cards.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent =
      'No series has two readings in this window yet. Growth charts appear once the collector has run on more than one day.';
    $('trends').replaceChildren(empty);
    return;
  }

  $('trends').replaceChildren(...cards);
  const note = $('filter-note');
  note.hidden = !widened;
  note.textContent = widened
    ? 'Some windows were widened to the last two readings, because one point does not draw a line.'
    : '';
}

/**
 * Engagement rate as a bar chart.
 *
 * Bars rather than a scatter, because the question is "which of my clips
 * earned the most attention per view", and that is a ranking, not a
 * correlation.
 */
function contentChart(items) {
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'No clip has enough views to rank yet.';
    return empty;
  }

  const top = items.slice(0, 8);
  const max = Math.max(...top.map((i) => i.rate));

  const wrap = document.createElement('div');
  wrap.className = 'bars';
  for (const item of top) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="label" title="${item.title ?? item.id}">${item.title ?? item.id}</span>
      <span class="track"><span style="width:${(item.rate / max) * 100}%"></span></span>
      <span class="val">${(item.rate * 100).toFixed(1)}% of ${compact(item.views)}</span>`;
    wrap.append(row);
  }
  return wrap;
}

/* ---------- verdict and cards ---------- */

/**
 * The one line worth reading if nothing else gets read.
 *
 * It names a single platform rather than summarising all six, because the
 * dashboard exists to answer "where does the next hour go" and a summary of
 * everything answers nothing.
 *
 * Computed over the visible platforms, so filtering to two platforms asks the
 * question of those two rather than repeating the global answer.
 */
function verdict(platforms) {
  const live = platforms.filter((p) => p.status !== 'blocked');
  const earning = live.filter((p) => p.met);
  const moving = live.filter((p) => !p.met && p.etaDays !== null);
  const awaiting = live.filter((p) => p.status === 'awaiting');
  const stalled = live.filter((p) => p.status !== 'awaiting' && !p.met && p.etaDays === null);

  if (moving.length === 0) {
    /*
      Awaiting is reported before stalled, and never described as a trend.
      Telling Sam that a platform "has data but no upward trend" when nothing
      was ever collected points him at the wrong problem entirely: he would go
      and make more videos when the actual fix is a missing API key.
    */
    if (awaiting.length > 0 && stalled.length === 0) {
      return {
        headline: 'No data has been collected yet.',
        body:
          `${awaiting.map((p) => p.name).join(', ')} ${awaiting.length === 1 ? 'has' : 'have'} nothing to show, which is a gap in the collection rather than in the work. ` +
          'Check the collection errors at the bottom of this page: they name what is missing.',
      };
    }

    if (stalled.length > 0) {
      return {
        headline: 'Nothing selected is on track to pay yet.',
        body:
          `${stalled.map((p) => p.name).join(', ')} ${stalled.length === 1 ? 'has' : 'have'} data but no upward trend. That is a signal about the work rather than about the numbers: nothing here is compounding.` +
          (awaiting.length > 0
            ? ` ${awaiting.map((p) => p.name).join(', ')} ${awaiting.length === 1 ? 'is' : 'are'} not being collected at all, so nothing can be said about ${awaiting.length === 1 ? 'it' : 'them'} either way.`
            : ''),
      };
    }

    return {
      headline: 'Not enough history yet.',
      body: 'There are readings but no trend to draw from them. Come back after a few more collection runs.',
    };
  }

  const next = moving[0];
  const gap = next.gaps.reduce((slowest, g) =>
    (g.etaDays ?? Infinity) > (slowest.etaDays ?? Infinity) ? g : slowest
  );

  return {
    headline: `${next.name} is the closest thing to money.`,
    body:
      `${humanEta(next.etaDays)} away at the current pace. The binding constraint is ` +
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
        : `${gap.perDay > 0 ? `${gap.perDay.toFixed(1)} a day` : 'not moving'}${
            gap.etaDays === null ? '' : `, ${humanEta(gap.etaDays)}`
          }`
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
    awaiting: 'no data yet',
    blocked: 'blocked',
  }[status];

  card.innerHTML = `
    <h3>${platform.name} <span class="tag ${status}">${label}</span></h3>
    <p class="role">${platform.role ?? ''}</p>`;

  if (status === 'awaiting') {
    for (const gap of platform.gaps ?? []) card.append(gapRow(gap));
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      platform.dataSource === 'manual'
        ? 'Nothing entered yet. These numbers are typed by hand into data/manual.json, because this platform gates its analytics API.'
        : 'Nothing collected yet. The collector is missing credentials for this platform; the errors at the foot of this page say which.';
    card.append(note);
    return card;
  }

  if (status === 'blocked') {
    // Still show the gaps where there are any. Blocked means "not a route to
    // money", not "throw the data away": the followers still matter for
    // sponsorship even when the platform's own programme is shut.
    for (const gap of platform.gaps ?? []) card.append(gapRow(gap));
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
        <tr><th>Clip</th><th>Where</th><th class="num">Views</th><th class="num">${rateLabel}</th></tr>
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

/** Content is filtered by the same platform chips as everything else. */
const visibleContent = (items) => items.filter((i) => state.platforms.has(i.platform));

function render() {
  const report = state.report;
  $('lock').hidden = true;
  $('report').hidden = false;

  const platforms = visiblePlatforms();
  const {headline, body} = verdict(platforms);
  $('verdict').innerHTML = `<strong>${headline}</strong><span>${body}</span>`;

  $('platforms').replaceChildren(...platforms.map(platformCard));
  renderKpis();
  renderPerformance();
  renderMatrix();
  renderSchedule();
  renderTrends();
  paintFreshness();

  const best = visibleContent(report.content.best);
  $('content-chart').replaceChildren(contentChart(best));
  $('content-best').replaceChildren(contentTable(best));
  $('content-worst').replaceChildren(contentTable(visibleContent(report.content.worst)));
  $('content-thin').replaceChildren(
    contentTable(visibleContent(report.content.insufficient), {rateLabel: 'rate'})
  );

  const collected = new Date(report.generatedAt);
  const ageDays = Math.floor((Date.now() - collected.getTime()) / 86400000);

  const meta = [
    `<p>Collected ${collected.toLocaleString('en-GB')}${
      ageDays > 2 ? ` (${ageDays} days ago, so the workflow may have stopped running)` : ''
    }.</p>`,
    `<p>Monetisation thresholds last verified ${report.thresholdsVerified}. Platforms change these without notice, so re-check before acting on a projection.</p>`,
  ];
  if (report.errors?.length) {
    meta.push(`<p>${report.errors.length} metric(s) failed to collect: ${report.errors.join('; ')}</p>`);
  }
  $('meta').innerHTML = meta.join('');
}

/* ---------- tabs ---------- */

/**
 * Four panels rather than one long scroll.
 *
 * The sections answer different questions on different days: "where do I put
 * the next hour" is a weekly question, "what do I post today" is a daily one.
 * Stacking them meant the daily one was always four screens down.
 */
function showTab(name) {
  state.tab = name;
  for (const button of document.querySelectorAll('.tab')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}

/* ---------- freshness and auto refresh ---------- */

/**
 * How old the data is, in words, updated every few seconds.
 *
 * This is the honest half of "real time". The page cannot call the platform
 * APIs itself: doing so would ship the API key to whoever opened it, which is
 * the whole reason collection happens in an Action. What the page CAN do is
 * notice the moment new data lands and say plainly how stale the current
 * reading is.
 */
function ageText(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'updated just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `updated ${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 36) return `updated ${Math.round(hours)} h ago`;
  return `updated ${Math.round(hours / 24)} days ago`;
}

function paintFreshness() {
  if (!state.report) return;
  const box = $('freshness');
  box.hidden = false;
  const minutes = (Date.now() - new Date(state.report.generatedAt).getTime()) / 60000;
  // Collection runs every 15 minutes. An hour without a new reading means the
  // workflow is failing, and silence about that is how a dashboard starts
  // lying: the numbers still look fine, they are just old.
  const stale = minutes > 60;
  $('freshness-dot').className = stale ? 'dot-stale' : 'dot-live';
  $('freshness-text').textContent = stale
    ? `${ageText(state.report.generatedAt)}, collection may have stopped`
    : ageText(state.report.generatedAt);
}

let refreshTimer = null;

/**
 * Poll for a newer report and re-render in place.
 *
 * Polling rather than pushing, because a static host has nothing to push with.
 * The fetch is cheap and conditional on content: if the decrypted report is the
 * same as the one on screen, nothing re-renders, so scroll position and the
 * open tab survive.
 */
async function refresh() {
  if (!state.dataKey) return;
  try {
    const box = await fetchJson(REPORT_URL);
    const next = await decryptPayload(state.dataKey, box);
    if (next.generatedAt === state.report?.generatedAt) return;
    state.report = next;
    for (const platform of next.platforms) {
      // A platform added since unlock should appear rather than silently sit
      // filtered out by a set built before it existed.
      if (!state.platforms.has(platform.id)) state.platforms.add(platform.id);
    }
    buildFilters();
    render();
  } catch {
    // A failed poll is not worth interrupting a working page for. The
    // freshness clock keeps counting, so a run of failures becomes visible as
    // the reading ageing rather than as an error nobody can act on.
  }
}

function startRefresh() {
  if (refreshTimer) return;
  paintFreshness();
  setInterval(paintFreshness, 10_000);
  refreshTimer = setInterval(refresh, 60_000);
  // Coming back to a tab left open overnight should not show yesterday.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

/* ---------- KPI strip ---------- */

function kpi(label, value, sub) {
  const box = document.createElement('div');
  box.className = 'kpi';
  box.innerHTML = `
    <span class="kpi-label">${label}</span>
    <span class="kpi-value">${value}</span>
    <span class="kpi-sub">${sub ?? ''}</span>`;
  return box;
}

function renderKpis() {
  const perf = state.report.performance;
  const totals = Object.values(perf?.byPlatform ?? {}).reduce(
    (t, p) => ({
      views: t.views + p.totals.views,
      likes: t.likes + p.totals.likes,
      comments: t.comments + p.totals.comments,
    }),
    {views: 0, likes: 0, comments: 0}
  );

  const youtube = state.report.platforms.find((p) => p.id === 'youtube');
  const subs = youtube?.metrics?.subscribers ?? youtube?.current?.subscribers ?? null;

  $('kpis').replaceChildren(
    kpi('Views', num(totals.views), 'across every measured post'),
    kpi('Likes', num(totals.likes), ''),
    kpi('Comments', num(totals.comments), ''),
    kpi('Subscribers', subs === null ? 'no data' : num(subs), 'YouTube')
  );
}

/* ---------- performance per platform ---------- */

function postLine(role, post) {
  if (!post) return `<div class="perf-row"><span class="perf-role">${role}</span><span class="muted">not enough posts</span></div>`;
  const title = post.title ?? post.id;
  const link = post.url
    ? `<a href="${post.url}" target="_blank" rel="noopener">${title}</a>`
    : title;
  return `
    <div class="perf-row">
      <span class="perf-role">${role}</span>
      <span class="perf-title" title="${title}">${link}</span>
      <span class="perf-num">${num(post.views)} views &middot; ${num(post.likes)} likes &middot; ${num(post.comments)} comments</span>
    </div>`;
}

function renderPerformance() {
  const perf = state.report.performance;
  if (!perf) {
    $('performance').replaceChildren();
    return;
  }

  const cards = state.report.platforms
    .filter((p) => state.platforms.has(p.id))
    .map((platform) => {
      const data = perf.byPlatform[platform.id];
      const card = document.createElement('article');
      card.className = 'card';

      if (!data || data.status === 'awaiting') {
        // Never a zero. "No data" and "no engagement" lead to opposite
        // decisions, and only one of them is about the videos.
        card.innerHTML = `
          <div class="chart-head"><h3>${platform.name}</h3></div>
          <p class="note">Awaiting per-post data. ${
            platform.dataSource === 'api'
              ? 'The collector has not returned any posts yet.'
              : 'This platform has no open API, so these numbers are entered by hand.'
          }</p>`;
        return card;
      }

      card.innerHTML = `
        <div class="chart-head">
          <h3>${platform.name}</h3>
          <span class="muted">${data.measured} post${data.measured === 1 ? '' : 's'} measured</span>
        </div>
        ${postLine('Most watched', data.best)}
        ${postLine('Least watched', data.worst)}
        ${postLine('Most liked', data.mostLiked)}
        ${postLine('Most commented', data.mostCommented)}
        <div class="perf-total">
          Total ${num(data.totals.views)} views, ${num(data.totals.likes)} likes,
          ${num(data.totals.comments)} comments
        </div>`;
      return card;
    });

  $('performance').replaceChildren(...cards);
}

/* ---------- the upload matrix ---------- */

const CELL = {
  published: {mark: '&#10003;', cls: 'cell-yes', word: 'published'},
  pending: {mark: '&#8226;', cls: 'cell-no', word: 'not posted'},
  blocked: {mark: '!', cls: 'cell-blocked', word: 'blocked'},
  'n/a': {mark: '&ndash;', cls: 'cell-na', word: 'not applicable'},
};

function renderMatrix() {
  const m = state.report.matrix;
  if (!m?.rows?.length) {
    $('matrix').innerHTML = '<p class="note">No assets catalogued yet.</p>';
    $('coverage').replaceChildren();
    return;
  }

  const c = m.coverage;
  $('coverage').replaceChildren(
    kpi('Published', `${c.published} / ${c.applicable}`, 'placements that exist'),
    kpi('Outstanding', num(c.pending - c.blocked), 'ready to post'),
    kpi('Blocked', num(c.blocked), 'cannot post yet'),
    kpi('Assets made', num(m.rows.length), 'episodes, shorts and posts')
  );

  const head = m.columns
    .map((p) => `<th class="col-plat">${p}</th>`)
    .join('');

  const body = m.rows
    .map((row) => {
      const cells = m.columns
        .map((p) => {
          const cell = row.cells[p];
          const style = CELL[cell.status];
          const inner = cell.url
            ? `<a href="${cell.url}" target="_blank" rel="noopener" title="${cell.at ?? ''}">${style.mark}</a>`
            : style.mark;
          const title = cell.blocked ? `${style.word}: ${cell.blocked}` : style.word;
          return `<td class="${style.cls}" title="${title}">${inner}</td>`;
        })
        .join('');
      return `
        <tr>
          <td class="row-ep">Ep ${row.episode}</td>
          <td class="row-asset">
            <span class="kindtag kind-${row.kind}">${row.kind}</span>
            <span class="row-title" title="${row.title ?? row.asset}">${row.title ?? row.asset}</span>
          </td>
          ${cells}
        </tr>`;
    })
    .join('');

  $('matrix').innerHTML = `
    <table class="grid">
      <thead><tr><th>Episode</th><th>Asset</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;

  // An upload recorded against an asset the catalogue does not know means
  // either a render is missing from the catalogue or something went out under
  // the wrong name. Both are mistakes worth seeing.
  const orphans = m.orphans ?? [];
  $('orphans').innerHTML = orphans.length
    ? `<p class="note warnline">${orphans.length} upload(s) recorded against assets not in the catalogue:
       ${orphans.map((o) => `episode ${o.episode} ${o.asset} on ${o.platform}`).join('; ')}.
       Either the catalogue is missing a render, or something was posted under the wrong name.</p>`
    : '';
}

/* ---------- the posting schedule ---------- */

function scheduleRow(item) {
  return `
    <tr>
      <td class="row-ep">${item.date}</td>
      <td class="col-plat">${item.platform}${item.manual ? ' <span class="byhand">by hand</span>' : ''}</td>
      <td>Ep ${item.episode}</td>
      <td class="row-title" title="${item.title ?? item.asset}">${item.title ?? item.asset}</td>
    </tr>`;
}

function renderSchedule() {
  const plan = state.report.schedule;
  if (!plan) return;

  if (plan.today.length === 0) {
    $('today').innerHTML =
      '<p class="note good">Nothing due today. Everything ready to post has been posted.</p>';
  } else {
    $('today').innerHTML = `
      <div class="today-list">
        ${plan.today
          .map(
            (i) => `<div class="today-item">
              <span class="col-plat">${i.platform}</span>
              <span class="row-title">${i.title ?? i.asset}</span>
              ${i.manual ? '<span class="byhand">you post this one</span>' : ''}
              ${i.file ? `<code class="path">${i.file}</code>` : ''}
            </div>`
          )
          .join('')}
      </div>`;
  }

  const later = plan.items.filter((i) => !plan.today.includes(i));
  $('upcoming').innerHTML = later.length
    ? `<table class="grid">
        <thead><tr><th>Date</th><th>Platform</th><th>Episode</th><th>Asset</th></tr></thead>
        <tbody>${later.map(scheduleRow).join('')}</tbody>
       </table>
       <p class="note">Backlog clears on ${plan.clearsOn} at the current pacing.</p>`
    : '<p class="note">Nothing queued beyond today.</p>';

  $('schedule-blocked').innerHTML = plan.blocked.length
    ? `<table class="grid">
        <thead><tr><th>Platform</th><th>Episode</th><th>Asset</th><th>Why</th></tr></thead>
        <tbody>${plan.blocked
          .map(
            (b) => `<tr>
              <td class="col-plat">${b.platform}</td>
              <td>Ep ${b.episode}</td>
              <td class="row-title">${b.title ?? b.asset}</td>
              <td class="muted">${b.blocked}</td>
            </tr>`
          )
          .join('')}</tbody>
       </table>`
    : '<p class="note good">Nothing blocked.</p>';
}
