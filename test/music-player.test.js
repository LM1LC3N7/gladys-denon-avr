import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaItems } from '@gladysassistant/integration-sdk';
import {
  decodeMediaId,
  encodeMediaId,
  latestAlbumMediaItem,
  toMediaItem,
} from '../src/heos/media.js';
import { browseItems } from '../src/heos/qobuz.js';
import { createMusicHandlers, registerMusic, startNowPlaying } from '../src/devices/music.js';
import { FEATURE, STATE, buildFeatures } from '../src/devices/features.js';
import { __clearConnectionsForTesting, getState, updateState } from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { FAKE_PID as PID, connectFakeHeos, sentOf } from '../test-fixtures/fakeHeos.js';
import { QOBUZ, qobuzReceiver } from '../test-fixtures/qobuzReceiver.js';

const ID = 'avr:music';
const DEVICE = { external_id: ID, selector: 'salon', params: [] };
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.afterEach(() => {
  __clearConnectionsForTesting();
});

function setup() {
  const gladys = createFakeGladys();
  return { gladys, music: createMusicHandlers(gladys, () => normalizeConfig()) };
}

/** Assert the items are what the core keeps (the SDK's own validator). */
function assertValid(items) {
  assert.deepEqual(validateMediaItems(items), [], JSON.stringify(items));
}

// --- Media ids and MediaItems (pure) -------------------------------------------

test('a media id carries source, container, media and name, and comes back intact', () => {
  const id = encodeMediaId({
    kind: 'track',
    sid: 30,
    cid: 'SEARCHED_TRACKS-a&b=c',
    mid: 'TR 1',
    name: 'Café',
  });
  assert.ok(id.startsWith('heos:'));
  assert.deepEqual(decodeMediaId(id), {
    kind: 'track',
    sid: 30,
    cid: 'SEARCHED_TRACKS-a&b=c',
    mid: 'TR 1',
    name: 'Café',
    artist: '',
  });
  assert.equal(decodeMediaId('spotify:track:1'), null);
  assert.equal(decodeMediaId('heos:s=30'), null, 'no kind');
  assert.equal(decodeMediaId(42), null);
  assert.equal(decodeMediaId('heos:k=x&s=abc').sid, null);
  assert.equal(encodeMediaId({ kind: 'container', sid: 30, cid: 'x'.repeat(600) }), null, '> 512');
  assert.equal(
    decodeMediaId(encodeMediaId({ kind: 'latest', sid: 30, name: 'n'.repeat(300) })).name.length,
    100,
  );
});

test('HEOS items become MediaItems: type, browsable, playable, subtitle, artwork key', () => {
  const key = (url) => `art-${url.length.toString(16).padStart(12, '0')}`;
  const [song, station, playlist, folder, artist, nothing] = browseItems([
    {
      container: 'no',
      mid: 'TR-1',
      type: 'song',
      artist: 'Céline Dion',
      album: 'Courage',
      name: 'Lying Down',
      image_url: 'https://x/a.jpg',
    },
    {
      container: 'no',
      mid: 's6566',
      type: 'station',
      name: 'FIP',
      image_url: 'file:///etc/passwd',
    },
    { container: 'yes', playable: 'no', type: 'playlist', cid: 'PL-1', name: 'Jazz' },
    { container: 'yes', playable: 'no', type: 'container', cid: 'LIB', name: 'Library' },
    { container: 'yes', playable: 'no', type: 'artist', cid: 'AR-1', name: 'Céline Dion' },
    { container: 'no', type: 'song', name: 'no mid' },
  ]);
  const items = [
    toMediaItem(song, 30, { cid: 'CTX', artworkKey: key }),
    toMediaItem(station, 1028, { artworkKey: key }),
    toMediaItem(playlist, 30),
    toMediaItem(folder, 30),
    toMediaItem(artist, 30),
  ];
  assert.deepEqual(
    items.map((item) => [item.type, item.browsable, item.playable, item.subtitle ?? '']),
    [
      ['track', false, true, 'Céline Dion · Courage'],
      ['radio', false, true, ''],
      ['playlist', true, true, ''],
      ['folder', true, false, ''],
      ['artist', true, true, ''],
    ],
  );
  assert.equal(items[0].artwork_key, key('https://x/a.jpg'));
  assert.equal(items[1].artwork_key, undefined, 'only an http(s) image');
  assert.deepEqual(decodeMediaId(items[0].id), {
    kind: 'track',
    sid: 30,
    cid: 'CTX',
    mid: 'TR-1',
    name: 'Lying Down',
    artist: '',
  });
  assert.equal(toMediaItem(nothing, 30), null);
  assertValid(items);
  const latest = latestAlbumMediaItem(30, 'Céline Dion', 'fr');
  assert.equal(latest.title, 'Dernier album de Céline Dion');
  assert.equal(latestAlbumMediaItem(30, 'Muse', 'en').title, 'Latest album by Muse');
  assert.equal(latestAlbumMediaItem(30, '  '), null);
  assertValid([latest]);
});

// --- Against a fake HEOS CLI ---------------------------------------------------

test('the five music handlers are registered on the SDK', () => {
  const gladys = createFakeGladys();
  registerMusic(gladys, () => normalizeConfig());
  assert.deepEqual(Object.keys(gladys.handlers.music).sort(), [
    'browse',
    'play',
    'queueGet',
    'queuePlay',
    'search',
  ]);
});

test('the root: HEOS favorites, HEOS playlists and Qobuz', async (t) => {
  await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const root = await music.browse(DEVICE, { parentId: null, offset: 0, limit: 50 });
  assert.deepEqual(
    root.items.map((item) => [item.title, decodeMediaId(item.id).sid]),
    [
      ['HEOS Favorites', 1028],
      ['HEOS Playlists', 1025],
      ['Qobuz', QOBUZ],
    ],
  );
  assert.equal(root.total, 3);
  assertValid(root.items);
  const page = await music.browse(DEVICE, { parentId: null, offset: 1, limit: 1 });
  assert.deepEqual(
    page.items.map((item) => item.title),
    ['HEOS Playlists'],
  );
});

test('the root without Qobuz: the HEOS lists only', async (t) => {
  await connectFakeHeos(
    t,
    ID,
    qobuzReceiver({
      overrides: { 'browse/get_music_sources': () => [{ payload: [{ name: 'TuneIn', sid: 3 }] }] },
    }),
  );
  const { music } = setup();
  const root = await music.browse(DEVICE, { parentId: null, offset: 0, limit: 50 });
  assert.deepEqual(
    root.items.map((item) => item.title),
    ['HEOS Favorites', 'HEOS Playlists'],
  );
});

test('Qobuz is browsed level by level down to the playlists, played whatever their flag', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { gladys, music } = setup();
  const root = await music.browse(DEVICE, { parentId: null, offset: 0, limit: 50 });
  const qobuz = root.items[2];
  const top = await music.browse(DEVICE, { parentId: qobuz.id, offset: 0, limit: 50 });
  assert.deepEqual(
    top.items.map((item) => item.title),
    ['Discover', 'Library'],
  );
  const library = await music.browse(DEVICE, { parentId: top.items[1].id, offset: 0, limit: 50 });
  assert.deepEqual(
    library.items.map((item) => item.title),
    ['Playlists', 'Albums', 'Artists'],
  );
  assert.ok(sentOf(fake, 'browse/browse').at(-1).endsWith('cid=LIBRARY&range=0,49'));
  const playlists = await music.browse(DEVICE, {
    parentId: library.items[0].id,
    offset: 0,
    limit: 50,
  });
  assert.equal(playlists.total, 2, "HEOS' count");
  assert.deepEqual(
    playlists.items.map((item) => [item.title, item.type, item.playable]),
    [
      ['Jazz du matin', 'playlist', true],
      ['Café & Soirée', 'playlist', true],
    ],
  );
  assert.equal(
    playlists.items[0].artwork_key,
    gladys.artworkKey('https://static.qobuz.com/images/covers/PL-1001_230.jpg'),
  );
  assertValid(playlists.items);
  await music.play(DEVICE, { id: playlists.items[1].id, type: 'playlist' }, 'append');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=PL-1002&aid=3`,
  ]);
});

test('a container page without a known count says there may be more', async (t) => {
  await connectFakeHeos(
    t,
    ID,
    qobuzReceiver({
      overrides: {
        'browse/browse': (params) =>
          params.cid === 'BIG'
            ? [
                {
                  payload: Array.from({ length: 2 }, (_, i) => ({
                    container: 'yes',
                    type: 'album',
                    cid: `A${i}`,
                    name: `Album ${i}`,
                  })),
                  message: `sid=30&cid=BIG&returned=2&count=0`,
                },
              ]
            : undefined,
      },
    }),
  );
  const { music } = setup();
  const parentId = encodeMediaId({ kind: 'container', sid: 30, cid: 'BIG' });
  const full = await music.browse(DEVICE, { parentId, offset: 4, limit: 2 });
  assert.equal(full.total, 7, 'offset + a full page + 1');
  const last = await music.browse(DEVICE, { parentId, offset: 4, limit: 3 });
  assert.equal(last.total, 6, 'a short page is the end');
});

test('HEOS favorites: a station, played with play_stream on the favorites source', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const root = await music.browse(DEVICE, { parentId: null, offset: 0, limit: 50 });
  const favorites = await music.browse(DEVICE, {
    parentId: root.items[0].id,
    offset: 0,
    limit: 50,
  });
  assert.deepEqual(
    favorites.items.map((item) => [item.title, item.type]),
    [['FIP', 'radio']],
  );
  await music.play(DEVICE, { id: favorites.items[0].id, type: 'radio' }, 'append');
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), [
    `heos://browse/play_stream?pid=${PID}&sid=1028&mid=s6566&name=FIP`,
  ]);
  const playlists = await music.browse(DEVICE, {
    parentId: root.items[1].id,
    offset: 0,
    limit: 50,
  });
  await music.play(DEVICE, { id: playlists.items[0].id, type: 'playlist' }, 'replace');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=1025&cid=171566&aid=4`,
  ]);
});

test('search over every kind: the artist, its latest album, albums, tracks', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const { items } = await music.search(DEVICE, { query: 'Céline Dion', type: null, limit: 20 });
  assert.deepEqual(
    items.map((item) => [item.type, item.title]),
    [
      ['artist', 'Céline Dion'],
      ['album', 'Dernier album · Latest album : Céline Dion'],
      ['artist', 'Céline Dion Tribute Band'],
      ['album', 'Céline Dion Forever'],
      ['album', 'Loved Me Back to Life'],
      ['album', 'Courage'],
    ],
  );
  assertValid(items);
  assert.deepEqual(
    sentOf(fake, 'browse/search').map((line) => /scid=(\d)/.exec(line)[1]),
    ['1', '2', '6', '3'],
    'artist, album, playlist, track',
  );
  assert.ok(
    sentOf(fake, 'browse/search').every((line) => line.endsWith('range=0,4')),
    '20 / 4 each',
  );
  const few = await music.search(DEVICE, { query: 'Céline Dion', type: null, limit: 2 });
  assert.equal(few.items.length, 2);
});

test('search by type: one criteria only; a missing criteria is an empty answer', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const albums = await music.search(DEVICE, { query: 'courage', type: 'album', limit: 10 });
  assert.deepEqual(
    albums.items.map((item) => item.subtitle),
    ['Paul Jones', 'Céline Dion'],
  );
  assert.deepEqual(sentOf(fake, 'browse/search'), [
    `heos://browse/search?sid=${QOBUZ}&search=courage&scid=2&range=0,9`,
  ]);
  const radios = await music.search(DEVICE, { query: 'courage', type: 'radio', limit: 10 });
  assert.deepEqual(radios.items, [], 'Qobuz has no Station criteria');
  const folders = await music.search(DEVICE, { query: 'courage', type: 'folder', limit: 10 });
  assert.deepEqual(folders.items, []);
});

test('a failing search kind is skipped, the others answer', async (t) => {
  t.mock.method(console, 'error', () => {});
  await connectFakeHeos(
    t,
    ID,
    qobuzReceiver({
      overrides: {
        'browse/search': (params) =>
          params.scid === '1'
            ? [{ result: 'fail', message: 'eid=12&text=System error&syserrno=-9' }]
            : undefined,
      },
    }),
  );
  const { music } = setup();
  const { items } = await music.search(DEVICE, { query: 'Céline Dion', type: null, limit: 20 });
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.type === 'album'));
});

test('"dernier album de …" offers the latest album first, resolved when played', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver({ artist: 'years' }));
  const { music } = setup();
  const { items } = await music.search(DEVICE, {
    query: 'dernier album de Céline Dion',
    type: null,
    limit: 20,
  });
  assert.equal(items[0].title, 'Dernier album de Céline Dion');
  assert.deepEqual(
    sentOf(fake, 'browse/search').map((line) => /search=([^&]*)&scid=(\d)/.exec(line).slice(1)),
    [['Céline Dion', '2']],
    'the albums of the artist, nothing else',
  );
  await music.play(DEVICE, { id: items[0].id, type: 'album' }, 'replace');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=ALB-2019&aid=4`,
  ]);
  const english = await music.search(DEVICE, { query: 'latest album by Céline Dion', limit: 5 });
  assert.equal(english.items[0].title, 'Latest album by Céline Dion');
});

test('a track and an artist found by search are played (next, append)', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const tracks = await music.search(DEVICE, {
    query: 'My Heart Will Go On',
    type: 'track',
    limit: 10,
  });
  const celine = tracks.items.find((item) => item.subtitle.startsWith('Céline Dion'));
  await music.play(DEVICE, { id: celine.id, type: 'track' }, 'next');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=SEARCHED_TRACKS-My Heart Will Go On&mid=TR-11&aid=2`,
  ]);
  const artists = await music.search(DEVICE, { query: 'Céline Dion', type: 'artist', limit: 10 });
  await music.play(DEVICE, { id: artists.items[0].id, type: 'artist' }, 'append');
  assert.equal(
    sentOf(fake, 'browse/add_to_queue')[1],
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=ARTIST-8216-TOP&aid=3`,
  );
  assert.ok(
    sentOf(fake, 'browse/browse').some((line) => line.includes('cid=ARTIST-8216&')),
    'the artist container opened directly, no new Artist search',
  );
  assert.equal(sentOf(fake, 'browse/search').length, 2);
});

test('the queue: items, the playing one, the total; a tap jumps to it', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const queue = await music.queueGet(DEVICE, { offset: 0, limit: 50 });
  assert.equal(queue.total, 3);
  assert.equal(queue.currentIndex, 1, 'qid 2 is playing');
  assert.deepEqual(
    queue.items.map((item) => [item.title, item.subtitle, item.type]),
    [
      ['Lying Down', 'Céline Dion · Courage', 'track'],
      ['Courage', 'Céline Dion · Courage', 'track'],
      ['Imperfections', 'Céline Dion · Courage', 'track'],
    ],
  );
  assert.ok(queue.items[0].artwork_key);
  assert.equal(queue.items[2].artwork_key, undefined);
  assertValid(queue.items);
  const page = await music.queueGet(DEVICE, { offset: 2, limit: 1 });
  assert.deepEqual(
    [page.items.map((item) => item.title), page.total, page.currentIndex],
    [['Imperfections'], 3, 1],
  );
  await music.queuePlay(DEVICE, 2);
  assert.deepEqual(sentOf(fake, 'player/play_queue'), [
    `heos://player/play_queue?pid=${PID}&qid=3`,
  ]);
  await assert.rejects(music.queuePlay(DEVICE, 7), /The queue has no item 8/);
  await assert.rejects(music.queuePlay(DEVICE, -1), /Invalid queue index/);
  // A queue item saved in a scene plays by its qid.
  await music.play(DEVICE, { id: queue.items[0].id, type: 'track' }, 'replace');
  assert.equal(sentOf(fake, 'player/play_queue')[1], `heos://player/play_queue?pid=${PID}&qid=1`);
});

test('a long queue is read page by page; nothing playing is a null index', async (t) => {
  const long = Array.from({ length: 130 }, (_, i) => ({ song: `S${i}`, qid: i + 1, mid: `M${i}` }));
  const fake = await connectFakeHeos(
    t,
    ID,
    qobuzReceiver({
      overrides: {
        'player/get_queue': (params) => {
          const [start, end] = params.range.split(',').map(Number);
          return [{ payload: long.slice(start, end + 1) }];
        },
        'player/get_now_playing_media': () => [{ payload: {} }],
      },
    }),
  );
  const { music } = setup();
  const queue = await music.queueGet(DEVICE, { offset: 120, limit: 50 });
  assert.equal(queue.total, 130);
  assert.equal(queue.items.length, 10);
  assert.equal(queue.currentIndex, null);
  assert.deepEqual(sentOf(fake, 'player/get_queue'), [
    `heos://player/get_queue?pid=${PID}&range=0,99`,
    `heos://player/get_queue?pid=${PID}&range=100,199`,
  ]);
});

test('unknown media, unknown entries and a receiver without HEOS are refused', async (t) => {
  await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  await assert.rejects(music.play(DEVICE, { id: 'spotify:x', type: 'track' }), /Unknown media/);
  await assert.rejects(
    music.play(DEVICE, { id: encodeMediaId({ kind: 'track', name: 'X' }), type: 'track' }),
    /"X" has no HEOS source/,
  );
  await assert.rejects(
    music.play(DEVICE, {
      id: encodeMediaId({ kind: 'container', sid: 30, name: 'Y' }),
      type: 'album',
    }),
    /"Y" cannot be played/,
  );
  await assert.rejects(music.browse(DEVICE, { parentId: 'nope' }), /Unknown catalog entry/);
  await assert.rejects(
    music.browse(DEVICE, { parentId: encodeMediaId({ kind: 'container', sid: 30, name: 'Z' }) }),
    /"Z" cannot be opened/,
  );
  const other = { external_id: 'avr:other' };
  await assert.rejects(music.browse(other, { parentId: null }), /cannot browse the music/);
  await assert.rejects(music.queueGet(other, {}), /cannot read the queue/);
  await assert.rejects(music.search(other, { query: 'x' }), /cannot use Qobuz/);
});

// --- Now playing ---------------------------------------------------------------

test('the now playing is published as music features, once per burst', async () => {
  const gladys = createFakeGladys();
  const stop = startNowPlaying(gladys, getState);
  try {
    updateState(ID, {
      [STATE.NOW_PLAYING_TITLE]: 'Courage',
      [STATE.NOW_PLAYING_ARTIST]: 'Céline Dion',
      [STATE.NOW_PLAYING_ALBUM]: 'Courage',
      [STATE.NOW_PLAYING_IMAGE_URL]: 'https://static.qobuz.com/images/covers/ALB-2019_600.jpg',
      volume: 30,
    });
    await tick(80);
    assert.equal(gladys.nowPlaying.length, 1);
    assert.deepEqual(gladys.nowPlaying[0], {
      deviceExternalId: ID,
      values: {
        title: 'Courage',
        artist: 'Céline Dion',
        album: 'Courage',
        artwork_url: 'https://static.qobuz.com/images/covers/ALB-2019_600.jpg',
      },
      options: {
        featureExternalIds: {
          title: `${ID}:title`,
          artist: `${ID}:artist`,
          album: `${ID}:album`,
          artwork: `${ID}:artwork`,
        },
      },
    });
    updateState(ID, { volume: 40 });
    await tick(80);
    assert.equal(gladys.nowPlaying.length, 1, 'another state publishes nothing');
    updateState(ID, { [STATE.NOW_PLAYING_TITLE]: '', [STATE.NOW_PLAYING_IMAGE_URL]: '' });
    await tick(80);
    assert.equal(gladys.nowPlaying[1].values.title, '');
    assert.equal(gladys.nowPlaying[1].values.artwork_url, null, 'no image: an empty artwork');
  } finally {
    stop();
  }
  updateState(ID, { [STATE.NOW_PLAYING_TITLE]: 'after stop' });
  await tick(80);
  assert.equal(gladys.nowPlaying.length, 2, 'stopped');
});

test('every receiver, HEOS speakers too, has the four now-playing music features', () => {
  for (const heosOnly of [false, true]) {
    const features = buildFeatures(ID, {}, { heosOnly });
    const music = features.filter((feature) =>
      [FEATURE.MUSIC_TITLE, FEATURE.MUSIC_ARTIST, FEATURE.MUSIC_ALBUM, FEATURE.MUSIC_ARTWORK].some(
        (key) => feature.external_id === `${ID}:${key}`,
      ),
    );
    assert.deepEqual(
      music.map((feature) => [feature.category, feature.type, feature.read_only]),
      [
        ['music', 'title', true],
        ['music', 'artist', true],
        ['music', 'album', true],
        ['music', 'artwork', true],
      ],
    );
  }
});
