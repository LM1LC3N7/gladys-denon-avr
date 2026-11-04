// -----------------------------------------------------------------------------
// The music sources HEOS lists (browse/get_music_sources) — pure helpers.
//
// The CLI spec gives fixed ids to the older services (Pandora 1, Rhapsody 2,
// TuneIn 3, Spotify 4, Deezer 5, Napster 6, iHeartRadio 7, SiriusXM 8,
// SoundCloud 9, TIDAL 10, Amazon 13) and to HEOS' own sources (Local Music
// 1024, Playlists 1025, History 1026, AUX inputs 1027, Favorites 1028);
// Qobuz (30) is only known from captures. A service is looked up by its name
// first, then by these ids: a renamed or unnamed entry still matches.
//
// Spotify is listed by HEOS but is Spotify Connect only (the spec: no
// browse, no search): played from the Spotify app, never from a catalog.
// -----------------------------------------------------------------------------

import { fold } from './qobuz.js';

// The services a scene action or the search setting can name, by key.
export const SERVICES = Object.freeze({
  qobuz: { label: 'Qobuz', pattern: /\bqobuz\b/, sids: [30] },
  tidal: { label: 'TIDAL', pattern: /\btidal\b/, sids: [10] },
  deezer: { label: 'Deezer', pattern: /\bdeezer\b/, sids: [5] },
  amazon: { label: 'Amazon Music', pattern: /\bamazon\b/, sids: [13] },
  soundcloud: { label: 'SoundCloud', pattern: /\bsoundcloud\b/, sids: [9] },
  napster: { label: 'Napster', pattern: /\b(napster|rhapsody)\b/, sids: [6, 2] },
  tunein: { label: 'TuneIn', pattern: /\btunein\b/, sids: [3] },
  iheartradio: { label: 'iHeartRadio', pattern: /\biheart(radio)?\b/, sids: [7] },
  pandora: { label: 'Pandora', pattern: /\bpandora\b/, sids: [1] },
  siriusxm: { label: 'SiriusXM', pattern: /\bsirius(xm)?\b/, sids: [8] },
});

// HEOS' own sources (CLI spec).
export const HEOS_SOURCES = Object.freeze({
  LOCAL: 1024,
  PLAYLISTS: 1025,
  HISTORY: 1026,
  AUX: 1027,
  FAVORITES: 1028,
});

// Listed by HEOS but with nothing to browse through the CLI: Spotify
// (Spotify Connect), QQMusic, and the "connect" pseudo source 0.
const NOT_BROWSABLE = new Set([0, 4, 18]);

const yes = (value) => value === 'yes' || value === true || value === 'true';

/**
 * The sources of a get_music_sources payload, normalized:
 * `{ sid, name, type, available }`, entries without a numeric sid dropped.
 * Never the account name (`service_username`).
 */
export function sourceList(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .filter((entry) => entry && entry.sid !== undefined && entry.sid !== null && entry.sid !== '')
    .filter((entry) => Number.isFinite(Number(entry.sid)))
    .map((entry) => ({
      sid: Number(entry.sid),
      name: String(entry.name ?? '').trim(),
      type: String(entry.type ?? ''),
      available: entry.available === undefined ? true : yes(entry.available),
    }));
}

/** Whether HEOS lets the CLI browse this source (Spotify, QQMusic: no). */
export const isBrowsable = (source) => !NOT_BROWSABLE.has(source.sid);

/** Whether this is Spotify (Spotify Connect only in HEOS). */
export const isSpotify = (source) => source.sid === 4 || /\bspotify\b/.test(fold(source.name));

/**
 * The source of a service key (`qobuz`, `tidal`…) or of a free name
 * ("Deezer", "TuneIn"), whatever its availability; null when HEOS lists none.
 * By name first; by the spec id only for an entry whose name names no
 * other known service.
 */
export function findService(list, key) {
  const service = SERVICES[String(key ?? '').toLowerCase()];
  if (service) {
    const byName = list.find((source) => service.pattern.test(fold(source.name)));
    if (byName) {
      return byName;
    }
    return (
      list.find(
        (source) =>
          service.sids.includes(source.sid) &&
          !Object.values(SERVICES).some((other) => other.pattern.test(fold(source.name))),
      ) ?? null
    );
  }
  const wanted = fold(key);
  if (!wanted) {
    return null;
  }
  return (
    list.find((source) => fold(source.name) === wanted) ??
    list.find((source) => fold(source.name).includes(wanted)) ??
    null
  );
}

/** The label of a service key, or the key itself. */
export const serviceLabel = (key) => SERVICES[key]?.label ?? String(key ?? '');

/**
 * The order the services are searched in when several are: Qobuz, TIDAL,
 * Deezer first (the catalogs a "latest album" is most likely looked up in),
 * then the others as HEOS lists them.
 */
export function searchOrder(list) {
  const first = ['qobuz', 'tidal', 'deezer'].map((key) => findService(list, key)).filter(Boolean);
  return [...first, ...list.filter((source) => !first.includes(source))];
}

/** The music services worth searching: signed in, browsable, not one of HEOS' own sources. */
export const searchableCandidates = (list) =>
  searchOrder(list).filter(
    (source) => source.available && isBrowsable(source) && source.sid < HEOS_SOURCES.LOCAL,
  );
