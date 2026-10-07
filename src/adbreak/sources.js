// -----------------------------------------------------------------------------
// Where song boundaries come from, per station.
//
// 1. HEOS itself: for a station whose stream carries metadata (Radio Paradise
//    via TuneIn reports `song`/`artist` live, for instance), every change of
//    get_now_playing_media is a new song — and arrives in sync with what the
//    receiver plays, no lag to compensate. Durations are not given, so they
//    are looked up on Deezer (free, keyless search API).
// 2. A dedicated feed for stations whose stream carries nothing at all: OUI FM
//    and the other stations of its website platform (Voltage, Alouette, Hit
//    West, Forum, Ado, Latina...) publish a live server-sent-events feed on
//    their own website, with the station's own durations, plus ~3 days of
//    playlist history. Discovered automatically: TuneIn gives the station's
//    website, whose page data names the platform stream id (idMds). The feed
//    runs ahead of what the receiver plays by the stream's buffering delay
//    (measured: ~3 s through TuneIn/Icecast, ~40 s through HLS), see
//    `lagSeconds`.
// 3. Nothing: only manual marks can teach the ad schedule (see stats.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'ad-break' });

// Direct stream URLs (played as a URL, not through TuneIn) that are known to
// be a TuneIn station: mapped to it so they share its statistics and feed.
// Only a hint — TuneIn plays need no entry here at all.
export const STREAM_URL_HINTS = [
  {
    tuneinId: 's6586', // OUI FM
    name: 'OUI FM',
    urlPatterns: [
      /ouifm\.ice\.infomaniak\.ch\/ouifm-/i,
      /ouifm\.radiohls\.infomaniak\.com\/ouifm\//i,
    ],
  },
];

/**
 * Identify the station currently playing from a HEOS now-playing payload.
 * @returns {null | {key: string, tuneinId: string|null, name: string, lagSeconds: number,
 *   heosTitle: string, heosArtist: string}}
 *   null when nothing radio-like is playing (no station, no stream).
 */
export function identifyStation(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const mid = typeof payload.mid === 'string' ? payload.mid : '';
  const albumId = typeof payload.album_id === 'string' ? payload.album_id : '';
  const stationName = typeof payload.station === 'string' ? payload.station.trim() : '';
  const isStation = payload.type === 'station';
  const isStream = /^https?:\/\//i.test(mid);
  if (!isStation && !isStream) {
    return null;
  }
  const hint = STREAM_URL_HINTS.find((s) => s.urlPatterns.some((re) => re.test(mid))) ?? null;
  const tuneinId = /^s\d+$/.test(albumId) ? albumId : (hint?.tuneinId ?? null);
  const key = tuneinId ? `tunein:${tuneinId}` : `url:${mid}`;
  const song = typeof payload.song === 'string' ? payload.song.trim() : '';
  const artist = typeof payload.artist === 'string' ? payload.artist.trim() : '';
  // HEOS fills song/artist/album with the literal "Url Stream" for any
  // direct URL: that is a placeholder, not metadata.
  const placeholder = song === 'Url Stream';
  return {
    key,
    tuneinId,
    // What the receiver actually streams: the jingle listener decodes the
    // same URL (TuneIn resolves to the station's own stream URL here too).
    streamUrl: isStream ? mid : null,
    name: stationName || hint?.name || mid,
    // HLS buffers far more than Icecast; measured by ear on OUI FM.
    lagSeconds: /\.m3u8|radiohls/i.test(mid) ? 40 : 3,
    heosTitle: placeholder ? '' : song,
    heosArtist: placeholder ? '' : artist,
  };
}

const durationCache = new Map();

/**
 * Song duration in seconds from Deezer's public search, or null.
 * Cached (including misses) for the life of the process.
 */
const normalize = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export async function lookupDurationSeconds(artist, title, fetchImpl = fetch) {
  const cacheKey = `${artist}\n${title}`.toLowerCase();
  if (durationCache.has(cacheKey)) {
    return durationCache.get(cacheKey);
  }
  let duration = null;
  try {
    // Deezer's advanced syntax (artist:"..." track:"...") now returns
    // nothing: plain search, then the result whose artist and title match.
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetchImpl(`https://api.deezer.com/search?q=${q}&limit=10`, {
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    const results = Array.isArray(json?.data) ? json.data : [];
    const wantedArtist = normalize(artist);
    const wantedTitle = normalize(title);
    const sameArtist = (r) => {
      const name = normalize(r.artist?.name ?? '');
      return name && (wantedArtist.includes(name) || name.includes(wantedArtist));
    };
    const sameTitle = (r) => normalize(r.title_short ?? r.title ?? '') === wantedTitle;
    const best =
      results.find((r) => sameArtist(r) && sameTitle(r)) ?? results.find((r) => sameArtist(r));
    duration = Number(best?.duration) || null;
  } catch (err) {
    logger.debug(`Deezer duration lookup failed for "${artist} - ${title}": ${err.message}`);
  }
  durationCache.set(cacheKey, duration);
  return duration;
}

const json = async (url, fetchImpl) => {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
};

/**
 * Find the live feed of a TuneIn station, if its website runs on the
 * Les Indés Radios platform: TuneIn's profile gives the website, whose
 * Next.js page data lists the station's streams — the first one of the
 * `zones` block is the main station (the others are its webradios).
 * @returns {Promise<null | {type: 'indesradios', site: string, mdsId: string}>}
 */
export async function discoverFeed(tuneinId, fetchImpl = fetch) {
  const profile = await json(`https://feed.tunein.com/profiles/${tuneinId}/nowPlaying`, fetchImpl);
  const webUrl = profile?.Link?.WebUrl;
  if (typeof webUrl !== 'string' || !/^https?:\/\//.test(webUrl)) {
    return null;
  }
  const site = new URL(webUrl.replace(/^http:/, 'https:')).origin;
  const res = await fetchImpl(`${site}/`, { signal: AbortSignal.timeout(15_000) });
  const page = await res.text();
  const mdsId = page.match(/"zones":\[\{.*?"idMds":"(\d+)"/s)?.[1];
  if (!mdsId) {
    return null;
  }
  return { type: 'indesradios', site: new URL(res.url || `${site}/`).origin, mdsId };
}

/** Song duration in seconds from a Deezer track id, or null (cached). */
export async function lookupDurationById(deezerId, fetchImpl = fetch) {
  const cacheKey = `id:${deezerId}`;
  if (!durationCache.has(cacheKey)) {
    let duration = null;
    try {
      duration =
        Number((await json(`https://api.deezer.com/track/${deezerId}`, fetchImpl))?.duration) ||
        null;
    } catch (err) {
      logger.debug(`Deezer lookup failed for track ${deezerId}: ${err.message}`);
    }
    durationCache.set(cacheKey, duration);
  }
  return durationCache.get(cacheKey);
}

/**
 * The station's playlist history (newest pages first, ~3 days available),
 * oldest song first: `[{startedAt, artist, title, deezerId}]`.
 */
export async function fetchPlaylistHistory({ site, mdsId, hours = 72, fetchImpl = fetch }) {
  const byId = new Map();
  const since = Date.now() - hours * 3_600_000;
  // A page holds the ~30 songs before `date` (~1 h of music): page back from
  // the oldest song of each page.
  let date = Date.now();
  for (let page = 0; page < hours * 2 && date > since; page++) {
    let items;
    try {
      items = await json(
        `${site}/api/TitleDiffusions?size=60&radioStreamId=${mdsId}&date=${date}`,
        fetchImpl,
      );
    } catch (err) {
      logger.debug(`${site}: playlist history page failed: ${err.message}`);
      break;
    }
    let oldest = date;
    for (const item of Array.isArray(items) ? items : []) {
      const startedAt = Date.parse(item.timestamp);
      byId.set(item.id, {
        startedAt,
        artist: item.title?.artist ?? '',
        title: item.title?.title ?? '',
        deezerId: item.title?.deezerId ?? null,
      });
      if (startedAt < oldest) {
        oldest = startedAt;
      }
    }
    if (oldest >= date) {
      break; // empty page, or no progress
    }
    date = oldest;
  }
  return [...byId.values()]
    .filter((s) => s.startedAt > 0)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Ad breaks found in a playlist history: the gaps between the end of a song
 * (start + duration, when the duration is known) and the start of the next.
 * @param {Array<{startedAt: number}>} songs oldest first
 * @param {(song) => number|null} durationOf seconds
 * @param {{min: number, max: number}} gapRange seconds
 */
export function breaksFromHistory(songs, durationOf, { min, max }) {
  const breaks = [];
  for (let i = 0; i + 1 < songs.length; i++) {
    const duration = durationOf(songs[i]);
    if (!duration) {
      continue;
    }
    const end = songs[i].startedAt + duration * 1000;
    const gap = (songs[i + 1].startedAt - end) / 1000;
    if (gap >= min && gap <= max) {
      breaks.push({ startedAt: end, durationSeconds: Math.round(gap) });
    }
  }
  return breaks;
}

/**
 * Parse one server-sent-events `data:` line of the Les Indés Radios feed.
 * @returns {null | {title: string, artist: string, durationSeconds: number|null, type: string}}
 */
export function parseIndesRadiosEvent(line) {
  if (!line.startsWith('data:')) {
    return null;
  }
  try {
    const m = JSON.parse(line.slice(5));
    if (!m || typeof m.title !== 'string') {
      return null;
    }
    return {
      title: m.title.trim(),
      artist: typeof m.artist === 'string' ? m.artist.trim() : '',
      durationSeconds: Number(m.durationInSeconds) || null,
      type: typeof m.type === 'string' ? m.type : '',
    };
  } catch {
    return null;
  }
}

/**
 * Follow a Les Indés Radios station's live feed (`/ws/metas`), reconnecting
 * with backoff. The feed replays the current song on connect without its
 * start time: that one is looked up in the station's playlist history
 * (`/api/TitleDiffusions`) so the end of the current song is known right
 * away instead of only from the next song on.
 *
 * @param {{site: string, mdsId: string, onTrack: (t: {title, artist, durationSeconds, startedAt: number}) => void}} opts
 * @returns {{stop(): void}}
 */
export function followIndesRadiosFeed({ site, mdsId, onTrack, fetchImpl = fetch }) {
  let stopped = false;
  let controller = null;
  let attempt = 0;
  let lastTitle = null;

  async function historyStartOf(title) {
    try {
      const res = await fetchImpl(
        `${site}/api/TitleDiffusions?size=1&radioStreamId=${mdsId}&date=${Date.now()}`,
        { signal: AbortSignal.timeout(8000) },
      );
      const [latest] = await res.json();
      if (latest?.title?.title?.toLowerCase() === title.toLowerCase()) {
        return Date.parse(latest.timestamp) || null;
      }
    } catch (err) {
      logger.debug(`${site}: playlist history lookup failed: ${err.message}`);
    }
    return null;
  }

  async function run() {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetchImpl(`${site}/ws/metas?id=${mdsId}`, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        attempt = 0;
        let first = true;
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            const event = parseIndesRadiosEvent(line);
            if (!event) {
              continue;
            }
            if (event.title === lastTitle) {
              first = false; // replay of the song already known (reconnect)
              continue;
            }
            lastTitle = event.title;
            const startedAt = first
              ? ((await historyStartOf(event.title)) ?? Date.now())
              : Date.now();
            first = false;
            if (!stopped) {
              onTrack({ ...event, startedAt });
            }
          }
        }
        throw new Error('feed closed');
      } catch (err) {
        if (stopped) {
          return;
        }
        attempt += 1;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
        logger.debug(`${site}: live feed interrupted (${err.message}), retrying in ${delay} ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  run();
  return {
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
