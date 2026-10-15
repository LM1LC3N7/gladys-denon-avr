// -----------------------------------------------------------------------------
// Qobuz through HEOS — pure helpers (no socket, no state).
//
// Since the HEOS app added Qobuz natively (summer 2025), Qobuz is a HEOS
// music service like TIDAL or Deezer: listed by browse/get_music_sources,
// browsed with browse/browse, searched with browse/search, played with
// browse/add_to_queue. Unlike the older services, Qobuz has no source id in
// the CLI specification nor in pyheos (the library behind Home Assistant's
// HEOS integration): it is looked up by name, and every name of the tree
// below it (the "My Qobuz" / playlists containers) is matched loosely, since
// it was built without a receiver showing it. The "Qobuz: check" button of
// the configuration (src/devices/actions.js) prints what a receiver really
// answers, to tighten these rules from a user report.
// -----------------------------------------------------------------------------

const yes = (value) => value === 'yes' || value === true || value === 'true';

/** Lowercase, accents and punctuation dropped, spaces collapsed: what names are compared on. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The Qobuz entry of a get_music_sources payload: `{ sid, name, available }`,
 * or null when the receiver lists no Qobuz at all (HEOS firmware without it,
 * or Qobuz not added in the HEOS app). `available` is false while no Qobuz
 * account is signed in on the HEOS account of the receiver.
 */
export function findQobuzSource(payload) {
  if (!Array.isArray(payload)) {
    return null;
  }
  const source = payload.find((entry) => /qobuz/i.test(String(entry?.name ?? '')));
  if (!source || source.sid === undefined || source.sid === null) {
    return null;
  }
  return {
    sid: Number(source.sid),
    name: String(source.name),
    available: source.available === undefined ? true : yes(source.available),
  };
}

/** The names of the sources of a get_music_sources payload (for the diagnostics). */
export function sourceNames(payload) {
  return Array.isArray(payload) ? payload.map((entry) => String(entry?.name ?? '?')) : [];
}

/** The items of a browse/search payload, normalized: `{ name, cid, mid, type, container, playable, artist }`. */
export function browseItems(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      name: String(item.name ?? '').trim(),
      cid: item.cid === undefined || item.cid === null ? null : String(item.cid),
      mid: item.mid === undefined || item.mid === null ? null : String(item.mid),
      type: String(item.type ?? ''),
      container: yes(item.container),
      playable: yes(item.playable),
      artist: String(item.artist ?? '').trim(),
    }));
}

/** A container that can be put in the queue as a whole (a playlist, an album). */
export const isPlayableContainer = (item) => item.container && item.playable && item.cid !== null;

// Containers of a service's top level that hold the user's own playlists,
// in the order they are tried: a "playlists" container first, then the
// library-like ones it may sit in ("My Qobuz", "Ma bibliothèque", the
// favorites). English and French names, as HEOS shows the service in the
// language of the app.
const PLAYLIST_CONTAINER = /\bplaylists?\b/;
const LIBRARY_CONTAINER =
  /\b(my qobuz|mon qobuz|library|bibliotheque|favorites?|favoris?|my music|ma musique)\b/;

/** A container named like a list of playlists ("Playlists", "My Playlists", "Mes playlists"). */
export const isPlaylistsContainer = (item) => PLAYLIST_CONTAINER.test(fold(item.name));

/** The containers of a level worth opening to find the user's playlists, best first. */
export function libraryContainers(items) {
  const containers = items.filter((item) => item.container && !item.playable && item.cid !== null);
  const playlists = containers.filter((item) => PLAYLIST_CONTAINER.test(fold(item.name)));
  const libraries = containers.filter(
    (item) => !playlists.includes(item) && LIBRARY_CONTAINER.test(fold(item.name)),
  );
  return [...playlists, ...libraries];
}

/**
 * The best match of `name` among `items`: same name first (accents, case
 * and punctuation ignored), then a name starting with it, then one
 * containing it. Null when nothing matches.
 */
export function pickByName(items, name) {
  const wanted = fold(name);
  if (!wanted) {
    return null;
  }
  return (
    items.find((item) => fold(item.name) === wanted) ??
    items.find((item) => fold(item.name).startsWith(wanted)) ??
    items.find((item) => fold(item.name).includes(wanted)) ??
    null
  );
}

// What each kind of the scene action searches for, by criteria name
// (get_search_criteria answers `Artist`, `Album`, `Track`, `Playlist`… for
// the other services; the name is matched, never a fixed scid).
const CRITERIA = {
  playlist: /\bplaylists?\b/,
  album: /\balbums?\b/,
};

/** The `scid` of the search criteria for a kind (`playlist`, `album`), or null. */
export function pickCriteria(payload, kind) {
  const pattern = CRITERIA[kind];
  if (!pattern || !Array.isArray(payload)) {
    return null;
  }
  const criteria = payload.find((entry) => pattern.test(fold(entry?.name)));
  return criteria?.scid === undefined ? null : Number(criteria.scid);
}

/** `returned` and `count` of a browse/search answer (paging), 0 when absent. */
export function pageInfo(message) {
  const returned = Number(message?.returned);
  const count = Number(message?.count);
  return {
    returned: Number.isFinite(returned) ? returned : 0,
    count: Number.isFinite(count) ? count : 0,
  };
}
