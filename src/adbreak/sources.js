// -----------------------------------------------------------------------------
// Where song boundaries come from, per station.
//
// 1. HEOS itself: for a station whose stream carries metadata (Radio Paradise
//    via TuneIn reports `song`/`artist` live, for instance), every change of
//    get_now_playing_media is a new song — and arrives in sync with what the
//    receiver plays, no lag to compensate. Durations are not given, so they
//    are looked up on Deezer (free, keyless search API).
// 2. A dedicated feed for stations whose stream carries nothing at all: OUI FM
//    (and its whole "Les Indés Radios" platform) publishes a live
//    server-sent-events feed on its own website, with the station's own
//    durations. It runs ahead of what the receiver plays by the stream's
//    buffering delay (measured: ~3 s through TuneIn/Icecast, ~40 s through
//    the HLS stream), see `lagSeconds`.
// 3. Nothing: only manual marks can teach the ad schedule (see stats.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'ad-break' });

// Stations with a dedicated feed. `match` is tested against the HEOS
// now-playing payload: TuneIn station id (album_id) or stream URL (mid).
// `seedWindows` are the ad windows measured on the station's own playlist
// history (3 days, 32 breaks), used until enough local listening is learned.
export const KNOWN_STATIONS = [
  {
    key: 'tunein:s6586',
    name: 'OUI FM',
    tuneinIds: ['s6586'],
    urlPatterns: [
      /ouifm\.ice\.infomaniak\.ch\/ouifm-/i,
      /ouifm\.radiohls\.infomaniak\.com\/ouifm\//i,
    ],
    feed: { type: 'indesradios', site: 'https://www.ouifm.fr', mdsId: '2174546520932614531' },
    seedWindows: [
      [9, 15],
      [34, 48],
    ],
  },
];

/**
 * Identify the station currently playing from a HEOS now-playing payload.
 * @returns {null | {key: string, name: string, known: object|null, lagSeconds: number,
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
  const known =
    KNOWN_STATIONS.find(
      (s) => s.tuneinIds.includes(albumId) || s.urlPatterns.some((re) => re.test(mid)),
    ) ?? null;
  const key = known?.key ?? (/^s\d+$/.test(albumId) ? `tunein:${albumId}` : `url:${mid}`);
  const song = typeof payload.song === 'string' ? payload.song.trim() : '';
  const artist = typeof payload.artist === 'string' ? payload.artist.trim() : '';
  // HEOS fills song/artist/album with the literal "Url Stream" for any
  // direct URL: that is a placeholder, not metadata.
  const placeholder = song === 'Url Stream';
  return {
    key,
    name: known?.name || stationName || mid,
    known,
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
export async function lookupDurationSeconds(artist, title, fetchImpl = fetch) {
  const cacheKey = `${artist}\n${title}`.toLowerCase();
  if (durationCache.has(cacheKey)) {
    return durationCache.get(cacheKey);
  }
  let duration = null;
  try {
    const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const res = await fetchImpl(`https://api.deezer.com/search?q=${q}&limit=1`, {
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    duration = Number(json?.data?.[0]?.duration) || null;
  } catch (err) {
    logger.debug(`Deezer duration lookup failed for "${artist} - ${title}": ${err.message}`);
  }
  durationCache.set(cacheKey, duration);
  return duration;
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
