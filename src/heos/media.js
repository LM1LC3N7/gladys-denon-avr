// -----------------------------------------------------------------------------
// The Gladys music player's media ids and MediaItems for HEOS — pure helpers.
//
// A MediaItem `id` is opaque to Gladys (≤ 512 characters) and comes back in
// a play command, a browse of its children, or a `music.play-media` scene
// action saved for months: it carries everything needed to replay it with
// no lookup — the HEOS source id, container id, media id and name — as a
// `heos:` URL query string. Two kinds are the module's own, resolved when
// played: `latest` (the latest album of an artist, so a scene keeps playing
// the newest one) and `artist` (an artist's radio or popular tracks).
// -----------------------------------------------------------------------------

import { MUSIC_MEDIA_TYPES } from '@gladysassistant/integration-sdk';
import { isQueueableContainer, isStation, isTrack } from './qobuz.js';

const PREFIX = 'heos:';
const MAX_ID_LENGTH = 512;
const MAX_NAME_IN_ID = 100;

// The root entries of the catalog.
export const ROOT = Object.freeze({
  FAVORITES: 'root:favorites',
  PLAYLISTS: 'root:playlists',
});

/**
 * Encode a media: `{ kind, sid, cid, mid, name, artist }` → `heos:k=…&s=…`.
 * Null when it would not fit in 512 characters (the item is left out).
 */
export function encodeMediaId({ kind, sid, cid, mid, name, artist }) {
  const params = new URLSearchParams();
  params.set('k', kind);
  if (sid !== undefined && sid !== null) {
    params.set('s', String(sid));
  }
  if (cid) {
    params.set('c', cid);
  }
  if (mid) {
    params.set('m', mid);
  }
  if (name) {
    params.set('n', String(name).slice(0, MAX_NAME_IN_ID));
  }
  if (artist) {
    params.set('a', String(artist).slice(0, MAX_NAME_IN_ID));
  }
  const id = PREFIX + params.toString();
  return id.length <= MAX_ID_LENGTH ? id : null;
}

/** Decode a media id of encodeMediaId(), or null when it is not one. */
export function decodeMediaId(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) {
    return null;
  }
  const params = new URLSearchParams(id.slice(PREFIX.length));
  const kind = params.get('k');
  if (!kind) {
    return null;
  }
  const sid = params.get('s');
  return {
    kind,
    sid: sid === null || sid === '' || !Number.isFinite(Number(sid)) ? null : Number(sid),
    cid: params.get('c') || null,
    mid: params.get('m') || null,
    name: params.get('n') || '',
    artist: params.get('a') || '',
  };
}

// HEOS item types → Gladys media types.
const TYPE = {
  song: MUSIC_MEDIA_TYPES.TRACK,
  track: MUSIC_MEDIA_TYPES.TRACK,
  album: MUSIC_MEDIA_TYPES.ALBUM,
  artist: MUSIC_MEDIA_TYPES.ARTIST,
  playlist: MUSIC_MEDIA_TYPES.PLAYLIST,
  station: MUSIC_MEDIA_TYPES.RADIO,
};

/**
 * A normalized HEOS item (browseItems() of ./qobuz.js) as a Gladys
 * MediaItem, or null when it can be neither browsed nor played.
 * `context.cid` is the container it was browsed or searched in (what a track
 * is queued with); `artworkKey(url)` the SDK's key of an image URL.
 */
export function toMediaItem(item, sid, { cid = null, artworkKey } = {}) {
  let kind;
  let type;
  let browsable = false;
  let playable;
  if (isTrack(item)) {
    kind = 'track';
    type = MUSIC_MEDIA_TYPES.TRACK;
    playable = true;
  } else if (isStation(item)) {
    kind = 'station';
    type = MUSIC_MEDIA_TYPES.RADIO;
    playable = true;
  } else if (item.container && item.cid !== null) {
    kind = item.type === 'artist' ? 'artist' : 'container';
    type = TYPE[item.type] ?? MUSIC_MEDIA_TYPES.FOLDER;
    browsable = true;
    // An artist plays as its radio or popular tracks (../devices/qobuz.js).
    playable = kind === 'artist' || isQueueableContainer(item);
  } else {
    return null;
  }
  const id = encodeMediaId({
    kind,
    sid,
    cid: kind === 'track' ? cid : item.cid,
    mid: kind === 'track' || kind === 'station' ? item.mid : null,
    name: item.name,
  });
  if (!id || !item.name) {
    return null;
  }
  const media = { id, type, title: item.name, browsable, playable };
  const subtitle = [item.artist, kind === 'track' ? item.album : ''].filter(Boolean).join(' · ');
  if (subtitle) {
    media.subtitle = subtitle;
  }
  if (artworkKey && /^https?:\/\//i.test(item.imageUrl)) {
    media.artwork_key = artworkKey(item.imageUrl);
  }
  return media;
}

const LATEST_TITLE = {
  fr: (artist) => `Dernier album de ${artist}`,
  en: (artist) => `Latest album by ${artist}`,
  both: (artist) => `Dernier album · Latest album : ${artist}`,
};

/** The "latest album of <artist>" entry, resolved when played; `lang` fr, en or both. */
export function latestAlbumMediaItem(sid, artist, lang = 'both') {
  const id = encodeMediaId({ kind: 'latest', sid, artist });
  if (!id || !String(artist ?? '').trim()) {
    return null;
  }
  return {
    id,
    type: MUSIC_MEDIA_TYPES.ALBUM,
    title: (LATEST_TITLE[lang] ?? LATEST_TITLE.both)(artist),
    subtitle: artist,
    browsable: false,
    playable: true,
  };
}
