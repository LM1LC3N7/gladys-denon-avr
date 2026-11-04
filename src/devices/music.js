// -----------------------------------------------------------------------------
// The receiver as a Gladys music player (Gladys >= 5.3.0, manifest `music`,
// capabilities/music.md of the core): the catalog (HEOS favorites, HEOS
// playlists, then every source HEOS lists signed in: Qobuz, TIDAL, Deezer,
// Amazon, TuneIn…, Local Music, AUX inputs), the search (the preferred
// service, or every service that can search), play with the replace /
// next / append modes, the queue, and the now playing (title, artist,
// album, artwork) published with the SDK's publishNowPlaying.
//
// A service that is not signed in is left out of the catalog and of the
// search ("Qobuz: check" lists it with its state). Spotify is left out too:
// in HEOS it is Spotify Connect only, nothing to browse.
//
// Gladys awaits every music command under 10 s, at most 4 in flight per
// integration: a search stops starting new HEOS searches once
// timing.musicSearchBudgetMs (6 s) is spent, and answers with what it has.
// -----------------------------------------------------------------------------

import { MUSIC_MEDIA_TYPES, createLogger } from '@gladysassistant/integration-sdk';
import {
  buildGetNowPlayingMediaCommand,
  buildGetQueueCommand,
  buildPlayQueueCommand,
} from '../heos/protocol.js';
import { browseItems, criteriaOf, fold, parseLatestAlbumQuery } from '../heos/qobuz.js';
import { decodeMediaId, encodeMediaId, latestAlbumMediaItem, toMediaItem } from '../heos/media.js';
import { normalizeZone } from '../denon/protocol.js';
import { HEOS_SOURCES, findService, isBrowsable, searchableCandidates } from '../heos/services.js';
import { FEATURE, STATE, featureExternalId } from './features.js';
import { ensureZoneReadyForHeos, requireHeos } from './control.js';
import { onDeviceStateChange, timing } from './registry.js';
import { createArtworkCache } from '../widgets/artwork.js';
import { DeadlineError, assertTimeLeft, runWithDeadline, timeLeft } from './deadline.js';
import {
  browsePage,
  heosSources,
  playArtistPlan,
  playInput,
  playStation,
  queueContainer,
  queueTrack,
  resolveArtist,
  resolveLatestAlbum,
  searchCriteriaOrNone,
  searchKind,
} from './qobuz.js';

const logger = createLogger({ name: 'music' });

// The queue read at most (pages of 100, the CLI spec cap).
const QUEUE_PAGE = 100;
const MAX_QUEUE = 500;
// Gladys media types → the HEOS search criteria searched, in this order
// when no type is asked.
const SEARCH_KINDS = {
  [MUSIC_MEDIA_TYPES.ARTIST]: ['artist'],
  [MUSIC_MEDIA_TYPES.ALBUM]: ['album'],
  [MUSIC_MEDIA_TYPES.PLAYLIST]: ['playlist'],
  [MUSIC_MEDIA_TYPES.TRACK]: ['track'],
  [MUSIC_MEDIA_TYPES.RADIO]: ['station'],
  [MUSIC_MEDIA_TYPES.FOLDER]: [],
};
const ALL_KINDS = ['artist', 'album', 'playlist', 'track'];

const folder = (id, title) => ({
  id,
  type: MUSIC_MEDIA_TYPES.FOLDER,
  title,
  browsable: true,
  playable: false,
});

/** `{ items, total }` of a page cut from a full list. */
const slice = (all, offset, limit) => ({
  items: all.slice(offset, offset + limit),
  total: all.length,
});

/**
 * The music handlers, bound to the SDK (`artworkKey`) and the live config
 * (the zone switched on before playing). Exported for the tests.
 */
export function createMusicHandlers(gladys, getConfig, { fetchFn } = {}) {
  const artworks = createArtworkCache(fetchFn ? { fetchFn } : {});
  const artworkKey = (url) => gladys.artworkKey(url);
  const mediaItems = (items, sid, context = {}) =>
    items.map((item) => toMediaItem(item, sid, { ...context, artworkKey })).filter(Boolean);

  // HEOS' favorites and playlists first, then every other source HEOS lists
  // signed in and browsable, in its order.
  async function root(externalId) {
    const items = [
      folder(encodeMediaId({ kind: 'source', sid: HEOS_SOURCES.FAVORITES }), 'HEOS Favorites'),
      folder(encodeMediaId({ kind: 'source', sid: HEOS_SOURCES.PLAYLISTS }), 'HEOS Playlists'),
    ];
    const { list } = await heosSources(externalId);
    for (const source of list) {
      if (
        source.available &&
        isBrowsable(source) &&
        source.sid !== HEOS_SOURCES.FAVORITES &&
        source.sid !== HEOS_SOURCES.PLAYLISTS
      ) {
        items.push(
          folder(
            encodeMediaId({ kind: 'source', sid: source.sid, name: source.name }),
            source.name || `HEOS ${source.sid}`,
          ),
        );
      }
    }
    return items;
  }

  /**
   * The services a search goes through, in order: the preferred one
   * (config `music_search_service`) when it is signed in and can search;
   * `auto` is Qobuz when it is there; otherwise (or `all`) every service
   * that announces search criteria.
   */
  async function searchTargets(externalId, heos) {
    const { list } = await heosSources(externalId);
    const preferred = String(getConfig().music_search_service ?? 'auto');
    const candidates = searchableCandidates(list);
    const canSearch = async (sources) => {
      const out = [];
      for (const source of sources) {
        if ((await searchCriteriaOrNone(externalId, heos, source.sid)).length > 0) {
          out.push(source);
        }
      }
      return out;
    };
    if (preferred !== 'all') {
      const wanted = findService(list, preferred === 'auto' ? 'qobuz' : preferred);
      if (wanted && candidates.includes(wanted)) {
        const target = await canSearch([wanted]);
        if (target.length > 0) {
          return target;
        }
      }
      if (preferred !== 'auto') {
        logger.info(
          `${externalId}: preferred search service "${preferred}" is not signed in or cannot search, searching every service`,
        );
      }
    }
    return canSearch(candidates);
  }

  const handlers = {
    async browse(device, { parentId, offset = 0, limit = 50 }) {
      const externalId = device.external_id;
      requireHeos(externalId, 'browse the music');
      if (parentId === null || parentId === undefined) {
        return slice(await root(externalId), offset, limit);
      }
      const media = decodeMediaId(parentId);
      if (!media || media.sid === null) {
        throw new Error(`Unknown catalog entry "${parentId}"`);
      }
      const heos = requireHeos(externalId, 'browse the music');
      if (media.kind === 'source') {
        // The top level of a source comes whole (no paging there).
        const page = await browsePage(heos, media.sid, null);
        return slice(mediaItems(page.items, media.sid), offset, limit);
      }
      if (!media.cid) {
        throw new Error(`"${media.name || parentId}" cannot be opened`);
      }
      const page = await browsePage(heos, media.sid, media.cid, offset, limit);
      const items = mediaItems(page.items, media.sid, { cid: media.cid });
      // HEOS' count is 0 when unknown: a full page says there may be more.
      const total =
        page.count > 0
          ? page.count
          : offset + page.items.length + (page.items.length >= limit ? 1 : 0);
      return { items, total };
    },

    async search(device, { query, type = null, limit = 20 }) {
      const externalId = device.external_id;
      const heos = requireHeos(externalId, 'search the music services');
      // The search budget bounds every HEOS request of the search, on every
      // service (./deadline.js): past it, the search answers what it has.
      return runWithDeadline(timing.musicSearchBudgetMs, async () => {
        let targets;
        try {
          targets = await searchTargets(externalId, heos);
        } catch (err) {
          if (err instanceof DeadlineError) {
            throw new Error(
              'HEOS did not answer the search in time (Gladys waits 10 s): try again',
              { cause: err },
            );
          }
          throw err;
        }
        if (targets.length === 0) {
          throw new Error('No signed-in HEOS music service can search on this receiver');
        }
        const several = targets.length > 1;
        const latestArtist = parseLatestAlbumQuery(query);
        const text = latestArtist ?? String(query ?? '').trim();
        const kinds = latestArtist ? ['album'] : type ? (SEARCH_KINDS[type] ?? []) : ALL_KINDS;
        const lang = /\balbum\s+(?:de|d['’]|du|des)\b/i.test(query) ? 'fr' : 'en';
        const steps = targets.length * kinds.length;
        const perStep = steps > 1 ? Math.max(3, Math.ceil(limit / steps)) : limit;
        const items = [];
        const failures = [];
        let stopped = false;
        let latestOffered = false;
        for (const source of targets) {
          if (stopped) {
            break;
          }
          const service = several ? source.name : '';
          await runWithDeadline(
            Infinity,
            async () => {
              let criteria;
              try {
                criteria = await searchCriteriaOrNone(externalId, heos, source.sid);
              } catch (err) {
                failures.push({ source, err });
                stopped = true;
                return;
              }
              // "Latest album of X": the first service that can search albums.
              if (latestArtist && !latestOffered && criteriaOf(criteria, 'album')) {
                items.push(
                  latestAlbumMediaItem(source.sid, latestArtist, lang, service, source.name),
                );
                latestOffered = true;
              }
              for (const kind of kinds) {
                if (!criteriaOf(criteria, kind)) {
                  continue;
                }
                if (timeLeft() <= 0) {
                  stopped = true;
                  return;
                }
                try {
                  const found = await searchKind(externalId, heos, source.sid, kind, text, {
                    limit: perStep,
                  });
                  const media = mediaItems(found.items, source.sid, {
                    trackCid: found.trackCid,
                    service,
                  });
                  for (const entry of media) {
                    items.push(entry);
                    // An artist matching the query also offers its latest album.
                    if (
                      kind === 'artist' &&
                      entry.type === MUSIC_MEDIA_TYPES.ARTIST &&
                      fold(entry.title) === fold(text) &&
                      criteriaOf(criteria, 'album')
                    ) {
                      items.push(
                        latestAlbumMediaItem(source.sid, entry.title, 'both', service, source.name),
                      );
                    }
                  }
                } catch (err) {
                  failures.push({ source, err });
                  logger.warn(
                    `${externalId}: ${source.name} ${kind} search "${text}" failed: ${err.message}`,
                  );
                  if (err instanceof DeadlineError) {
                    stopped = true;
                    return;
                  }
                }
              }
            },
            source.name,
          );
        }
        const found = items.filter(Boolean);
        if (stopped) {
          logger.info(
            `${externalId}: search "${text}" cut short after ${timing.musicSearchBudgetMs} ms`,
          );
        }
        // Nothing found because a service failed: say so, never "no result".
        if (found.length === 0 && failures.length > 0) {
          const { source, err } = failures[0];
          throw new Error(
            err instanceof DeadlineError
              ? `${source.name} did not answer the search "${text}" in time (Gladys waits 10 s): try again`
              : `${source.name} could not search "${text}": ${err.message}`,
          );
        }
        return { items: found.slice(0, limit) };
      });
    },

    async play(device, media, mode = 'replace') {
      const externalId = device.external_id;
      const decoded = decodeMediaId(media?.id);
      if (!decoded) {
        throw new Error(`Unknown media "${media?.id}"`);
      }
      const heos = requireHeos(externalId, 'play music');
      const { kind, sid, cid, mid, name } = decoded;
      let play;
      if (kind === 'queue') {
        play = () => heos.request(buildPlayQueueCommand(heos.pid, mid));
      } else if (kind === 'input' && mid) {
        play = () => playInput(heos, mid, sid);
      } else if (sid === null) {
        throw new Error(`"${name || media.id}" has no HEOS source`);
      } else if (kind === 'latest') {
        const latest = await resolveLatestAlbum(externalId, heos, sid, decoded.artist, {
          label: name || `HEOS ${sid}`,
        });
        logger.info(
          `${externalId}: latest album of "${decoded.artist}": "${latest.album.name}" (${latest.method})`,
        );
        play = () => queueContainer(heos, sid, latest.album.cid, mode);
      } else if (kind === 'artist') {
        const plan = await resolveArtist(externalId, heos, sid, name, {
          artist: cid ? { cid, name, playable: false, container: true } : null,
        });
        logger.info(`${externalId}: artist "${plan.name}" played by ${plan.method}`);
        play = () => playArtistPlan(heos, sid, plan, mode);
      } else if (kind === 'station' && mid) {
        play = () => playStation(heos, sid, cid, mid, name);
      } else if (kind === 'track' && mid) {
        play = () => queueTrack(heos, sid, cid ?? '', mid, mode);
      } else if (kind === 'container' && cid) {
        play = () => queueContainer(heos, sid, cid, mode);
      } else {
        throw new Error(`"${name || media.id}" cannot be played`);
      }
      // Only when enough time is left to switch the zone on and play: a
      // command Gladys already gave up on never starts the music.
      assertTimeLeft(timing.musicActReserveMs, 'before playing');
      await ensureZoneReadyForHeos(externalId, normalizeZone(getConfig().zone));
      await play();
    },

    async queueGet(device, { offset = 0, limit = 50 }) {
      const externalId = device.external_id;
      const heos = requireHeos(externalId, 'read the queue');
      const all = [];
      for (let start = 0; all.length < MAX_QUEUE; start += QUEUE_PAGE) {
        const answer = await heos.request(
          buildGetQueueCommand(heos.pid, [start, start + QUEUE_PAGE - 1]),
        );
        const page = Array.isArray(answer.payload) ? answer.payload : [];
        all.push(...page);
        if (page.length < QUEUE_PAGE) {
          break;
        }
      }
      let currentIndex = null;
      try {
        const now = await heos.request(buildGetNowPlayingMediaCommand(heos.pid));
        const qid = now.payload?.qid;
        if (qid !== undefined && qid !== null) {
          const index = all.findIndex((entry) => String(entry?.qid) === String(qid));
          currentIndex = index === -1 ? null : index;
        }
      } catch (err) {
        logger.debug(`${externalId}: no now playing for the queue: ${err.message}`);
      }
      const items = all.slice(offset, offset + limit).map((entry, i) => {
        const [item] = browseItems([{ ...entry, name: entry?.song, container: 'no' }]);
        const media = {
          id: encodeMediaId({
            kind: 'queue',
            mid: String(entry?.qid ?? offset + i + 1),
            name: item.name,
          }),
          type: MUSIC_MEDIA_TYPES.TRACK,
          title: item.name || '?',
          browsable: false,
          playable: true,
        };
        const subtitle = [item.artist, item.album].filter(Boolean).join(' · ');
        if (subtitle) {
          media.subtitle = subtitle;
        }
        if (/^https?:\/\//i.test(item.imageUrl)) {
          media.artwork_key = artworkKey(item.imageUrl);
        }
        return media;
      });
      return { items, currentIndex, total: all.length };
    },

    async queuePlay(device, index) {
      const externalId = device.external_id;
      const heos = requireHeos(externalId, 'play from the queue');
      const position = Number(index);
      if (!Number.isInteger(position) || position < 0) {
        throw new Error(`Invalid queue index ${index}`);
      }
      const answer = await heos.request(buildGetQueueCommand(heos.pid, [position, position]));
      const qid = Array.isArray(answer.payload) ? answer.payload[0]?.qid : undefined;
      if (qid === undefined || qid === null) {
        throw new Error(`The queue has no item ${position + 1}`);
      }
      assertTimeLeft(timing.musicActReserveMs, 'before playing');
      await heos.request(buildPlayQueueCommand(heos.pid, qid));
    },

    // The artwork bytes behind a key (now playing, catalog thumbnails): the
    // URL HEOS gave (a service's image CDN, e.g. Qobuz's), downloaded and
    // checked like the widget's cover — an image above 300 KB or not a
    // PNG/JPEG/WebP is refused here with a log line, the frame stays empty.
    async getArtwork(key) {
      const url = gladys.artworkUrls?.get(key);
      if (!url) {
        throw new Error(`Unknown artwork ${key}`);
      }
      const prepared = await artworks.prepare(url);
      const image = prepared ? artworks.get(prepared) : undefined;
      if (!image) {
        throw new Error(`Artwork ${key} left out: see the "Artwork left out" log line`);
      }
      return image;
    },
  };
  // Every command under the music deadline (./deadline.js): Gladys waits
  // 10 s, the module stops by 8 s and says why.
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (...args) => runWithDeadline(timing.musicDeadlineMs, () => handler(...args), 'HEOS'),
    ]),
  );
}

/** Register the music handlers on the SDK (before connect()). */
export function registerMusic(gladys, getConfig) {
  const handlers = createMusicHandlers(gladys, getConfig);
  gladys.onMusicBrowse(handlers.browse);
  gladys.onMusicSearch(handlers.search);
  gladys.onMusicPlay(handlers.play);
  gladys.onMusicQueueGet(handlers.queueGet);
  gladys.onMusicQueuePlay(handlers.queuePlay);
  gladys.onMusicGetArtwork(handlers.getArtwork);
}

// The now-playing states published as the music features of the device.
const NOW_PLAYING_KEYS = new Set([
  STATE.NOW_PLAYING_TITLE,
  STATE.NOW_PLAYING_ARTIST,
  STATE.NOW_PLAYING_ALBUM,
  STATE.NOW_PLAYING_IMAGE_URL,
]);

/** The feature external ids publishNowPlaying writes for one device. */
export function nowPlayingFeatureIds(externalId) {
  return {
    title: featureExternalId(externalId, FEATURE.MUSIC_TITLE),
    artist: featureExternalId(externalId, FEATURE.MUSIC_ARTIST),
    album: featureExternalId(externalId, FEATURE.MUSIC_ALBUM),
    artwork: featureExternalId(externalId, FEATURE.MUSIC_ARTWORK),
  };
}

/**
 * Publish the title, artist, album and artwork of every receiver as its
 * music features whenever they change (the Telnet NSE lines and HEOS'
 * get_now_playing_media both feed them). One batch per change burst; the
 * SDK diffs against what it published. Returns the stop function.
 */
// Publish again the now playing of one receiver (startNowPlaying()'s
// scheduler; nothing until it runs).
let refreshNowPlaying = () => {};

/**
 * Publish the current now playing of one receiver again: after Discovery
 * "Update" or a creation, the SDK forgot what it published and the new
 * music features would stay empty until the next track.
 */
export function republishNowPlaying(externalId) {
  refreshNowPlaying(externalId);
}

export function startNowPlaying(gladys, getState) {
  const timers = new Map();
  const publish = (externalId) => {
    timers.delete(externalId);
    const state = getState(externalId);
    const imageUrl = state[STATE.NOW_PLAYING_IMAGE_URL] ?? '';
    gladys
      .publishNowPlaying(
        externalId,
        {
          title: state[STATE.NOW_PLAYING_TITLE] ?? '',
          artist: state[STATE.NOW_PLAYING_ARTIST] ?? '',
          album: state[STATE.NOW_PLAYING_ALBUM] ?? '',
          artwork_url: imageUrl || null,
        },
        { featureExternalIds: nowPlayingFeatureIds(externalId) },
      )
      .catch((err) => logger.error(`publishNowPlaying failed for ${externalId}: ${err.message}`));
  };
  const schedule = (externalId) => {
    if (!timers.has(externalId)) {
      timers.set(
        externalId,
        setTimeout(() => publish(externalId), timing.nowPlayingBatchMs),
      );
    }
  };
  const unsubscribe = onDeviceStateChange((externalId, key) => {
    if (NOW_PLAYING_KEYS.has(key)) {
      schedule(externalId);
    }
  });
  refreshNowPlaying = schedule;
  return () => {
    refreshNowPlaying = () => {};
    unsubscribe();
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };
}
