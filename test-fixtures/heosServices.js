// -----------------------------------------------------------------------------
// The other HEOS sources of the fake receiver (test-fixtures/qobuzReceiver.js):
// TIDAL, Deezer, TuneIn, Spotify, Amazon (signed out), Local Music with two
// media servers, the AUX inputs of two players, History.
//
// Real captures where they exist, quoted as is:
// - TIDAL search criteria (pyheos fixture `browse.get_search_criteria`),
//   TIDAL album/track ids (`LIBALBUM-<album_id>`, pyheos fixtures);
// - Deezer first level, search criteria (no Playlist), artist search
//   "radiohead" and track search "creep" (gaelsimon/neos-audio samples).
// Assumed (no capture): the TIDAL tree under "My Music", TuneIn's "Station"
// criteria and its "Local Radio" container, the Local Music servers and the
// AUX players (shaped on the CLI spec 1.17 "Browse Source" examples).
// -----------------------------------------------------------------------------

export const TIDAL = 10;
export const DEEZER = 5;
export const TUNEIN = 3;
export const USB_SERVER = 1588621200;
export const NAS_SERVER = -1204873652;
export const OTHER_PLAYER = 77;

const container = (cid, name, extra = {}) => ({
  container: 'yes',
  playable: 'no',
  type: 'container',
  name,
  image_url: '',
  cid,
  ...extra,
});

/** The entries of get_music_sources besides Qobuz and Favorites. */
export function otherSources(account) {
  return [
    {
      name: 'Spotify',
      image_url: 'https://production.ws.skyegloup.com:443/media/images/service/logos/spotify.png',
      type: 'music_service',
      sid: 4,
      available: 'true',
      service_username: account,
    },
    {
      name: 'Deezer',
      image_url: 'https://production.ws.skyegloup.com:443/media/images/service/logos/deezer.png',
      type: 'music_service',
      sid: DEEZER,
      available: 'true',
      service_username: account,
    },
    {
      name: 'Tidal',
      image_url: 'https://production.ws.skyegloup.com:443/media/images/service/logos/tidal.png',
      type: 'music_service',
      sid: TIDAL,
      available: 'true',
      service_username: account,
    },
    { name: 'Amazon', type: 'music_service', sid: 13, available: 'false' },
    { name: 'Local Music', type: 'heos_server', sid: 1024, available: 'true' },
    { name: 'Playlists', type: 'heos_service', sid: 1025, available: 'true' },
    { name: 'History', type: 'heos_service', sid: 1026, available: 'true' },
    { name: 'AUX Input', type: 'heos_service', sid: 1027, available: 'true' },
  ];
}

const page = (params, payload) => [
  {
    payload,
    message: `sid=${params.sid}${params.cid ? `&cid=${encodeURIComponent(params.cid)}` : ''}&returned=${payload.length}&count=${payload.length}`,
  },
];

/** The browse answers of the other sources, or undefined for Qobuz and the HEOS lists. */
export function otherBrowse(params, pid) {
  const sid = Number(params.sid);
  if (sid === DEEZER && !params.cid) {
    // Real capture (neos-audio), Deezer's first level.
    return page(
      params,
      [
        'Flow',
        'Deezer Picks',
        "What's Hot",
        'Radio Channels',
        'Recommendations',
        'My Playlists',
        'My Albums',
        'Favorite Artists',
      ].map((name) => container(name, name)),
    );
  }
  if (sid === DEEZER && params.cid === 'My Playlists') {
    return page(params, [
      {
        container: 'yes',
        type: 'playlist',
        cid: 'Playlists-9081',
        playable: 'yes',
        name: 'Running',
        image_url: 'http://api.deezer.com/2.0/playlist/9081/image',
      },
    ]);
  }
  if (sid === TIDAL && !params.cid) {
    return page(params, [container('NEW', "What's New"), container('MYMUSIC', 'My Music')]);
  }
  if (sid === TIDAL && params.cid === 'MYMUSIC') {
    return page(params, [container('LIBPLAYLISTS', 'Playlists'), container('LIBALBUMS', 'Albums')]);
  }
  if (sid === TIDAL && params.cid === 'LIBPLAYLISTS') {
    return page(params, [
      {
        container: 'yes',
        type: 'playlist',
        cid: 'LIBPLAYLIST-5f1a',
        playable: 'yes',
        name: 'Workout',
        image_url: '',
      },
    ]);
  }
  if (sid === TIDAL && params.cid?.startsWith('LIBARTIST-')) {
    return page(params, []);
  }
  if (sid === TUNEIN && !params.cid) {
    return page(params, [container('LOCAL', 'Local Radio'), container('MUSIC', 'Music')]);
  }
  if (sid === TUNEIN && params.cid === 'LOCAL') {
    return page(params, [
      {
        container: 'no',
        mid: 's6566',
        type: 'station',
        playable: 'yes',
        name: 'FIP',
        image_url: 'http://cdn-radiotime-logos.tunein.com/s6566q.png',
      },
    ]);
  }
  if (sid === 1024) {
    return page(params, [
      { name: 'AVR-S970H USB', image_url: '', sid: USB_SERVER, type: 'heos_server' },
      { name: 'Synology', image_url: '', sid: NAS_SERVER, type: 'dlna_server' },
    ]);
  }
  if (sid === USB_SERVER && !params.cid) {
    return page(params, [container('USB-MUSIC', 'Music')]);
  }
  if (sid === 1027) {
    return page(params, [
      { name: 'Salon', image_url: '', sid: pid, type: 'heos_service' },
      { name: 'Cuisine', image_url: '', sid: OTHER_PLAYER, type: 'heos_service' },
    ]);
  }
  if (sid === pid || sid === OTHER_PLAYER) {
    return page(params, [
      {
        container: 'no',
        mid: 'inputs/aux_in_1',
        type: 'station',
        playable: 'yes',
        name: 'AUX In',
        image_url: '',
      },
      {
        container: 'no',
        mid: 'inputs/optical_in_1',
        type: 'station',
        playable: 'yes',
        name: 'Optical In',
        image_url: '',
      },
    ]);
  }
  if (sid === 1026 && !params.cid) {
    // Real capture (neos-audio), History's first level.
    return page(params, [
      {
        container: 'yes',
        playable: 'yes',
        type: 'container',
        name: 'TRACKS',
        image_uri: '',
        image_url: '',
        cid: 'TRACKS',
      },
      {
        container: 'yes',
        playable: 'no',
        type: 'container',
        name: 'STATIONS',
        image_uri: '',
        image_url: '',
        cid: 'STATIONS',
      },
    ]);
  }
  return undefined;
}

/** The search criteria of the other sources; undefined for Qobuz. */
export function otherCriteria(params) {
  const sid = Number(params.sid);
  if (sid === TIDAL) {
    // Real capture (pyheos fixture).
    return [
      {
        payload: [
          { name: 'Artist', scid: 1, wildcard: 'no' },
          { name: 'Album', scid: 2, wildcard: 'no' },
          { name: 'Track', scid: 3, wildcard: 'no', cid: 'SEARCHED_TRACKS-', playable: 'yes' },
          { name: 'Playlist', scid: 6, wildcard: 'no' },
        ],
        message: 'sid=10',
      },
    ];
  }
  if (sid === DEEZER) {
    // Real capture (neos-audio): no Playlist criteria.
    return [
      {
        payload: [
          { name: 'Artist', scid: 1, wildcard: 'no' },
          { name: 'Album', scid: 2, wildcard: 'no' },
          { name: 'Track', scid: 3, wildcard: 'no', cid: 'SEARCHED_TRACKS-', playable: 'yes' },
        ],
        message: 'sid=5',
      },
    ];
  }
  if (sid === TUNEIN) {
    return [{ payload: [{ name: 'Station', scid: 4, wildcard: 'no' }], message: 'sid=3' }];
  }
  if (sid === 30) {
    return undefined;
  }
  return [{ result: 'fail', message: `eid=1&text=Unrecognized command&sid=${sid}` }];
}

/** The search answers of the other sources; undefined for Qobuz. */
export function otherSearch(params) {
  const sid = Number(params.sid);
  if (sid === 30) {
    return undefined;
  }
  const text = String(params.search ?? '').toLowerCase();
  const reply = (payload) => [
    {
      payload,
      message: `sid=${sid}&search=${encodeURIComponent(params.search)}&scid=${params.scid}&returned=${payload.length}&count=${payload.length}`,
    },
  ];
  if (sid === DEEZER && params.scid === '1' && text.includes('radiohead')) {
    // Real capture (neos-audio).
    return reply([
      {
        container: 'yes',
        type: 'artist',
        cid: 'Artists-399',
        playable: 'no',
        name: 'Radiohead',
        image_url: 'http://api.deezer.com/2.0/artist/399/image?size=small',
      },
      {
        container: 'yes',
        type: 'artist',
        cid: 'Artists-1431492',
        playable: 'no',
        name: 'Gigamesh',
        image_url: 'http://api.deezer.com/2.0/artist/1431492/image?size=small',
      },
    ]);
  }
  if (sid === DEEZER && params.scid === '3' && text.includes('creep')) {
    // Real capture (neos-audio).
    return reply([
      {
        container: 'no',
        mid: '138547415',
        type: 'song',
        artist: 'Radiohead',
        album: 'Pablo Honey',
        album_id: '14880711',
        playable: 'yes',
        name: 'Creep',
        image_url: 'http://api.deezer.com/2.0/album/14880711/image?size=big',
      },
    ]);
  }
  if (sid === TIDAL && params.scid === '1' && /c[eé]line/.test(text)) {
    return reply([container('LIBARTIST-1234', 'Céline Dion', { type: 'artist' })]);
  }
  if (sid === TIDAL && params.scid === '2' && /c[eé]line|courage/.test(text)) {
    return reply([
      {
        container: 'yes',
        type: 'album',
        artist: 'Céline Dion',
        cid: 'LIBALBUM-120914587',
        playable: 'yes',
        name: 'Courage (Deluxe Edition)',
        image_url: 'http://resources.wimpmusic.com/images/a1/320x320.jpg',
      },
    ]);
  }
  if (sid === TUNEIN && params.scid === '4' && text.includes('fip')) {
    return reply([
      {
        container: 'no',
        mid: 's6566',
        type: 'station',
        playable: 'yes',
        name: 'FIP',
        image_url: 'http://cdn-radiotime-logos.tunein.com/s6566q.png',
      },
      {
        container: 'no',
        mid: 's15200',
        type: 'station',
        playable: 'yes',
        name: 'FIP Rock',
        image_url: '',
      },
    ]);
  }
  return reply([]);
}
