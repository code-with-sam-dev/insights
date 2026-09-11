/**
 * What to post next, where, and on which day.
 *
 * The matrix says which cells are empty. That is a list, not a plan: posting
 * everything the moment it is ready is exactly what gets a young account
 * throttled. This module spreads the empty cells across days under the pacing
 * rules each platform has already taught us.
 *
 * Two rules it must not break:
 *
 *   TikTok takes one clip a day. Three in five minutes from a low-follower
 *   account reads as spam to its early distribution, and they get throttled
 *   together instead of each getting its own cold-start test.
 *
 *   A blocked item never gets a date. Putting something on a day when the
 *   platform will refuse it is how a schedule stops being believed.
 */

/**
 * How many posts a day each platform will take without the account looking
 * automated. YouTube is generous because uploads there are expected in
 * batches; TikTok is the tightest and the one that has actually bitten.
 */
export const DAILY_CAP = {
  youtube: 3,
  linkedin: 1,
  x: 1,
  instagram: 2,
  tiktok: 1,
  facebook: 1,
};

/** Facebook is excluded from the automated run, so its rows need a name on them. */
const MANUAL = new Set(['facebook']);

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function postingPlan(rows = [], {today = new Date().toISOString().slice(0, 10)} = {}) {
  const pending = [];
  const blocked = [];

  for (const row of rows) {
    for (const platform of row.carried) {
      const cell = row.cells[platform];
      if (cell.status === 'published') continue;
      const item = {
        platform,
        episode: row.episode,
        asset: row.asset,
        kind: row.kind,
        title: row.title ?? null,
        file: row.file ?? null,
        manual: MANUAL.has(platform),
      };
      if (cell.status === 'blocked') blocked.push({...item, blocked: cell.blocked});
      else pending.push({...item, createdAt: row.createdAt ?? null});
    }
  }

  // Oldest waiting first. The newest episode is the one just finished, so
  // ordering by recency would leave yesterday's unfinished clips at the bottom
  // of the list forever, which is precisely how they were forgotten.
  pending.sort(
    (a, b) =>
      String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
      a.episode - b.episode ||
      String(a.asset).localeCompare(String(b.asset))
  );

  // Pacing is per platform: nothing is gained by making Instagram wait behind
  // TikTok, so each platform fills its own days independently.
  const used = new Map();
  const items = pending.map((item) => {
    const cap = DAILY_CAP[item.platform] ?? 1;
    let offset = 0;
    for (;;) {
      const date = addDays(today, offset);
      const slot = `${item.platform}:${date}`;
      const taken = used.get(slot) ?? 0;
      if (taken < cap) {
        used.set(slot, taken + 1);
        return {...item, date};
      }
      offset += 1;
    }
  });

  items.sort(
    (a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform)
  );

  return {
    items,
    blocked,
    today: items.filter((i) => i.date === today),
    // How long until the backlog is cleared at the current pacing. A number
    // that grows episode on episode means the rules, not the effort, are the
    // constraint.
    clearsOn: items.length ? items[items.length - 1].date : null,
  };
}
