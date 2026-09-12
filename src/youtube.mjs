/**
 * YouTube collection.
 *
 * Two different APIs, with very different access costs, and the difference
 * decides what this dashboard can honestly show:
 *
 *   Data API v3        public counts. Needs only an API key. Gives
 *                      subscribers, total views, and per-video statistics.
 *   Analytics API      watch time, retention, traffic sources. Needs OAuth as
 *                      the channel owner, so it needs a refresh token.
 *
 * Watch hours are one of the two Partner Programme requirements, so without
 * the Analytics half the dashboard cannot project when YouTube starts paying.
 * When the OAuth credentials are absent this returns null for those metrics
 * rather than guessing, and the page says the number is missing and why.
 *
 * Every failure here returns null and logs. A collection run that half fails
 * must still commit what it did get, because a missing day is a hole in every
 * trend line.
 */

const DATA_API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

/** Exchanges the long-lived refresh token for a short-lived access token. */
async function accessToken({clientId, clientSecret, refreshToken}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const json = await getJson(TOKEN_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body,
  });
  return json.access_token;
}

export async function channelStats({apiKey, channelId}) {
  const url = `${DATA_API}/channels?part=statistics,contentDetails&id=${channelId}&key=${apiKey}`;
  const json = await getJson(url);
  const channel = json.items?.[0];
  if (!channel) throw new Error(`no channel returned for ${channelId}`);

  return {
    subscribers: Number(channel.statistics.subscriberCount),
    views: Number(channel.statistics.viewCount),
    videos: Number(channel.statistics.videoCount),
    uploadsPlaylist: channel.contentDetails?.relatedPlaylists?.uploads ?? null,
  };
}

/**
 * Per-video engagement, for the "what is working" ranking.
 *
 * Engagements are likes plus comments. Neither is a perfect proxy for whether
 * a viewer got value, but the ratio between videos is comparable, which is all
 * the ranking needs. Likes and comments are also returned separately, because
 * the most liked clip and the most commented clip are usually different ones
 * and the difference is the signal.
 */
/**
 * Seconds from an ISO 8601 duration, or null when there is nothing to read.
 *
 * Null rather than zero on purpose: zero would classify every video whose
 * duration failed to collect as a Short, which is the one mistake that would
 * make the Shorts comparison meaningless.
 */
export function parseDuration(iso) {
  const match = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso ?? ''));
  if (!match) return null;
  const [h, m, s] = [match[1], match[2], match[3]].map((v) => Number(v ?? 0));
  const total = h * 3600 + m * 60 + s;
  return Number.isFinite(total) ? total : null;
}

export async function videoStats({apiKey, uploadsPlaylist, limit = 50}) {
  if (!uploadsPlaylist) return [];

  const listUrl =
    `${DATA_API}/playlistItems?part=contentDetails&playlistId=${uploadsPlaylist}` +
    `&maxResults=${limit}&key=${apiKey}`;
  const list = await getJson(listUrl);
  const ids = list.items?.map((i) => i.contentDetails.videoId) ?? [];
  if (ids.length === 0) return [];

  const statsUrl =
    `${DATA_API}/videos?part=snippet,statistics,contentDetails&id=${ids.join(',')}&key=${apiKey}`;
  const stats = await getJson(statsUrl);

  return (stats.items ?? []).map((v) => {
    const likes = Number(v.statistics.likeCount ?? 0);
    const comments = Number(v.statistics.commentCount ?? 0);
    return {
      id: v.id,
      title: v.snippet.title,
      platform: 'youtube',
      url: `https://www.youtube.com/watch?v=${v.id}`,
      publishedAt: v.snippet.publishedAt,
      views: Number(v.statistics.viewCount ?? 0),
      // Kept split as well as summed. Sam asked which post has the most likes
      // and which has the most comments, and those two are frequently not the
      // same post, nor the most watched one. Summing them first threw that away.
      likes,
      comments,
      engagements: likes + comments,
      // Decides Short against long form on the content library page. The two
      // are not comparable and must never be averaged together.
      durationSeconds: parseDuration(v.contentDetails?.duration),
    };
  });
}

/**
 * Watch time over the trailing 365 days, which is the Partner Programme window.
 *
 * Returns null when OAuth is not configured. Null is the honest answer and the
 * rest of the system is built to carry it: a missing metric reads as "no data",
 * never as zero.
 */
export async function watchHours({clientId, clientSecret, refreshToken, channelId}) {
  if (!clientId || !clientSecret || !refreshToken) return null;

  const token = await accessToken({clientId, clientSecret, refreshToken});

  const end = new Date();
  const start = new Date(end.getTime() - 365 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const url =
    `${ANALYTICS_API}?ids=channel==${channelId}` +
    `&startDate=${iso(start)}&endDate=${iso(end)}&metrics=estimatedMinutesWatched`;

  const json = await getJson(url, {headers: {Authorization: `Bearer ${token}`}});
  const minutes = json.rows?.[0]?.[0];
  return minutes === undefined ? null : minutes / 60;
}

/** Everything YouTube can give us today, with per-call failures isolated. */
export async function collectYouTube(config, log = console) {
  const result = {metrics: {}, content: [], errors: []};

  let stats;
  try {
    stats = await channelStats(config);
    result.metrics.subscribers = stats.subscribers;
    result.metrics.views = stats.views;
  } catch (error) {
    result.errors.push(`channelStats: ${error.message}`);
    log.warn(`YouTube channel stats failed: ${error.message}`);
    return result;
  }

  try {
    result.content = await videoStats({...config, uploadsPlaylist: stats.uploadsPlaylist});
  } catch (error) {
    result.errors.push(`videoStats: ${error.message}`);
    log.warn(`YouTube video stats failed: ${error.message}`);
  }

  try {
    result.metrics.watchHours = await watchHours(config);
  } catch (error) {
    result.errors.push(`watchHours: ${error.message}`);
    log.warn(`YouTube watch hours failed: ${error.message}`);
  }

  return result;
}
