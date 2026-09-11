/**
 * What we made, against where it went.
 *
 * data/uploads.json records attempts. data/catalogue.json records renders. The
 * interesting gap is the one only visible by joining them: a finished clip that
 * was never posted anywhere leaves no row in the register at all, so before
 * this module the most expensive failure was the one the dashboard could not
 * show.
 *
 * One distinction carries the whole design. "This platform does not take this
 * kind of asset" is not the same as "this platform has not got it yet". A
 * long-form episode is not missing from TikTok. Rendering both as a red cell
 * produces a permanent red nobody can clear, and a board with a cell like that
 * stops being read.
 */

/** Which platforms are expected to carry each kind of asset. */
export const CARRIES = {
  episode: ['youtube'],
  short: ['youtube', 'tiktok', 'instagram', 'facebook'],
  post: ['linkedin', 'x'],
};

/** Every platform that appears as a column, in the order they are posted to. */
export const COLUMNS = ['youtube', 'linkedin', 'x', 'instagram', 'tiktok', 'facebook'];

/** Episode first, then shorts in name order, then the announcement post. */
const RANK = {episode: 0, short: 1, post: 2};

const key = (e) => `${e.episode}/${e.asset}`;

export function uploadMatrix(catalogue = [], entries = []) {
  const byKey = new Map();
  for (const entry of entries) {
    const list = byKey.get(key(entry)) ?? [];
    list.push(entry);
    byKey.set(key(entry), list);
  }

  const known = new Set(catalogue.map(key));

  const rows = [...catalogue]
    .sort(
      (a, b) =>
        b.episode - a.episode ||
        RANK[a.kind] - RANK[b.kind] ||
        String(a.asset).localeCompare(String(b.asset))
    )
    .map((asset) => {
      const carried = CARRIES[asset.kind] ?? [];
      const mine = byKey.get(key(asset)) ?? [];

      const cells = {};
      for (const platform of COLUMNS) {
        if (!carried.includes(platform)) {
          cells[platform] = {status: 'n/a'};
          continue;
        }
        const entry = mine.find((e) => e.platform === platform);
        if (entry?.url) {
          cells[platform] = {status: 'published', url: entry.url, at: entry.at ?? null};
        } else if (entry?.blocked) {
          cells[platform] = {status: 'blocked', blocked: entry.blocked};
        } else {
          cells[platform] = {status: 'pending'};
        }
      }

      return {...asset, carried, cells};
    });

  // An upload recorded against something the catalogue does not list means
  // either a render is missing from the catalogue or something went out under
  // the wrong name. Both are worth seeing; neither is worth silently dropping.
  const orphans = entries.filter((e) => !known.has(key(e)));

  return {rows, orphans};
}

/**
 * Progress over the cells that could ever be filled.
 *
 * Deliberately excludes n/a. Counting a row as 1 of 6 because TikTok does not
 * take long-form would make a finished episode look permanently incomplete.
 */
export function coverage(rows = []) {
  let applicable = 0;
  let published = 0;
  let blocked = 0;

  for (const row of rows) {
    for (const platform of row.carried) {
      applicable += 1;
      const status = row.cells[platform].status;
      if (status === 'published') published += 1;
      if (status === 'blocked') blocked += 1;
    }
  }

  return {applicable, published, blocked, pending: applicable - published};
}
