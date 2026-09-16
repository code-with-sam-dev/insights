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
import {
  seriesPath,
  filterSince,
  niceTicks,
  linearScale,
  ratePerHour,
  rateBars,
  rateRuns,
  pathOf,
} from './chart.js';

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
  // Launch to date, which is what Sam asked the per-hour charts for. The
  // shorter windows are for reading one launch closely.
  pulseHours: null,
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

/* Metrics with no monetisation requirement behind them have no label of their
   own, and the raw key reads as a variable name rather than as a number about
   the channel. */
const METRIC_LABELS = {
  viewsLongForm: 'long form views',
  viewsShorts: 'Shorts views',
  views: 'views',
  subscribers: 'subscribers',
  watchHours: 'watch hours',
};

/* ---------- per hour, from launch ---------- */

const HOUR_PX = 4;
const PULSE_HEIGHT = 150;

/** Readable dates on an axis that can be a year wide. */
const axisDate = (ms) =>
  new Date(ms).toLocaleDateString(undefined, {day: 'numeric', month: 'short'});

const axisHour = (ms) =>
  new Date(ms).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: 'numeric'});

const axisClock = (ms) => new Date(ms).toLocaleTimeString(undefined, {hour: 'numeric'});

/**
 * One rate series as bars on a real time axis, scrolling sideways.
 *
 * The width is the DATA's width, not the container's. Six weeks of quarter
 * hourly readings cannot be squeezed into 560 pixels without every bar
 * becoming sub-pixel and the whole thing turning into a grey smear, which is
 * exactly what a fixed-width chart would do here as the history grows. So the
 * chart grows and the container scrolls.
 */
function pulseChart(seriesSet, windowHours, render = 'bars') {
  const pad = {left: 44, right: 12, top: 10, bottom: 26};
  const cutoff = windowHours ? Date.now() - windowHours * 3600000 : null;

  const laid = seriesSet
    .map((s) => ({
      ...s,
      rates: ratePerHour(s.series).filter((r) => cutoff === null || r.to >= cutoff),
    }))
    .filter((s) => s.rates.length > 0);

  if (laid.length === 0) return null;

  // ONE time axis and ONE value axis across every series in the chart. Scaling
  // each to itself would put a Short's quiet week at the same height as an
  // episode's launch night.
  const all = laid.flatMap((s) => s.rates);
  const t0 = Math.min(...all.map((r) => r.from));
  const t1 = Math.max(...all.map((r) => r.to));
  const hours = (t1 - t0) / 3600000;

  // Wide enough that a busy hour is a bar rather than a hairline, bounded so a
  // year of collection does not produce a canvas no browser will paint. The
  // window chips are how you look closer; this is only the outer limit.
  const plotWidth = Math.round(Math.min(12000, Math.max(640, hours * HOUR_PX)));
  const width = plotWidth + pad.left + pad.right;
  const h = PULSE_HEIGHT - pad.top - pad.bottom;

  const top = Math.max(...all.map((r) => r.perHour), 0);
  const floor = Math.min(...all.map((r) => r.perHour), 0);
  const ticks = niceTicks(Math.min(0, floor), top || 1, 3);
  const y = linearScale([ticks[0], ticks.at(-1)], [h, 0]);
  const domain = [t0, t1, ticks[0], ticks.at(-1)];

  // Room past the last bar for the final date label, which otherwise loses its
  // last two characters against the edge of the scroller.
  const canvas = plotWidth + pad.right + 16;
  const svg = el('svg', {
    class: 'chart pulse-chart',
    width: canvas,
    height: PULSE_HEIGHT,
    viewBox: `0 0 ${canvas} ${PULSE_HEIGHT}`,
    preserveAspectRatio: 'xMinYMin meet',
    role: 'img',
  });

  // THE VALUE AXIS DOES NOT SCROLL. It lives in its own fixed SVG beside the
  // plot, because a scale that slides off the left edge on the first swipe
  // leaves a chart of bars with no numbers on it at all, which is the state
  // this chart spent its first render in.
  const axis = el('svg', {
    class: 'chart pulse-axis',
    width: pad.left,
    height: PULSE_HEIGHT,
    viewBox: `0 0 ${pad.left} ${PULSE_HEIGHT}`,
    'aria-hidden': 'true',
  });
  const axisG = el('g', {transform: `translate(${pad.left},${pad.top})`});
  for (const tick of ticks) {
    axisG.append(
      el('text', {class: 'axis', x: -6, y: y(tick) + 3, 'text-anchor': 'end'}, compact(tick))
    );
  }
  axis.append(axisG);

  const g = el('g', {transform: `translate(0,${pad.top})`});

  for (const tick of ticks) {
    g.append(el('line', {class: 'grid', x1: 0, x2: plotWidth, y1: y(tick), y2: y(tick)}));
  }

  // Date ticks, thinned so a long range does not end up with more grid than
  // data. Hourly ticks once the window is short enough to warrant them.
  const xScale = linearScale([t0, t1], [0, plotWidth]);
  const dayMs = 86400000;
  if (hours <= 48) {
    const step = hours <= 12 ? 1 : hours <= 26 ? 3 : 6;
    const first = new Date(t0);
    first.setMinutes(0, 0, 0);
    first.setHours(first.getHours() + 1);
    for (let t = first.getTime(); t <= t1; t += step * 3600000) {
      const x = xScale(t);
      g.append(el('line', {class: 'grid day', x1: x, x2: x, y1: 0, y2: h}));
      g.append(
        el('text', {class: 'axis', x, y: h + 16, 'text-anchor': 'middle'}, axisClock(t))
      );
    }
  } else {
    const days = Math.ceil((t1 - t0) / dayMs);
    const every = days > 120 ? 14 : days > 40 ? 7 : days > 14 ? 2 : 1;
    const first = new Date(t0);
    first.setHours(24, 0, 0, 0);
    let index = 0;
    for (let t = first.getTime(); t <= t1; t += dayMs, index += 1) {
      if (index % every !== 0) continue;
      const x = xScale(t);
      g.append(el('line', {class: 'grid day', x1: x, x2: x, y1: 0, y2: h}));
      g.append(el('text', {class: 'axis', x, y: h + 16, 'text-anchor': 'middle'}, axisDate(t)));
    }
  }

  // Every mark says what it is. A chart whose numbers can only be guessed from
  // a grid line is a picture, not a measurement.
  const tip = (s, rate) =>
    el(
      'title',
      {},
      `${s.label}: ${num(Math.round(rate.perHour))} per hour, ${axisHour(rate.to)}` +
        (rate.coarse ? ' (a whole day averaged, before hourly collection began)' : '')
    );

  for (const s of laid) {
    const layer = el('g', {class: `${render} ${s.className}`});

    if (render === 'line') {
      for (const run of rateRuns(s.rates, {width: plotWidth, height: h, domain})) {
        const d = pathOf(run.points);
        if (!d) continue;
        const cls = run.coarse ? 'line coarse' : 'line';
        // Closed along the baseline from the same path, so the fill can never
        // disagree with the line above it.
        const first = run.points[0];
        const last = run.points.at(-1);
        layer.append(
          el('path', {
            class: run.coarse ? 'area coarse' : 'area',
            d: `${d} L${last.x.toFixed(1)},${y(0)} L${first.x.toFixed(1)},${y(0)} Z`,
          })
        );
        layer.append(el('path', {class: cls, d}));
      }

      // A hit target per reading. The line itself is two pixels wide and
      // nobody can hover it, so the numbers would be unreachable without this.
      for (const run of rateRuns(s.rates, {width: plotWidth, height: h, domain})) {
        for (const point of run.points) {
          const dot = el('circle', {
            class: point.coarse ? 'dot coarse' : 'dot',
            cx: point.x.toFixed(1),
            cy: point.y.toFixed(1),
            r: 2.5,
          });
          dot.append(tip(s, point.rate));
          layer.append(dot);
        }
      }
    } else {
      for (const bar of rateBars(s.rates, {width: plotWidth, height: h, domain})) {
        const rect = el('rect', {
          x: bar.x.toFixed(1),
          y: bar.y.toFixed(1),
          width: bar.width.toFixed(1),
          height: bar.height.toFixed(1),
          class: bar.rate.coarse ? 'bar coarse' : 'bar',
        });
        rect.append(tip(s, bar.rate));
        layer.append(rect);
      }
    }

    g.append(layer);
  }

  svg.append(g);
  return {axis, plot: svg, width: canvas};
}

/**
 * A titled, scrolling rate chart with its own legend and current reading.
 */
function pulseCard({title, seriesSet, unit, render}) {
  const chart = pulseChart(seriesSet, state.pulseHours, render);
  if (!chart) return null;

  const card = document.createElement('article');
  card.className = 'card pulse-card';

  const head = document.createElement('div');
  head.className = 'chart-head';

  const recent = seriesSet
    .map((s) => {
      const rates = ratePerHour(s.series);
      const fine = rates.filter((r) => !r.coarse);
      const last = (fine.length ? fine : rates).at(-1);
      return last ? {label: s.label, className: s.className, perHour: last.perHour} : null;
    })
    .filter(Boolean);

  head.innerHTML = `
    <h3>${title}</h3>
    <div class="legend">
      ${recent
        .map(
          (r) =>
            `<span class="legend-item ${r.className}"><i></i>${r.label}
             <strong>${num(Math.round(r.perHour))}</strong>/hr</span>`
        )
        .join('')}
    </div>`;

  const scroller = document.createElement('div');
  scroller.className = 'chart-scroll';
  scroller.append(chart.plot);

  const body = document.createElement('div');
  body.className = 'pulse-body';
  body.append(chart.axis, scroller);

  card.append(head, body);

  // Opened at the right hand edge, because the useful end of a growth chart is
  // now, not launch. Scrolling back is a deliberate act; scrolling forward
  // every single visit is a tax.
  requestAnimationFrame(() => {
    scroller.scrollLeft = scroller.scrollWidth;
  });

  const note = document.createElement('p');
  note.className = 'note small';
  note.textContent = `The dashed stretch is averaged over a whole day, from before per-hour collection started, so it does not claim to have measured any particular hour. ${unit}`;
  card.append(note);

  return card;
}

/**
 * How far back the per-hour charts look.
 *
 * "All" is the default because Sam asked for launch to date, and it is the
 * window that answers the question the charts exist for: has this channel ever
 * had a night that worked. The shorter windows are for reading a single
 * launch, where a month of quiet days squashes the hour you care about.
 */
const PULSE_WINDOWS = [
  {label: '24 hours', hours: 24},
  {label: '7 days', hours: 24 * 7},
  {label: '30 days', hours: 24 * 30},
  {label: 'All', hours: null},
];

function renderPulseFilter() {
  $('pulse-filter').replaceChildren(
    ...PULSE_WINDOWS.map((w) =>
      chip(w.label, state.pulseHours === w.hours, () => {
        state.pulseHours = w.hours;
        renderPulseFilter();
        renderPulse();
      })
    )
  );
}

function renderPulse() {
  const samples = state.report.history?.samples?.youtube ?? {};

  /*
    LONG FORM AND SHORTS GET A CHART EACH, on Sam's ruling, and the data settles
    the argument rather than taste. Drawn on one shared axis the two lines are
    truthful and half of the chart is unreadable: Shorts outrun long form by
    roughly two orders of magnitude on this channel, one episode having taken
    23 views while its own Shorts took 1,713, so the long form line lies flat on
    zero exactly when there is something to see in it.

    The risk of separating them is that a reader compares the two heights and
    concludes something false. That is handled the way the Library panel already
    handles it: they are visibly different charts, each with its own axis, and
    the note says they are not comparable. An unreadable chart cannot be saved
    by being technically fair.
  */
  const charts = [
    {
      title: 'Long form views per hour',
      unit: 'Its own scale. Long form and Shorts are never plotted together, because a Short outruns an episode by so much that the episode would lie flat on zero.',
      seriesSet: [{label: 'Long form', className: 'long', series: samples.viewsLongForm ?? []}],
    },
    {
      title: 'Shorts views per hour',
      unit: 'Its own scale, for the same reason. Shorts are measured on swipes, an episode on watch time.',
      seriesSet: [{label: 'Shorts', className: 'short', series: samples.viewsShorts ?? []}],
    },
    {
      title: 'Subscribers per hour',
      unit: 'A thousand subscribers is one of the two doors to monetisation.',
      seriesSet: [{label: 'Subscribers', className: 'subs', series: samples.subscribers ?? []}],
    },
  ];

  const cards = charts.map((c) => pulseCard({...c, render: 'line'})).filter(Boolean);

  if (cards.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = state.pulseHours
      ? 'Nothing was collected in this window. Try a wider one.'
      : 'Per-hour charts need two readings. They fill in from the next collection run, and the split between long form and Shorts starts accruing from the same run.';
    $('pulse').replaceChildren(empty);
    return;
  }

  $('pulse').replaceChildren(...cards);
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
      const label = gap?.label ?? METRIC_LABELS[metric] ?? metric;
      cards.push(trendCard(platform, label, series, requirement?.target));
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
  renderShortsSummary();
  renderLibraryFilter();
  renderLibrary();
  renderSchedule();
  renderTrends();
  renderPulseFilter();
  renderPulse();
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

/* ---------- the content library ---------- */

/**
 * Every upload, everywhere, with its numbers.
 *
 * The report does the joining; this only draws it. Two things are deliberate.
 * A row with no measurement shows "no data" and never a zero, because zero
 * views and an uncollected number lead to opposite decisions. And a row the
 * register does not know is shown with a tag rather than hidden: it means
 * something went out without being written down, which is worth seeing.
 */
const FORMATS = [
  {id: 'all', label: 'Everything'},
  {id: 'short', label: 'Shorts'},
  {id: 'long', label: 'Long form'},
];

function libraryRows() {
  const rows = state.report.library?.rows ?? [];
  const pick = state.libraryFormat ?? 'all';
  return pick === 'all' ? rows : rows.filter((r) => r.format === pick);
}

function renderLibraryFilter() {
  const host = $('library-filter');
  if (!host) return;
  host.replaceChildren(
    ...FORMATS.map((f) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = f.label;
      b.setAttribute('aria-pressed', String((state.libraryFormat ?? 'all') === f.id));
      b.addEventListener('click', () => {
        state.libraryFormat = f.id;
        renderLibraryFilter();
        renderLibrary();
      });
      return b;
    })
  );
}

function shortsCard(title, s, sub) {
  if (!s || s.status !== 'measured') {
    return kpi(title, 'awaiting', 'nothing measured yet');
  }
  return kpi(title, num(s.medianViews), `${sub}, mean ${num(s.meanViews)} over ${s.measured}`);
}

function renderShortsSummary() {
  const host = $('shorts-summary');
  if (!host) return;
  const lib = state.report.library?.shorts;
  if (!lib) {
    host.replaceChildren();
    return;
  }

  const cards = [
    shortsCard('Shorts, median views', lib.shorts, 'median'),
    shortsCard('Long form, median views', lib.long, 'median'),
  ];

  if (lib.shorts?.status === 'measured') {
    cards.push(
      kpi('Best Short', lib.shorts.best?.title ?? 'no data', `${num(lib.shorts.best?.views)} views`),
      kpi('Weakest Short', lib.shorts.worst?.title ?? 'no data', `${num(lib.shorts.worst?.views)} views`)
    );
  }
  host.replaceChildren(...cards);
}

function renderLibrary() {
  const host = $('library');
  if (!host) return;

  const rows = libraryRows();
  if (rows.length === 0) {
    host.innerHTML = '<p class="note">Nothing uploaded yet.</p>';
    return;
  }

  const body = rows
    .map((r) => {
      const when = (r.publishedAt ?? r.at ?? '').slice(0, 10);
      const title = r.title ?? r.asset ?? 'untitled';
      const link = r.url
        ? `<a href="${r.url}" target="_blank" rel="noopener">${title}</a>`
        : title;
      const tag = r.unregistered
        ? ' <span class="tag-unregistered">NOT IN REGISTER</span>'
        : '';
      // A blocked platform states its reason. It is not a clip that did badly.
      const numbers =
        r.status === 'measured'
          ? `<td>${num(r.views)}</td><td>${num(r.likes)}</td><td>${num(r.comments)}</td>`
          : `<td colspan="3" class="note">${
              r.blocked ? `blocked: ${r.blocked}` : r.status
            }</td>`;
      return `
        <tr>
          <td class="row-ep">${when}</td>
          <td class="col-plat">${r.platform}</td>
          <td class="fmt-${r.format}">${r.format}</td>
          <td class="row-title">${link}${tag}</td>
          ${numbers}
        </tr>`;
    })
    .join('');

  host.innerHTML = `
    <table class="grid">
      <thead>
        <tr>
          <th>Published</th><th>Platform</th><th>Format</th><th>Title</th>
          <th>Views</th><th>Likes</th><th>Comments</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
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
