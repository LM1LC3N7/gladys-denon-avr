// -----------------------------------------------------------------------------
// The receiver as a Gladys music player (Gladys >= 5.3.0, manifest `music`,
// capabilities/music.md of the core): the catalog (HEOS favorites, HEOS
// playlists, Qobuz), the search (Qobuz), play with the replace / next /
// append modes, the queue, and the now playing (title, artist, album,
// artwork) published with the SDK's publishNowPlaying.
//
// Gladys awaits every music command under 10 s, at most 4 in flight per
// integration: a search over several kinds stops starting new HEOS searches
// once SEARCH_BUDGET_MS is spent, and answers with what it has.
// -----------------------------------------------------------------------------

import { MUSIC_MEDIA_TYPES, createLogger } from '@gladysassistant/integration-sdk';
import {
  HEOS_SOURCE,
  buildGetNowPlayingMediaCommand,
  buildGetQueueCommand,
  buildPlayQueueCommand,
} from '../heos/protocol.js';
import { browseItems, fold, parseLatestAlbumQuery } from '../heos/qobuz.js';
import { decodeMediaId, encodeMediaId, latestAlbumMediaItem, toMediaItem } from '../heos/media.js';
import { normalizeZone } from '../denon/protocol.js';
import { FEATURE, STATE, featureExternalId } from './features.js';
import { ensureZoneReadyForHeos, requireHeos } from './control.js';
import { onDeviceStateChange, timing } from './registry.js';
import {
  browsePage,
  playArtistPlan,
  playStation,
  qobuzSource,
  queueContainer,
  queueTrack,
  resolveArtist,
  resolveLatestAlbum,
  searchKind,
} from './qobuz.js';

const logger = createLogger({ name: 'music' });

// A search over every kind stops starting new HEOS searches after this.
const SEARCH_BUDGET_MS = 6_000;
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
export function createMusicHandlers(gladys, getConfig) {
  const artworkKey = (url) => gladys.artworkKey(url);
  const mediaItems = (items, sid, cid) =>
    items.map((item) => toMediaItem(item, sid, { cid, artworkKey })).filter(Boolean);

  async function root(externalId) {
    const items = [
      folder(encodeMediaId({ kind: 'source', sid: HEOS_SOURCE.FAVORITES }), 'HEOS Favorites'),
      folder(encodeMediaId({ kind: 'source', sid: HEOS_SOURCE.PLAYLISTS }), 'HEOS Playlists'),
    ];
    try {
      const source = await qobuzSource(externalId);
      items.push(folder(encodeMediaId({ kind: 'source', sid: source.sid }), source.name));
    } catch (err) {
      // No Qobuz on this receiver: the HEOS lists only.
      logger.debug(`${externalId}: no Qobuz in the catalog: ${err.message}`);
    }
    return items;
  }

  return {
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
        return slice(mediaItems(page.items, media.sid, null), offset, limit);
      }
      if (!media.cid) {
        throw new Error(`"${media.name || parentId}" cannot be opened`);
      }
      const page = await browsePage(heos, media.sid, media.cid, offset, limit);
      const items = mediaItems(page.items, media.sid, media.cid);
      // HEOS' count is 0 when unknown: a full page says there may be more.
      const total =
        page.count > 0
          ? page.count
          : offset + page.items.length + (page.items.length >= limit ? 1 : 0);
      return { items, total };
    },

    async search(device, { query, type = null, limit = 20 }) {
      const externalId = device.external_id;
      const source = await qobuzSource(externalId);
      const heos = requireHeos(externalId, 'search Qobuz');
      const latestArtist = parseLatestAlbumQuery(query);
      const text = latestArtist ?? String(query ?? '').trim();
      const kinds = latestArtist ? ['album'] : type ? (SEARCH_KINDS[type] ?? []) : ALL_KINDS;
      const items = [];
      if (latestArtist) {
        const lang = /\balbum\s+(?:de|d['’]|du|des)\b/i.test(query) ? 'fr' : 'en';
        items.push(latestAlbumMediaItem(source.sid, latestArtist, lang));
      }
      const perKind = kinds.length > 1 ? Math.max(3, Math.ceil(limit / kinds.length)) : limit;
      const startedAt = Date.now();
      for (const kind of kinds) {
        if (Date.now() - startedAt > SEARCH_BUDGET_MS) {
          logger.info(`${externalId}: Qobuz search "${text}" cut short before ${kind}`);
          break;
        }
        try {
          const found = await searchKind(externalId, heos, source.sid, kind, text, {
            limit: perKind,
          });
          for (const media of mediaItems(found.items, source.sid, found.trackCid)) {
            items.push(media);
            // An artist matching the query also offers its latest album.
            if (
              kind === 'artist' &&
              media.type === MUSIC_MEDIA_TYPES.ARTIST &&
              fold(media.title) === fold(text)
            ) {
              items.push(latestAlbumMediaItem(source.sid, media.title));
            }
          }
        } catch (err) {
          logger.warn(`${externalId}: Qobuz ${kind} search "${text}" failed: ${err.message}`);
        }
      }
      return { items: items.filter(Boolean).slice(0, limit) };
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
      } else if (sid === null) {
        throw new Error(`"${name || media.id}" has no HEOS source`);
      } else if (kind === 'latest') {
        const latest = await resolveLatestAlbum(externalId, heos, sid, decoded.artist);
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
      await heos.request(buildPlayQueueCommand(heos.pid, qid));
    },
  };
}

/** Register the music handlers on the SDK (before connect()). */
export function registerMusic(gladys, getConfig) {
  const handlers = createMusicHandlers(gladys, getConfig);
  gladys.onMusicBrowse(handlers.browse);
  gladys.onMusicSearch(handlers.search);
  gladys.onMusicPlay(handlers.play);
  gladys.onMusicQueueGet(handlers.queueGet);
  gladys.onMusicQueuePlay(handlers.queuePlay);
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
  const unsubscribe = onDeviceStateChange((externalId, key) => {
    if (NOW_PLAYING_KEYS.has(key) && !timers.has(externalId)) {
      timers.set(
        externalId,
        setTimeout(() => publish(externalId), timing.nowPlayingBatchMs),
      );
    }
  });
  return () => {
    unsubscribe();
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };
}
