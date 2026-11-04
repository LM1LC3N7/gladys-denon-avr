// -----------------------------------------------------------------------------
// The HEOS answers of a receiver with Qobuz signed in, for test/qobuz.test.js
// and test/music-player.test.js. Shapes follow the HEOS CLI spec 1.17 and
// real captures of other services (pyheos fixtures for TIDAL, neos-audio
// captures for Deezer): `container`/`playable` as "yes"/"no", `type`
// artist/album/song/station/playlist/container, a track's `album_id`, a
// "command under process" placeholder before a slow browse. What is Qobuz
// specific is assumed (no real capture exists): source id 30 (seen in
// third-party captures), a "Library" > "Playlists" tree (a Home Assistant
// user's report), playlists listed with `playable: no` (Home Assistant core
// issue 150334), TIDAL-like search criteria.
// -----------------------------------------------------------------------------

import { FAKE_PID } from './fakeHeos.js';
import { otherBrowse, otherCriteria, otherSearch, otherSources } from './heosServices.js';

export const QOBUZ = 30;
export const ACCOUNT = 'louis.qobuz@example.fr';

const container = (cid, name, extra = {}) => ({
  container: 'yes',
  playable: 'no',
  type: 'container',
  name,
  image_url: '',
  cid,
  ...extra,
});
const playlist = (cid, name) => ({
  container: 'yes',
  playable: 'no', // the Qobuz quirk: a playlist HEOS calls not playable
  type: 'playlist',
  name,
  image_url: `https://static.qobuz.com/images/covers/${cid}_230.jpg`,
  cid,
});
const album = (cid, name, artist = 'Céline Dion', extra = {}) => ({
  container: 'yes',
  playable: 'yes',
  type: 'album',
  artist,
  name,
  image_url: `https://static.qobuz.com/images/covers/${cid}_230.jpg`,
  cid,
  ...extra,
});
const song = (mid, name, artist, albumName, albumId) => ({
  container: 'no',
  mid,
  type: 'song',
  artist,
  album: albumName,
  album_id: albumId,
  playable: 'yes',
  name,
  image_url: `https://static.qobuz.com/images/covers/${albumId}_230.jpg`,
});

export const CELINE = 'ARTIST-8216';
const ALBUMS = [
  album('ALB-2019', 'Courage'),
  album('ALB-2013', 'Loved Me Back to Life'),
  album('ALB-2007', 'Taking Chances'),
];

/**
 * What the artist container of Céline Dion holds, by `artist` variant:
 * - `albums` (default): "Top Tracks", "Albums" (newest first, no year), "Similar Artists";
 * - `latest`: a "Latest Release" container first, then the albums out of order;
 * - `years`: the albums directly, out of order, a year in their names;
 * - `radio`: an "Artist Radio" station first;
 * - `bare`: nothing (the albums only through the Album search);
 * - `none`: the Artist search finds nobody.
 */
function artistChildren(variant) {
  switch (variant) {
    case 'latest':
      return [
        container(`${CELINE}-LATEST`, 'Latest Release'),
        container(`${CELINE}-ALBUMS`, 'Albums'),
      ];
    case 'years':
      return [
        album('ALB-2007', 'Taking Chances (2007)'),
        album('ALB-2019', 'Courage (2019)'),
        album('ALB-2013', 'Loved Me Back to Life (2013)'),
      ];
    case 'radio':
      return [
        {
          container: 'no',
          mid: 'RADIO-8216',
          type: 'station',
          playable: 'yes',
          name: 'Céline Dion Radio',
          image_url: '',
        },
        container(`${CELINE}-TOP`, 'Top Tracks', { playable: 'yes' }),
      ];
    case 'bare':
      return [];
    default:
      return [
        container(`${CELINE}-TOP`, 'Top Tracks', { playable: 'yes' }),
        container(`${CELINE}-ALBUMS`, 'Albums'),
        container(`${CELINE}-SIMILAR`, 'Similar Artists'),
      ];
  }
}

/**
 * The answers of the receiver; `overrides[command](params)` replaces one,
 * `artist` picks the artist container variant, `topOptions` the options of
 * the Qobuz first level, `qobuz: false` leaves Qobuz out, `services: false`
 * the other sources (./heosServices.js).
 */
export function qobuzReceiver({
  overrides = {},
  artist = 'albums',
  topOptions,
  qobuz = true,
  services = true,
} = {}) {
  return (command, params) => {
    if (overrides[command]) {
      const replies = overrides[command](params);
      if (replies !== undefined) {
        return replies;
      }
    }
    switch (command) {
      case 'browse/get_music_sources':
        return [
          {
            payload: [
              { name: 'Pandora', sid: 1, type: 'music_service', available: 'false' },
              {
                name: 'TuneIn',
                image_url:
                  'https://production.ws.skyegloup.com:443/media/images/service/logos/tunein.png',
                sid: 3,
                type: 'music_service',
                available: 'true',
                service_username: ACCOUNT,
              },
              ...(qobuz
                ? [
                    {
                      name: 'Qobuz',
                      image_url:
                        'https://production.ws.skyegloup.com:443/media/images/service/logos/qobuz.png',
                      type: 'music_service',
                      sid: QOBUZ,
                      available: 'true',
                      service_username: ACCOUNT,
                    },
                  ]
                : []),
              ...(services ? otherSources(ACCOUNT) : []),
              { name: 'Favorites', sid: 1028, type: 'heos_service', available: 'true' },
            ],
          },
        ];
      case 'browse/browse':
        return otherBrowse(params, FAKE_PID) ?? browse(params, artist, topOptions);
      case 'browse/get_search_criteria':
        return (
          otherCriteria(params) ?? [
            {
              payload: [
                { name: 'Artist', scid: 1, wildcard: 'no' },
                { name: 'Album', scid: 2, wildcard: 'no' },
                {
                  name: 'Track',
                  scid: 3,
                  wildcard: 'no',
                  cid: 'SEARCHED_TRACKS-',
                  playable: 'yes',
                },
                { name: 'Playlist', scid: 6, wildcard: 'no' },
              ],
              message: `sid=${params.sid}`,
            },
          ]
        );
      case 'browse/search':
        return otherSearch(params) ?? search(params, artist);
      case 'browse/set_service_option':
        if (params.option === '13') {
          return [
            {
              payload: [
                {
                  container: 'no',
                  mid: 'CREATE_STATION-8216',
                  type: 'station',
                  playable: 'yes',
                  name: `${params.name} Radio`,
                  image_url: '',
                },
              ],
              message: `sid=${params.sid}&option=13`,
            },
          ];
        }
        return [{ result: 'fail', message: 'eid=15&text=Option not supported' }];
      case 'player/get_queue':
        return queue(params);
      case 'player/get_now_playing_media':
        return [
          {
            payload: {
              type: 'song',
              song: 'Courage',
              album: 'Courage',
              artist: 'Céline Dion',
              image_url: 'https://static.qobuz.com/images/covers/ALB-2019_600.jpg',
              mid: 'TR-11',
              qid: 2,
              sid: QOBUZ,
              album_id: 'ALB-2019',
            },
            message: `pid=${params.pid}`,
          },
        ];
      default:
        return [{}];
    }
  };
}

function browse(params, artist, topOptions) {
  const page = (payload, extra = '') => [
    {
      payload,
      message: `sid=${params.sid}&cid=${encodeURIComponent(params.cid ?? '')}&range=${params.range ?? ''}&returned=${payload.length}&count=${payload.length}${extra}`,
    },
  ];
  if (Number(params.sid) === 1028) {
    return [
      {
        payload: [
          {
            container: 'no',
            mid: 's6566',
            type: 'station',
            playable: 'yes',
            name: 'FIP',
            image_url: 'http://cdn-radiotime-logos.tunein.com/s6566q.png',
          },
        ],
        message: 'sid=1028&returned=1&count=1',
        options: [{ browse: [{ id: 20, name: 'Remove from HEOS Favorites' }] }],
      },
    ];
  }
  if (Number(params.sid) === 1025) {
    return [
      {
        payload: [
          {
            container: 'yes',
            type: 'playlist',
            cid: '171566',
            playable: 'yes',
            name: 'Rockin Songs',
            image_url: '',
          },
        ],
        message: 'sid=1025&returned=1&count=1',
      },
    ];
  }
  if (!params.cid) {
    // A slow service: the placeholder first, then the answer.
    return [
      { message: `command under process&sid=${params.sid}` },
      {
        payload: [container('DISCOVER', 'Discover'), container('LIBRARY', 'Library')],
        message: `sid=${params.sid}&returned=2&count=2`,
        ...(topOptions ? { options: topOptions } : {}),
      },
    ];
  }
  switch (params.cid) {
    case 'LIBRARY':
      return page([
        container('LIB-PLAYLISTS', 'Playlists'),
        container('LIB-ALBUMS', 'Albums'),
        container('LIB-ARTISTS', 'Artists'),
      ]);
    case 'LIB-PLAYLISTS':
      return page([playlist('PL-1001', 'Jazz du matin'), playlist('PL-1002', 'Café & Soirée')]);
    case CELINE:
      return page(artistChildren(artist));
    case `${CELINE}-ALBUMS`:
      return page(
        artist === 'latest'
          ? [ALBUMS[2], ALBUMS[1], ALBUMS[0]] // not newest first: the latest container wins
          : ALBUMS,
      );
    case `${CELINE}-LATEST`:
      return page([ALBUMS[0]]);
    case `${CELINE}-TOP`:
      return page([
        song('TR-11', 'My Heart Will Go On', 'Céline Dion', "Let's Talk About Love", 'ALB-1997'),
      ]);
    default:
      return page([]);
  }
}

function search(params, artist) {
  const reply = (payload) => [
    {
      payload,
      message: `sid=${params.sid}&search=${encodeURIComponent(params.search)}&scid=${params.scid}&range=${params.range}&returned=${payload.length}&count=${payload.length}`,
    },
  ];
  const text = String(params.search ?? '').toLowerCase();
  switch (params.scid) {
    case '1':
      if (artist === 'none' || (!text.includes('celine') && !text.includes('céline'))) {
        return reply([]);
      }
      return reply([
        container(CELINE, 'Céline Dion', { type: 'artist' }),
        container('ARTIST-99', 'Céline Dion Tribute Band', { type: 'artist' }),
      ]);
    case '2':
      if (text.includes('céline') || text.includes('celine')) {
        return reply(
          artist === 'none'
            ? []
            : [
                // By relevance: a tribute album first.
                album('ALB-TRIB', 'Céline Dion Forever', 'Tribute Band'),
                album('ALB-2013', 'Loved Me Back to Life'),
                album('ALB-2019', 'Courage'),
              ],
        );
      }
      if (text.includes('courage')) {
        return reply([album('ALB-PJ', 'Courage', 'Paul Jones'), album('ALB-2019', 'Courage')]);
      }
      if (text.includes('kind of blue')) {
        return reply([album('AL1', 'Kind of Blue', 'Miles Davis')]);
      }
      return reply([]);
    case '3':
      if (text.includes('heart will go on')) {
        return reply([
          song('TR-KG', 'My Heart Will Go On', 'Kenny G', 'Classics', 'ALB-KG'),
          song('TR-11', 'My Heart Will Go On', 'Céline Dion', "Let's Talk About Love", 'ALB-1997'),
        ]);
      }
      return reply([]);
    case '6':
      if (text.includes('rock')) {
        return reply([playlist('CAT1', 'Les essentiels du rock')]);
      }
      return reply([]);
    default:
      return [{ result: 'fail', message: 'eid=9&text=Out of range' }];
  }
}

const QUEUE = [
  {
    song: 'Lying Down',
    album: 'Courage',
    artist: 'Céline Dion',
    image_url: 'https://static.qobuz.com/images/covers/ALB-2019_230.jpg',
    qid: 1,
    mid: 'TR-10',
    album_id: 'ALB-2019',
  },
  {
    song: 'Courage',
    album: 'Courage',
    artist: 'Céline Dion',
    image_url: 'https://static.qobuz.com/images/covers/ALB-2019_230.jpg',
    qid: 2,
    mid: 'TR-11',
    album_id: 'ALB-2019',
  },
  {
    song: 'Imperfections',
    album: 'Courage',
    artist: 'Céline Dion',
    image_url: '',
    qid: 3,
    mid: 'TR-12',
    album_id: 'ALB-2019',
  },
];

function queue(params) {
  const [start, end] = String(params.range ?? '0,99')
    .split(',')
    .map(Number);
  const payload = QUEUE.slice(start, end + 1);
  return [
    {
      payload,
      message: `pid=${params.pid}&range=${params.range}&returned=${payload.length}&count=${QUEUE.length}`,
    },
  ];
}
