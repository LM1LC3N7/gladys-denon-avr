// -----------------------------------------------------------------------------
// Qobuz on one receiver, through its HEOS session: find the Qobuz source,
// list the user's playlists, search the catalog, play a playlist or an
// album. Every call goes through heos.request() (./heos-session.js): one
// command at a time, each awaited for its answer.
//
// Nothing here talks to Qobuz itself: the receiver does, with the Qobuz
// account signed in in the HEOS app. The integration only ever sees what
// HEOS shows (names, container ids) and never the user's Qobuz credentials.
// -----------------------------------------------------------------------------

import {
  buildAddContainerToQueueCommand,
  buildBrowseCommand,
  buildGetMusicSourcesCommand,
  buildGetSearchCriteriaCommand,
  buildSearchCommand,
} from '../heos/protocol.js';
import {
  browseItems,
  findQobuzSource,
  isPlayableContainer,
  isPlaylistsContainer,
  libraryContainers,
  pageInfo,
  pickByName,
  pickCriteria,
  sourceNames,
} from '../heos/qobuz.js';
import { ensureZoneReadyForHeos, requireHeos } from './control.js';
import { registerResetHook, timing } from './registry.js';

// A page of a browse: the CLI spec caps most services at 100 items.
const PAGE_SIZE = 50;
// The user's playlists read at most: enough for any real library, bounded
// so one scene never browses for minutes.
const MAX_PLAYLISTS = 200;
// Containers opened to find the playlists: the top level, then at most this
// many library-like containers, one level deep each.
const MAX_CONTAINERS = 4;

/** Qobuz is missing from HEOS, or signed out: `reason` is `missing` | `signed_out`. */
export class QobuzUnavailableError extends Error {
  constructor(reason, sources = []) {
    super(
      reason === 'signed_out'
        ? 'Qobuz is listed by HEOS but not signed in: sign in to Qobuz in the HEOS app'
        : `HEOS lists no Qobuz source (sources: ${sources.join(', ') || 'none'}): add Qobuz in the HEOS app (Music services)`,
    );
    this.name = 'QobuzUnavailableError';
    this.reason = reason;
    this.sources = sources;
  }
}

// Per receiver: { sid, at } and { playlists, at }. Dropped between tests.
const sourceCache = new Map();
const playlistCache = new Map();
registerResetHook(() => {
  sourceCache.clear();
  playlistCache.clear();
});

const fresh = (entry) => entry && Date.now() - entry.at < timing.qobuzCacheMs;

/**
 * The Qobuz source of one receiver: `{ sid, name, available, sources }`.
 * Throws QobuzUnavailableError when HEOS does not list it or it is signed out.
 */
export async function qobuzSource(externalId, { refresh = false } = {}) {
  const heos = requireHeos(externalId, 'use Qobuz');
  const cached = sourceCache.get(externalId);
  if (!refresh && fresh(cached)) {
    return cached.source;
  }
  const answer = await heos.request(buildGetMusicSourcesCommand());
  const source = findQobuzSource(answer.payload);
  const sources = sourceNames(answer.payload);
  if (!source) {
    throw new QobuzUnavailableError('missing', sources);
  }
  if (!source.available) {
    throw new QobuzUnavailableError('signed_out', sources);
  }
  const value = { ...source, sources };
  sourceCache.set(externalId, { source: value, at: Date.now() });
  return value;
}

/** Every item of one container (or the top level when `cid` is null), page by page, up to `max`. */
async function browseAll(heos, sid, cid, max) {
  const items = [];
  for (let start = 0; items.length < max; start += PAGE_SIZE) {
    const answer = await heos.request(
      buildBrowseCommand(sid, cid ?? undefined, cid ? [start, start + PAGE_SIZE - 1] : undefined),
    );
    const page = browseItems(answer.payload);
    items.push(...page);
    const { count } = pageInfo(answer.message);
    // The top level has no paging; a container stops on a short or last page.
    if (!cid || page.length === 0 || page.length < PAGE_SIZE || (count && items.length >= count)) {
      break;
    }
  }
  return items.slice(0, max);
}

/**
 * The user's Qobuz playlists, as HEOS shows them: `{ source, topLevel, playlists }`.
 * `topLevel` (the names of the first level) is for the diagnostics.
 */
export async function listQobuzPlaylists(externalId, { refresh = false } = {}) {
  const source = await qobuzSource(externalId, { refresh });
  const cached = playlistCache.get(externalId);
  if (!refresh && fresh(cached)) {
    return cached.value;
  }
  const heos = requireHeos(externalId, 'use Qobuz');
  const top = await browseAll(heos, source.sid, null, MAX_PLAYLISTS);
  const playlists = top.filter(isPlayableContainer).filter((item) => item.type === 'playlist');
  const opened = [];
  const queue = libraryContainers(top);
  while (queue.length > 0 && opened.length < MAX_CONTAINERS && playlists.length < MAX_PLAYLISTS) {
    const container = queue.shift();
    opened.push(container.name);
    const items = await browseAll(heos, source.sid, container.cid, MAX_PLAYLISTS);
    const found = items.filter(isPlayableContainer);
    // In a "playlists" container every playable container is a playlist;
    // elsewhere (a library, the favorites) only those typed so.
    playlists.push(
      ...(isPlaylistsContainer(container)
        ? found
        : found.filter((item) => item.type === 'playlist')),
    );
    // One level deeper: a "My Qobuz" holding a "Playlists" container.
    queue.push(...libraryContainers(items).filter((item) => !opened.includes(item.name)));
  }
  const unique = [...new Map(playlists.map((item) => [item.cid, item])).values()];
  const value = {
    source,
    topLevel: top.map((item) => item.name),
    opened,
    playlists: unique.slice(0, MAX_PLAYLISTS),
  };
  playlistCache.set(externalId, { value, at: Date.now() });
  return value;
}

/** Search the Qobuz catalog for a kind (`playlist`, `album`); the playable containers found. */
async function searchQobuz(externalId, source, kind, text) {
  const heos = requireHeos(externalId, 'use Qobuz');
  const criteria = await heos.request(buildGetSearchCriteriaCommand(source.sid));
  const scid = pickCriteria(criteria.payload, kind);
  if (scid === null) {
    return [];
  }
  const answer = await heos.request(buildSearchCommand(source.sid, scid, text, [0, 19]));
  return browseItems(answer.payload).filter(isPlayableContainer);
}

/**
 * Play a Qobuz playlist or album by name on the configured zone (switched on
 * and to HEOS first, as for a HEOS favorite), replacing the queue. A
 * playlist is looked up in the user's own playlists first, then in the
 * catalog; an album in the catalog. Resolves `{ played, artist }`, throws
 * when nothing matches.
 */
export async function playQobuz(externalId, { kind = 'playlist', name }, zone) {
  const wanted = String(name ?? '').trim();
  if (!wanted) {
    throw new Error('A playlist or album name is required');
  }
  if (kind !== 'playlist' && kind !== 'album') {
    throw new Error(`Unknown Qobuz kind "${kind}" (playlist or album)`);
  }
  const source = await qobuzSource(externalId);
  let item = null;
  if (kind === 'playlist') {
    item = pickByName((await listQobuzPlaylists(externalId)).playlists, wanted);
  }
  if (!item) {
    item = pickByName(await searchQobuz(externalId, source, kind, wanted), wanted);
  }
  if (!item) {
    throw new Error(`No Qobuz ${kind} named "${wanted}"`);
  }
  const heos = requireHeos(externalId, 'play from Qobuz');
  await ensureZoneReadyForHeos(externalId, zone);
  await heos.request(buildAddContainerToQueueCommand(heos.pid, source.sid, item.cid));
  return { played: item.name, artist: item.artist };
}
