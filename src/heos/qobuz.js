// -----------------------------------------------------------------------------
// Qobuz through HEOS — pure helpers (no socket, no state).
//
// Since HEOS 37.1 (summer 2025), Qobuz is a HEOS music service like TIDAL or
// Deezer: listed by browse/get_music_sources, browsed with browse/browse,
// searched with browse/search, played with browse/add_to_queue. Qobuz is not
// in the CLI specification (1.17, 2021) nor in pyheos: its source id 30 is
// only known from third-party captures, so the source is looked up by name
// first. Every name of the tree below it ("Library", "Playlists"…) is matched
// loosely, and no field HEOS might leave out is relied upon: these rules were
// written without a receiver showing Qobuz. The "Qobuz: check" button of the
// configuration (src/devices/actions.js) logs what a receiver really answers,
// to tighten them from a user report.
//
// Known quirk (Home Assistant core issue 150334, a Qobuz user): HEOS lists
// Qobuz playlists with `playable: no`, while add_to_queue accepts such a
// container. A playlist or an album is therefore queued whatever the flag.
// -----------------------------------------------------------------------------

// Qobuz's HEOS source id, as seen in captures (not in the CLI spec).
export const QOBUZ_SID = 30;

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
 * or Qobuz not added in the HEOS app). Found by name, else by its usual id
 * 30. `available` is false while no Qobuz account is signed in on the HEOS
 * account of the receiver.
 */
export function findQobuzSource(payload) {
  if (!Array.isArray(payload)) {
    return null;
  }
  const valid = payload.filter(
    (entry) => entry && entry.sid !== undefined && entry.sid !== null && entry.sid !== '',
  );
  const source =
    valid.find((entry) => /qobuz/i.test(String(entry.name ?? ''))) ??
    valid.find((entry) => Number(entry.sid) === QOBUZ_SID && !entry.name);
  if (!source) {
    return null;
  }
  return {
    sid: Number(source.sid),
    name: String(source.name ?? 'Qobuz'),
    available: source.available === undefined ? true : yes(source.available),
  };
}

/** The names of the sources of a get_music_sources payload (for the diagnostics). */
export function sourceNames(payload) {
  return Array.isArray(payload) ? payload.map((entry) => String(entry?.name ?? '?')) : [];
}

/**
 * The sources for the diagnostics log: name, sid, type, available. Never
 * `service_username` (the account name of the user).
 */
export function sourceSummaries(payload) {
  return Array.isArray(payload)
    ? payload.map((entry) => ({
        name: String(entry?.name ?? '?'),
        sid: entry?.sid ?? null,
        type: String(entry?.type ?? ''),
        available: entry?.available ?? null,
      }))
    : [];
}

/** The account names of a get_music_sources payload: what the diagnostics must never print. */
export function accountNames(payload) {
  return Array.isArray(payload)
    ? payload.map((entry) => String(entry?.service_username ?? '').trim()).filter(Boolean)
    : [];
}

// Fields some services may carry with a release date or year (none is in
// the CLI spec: looked at, never required).
const DATE_FIELDS = ['release_date', 'released_at', 'release_year', 'year', 'date'];
const YEAR_IN_NAME = /[([](\d{4})[)\]]/;

/** The release year of a raw browse/search item, or null (a date field, else "(2023)" in the name). */
export function yearOf(raw) {
  const plausible = (year) => (year >= 1900 && year <= 2100 ? year : null);
  for (const field of DATE_FIELDS) {
    const match = /(\d{4})/.exec(String(raw?.[field] ?? ''));
    if (match) {
      const year = plausible(Number(match[1]));
      if (year) {
        return year;
      }
    }
  }
  const match = YEAR_IN_NAME.exec(String(raw?.name ?? ''));
  return match ? plausible(Number(match[1])) : null;
}

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());
const idOrNull = (value) =>
  value === undefined || value === null || value === '' ? null : String(value);

/**
 * The items of a browse/search payload, normalized: `{ name, sid, cid, mid,
 * type, container, playable, artist, album, albumId, imageUrl, year }`.
 */
export function browseItems(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      name: text(item.name),
      // A sub-source (a media server under Local Music, a player under AUX
      // inputs) carries its own source id instead of a container id.
      sid: idOrNull(item.sid),
      cid: idOrNull(item.cid),
      mid: idOrNull(item.mid),
      type: text(item.type).toLowerCase(),
      container: yes(item.container),
      playable: yes(item.playable),
      artist: text(item.artist),
      album: text(item.album),
      albumId: idOrNull(item.album_id),
      imageUrl: text(item.image_url),
      year: yearOf(item),
    }));
}

/**
 * A container that can be put in the queue as a whole: a playable one, or a
 * playlist or an album whatever its `playable` flag (the Qobuz quirk above).
 */
export const isQueueableContainer = (item) =>
  item.container &&
  item.cid !== null &&
  (item.playable || item.type === 'playlist' || item.type === 'album');

/** A track that can be put in the queue (`mid`, not a container). */
export const isTrack = (item) =>
  !item.container && item.mid !== null && (item.type === 'song' || item.type === 'track');

/** An input (AUX, optical…) played with play_input: its media id is `inputs/…`. */
export const isInput = (item) => !item.container && /^inputs\//.test(item.mid ?? '');

/** A station played with play_stream. */
export const isStation = (item) =>
  !item.container && item.mid !== null && item.type === 'station' && !isInput(item);

/** An album container. */
export const isAlbum = (item) => item.type === 'album' && item.cid !== null;

// Containers of a service's top level that hold the user's own playlists,
// in the order they are tried: a "playlists" container first, then the
// library-like ones it may sit in ("Library", "My Qobuz", the favorites).
// English and French names, as HEOS shows the service in the language of
// the app.
const PLAYLIST_CONTAINER = /\bplaylists?\b/;
const LIBRARY_CONTAINER =
  /\b(my qobuz|mon qobuz|library|bibliotheque|favorites?|favoris?|my music|ma musique)\b/;

/** A container named like a list of playlists ("Playlists", "My Playlists", "Mes playlists"). */
export const isPlaylistsContainer = (item) => PLAYLIST_CONTAINER.test(fold(item.name));

/**
 * The containers of a level worth opening to find the user's playlists,
 * best first. A playlist or an album is never opened as a folder, even
 * when HEOS calls it not playable.
 */
export function libraryContainers(items) {
  const containers = items.filter(
    (item) =>
      item.container &&
      !item.playable &&
      item.cid !== null &&
      item.type !== 'playlist' &&
      item.type !== 'album',
  );
  const playlists = containers.filter((item) => PLAYLIST_CONTAINER.test(fold(item.name)));
  const libraries = containers.filter(
    (item) => !playlists.includes(item) && LIBRARY_CONTAINER.test(fold(item.name)),
  );
  return [...playlists, ...libraries];
}

/** Whether `item` is by `artist` (folded, either containing the other); true when no artist is wanted. */
export function byArtist(item, artist) {
  const wanted = fold(artist);
  if (!wanted) {
    return true;
  }
  const actual = fold(item.artist);
  return actual !== '' && (actual.includes(wanted) || wanted.includes(actual));
}

/**
 * The best match of `name` among `items`: same name first (accents, case
 * and punctuation ignored), then a name starting with it, then one
 * containing it. With `artist`, only the items by that artist count (when
 * HEOS names an artist at all). Null when nothing matches.
 */
export function pickByName(items, name, artist = '') {
  const wanted = fold(name);
  if (!wanted) {
    return null;
  }
  let pool = items;
  if (fold(artist)) {
    const named = items.filter((item) => item.artist);
    pool = named.length > 0 ? named.filter((item) => byArtist(item, artist)) : items;
  }
  return (
    pool.find((item) => fold(item.name) === wanted) ??
    pool.find((item) => fold(item.name).startsWith(wanted)) ??
    pool.find((item) => fold(item.name).includes(wanted)) ??
    null
  );
}

// What each kind searches for, by criteria name (get_search_criteria
// answers `Artist`, `Album`, `Track`, `Playlist`… for the other services;
// the name is matched, never a fixed scid).
const CRITERIA = {
  playlist: /\bplaylists?\b/,
  album: /\balbums?\b/,
  artist: /\b(artists?|artistes?)\b/,
  track: /\b(tracks?|songs?|titres?|morceaux|morceau)\b/,
  station: /\b(stations?|radios?)\b/,
};

/** The criteria of a kind: `{ scid, name, cid, playable }`, or null when the service has none. */
export function criteriaOf(payload, kind) {
  const pattern = CRITERIA[kind];
  if (!pattern || !Array.isArray(payload)) {
    return null;
  }
  const criteria = payload.find((entry) => pattern.test(fold(entry?.name)));
  if (!criteria || criteria.scid === undefined || criteria.scid === null) {
    return null;
  }
  return {
    scid: Number(criteria.scid),
    name: String(criteria.name),
    cid: idOrNull(criteria.cid),
    playable: yes(criteria.playable),
  };
}

/** The `scid` of the search criteria for a kind, or null. */
export function pickCriteria(payload, kind) {
  return criteriaOf(payload, kind)?.scid ?? null;
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

/** The options of an answer (`[{ browse: [{ id, name }] }]`), flat: `[{ context, id, name }]`. */
export function parseOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }
  const flat = [];
  for (const group of options) {
    if (!group || typeof group !== 'object') {
      continue;
    }
    for (const [context, list] of Object.entries(group)) {
      for (const option of Array.isArray(list) ? list : []) {
        const id = Number(option?.id);
        if (Number.isInteger(id)) {
          flat.push({ context, id, name: text(option?.name) });
        }
      }
    }
  }
  return flat;
}

// "Create New Station" (CLI spec, set_service_option).
export const OPTION_CREATE_STATION = 13;

// Children of an artist container, by name (English and French).
const LATEST_CONTAINER =
  /\b(latest|newest|new releases?|last release|derniere sortie|dernieres sorties|nouveautes?|nouvelle sortie)\b/;
const ALBUMS_CONTAINER = /\b(albums?|discography|discographie)\b/;
const RADIO_CONTAINER = /\bradios?\b/;
const TOP_CONTAINER =
  /\b(top|popular|populaires?|best|meilleurs?|incontournables|essentials?|essentiels|hits|tracks|titres|morceaux)\b/;

/** The child of an artist container named like its latest release, or null. */
export const findLatestContainer = (items) =>
  items.find((item) => item.container && LATEST_CONTAINER.test(fold(item.name))) ?? null;

/** The child of an artist container holding its albums, or null. */
export const findAlbumsContainer = (items) =>
  items.find(
    (item) => item.container && !isAlbum(item) && ALBUMS_CONTAINER.test(fold(item.name)),
  ) ?? null;

/** The radio of an artist: a station or a container named "radio", or null. */
export const findRadio = (items) =>
  items.find(
    (item) => (isStation(item) || item.container) && RADIO_CONTAINER.test(fold(item.name)),
  ) ?? null;

/** The "top tracks" of an artist: a container named so, or null. */
export const findTopTracks = (items) =>
  items.find(
    (item) =>
      item.container && !isAlbum(item) && item.cid !== null && TOP_CONTAINER.test(fold(item.name)),
  ) ?? null;

/**
 * The latest of some albums: the most recent year when HEOS gives one (in a
 * field or the name), else the first one listed. `{ album, method }`, null
 * when there is no album. HEOS documents no date and no order: the first
 * listed is an assumption (Qobuz lists a discography newest first).
 */
export function pickLatestAlbum(albums) {
  const list = albums.filter(isAlbum);
  if (list.length === 0) {
    return null;
  }
  const dated = list.filter((album) => album.year !== null);
  if (dated.length > 0) {
    const latest = dated.reduce((best, album) => (album.year > best.year ? album : best));
    return { album: latest, method: 'year' };
  }
  return { album: list[0], method: 'first_listed' };
}

const LATEST_QUERY =
  /^\s*(?:(?:joue|jouer|lance|lancer|mets|play)\s+)?(?:le\s+|l['’]\s*|the\s+|son\s+|leur\s+)?(?:tout\s+)?(?:dernier|derniere|nouvel|nouveau|plus\s+recent|latest|newest|last|new)\s+album\s+(?:de\s+la\s+|de\s+l['’]\s*|de\s+|d['’]\s*|du\s+|des\s+|by\s+|of\s+|from\s+)(.+?)\s*[.!?]?\s*$/i;

/**
 * The artist of a "latest album" request ("dernier album de Céline Dion",
 * "latest album by Muse"), or null for any other text.
 */
export function parseLatestAlbumQuery(query) {
  const match = LATEST_QUERY.exec(
    String(query ?? '')
      .normalize('NFC')
      .replace(/ernière/gi, 'erniere')
      .replace(/récent/gi, 'recent'),
  );
  return match ? match[1].trim() || null : null;
}

/**
 * One item for the diagnostics log: what HEOS sent, without any URL (only
 * whether there is one), without nested values, every account name hidden.
 */
export function describeItem(raw, hidden = []) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === 'image_url' || key === 'image_uri') {
      out[key] = value ? '(set)' : '';
    } else if (key === 'service_username') {
      out[key] = '(hidden)';
    } else if (value !== null && typeof value === 'object') {
      // Nothing nested is printed: it could hold anything.
      out[key] = Array.isArray(value) ? '(list)' : '(object)';
    } else if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) {
      // Any URL (a stream, a link): only that there is one.
      out[key] = '(url)';
    } else {
      out[key] = redact(typeof value === 'string' ? value.slice(0, 80) : value, hidden);
    }
  }
  return out;
}

/** `value` with every account name of `hidden` replaced (strings only). */
export function redact(value, hidden = []) {
  if (typeof value !== 'string') {
    return value;
  }
  let out = value;
  for (const name of hidden) {
    if (name) {
      out = out.split(name).join('(account)');
    }
  }
  return out;
}
