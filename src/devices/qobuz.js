// -----------------------------------------------------------------------------
// Qobuz — and every other HEOS music service (TIDAL, Deezer, Amazon,
// TuneIn…) — on one receiver, through its HEOS session: find the service,
// list the user's playlists, search the catalog, and play a playlist, an
// album, the latest album of an artist, an artist (radio or popular tracks),
// a track or a radio station. Every call goes through heos.request() (./heos-session.js):
// one command at a time, each awaited for its answer.
//
// Nothing here talks to Qobuz itself: the receiver does, with the Qobuz
// account signed in in the HEOS app. The integration only ever sees what
// HEOS shows (names, container ids) and never the user's Qobuz credentials.
//
// What HEOS shows of Qobuz is not documented (see src/heos/qobuz.js): every
// lookup is tolerant, says which rule found what (`method`), and fails with
// a plain "not found" rather than guessing wildly.
// -----------------------------------------------------------------------------

import {
  aidOfMode,
  buildAddContainerToQueueCommand,
  buildAddTrackToQueueCommand,
  buildBrowseCommand,
  buildCreateStationCommand,
  buildGetMusicSourcesCommand,
  buildGetSearchCriteriaCommand,
  buildPlayInputCommand,
  buildPlayStationCommand,
  buildSearchCommand,
} from '../heos/protocol.js';
import { findService, isSpotify, serviceLabel, sourceList } from '../heos/services.js';
import {
  OPTION_CREATE_STATION,
  accountNames,
  browseItems,
  byArtist,
  criteriaOf,
  findAlbumsContainer,
  findLatestContainer,
  findRadio,
  findTopTracks,
  fold,
  isAlbum,
  isPlaylistsContainer,
  isQueueableContainer,
  isStation,
  isTrack,
  libraryContainers,
  pageInfo,
  parseOptions,
  pickByName,
  pickLatestAlbum,
} from '../heos/qobuz.js';
import { ensureZoneReadyForHeos, requireHeos } from './control.js';
import { registerResetHook, timing } from './registry.js';
import { DeadlineError, assertTimeLeft } from './deadline.js';

// A page of a browse: the CLI spec caps most services at 50 or 100 items.
const PAGE_SIZE = 50;
// The user's playlists read at most: enough for any real library, bounded
// so one scene never browses for minutes.
const MAX_PLAYLISTS = 200;
// Containers opened to find the playlists: the top level, then at most this
// many library-like containers, one level deep each.
const MAX_CONTAINERS = 4;
// Search results read per request, and the children of an artist read.
const SEARCH_PAGE = 20;
const ARTIST_CHILDREN = 50;
// HEOS caps a search text at 128 characters.
const MAX_SEARCH_TEXT = 128;
// The container of searched tracks when the criteria names none (CLI spec).
const SEARCHED_TRACKS = 'SEARCHED_TRACKS-';

export const QOBUZ_KINDS = Object.freeze(['playlist', 'album', 'latest_album', 'artist', 'track']);
// What a generic service can play (a TuneIn radio by name, for one).
export const SERVICE_KINDS = Object.freeze([...QOBUZ_KINDS, 'radio']);

/**
 * A service is missing from HEOS, or signed out: `reason` is `missing` |
 * `signed_out`, `service` its label, `sources` the names HEOS lists.
 */
export class ServiceUnavailableError extends Error {
  constructor(reason, sources = [], service = 'Qobuz') {
    super(
      reason === 'signed_out'
        ? `${service} is listed by HEOS but not signed in: sign in to ${service} in the HEOS app`
        : `HEOS lists no ${service} source (sources: ${sources.join(', ') || 'none'}): add ${service} in the HEOS app (Music services)`,
    );
    this.name = 'ServiceUnavailableError';
    this.reason = reason;
    this.sources = sources;
    this.service = service;
  }
}
// The name of 1.2.x, kept for the callers that test for it.
export const QobuzUnavailableError = ServiceUnavailableError;

/** Nothing matched in a service: the message says what was looked for. */
export class QobuzNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QobuzNotFoundError';
  }
}

// Per receiver: the source, the playlists, the search criteria and the
// top-level options (per source id), each `{ value, at }`. Dropped between tests.
const sourceCache = new Map();
const playlistCache = new Map();
const criteriaCache = new Map();
const topLevelCache = new Map();
registerResetHook(() => {
  sourceCache.clear();
  playlistCache.clear();
  criteriaCache.clear();
  topLevelCache.clear();
});

const fresh = (entry) => entry && Date.now() - entry.at < timing.qobuzCacheMs;

async function cached(cache, key, refresh, load) {
  const entry = cache.get(key);
  if (!refresh && fresh(entry)) {
    return entry.value;
  }
  const value = await load();
  cache.set(key, { value, at: Date.now() });
  return value;
}

/**
 * Every source HEOS lists on one receiver (cached): `{ list, names, hidden }`
 * — `list` normalized (../heos/services.js), `names` for the messages,
 * `hidden` the account names HEOS lists, never to be logged.
 */
export async function heosSources(externalId, { refresh = false } = {}) {
  const heos = requireHeos(externalId, 'use the HEOS music services');
  return cached(sourceCache, externalId, refresh, async () => {
    const answer = await heos.request(buildGetMusicSourcesCommand());
    return {
      list: sourceList(answer.payload),
      names: Array.isArray(answer.payload)
        ? answer.payload.map((entry) => String(entry?.name ?? '?'))
        : [],
      hidden: accountNames(answer.payload),
    };
  });
}

/**
 * The source of a service (`qobuz`, `tidal`… or a name) on one receiver:
 * `{ sid, name, available, sources, hidden, label }`. Throws
 * ServiceUnavailableError when HEOS does not list it or it is signed out.
 */
export async function serviceSource(externalId, service, { refresh = false } = {}) {
  const label = serviceLabel(service);
  requireHeos(externalId, `use ${label}`);
  const { list, names, hidden } = await heosSources(externalId, { refresh });
  const source = findService(list, service);
  if (!source) {
    throw new ServiceUnavailableError('missing', names, label);
  }
  if (isSpotify(source)) {
    throw new Error(
      'Spotify is Spotify Connect only in HEOS: start it from the Spotify app, it cannot be browsed nor searched',
    );
  }
  if (!source.available) {
    throw new ServiceUnavailableError('signed_out', names, label);
  }
  return { ...source, name: source.name || label, label, sources: names, hidden };
}

/** The Qobuz source of one receiver (see serviceSource()). */
export function qobuzSource(externalId, options) {
  return serviceSource(externalId, 'qobuz', options);
}

/**
 * One page of a container (`cid`) or of a source's top level (no `cid`, no
 * range: HEOS pages the top level of the favorites only).
 * `{ items, count, options, raw }`, `count` 0 when HEOS does not know it.
 */
export async function browsePage(heos, sid, cid, offset = 0, limit = PAGE_SIZE) {
  const answer = await heos.request(
    buildBrowseCommand(sid, cid ?? undefined, cid ? [offset, offset + limit - 1] : undefined),
  );
  return {
    items: browseItems(answer.payload),
    count: pageInfo(answer.message).count,
    options: parseOptions(answer.options),
    raw: Array.isArray(answer.payload) ? answer.payload : [],
  };
}

/** Every item of one container (or the top level when `cid` is null), page by page, up to `max`. */
export async function browseAll(heos, sid, cid, max) {
  const items = [];
  for (let start = 0; items.length < max; start += PAGE_SIZE) {
    const page = await browsePage(heos, sid, cid, start, PAGE_SIZE);
    items.push(...page.items);
    // The top level has no paging; a container stops on a short or last page.
    if (
      !cid ||
      page.items.length === 0 ||
      page.items.length < PAGE_SIZE ||
      (page.count && items.length >= page.count)
    ) {
      break;
    }
  }
  return items.slice(0, max);
}

/** The top level of a source and its options (cached): `{ items, options }`. */
export async function topLevel(externalId, heos, sid, { refresh = false } = {}) {
  return cached(topLevelCache, `${externalId}|${sid}`, refresh, async () => {
    const page = await browsePage(heos, sid, null);
    return { items: page.items, options: page.options };
  });
}

/**
 * The user's playlists of a service, as HEOS shows them: `{ source, topLevel, opened, playlists }`.
 * `topLevel` (the names of the first level) is for the diagnostics.
 */
export async function listServicePlaylists(externalId, service, { refresh = false } = {}) {
  const source = await serviceSource(externalId, service, { refresh });
  const key = `${externalId}|${source.sid}`;
  const entry = playlistCache.get(key);
  if (!refresh && fresh(entry)) {
    return entry.value;
  }
  const heos = requireHeos(externalId, `use ${source.label}`);
  const top = (await topLevel(externalId, heos, source.sid, { refresh })).items;
  const playlists = top.filter(isQueueableContainer).filter((item) => item.type === 'playlist');
  const opened = [];
  const queue = libraryContainers(top);
  while (queue.length > 0 && opened.length < MAX_CONTAINERS && playlists.length < MAX_PLAYLISTS) {
    const container = queue.shift();
    opened.push(container.name);
    const items = await browseAll(heos, source.sid, container.cid, MAX_PLAYLISTS);
    const found = items.filter(isQueueableContainer);
    // In a "playlists" container every queueable container is a playlist
    // (HEOS may type it "container"); elsewhere (a library, the favorites)
    // only those typed so.
    playlists.push(
      ...(isPlaylistsContainer(container)
        ? found.filter((item) => item.type !== 'album')
        : found.filter((item) => item.type === 'playlist')),
    );
    // One level deeper: a "Library" holding a "Playlists" container.
    queue.push(...libraryContainers(items).filter((item) => !opened.includes(item.name)));
  }
  const unique = [...new Map(playlists.map((item) => [item.cid, item])).values()];
  const value = {
    source,
    topLevel: top.map((item) => item.name),
    opened,
    playlists: unique.slice(0, MAX_PLAYLISTS),
  };
  playlistCache.set(key, { value, at: Date.now() });
  return value;
}

/** The user's Qobuz playlists (see listServicePlaylists()). */
export function listQobuzPlaylists(externalId, options) {
  return listServicePlaylists(externalId, 'qobuz', options);
}

/**
 * The search criteria of a source, or none when HEOS refuses (a service
 * that cannot search). A deadline passed is thrown, never taken for "none".
 */
export async function searchCriteriaOrNone(externalId, heos, sid) {
  try {
    return await searchCriteria(externalId, heos, sid);
  } catch (err) {
    if (err instanceof DeadlineError) {
      throw err;
    }
    return [];
  }
}

/** The raw search criteria of a source (cached). */
export async function searchCriteria(externalId, heos, sid, { refresh = false } = {}) {
  return cached(criteriaCache, `${externalId}|${sid}`, refresh, async () => {
    const answer = await heos.request(buildGetSearchCriteriaCommand(sid));
    return Array.isArray(answer.payload) ? answer.payload : [];
  });
}

const searchText = (value) =>
  String(value ?? '')
    .trim()
    .slice(0, MAX_SEARCH_TEXT);

/**
 * Search a source for a kind (`playlist`, `album`, `artist`, `track`,
 * `station`): `{ criteria, text, items }`, `items` empty when the service
 * has no such criteria. `trackCid` is the container a found track is queued
 * with.
 */
export async function searchKind(externalId, heos, sid, kind, value, { limit = SEARCH_PAGE } = {}) {
  const text = searchText(value);
  const criteria = criteriaOf(await searchCriteria(externalId, heos, sid), kind);
  if (!criteria || !text) {
    return { criteria, text, items: [], trackCid: null };
  }
  const answer = await heos.request(buildSearchCommand(sid, criteria.scid, text, [0, limit - 1]));
  return {
    criteria,
    text,
    items: browseItems(answer.payload),
    trackCid: `${criteria.cid ?? SEARCHED_TRACKS}${text}`,
  };
}

/** The artist container best matching `name` (an Artist search), or null. */
export async function findArtist(externalId, heos, sid, name) {
  const { items } = await searchKind(externalId, heos, sid, 'artist', name);
  const artists = items.filter((item) => item.container && item.cid !== null);
  const typed = artists.filter((item) => item.type === 'artist');
  return pickByName(typed.length > 0 ? typed : artists, name);
}

/** The children of an artist container (an empty list when HEOS refuses to open it). */
async function artistChildren(heos, sid, artist) {
  try {
    return await browseAll(heos, sid, artist.cid, ARTIST_CHILDREN);
  } catch (err) {
    if (err instanceof DeadlineError) {
      throw err;
    }
    return [];
  }
}

/**
 * The latest album of an artist: `{ album, artist, method }`, or throws
 * QobuzNotFoundError. See pickLatestAlbum() for what "latest" can mean.
 */
export async function resolveLatestAlbum(
  externalId,
  heos,
  sid,
  artistName,
  { label = 'Qobuz' } = {},
) {
  const wanted = String(artistName ?? '').trim();
  if (!wanted) {
    throw new Error('An artist name is required');
  }
  const artist = await findArtist(externalId, heos, sid, wanted);
  if (artist) {
    const children = await artistChildren(heos, sid, artist);
    const latest = findLatestContainer(children);
    if (latest) {
      if (isAlbum(latest)) {
        return { album: latest, artist: artist.name, method: 'latest_container' };
      }
      const inside = (await browseAll(heos, sid, latest.cid, PAGE_SIZE)).filter(isAlbum);
      if (inside.length > 0) {
        return { album: inside[0], artist: artist.name, method: 'latest_container' };
      }
    }
    let albums = children.filter(isAlbum);
    if (albums.length === 0) {
      const container = findAlbumsContainer(children);
      if (container) {
        albums = (await browseAll(heos, sid, container.cid, ARTIST_CHILDREN)).filter(isAlbum);
      }
    }
    const picked = pickLatestAlbum(albums);
    if (picked) {
      return { album: picked.album, artist: artist.name, method: picked.method };
    }
  }
  // No artist container, or nothing in it: the albums found by the artist's name.
  const { items } = await searchKind(externalId, heos, sid, 'album', wanted);
  const picked = pickLatestAlbum(items.filter((item) => isAlbum(item) && byArtist(item, wanted)));
  if (picked) {
    return {
      album: picked.album,
      artist: picked.album.artist || artist?.name || wanted,
      method: picked.method === 'year' ? 'album_search_year' : 'album_search',
    };
  }
  throw new QobuzNotFoundError(`No ${label} album found for the artist "${wanted}"`);
}

/**
 * How to play an artist: `{ play, method, name }` where `play` is
 * `{ station: item }` or `{ cid }`. Tries, in order: a "radio" child of the
 * artist, a "top tracks" child, the artist container itself when playable,
 * a station created by HEOS (option 13, only when the source offers it),
 * every track found by the artist's name. Throws QobuzNotFoundError.
 */
export async function resolveArtist(externalId, heos, sid, artistName, { artist = null } = {}) {
  const wanted = String(artistName ?? '').trim();
  if (!wanted) {
    throw new Error('An artist name is required');
  }
  const found = artist ?? (await findArtist(externalId, heos, sid, wanted));
  const name = found?.name || wanted;
  if (found) {
    const children = await artistChildren(heos, sid, found);
    const radio = findRadio(children);
    if (radio && isStation(radio)) {
      return { play: { station: radio }, method: 'artist_radio', name };
    }
    if (radio?.cid) {
      return { play: { cid: radio.cid }, method: 'artist_radio', name };
    }
    const top = findTopTracks(children);
    if (top) {
      return { play: { cid: top.cid }, method: 'top_tracks', name };
    }
    if (found.playable) {
      return { play: { cid: found.cid }, method: 'artist', name };
    }
  }
  const { options } = await topLevel(externalId, heos, sid).catch((err) => {
    if (err instanceof DeadlineError) {
      throw err;
    }
    return { options: [] };
  });
  const artistCriteria = criteriaOf(await searchCriteria(externalId, heos, sid), 'artist');
  if (artistCriteria && options.some((option) => option.id === OPTION_CREATE_STATION)) {
    try {
      const answer = await heos.request(buildCreateStationCommand(sid, artistCriteria.scid, name));
      const station = browseItems(answer.payload).find(isStation);
      if (station) {
        return { play: { station }, method: 'created_station', name };
      }
    } catch (err) {
      if (err instanceof DeadlineError) {
        throw err;
      }
      // Not offered after all: the searched tracks below.
    }
  }
  const tracks = criteriaOf(await searchCriteriaOrNone(externalId, heos, sid), 'track');
  if (tracks?.playable) {
    return {
      play: { cid: `${tracks.cid ?? SEARCHED_TRACKS}${searchText(name)}` },
      method: 'searched_tracks',
      name,
    };
  }
  throw new QobuzNotFoundError(
    `No way to play the artist "${wanted}" through HEOS (no radio, no popular tracks, no track search)`,
  );
}

/** Put a container in the queue (`aid` from the mode). */
export function queueContainer(heos, sid, cid, mode) {
  return heos.request(buildAddContainerToQueueCommand(heos.pid, sid, cid, aidOfMode(mode)));
}

/** Put a track in the queue (`cid`: the container it was browsed or searched in). */
export function queueTrack(heos, sid, cid, mid, mode) {
  return heos.request(buildAddTrackToQueueCommand(heos.pid, sid, cid, mid, aidOfMode(mode)));
}

/** Play a station (HEOS cannot queue one: it plays now, whatever the mode). */
export function playStation(heos, sid, cid, mid, name) {
  return heos.request(buildPlayStationCommand(heos.pid, sid, cid, mid, name));
}

/** Play an input (`inputs/…`) of the player `spid` (an AUX entry). */
export function playInput(heos, input, spid) {
  return heos.request(buildPlayInputCommand(heos.pid, input, spid));
}

/** Play what resolveArtist() found. */
export function playArtistPlan(heos, sid, plan, mode) {
  return plan.play.station
    ? playStation(heos, sid, null, plan.play.station.mid, plan.play.station.name)
    : queueContainer(heos, sid, plan.play.cid, mode);
}

/** Search an album or a track by name, the artist narrowing it down (then joined to the search). */
async function findByName(externalId, heos, sid, kind, name, artist) {
  const accept = kind === 'track' ? isTrack : isQueueableContainer;
  let result = await searchKind(externalId, heos, sid, kind, name);
  let item = pickByName(result.items.filter(accept), name, artist);
  if (!item && fold(artist)) {
    result = await searchKind(externalId, heos, sid, kind, `${artist} ${name}`);
    item = pickByName(result.items.filter(accept), name, artist);
  }
  return { item, trackCid: result.trackCid };
}

/**
 * Play from a HEOS music service (`service`: `qobuz`, `tidal`… or a name) on
 * the configured zone (switched on and to HEOS first, as for a HEOS
 * favorite). `kind`:
 * - `playlist`: by name, the user's own first, then the catalog;
 * - `album`: by name, `artist` narrowing it down;
 * - `latest_album`: the latest album of the artist named `name`;
 * - `artist`: the artist named `name`, its radio or popular tracks;
 * - `track`: by name, `artist` narrowing it down;
 * - `radio`: a station by name (TuneIn, iHeartRadio…).
 * `mode` `replace` (default), `next` or `append` (a station always plays now).
 * Resolves `{ played, artist, type, method, service }`; throws when nothing matches.
 */
export async function playFromService(
  externalId,
  { service = 'qobuz', kind = 'playlist', name, artist = '', mode = 'replace' },
  zone,
) {
  const wanted = String(name ?? '').trim();
  if (!wanted) {
    throw new Error('A name is required (playlist, album, artist, track or radio)');
  }
  if (!SERVICE_KINDS.includes(kind)) {
    throw new Error(`Unknown kind "${kind}" (${SERVICE_KINDS.join(', ')})`);
  }
  const source = await serviceSource(externalId, service);
  const { sid, label } = source;
  const heos = requireHeos(externalId, `play from ${label}`);
  let play;
  let result;
  if (kind === 'latest_album') {
    const latest = await resolveLatestAlbum(externalId, heos, sid, wanted, { label });
    play = () => queueContainer(heos, sid, latest.album.cid, mode);
    result = {
      played: latest.album.name,
      artist: latest.album.artist || latest.artist,
      type: 'album',
      method: latest.method,
    };
  } else if (kind === 'artist') {
    const plan = await resolveArtist(externalId, heos, sid, wanted);
    play = () => playArtistPlan(heos, sid, plan, mode);
    result = { played: plan.name, artist: plan.name, type: 'artist', method: plan.method };
  } else if (kind === 'radio') {
    const { items } = await searchKind(externalId, heos, sid, 'station', wanted);
    const station = pickByName(items.filter(isStation), wanted);
    if (!station) {
      throw new QobuzNotFoundError(`No ${label} radio named "${wanted}"`);
    }
    play = () => playStation(heos, sid, null, station.mid, station.name);
    result = { played: station.name, artist: '', type: 'radio', method: 'search' };
  } else if (kind === 'playlist') {
    let item = pickByName((await listServicePlaylists(externalId, service)).playlists, wanted);
    let method = 'library';
    if (!item) {
      const { items } = await searchKind(externalId, heos, sid, 'playlist', wanted);
      item = pickByName(items.filter(isQueueableContainer), wanted);
      method = 'search';
    }
    if (!item) {
      throw new QobuzNotFoundError(`No ${label} playlist named "${wanted}"`);
    }
    play = () => queueContainer(heos, sid, item.cid, mode);
    result = { played: item.name, artist: item.artist, type: 'playlist', method };
  } else {
    const { item, trackCid } = await findByName(externalId, heos, sid, kind, wanted, artist);
    if (!item) {
      throw new QobuzNotFoundError(
        `No ${label} ${kind} named "${wanted}"${fold(artist) ? ` by "${artist}"` : ''}`,
      );
    }
    play =
      kind === 'track'
        ? () => queueTrack(heos, sid, trackCid, item.mid, mode)
        : () => queueContainer(heos, sid, item.cid, mode);
    result = { played: item.name, artist: item.artist, type: kind, method: 'search' };
  }
  // A Gladys music command past its deadline never starts the music (a
  // scene action has no deadline: no-op there).
  assertTimeLeft(timing.musicActReserveMs, 'before playing');
  await ensureZoneReadyForHeos(externalId, zone);
  await play();
  return { ...result, service: source.name };
}

/**
 * Play from Qobuz (the 1.2 scene action): playFromService() on Qobuz, the
 * radio kind excepted. Resolves `{ played, artist, type, method }`.
 */
export async function playQobuz(externalId, fields, zone) {
  if (!QOBUZ_KINDS.includes(fields?.kind ?? 'playlist')) {
    throw new Error(`Unknown Qobuz kind "${fields.kind}" (${QOBUZ_KINDS.join(', ')})`);
  }
  const result = await playFromService(externalId, { ...fields, service: 'qobuz' }, zone);
  delete result.service;
  return result;
}
