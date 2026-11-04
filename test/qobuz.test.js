import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADD_TO_QUEUE,
  aidOfMode,
  buildAddContainerToQueueCommand,
  buildAddTrackToQueueCommand,
  buildBrowseCommand,
  buildCreateStationCommand,
  buildGetQueueCommand,
  buildPlayQueueCommand,
  buildPlayStationCommand,
  buildSearchCommand,
  escapeHeosValue,
  isCommandUnderProcess,
  parseMessage,
} from '../src/heos/protocol.js';
import {
  browseItems,
  criteriaOf,
  describeItem,
  findQobuzSource,
  fold,
  libraryContainers,
  parseLatestAlbumQuery,
  parseOptions,
  pickByName,
  pickCriteria,
  pickLatestAlbum,
  redact,
  sourceSummaries,
  yearOf,
} from '../src/heos/qobuz.js';
import { HeosCommandError } from '../src/devices/heos-session.js';
import { playQobuz, listQobuzPlaylists, QobuzUnavailableError } from '../src/devices/qobuz.js';
import { runQobuzCheckAction } from '../src/devices/actions.js';
import { createSceneActionHandlers } from '../src/scenes/actions.js';
import {
  __clearConnectionsForTesting,
  __setTimingForTesting,
  setSession,
} from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { FAKE_PID as PID, connectFakeHeos, sentOf } from '../test-fixtures/fakeHeos.js';
import { ACCOUNT, QOBUZ, qobuzReceiver } from '../test-fixtures/qobuzReceiver.js';

const ID = 'avr:qobuz';
const connect = (t, respond) => connectFakeHeos(t, ID, respond);

test.afterEach(() => {
  __clearConnectionsForTesting();
});

// --- Pure helpers ------------------------------------------------------------

test('HEOS parameters: & = % escaped, nothing else', () => {
  assert.equal(escapeHeosValue('Café & Soirée = 100%'), 'Café %26 Soirée %3D 100%25');
  assert.equal(
    buildSearchCommand(30, 2, 'Rock & Roll', [0, 19]),
    'browse/search?sid=30&search=Rock %26 Roll&scid=2&range=0,19',
  );
  assert.equal(buildBrowseCommand(30), 'browse/browse?sid=30');
  assert.equal(buildBrowseCommand(30, 'A&B', [0, 49]), 'browse/browse?sid=30&cid=A%26B&range=0,49');
  assert.equal(
    buildAddContainerToQueueCommand(7, 30, 'PL1'),
    `browse/add_to_queue?pid=7&sid=30&cid=PL1&aid=${ADD_TO_QUEUE.REPLACE_AND_PLAY}`,
  );
});

test('the commands of the CLI spec: track to queue, station, created station, queue', () => {
  assert.equal(
    buildAddTrackToQueueCommand(7, 30, 'SEARCHED_TRACKS-a&b', 'TR=1', 2),
    'browse/add_to_queue?pid=7&sid=30&cid=SEARCHED_TRACKS-a%26b&mid=TR%3D1&aid=2',
  );
  assert.equal(
    buildPlayStationCommand(7, 1028, null, 's6566', 'FIP & co'),
    'browse/play_stream?pid=7&sid=1028&mid=s6566&name=FIP %26 co',
  );
  assert.equal(
    buildPlayStationCommand(7, 5, 'Flow', 'flow', ''),
    'browse/play_stream?pid=7&sid=5&cid=Flow&mid=flow',
  );
  assert.equal(
    buildCreateStationCommand(1, 1, 'Céline Dion'),
    'browse/set_service_option?sid=1&option=13&scid=1&name=Céline Dion',
  );
  assert.equal(buildGetQueueCommand(7, [0, 99]), 'player/get_queue?pid=7&range=0,99');
  assert.equal(buildGetQueueCommand(7), 'player/get_queue?pid=7');
  assert.equal(buildPlayQueueCommand(7, 3), 'player/play_queue?pid=7&qid=3');
});

test('play modes are the aid of the CLI spec: replace 4, next 2, append 3', () => {
  assert.equal(aidOfMode('replace'), 4);
  assert.equal(aidOfMode('next'), 2);
  assert.equal(aidOfMode('append'), 3);
  assert.equal(aidOfMode(undefined), 4);
  assert.equal(aidOfMode('shuffle'), 4);
});

test('"command under process" is recognized; options are kept (pyheos fixtures)', () => {
  const parsed = parseMessage(
    '{"heos": {"command": "player/clear_queue", "result": "success", "message": "command under process&pid=1"}}',
  );
  assert.equal(isCommandUnderProcess(parsed), true);
  assert.equal(isCommandUnderProcess({ message: { pid: '1' } }), false);
  const favorites = parseMessage(
    '{"heos":{"command":"browse/browse","result":"success","message":"sid=1028&returned=1&count=1"},"payload":[],"options":[{"browse":[{"id":20,"name":"Remove from HEOS Favorites"}]}]}',
  );
  assert.deepEqual(parseOptions(favorites.options), [
    { context: 'browse', id: 20, name: 'Remove from HEOS Favorites' },
  ]);
  assert.deepEqual(parseOptions(undefined), []);
  assert.deepEqual(parseOptions([null, { play: [{ id: 'x' }, { id: 19 }] }]), [
    { context: 'play', id: 19, name: '' },
  ]);
});

test('the Qobuz source is found by name, else by its id 30; sign-in from `available`', () => {
  const payload = [
    { name: 'Pandora', sid: 1, type: 'music_service', available: 'true' },
    { name: 'Qobuz', sid: 30, type: 'music_service', available: 'true', service_username: 'x' },
  ];
  assert.deepEqual(findQobuzSource(payload), { sid: 30, name: 'Qobuz', available: true });
  assert.equal(findQobuzSource([{ name: 'Qobuz', sid: 30, available: 'false' }]).available, false);
  assert.deepEqual(findQobuzSource([{ sid: 30, available: 'true' }]), {
    sid: 30,
    name: 'Qobuz',
    available: true,
  });
  assert.equal(
    findQobuzSource([{ name: 'TIDAL', sid: 30 }]),
    null,
    'a named source 30 is not Qobuz',
  );
  assert.equal(findQobuzSource([{ name: 'Qobuz' }]), null, 'no sid, no source');
  assert.equal(findQobuzSource([{ name: 'TIDAL', sid: 10 }]), null);
  assert.equal(findQobuzSource(undefined), null);
});

test('the sources summary never carries the account name', () => {
  const summary = sourceSummaries([{ name: 'Qobuz', sid: 30, service_username: ACCOUNT }]);
  assert.deepEqual(summary, [{ name: 'Qobuz', sid: 30, type: '', available: null }]);
  assert.ok(!JSON.stringify(summary).includes(ACCOUNT));
  const item = describeItem(
    { name: `Playlists of ${ACCOUNT}`, image_url: 'https://x/y.jpg', service_username: ACCOUNT },
    [ACCOUNT],
  );
  assert.deepEqual(item, {
    name: 'Playlists of (account)',
    image_url: '(set)',
    service_username: '(hidden)',
  });
  assert.equal(redact(42, [ACCOUNT]), 42);
});

test('names are compared without case, accents nor punctuation; best match first', () => {
  assert.equal(fold('  Café & Soirée!! '), 'cafe soiree');
  const items = browseItems([
    { container: 'yes', playable: 'yes', type: 'playlist', cid: '1', name: 'Jazz du matin (2024)' },
    { container: 'yes', playable: 'yes', type: 'playlist', cid: '2', name: 'Jazz' },
    { container: 'yes', playable: 'yes', type: 'playlist', cid: '3', name: 'Le jazz de Noël' },
  ]);
  assert.equal(pickByName(items, 'JAZZ').cid, '2', 'the exact name wins');
  assert.equal(pickByName(items, 'jazz du matin').cid, '1', 'then a name starting with it');
  assert.equal(pickByName(items, 'noel').cid, '3', 'then a name containing it');
  assert.equal(pickByName(items, 'rock'), null);
  assert.equal(pickByName(items, '  '), null);
});

test('an artist narrows a name down, when HEOS names artists', () => {
  const items = browseItems([
    { container: 'yes', type: 'album', cid: 'PJ', name: 'Courage', artist: 'Paul Jones' },
    { container: 'yes', type: 'album', cid: 'CD', name: 'Courage', artist: 'Céline Dion' },
  ]);
  assert.equal(pickByName(items, 'courage').cid, 'PJ', 'no artist: the first');
  assert.equal(pickByName(items, 'courage', 'celine dion').cid, 'CD');
  assert.equal(pickByName(items, 'courage', 'Muse'), null, 'nobody else');
  const anonymous = browseItems([{ container: 'yes', type: 'album', cid: 'A', name: 'Courage' }]);
  assert.equal(
    pickByName(anonymous, 'courage', 'Céline Dion').cid,
    'A',
    'no artist field: ignored',
  );
});

test('the containers worth opening: playlists first, then the library-like ones, never a playlist', () => {
  const items = browseItems([
    { container: 'yes', playable: 'no', cid: 'NEW', name: 'Nouveautés' },
    { container: 'yes', playable: 'no', cid: 'LIB', name: 'Library' },
    { container: 'yes', playable: 'no', cid: 'PL', name: 'Mes playlists' },
    { container: 'yes', playable: 'yes', cid: 'X', type: 'playlist', name: 'Playlist jouable' },
    { container: 'yes', playable: 'no', cid: 'FAV', type: 'playlist', name: 'My favorites' },
  ]);
  assert.deepEqual(
    libraryContainers(items).map((item) => item.cid),
    ['PL', 'LIB'],
  );
});

test('the search criteria are picked by name, with the track container prefix', () => {
  const criteria = [
    { name: 'Artist', scid: 1 },
    { name: 'Albums', scid: 2 },
    { name: 'Track', scid: 3, cid: 'SEARCHED_TRACKS-', playable: 'yes' },
    { name: 'Playlist', scid: 6 },
  ];
  assert.equal(pickCriteria(criteria, 'album'), 2);
  assert.equal(pickCriteria(criteria, 'playlist'), 6);
  assert.equal(pickCriteria(criteria, 'artist'), 1);
  assert.deepEqual(criteriaOf(criteria, 'track'), {
    scid: 3,
    name: 'Track',
    cid: 'SEARCHED_TRACKS-',
    playable: true,
  });
  assert.equal(pickCriteria([{ name: 'Artist', scid: 1 }], 'album'), null);
  assert.equal(pickCriteria(criteria, 'station'), null);
  assert.equal(pickCriteria(criteria, 'other'), null);
  assert.equal(criteriaOf([{ name: 'Album' }], 'album'), null, 'no scid, no criteria');
});

test('a release year: from a date field, else "(2019)" in the name, never an absurd one', () => {
  assert.equal(yearOf({ release_date: '2019-11-15' }), 2019);
  assert.equal(yearOf({ year: 2013 }), 2013);
  assert.equal(yearOf({ name: 'Courage (2019)' }), 2019);
  assert.equal(yearOf({ name: 'Courage [Deluxe] [2020]' }), 2020);
  assert.equal(yearOf({ name: 'Courage' }), null);
  assert.equal(yearOf({ name: 'Live (1234)' }), null);
  assert.equal(yearOf({ year: '0' }), null);
});

test('the latest album: the most recent year, else the first listed', () => {
  const albums = browseItems([
    { container: 'yes', type: 'album', cid: 'A', name: 'Taking Chances (2007)' },
    { container: 'yes', type: 'album', cid: 'B', name: 'Courage (2019)' },
    { container: 'yes', type: 'album', cid: 'C', name: 'Loved Me Back to Life (2013)' },
  ]);
  assert.deepEqual(
    [pickLatestAlbum(albums).album.cid, pickLatestAlbum(albums).method],
    ['B', 'year'],
  );
  const undated = browseItems([
    { container: 'yes', type: 'album', cid: 'X', name: 'Courage' },
    { container: 'yes', type: 'album', cid: 'Y', name: 'Taking Chances' },
  ]);
  assert.deepEqual(
    [pickLatestAlbum(undated).album.cid, pickLatestAlbum(undated).method],
    ['X', 'first_listed'],
  );
  assert.equal(pickLatestAlbum([]), null);
  assert.equal(
    pickLatestAlbum(browseItems([{ container: 'yes', type: 'playlist', cid: 'P', name: 'P' }])),
    null,
  );
});

test('"latest album" requests are recognized in French and English', () => {
  assert.equal(parseLatestAlbumQuery('dernier album de Céline Dion'), 'Céline Dion');
  assert.equal(parseLatestAlbumQuery('Joue le dernier album de Céline Dion'), 'Céline Dion');
  assert.equal(parseLatestAlbumQuery("le dernier album d'Indochine"), 'Indochine');
  assert.equal(parseLatestAlbumQuery('la dernière album de Muse'), null, 'not a known form');
  assert.equal(parseLatestAlbumQuery('nouvel album de Stromae.'), 'Stromae');
  assert.equal(parseLatestAlbumQuery('latest album by Muse'), 'Muse');
  assert.equal(parseLatestAlbumQuery('the last album of Daft Punk'), 'Daft Punk');
  assert.equal(parseLatestAlbumQuery('Céline Dion'), null);
  assert.equal(parseLatestAlbumQuery('album de Céline Dion'), null);
  assert.equal(parseLatestAlbumQuery(undefined), null);
});

// --- Against a fake HEOS CLI ---------------------------------------------------

test('a playlist of the library (Library > Playlists), listed not playable, is queued anyway', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(ID, { kind: 'playlist', name: 'jazz DU matin' }, 'main');
  assert.deepEqual(result, {
    played: 'Jazz du matin',
    artist: '',
    type: 'playlist',
    method: 'library',
  });
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=PL-1001&aid=4`,
  ]);
  assert.deepEqual(sentOf(fake, 'browse/search'), [], 'found in the library, no search');
  // The library is cached: a second scene does not browse it again.
  const browses = sentOf(fake, 'browse/browse').length;
  await playQobuz(ID, { kind: 'playlist', name: 'café & soirée', mode: 'append' }, 'main');
  assert.equal(sentOf(fake, 'browse/browse').length, browses);
  assert.equal(
    sentOf(fake, 'browse/add_to_queue')[1],
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=PL-1002&aid=3`,
  );
});

test('a playlist not in the library comes from the catalog search', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(ID, { kind: 'playlist', name: 'essentiels du rock' }, 'main');
  assert.equal(result.played, 'Les essentiels du rock');
  assert.equal(result.method, 'search');
  assert.ok(sentOf(fake, 'browse/search')[0].includes('&scid=6'), 'the Playlist criteria');
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].endsWith('cid=CAT1&aid=4'));
});

test('an album: the catalog search, narrowed by the artist, played next', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(
    ID,
    { kind: 'album', name: 'courage', artist: 'Céline Dion', mode: 'next' },
    'main',
  );
  assert.deepEqual(result, {
    played: 'Courage',
    artist: 'Céline Dion',
    type: 'album',
    method: 'search',
  });
  assert.ok(sentOf(fake, 'browse/search')[0].includes('search=courage&scid=2'));
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=ALB-2019&aid=2`,
  ]);
  assert.deepEqual(sentOf(fake, 'browse/browse'), [], 'an album never browses the library');
});

test('an album without artist: the first match', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(ID, { kind: 'album', name: 'Kind of Blue' }, 'main');
  assert.equal(result.artist, 'Miles Davis');
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].includes('cid=AL1'));
});

test('latest album: the first of the artist\'s "Albums" container (HEOS order assumed)', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(ID, { kind: 'latest_album', name: 'celine dion' }, 'main');
  assert.deepEqual(result, {
    played: 'Courage',
    artist: 'Céline Dion',
    type: 'album',
    method: 'first_listed',
  });
  assert.ok(sentOf(fake, 'browse/search')[0].includes('&scid=1'), 'an Artist search');
  assert.ok(
    sentOf(fake, 'browse/browse').some((line) => line.includes('cid=ARTIST-8216-ALBUMS')),
    'the albums container opened',
  );
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=ALB-2019&aid=4`,
  ]);
});

test('latest album: a "Latest Release" container wins over the album order', async (t) => {
  const fake = await connect(t, qobuzReceiver({ artist: 'latest' }));
  const result = await playQobuz(ID, { kind: 'latest_album', name: 'Céline Dion' }, 'main');
  assert.equal(result.method, 'latest_container');
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].includes('cid=ALB-2019'));
});

test('latest album: a year in the names wins over the order', async (t) => {
  const fake = await connect(t, qobuzReceiver({ artist: 'years' }));
  const result = await playQobuz(ID, { kind: 'latest_album', name: 'Céline Dion' }, 'main');
  assert.equal(result.method, 'year');
  assert.equal(result.played, 'Courage (2019)');
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].includes('cid=ALB-2019'));
});

test('latest album: an empty artist container falls back on the Album search, by that artist only', async (t) => {
  const fake = await connect(t, qobuzReceiver({ artist: 'bare' }));
  const result = await playQobuz(ID, { kind: 'latest_album', name: 'Céline Dion' }, 'main');
  assert.equal(result.method, 'album_search');
  assert.equal(result.played, 'Loved Me Back to Life', 'the first listed: an assumption');
  assert.equal(result.artist, 'Céline Dion');
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].includes('cid=ALB-2013'));
});

test('latest album: nobody found, a clear error and nothing played', async (t) => {
  const fake = await connect(t, qobuzReceiver({ artist: 'none' }));
  await assert.rejects(
    playQobuz(ID, { kind: 'latest_album', name: 'Céline Dion' }, 'main'),
    /No Qobuz album found for the artist "Céline Dion"/,
  );
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
});

test('artist: its radio station is played with play_stream', async (t) => {
  const fake = await connect(t, qobuzReceiver({ artist: 'radio' }));
  const result = await playQobuz(ID, { kind: 'artist', name: 'Céline Dion' }, 'main');
  assert.deepEqual(result, {
    played: 'Céline Dion',
    artist: 'Céline Dion',
    type: 'artist',
    method: 'artist_radio',
  });
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), [
    `heos://browse/play_stream?pid=${PID}&sid=${QOBUZ}&mid=RADIO-8216&name=Céline Dion Radio`,
  ]);
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
});

test('artist: its "Top Tracks" when there is no radio', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(
    ID,
    { kind: 'artist', name: 'Céline Dion', mode: 'append' },
    'main',
  );
  assert.equal(result.method, 'top_tracks');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=ARTIST-8216-TOP&aid=3`,
  ]);
});

test('artist: a station created by HEOS, only when Qobuz offers option 13', async (t) => {
  const fake = await connect(
    t,
    qobuzReceiver({
      artist: 'bare',
      topOptions: [{ browse: [{ id: 13, name: 'Create New Station' }] }],
    }),
  );
  const result = await playQobuz(ID, { kind: 'artist', name: 'Céline Dion' }, 'main');
  assert.equal(result.method, 'created_station');
  assert.deepEqual(sentOf(fake, 'browse/set_service_option'), [
    `heos://browse/set_service_option?sid=${QOBUZ}&option=13&scid=1&name=Céline Dion`,
  ]);
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), [
    `heos://browse/play_stream?pid=${PID}&sid=${QOBUZ}&mid=CREATE_STATION-8216&name=Céline Dion Radio`,
  ]);
});

test('artist: otherwise every track found by its name (SEARCHED_TRACKS-)', async (t) => {
  const fake = await connect(t, qobuzReceiver({ artist: 'bare' }));
  const result = await playQobuz(ID, { kind: 'artist', name: 'Céline Dion' }, 'main');
  assert.equal(result.method, 'searched_tracks');
  assert.deepEqual(sentOf(fake, 'browse/set_service_option'), [], 'option 13 not offered');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=SEARCHED_TRACKS-Céline Dion&aid=4`,
  ]);
});

test('artist: no way at all, a clear error', async (t) => {
  await connect(
    t,
    qobuzReceiver({
      artist: 'none',
      overrides: {
        'browse/get_search_criteria': () => [{ payload: [{ name: 'Artist', scid: 1 }] }],
      },
    }),
  );
  await assert.rejects(
    playQobuz(ID, { kind: 'artist', name: 'Céline Dion' }, 'main'),
    /No way to play the artist "Céline Dion"/,
  );
});

test('a track: the search, narrowed by the artist, queued with its search container', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(
    ID,
    { kind: 'track', name: 'my heart will go on', artist: 'Celine Dion', mode: 'next' },
    'main',
  );
  assert.deepEqual(result, {
    played: 'My Heart Will Go On',
    artist: 'Céline Dion',
    type: 'track',
    method: 'search',
  });
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ}&cid=SEARCHED_TRACKS-my heart will go on&mid=TR-11&aid=2`,
  ]);
});

test('a track by an artist the first search misses: searched again with the artist', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  await assert.rejects(
    playQobuz(ID, { kind: 'track', name: 'my heart will go on', artist: 'Muse' }, 'main'),
    /No Qobuz track named "my heart will go on" by "Muse"/,
  );
  assert.deepEqual(
    sentOf(fake, 'browse/search').map((line) => /search=([^&]*)/.exec(line)[1]),
    ['my heart will go on', 'Muse my heart will go on'],
  );
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
});

test('nothing matching: a clear error, nothing played', async (t) => {
  const fake = await connect(
    t,
    qobuzReceiver({ overrides: { 'browse/search': () => [{ payload: [] }] } }),
  );
  await assert.rejects(
    playQobuz(ID, { kind: 'playlist', name: 'Inconnue' }, 'main'),
    /No Qobuz playlist named "Inconnue"/,
  );
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
  await assert.rejects(playQobuz(ID, { kind: 'album', name: ' ' }, 'main'), /name is required/);
  await assert.rejects(playQobuz(ID, { kind: 'radio', name: 'x' }, 'main'), /Unknown Qobuz kind/);
});

test('the scene action passes kind, artist and mode, and returns what was played', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  setSession(ID, { device: { name: 'Salon' } });
  const handlers = createSceneActionHandlers(() => normalizeConfig());
  const outputs = await handlers.play_qobuz({
    avr: ID,
    kind: 'album',
    name: 'Courage',
    artist: 'Céline Dion',
    mode: 'append',
  });
  assert.deepEqual(outputs, {
    played: 'Courage',
    artist: 'Céline Dion',
    type: 'album',
    method: 'search',
  });
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].endsWith('cid=ALB-2019&aid=3'));
  // A scene saved before 1.3 (no artist, no mode): a playlist, the queue replaced.
  await handlers.play_qobuz({ avr: ID, name: 'Jazz du matin' });
  assert.ok(sentOf(fake, 'browse/add_to_queue')[1].endsWith('cid=PL-1001&aid=4'));
});

test('Qobuz missing or signed out in HEOS: QobuzUnavailableError, and the check says what to do', async (t) => {
  await connect(
    t,
    qobuzReceiver({
      overrides: {
        'browse/get_music_sources': () => [
          { payload: [{ name: 'TuneIn', sid: 3, available: 'true' }] },
        ],
      },
    }),
  );
  await assert.rejects(playQobuz(ID, { name: 'x' }, 'main'), (err) => {
    assert.ok(err instanceof QobuzUnavailableError);
    assert.equal(err.reason, 'missing');
    assert.deepEqual(err.sources, ['TuneIn']);
    return true;
  });
  const check = await runQobuzCheckAction({ fields: { device: ID } });
  assert.match(check.fr, /ne liste pas de source Qobuz.*sources vues : TuneIn/);
  assert.match(check.en, /restart the integration/);
});

test('signed out: the check asks to sign in to Qobuz in the HEOS app', async (t) => {
  await connect(
    t,
    qobuzReceiver({
      overrides: {
        'browse/get_music_sources': () => [
          { payload: [{ name: 'Qobuz', sid: 30, available: 'false' }] },
        ],
      },
    }),
  );
  const check = await runQobuzCheckAction({ fields: { device: ID } });
  assert.match(check.fr, /aucun compte Qobuz n'y est connecté/);
});

test('a refused browse (HEOS account signed out, eid 8) is reported, never hangs', async (t) => {
  await connect(
    t,
    qobuzReceiver({
      overrides: {
        'browse/browse': () => [{ result: 'fail', message: 'eid=8&text=User not logged in' }],
      },
    }),
  );
  await assert.rejects(listQobuzPlaylists(ID, { refresh: true }), (err) => {
    assert.ok(err instanceof HeosCommandError);
    assert.equal(err.eid, 8);
    return true;
  });
  const check = await runQobuzCheckAction({ fields: { device: ID } });
  assert.match(
    check.fr,
    /Impossible de lire Qobuz via HEOS : HEOS refused browse\/browse: User not logged in/,
  );
});

test('the check lists the first level and the playlists found', async (t) => {
  t.mock.method(console, 'log', () => {});
  await connect(t, qobuzReceiver());
  const check = await runQobuzCheckAction({ fields: { device: ID } });
  assert.equal(
    check.fr,
    "Qobuz trouvé (source HEOS 30). Premier niveau : Discover, Library. 2 playlists : Jazz du matin, Café & Soirée. Détails : lignes « Qobuz check » des logs de l'intégration.",
  );
});

test('the check with an artist logs the real structure, never the account, and plays nothing', async (t) => {
  const logged = [];
  t.mock.method(console, 'log', (...args) => logged.push(args.join(' ')));
  const fake = await connect(t, qobuzReceiver());
  const check = await runQobuzCheckAction({ fields: { device: ID, artist: 'Céline Dion' } });
  assert.match(
    check.fr,
    /Artiste « Céline Dion » : dernier album « Courage » \(trouvé par : first_listed\), artiste joué par : top_tracks\./,
  );
  assert.match(check.en, /Artist "Céline Dion": latest album "Courage" \(found by: first_listed\)/);
  const lines = logged.filter((line) => line.includes('Qobuz check'));
  const text = lines.join('\n');
  assert.ok(!text.includes(ACCOUNT), 'the account name is never logged');
  assert.ok(!text.includes('static.qobuz.com'), 'no image URL');
  for (const expected of [
    'sources: [',
    'first level options: []',
    'first level (2 items)',
    '"Library" (3 items, count 3)',
    'search criteria: [{"name":"Artist","scid":1',
    'artist search "Céline Dion" (2 items)',
    'artist "Céline Dion" (3 items, count 3)',
    'album search "Céline Dion"',
    'latest album of "Céline Dion": {"album":"Courage","method":"first_listed"}',
    'artist play "Céline Dion": {"method":"top_tracks"',
  ]) {
    assert.ok(text.includes(expected), `logged: ${expected}\n${text}`);
  }
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [], 'nothing played');
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), []);
});

test('an account name shown anywhere by HEOS is hidden from the check logs', async (t) => {
  const logged = [];
  t.mock.method(console, 'log', (...args) => logged.push(args.join(' ')));
  await connect(
    t,
    qobuzReceiver({
      overrides: {
        'browse/browse': (params) =>
          params.cid
            ? undefined
            : [
                {
                  payload: [
                    {
                      container: 'yes',
                      type: 'container',
                      playable: 'no',
                      cid: 'ME',
                      name: `${ACCOUNT} library`,
                    },
                  ],
                },
              ],
      },
    }),
  );
  await runQobuzCheckAction({ fields: { device: ID } });
  const text = logged.filter((line) => line.includes('Qobuz check')).join('\n');
  assert.ok(text.includes('(account) library'), text);
  assert.ok(!text.includes(ACCOUNT));
});

test('an album inside a "Playlists" container is not taken for a playlist', async (t) => {
  await connect(
    t,
    qobuzReceiver({
      overrides: {
        'browse/browse': (params) =>
          params.cid === 'LIB-PLAYLISTS'
            ? [
                {
                  payload: [
                    {
                      container: 'yes',
                      playable: 'no',
                      type: 'playlist',
                      cid: 'PL-1',
                      name: 'Jazz',
                    },
                    {
                      container: 'yes',
                      playable: 'yes',
                      type: 'album',
                      cid: 'AL-1',
                      name: 'Jazz at Massey Hall',
                    },
                    {
                      container: 'yes',
                      playable: 'yes',
                      type: 'container',
                      cid: 'MIX',
                      name: 'Mix',
                    },
                  ],
                },
              ]
            : undefined,
      },
    }),
  );
  const { playlists } = await listQobuzPlaylists(ID, { refresh: true });
  assert.deepEqual(
    playlists.map((item) => item.cid),
    ['PL-1', 'MIX'],
  );
});

test('the check goes on when one step fails', async (t) => {
  const logged = [];
  t.mock.method(console, 'log', (...args) => logged.push(args.join(' ')));
  await connect(
    t,
    qobuzReceiver({
      artist: 'none',
      overrides: {
        'browse/get_search_criteria': () => [
          { result: 'fail', message: 'eid=4&text=Requested data not available' },
        ],
      },
    }),
  );
  const check = await runQobuzCheckAction({ fields: { device: ID, artist: 'Céline Dion' } });
  assert.match(check.fr, /aucun dernier album trouvé, artiste non jouable/);
  const text = logged.join('\n');
  assert.match(text, /search criteria failed: HEOS refused browse\/get_search_criteria/);
  assert.match(text, /latest album of "Céline Dion" failed/);
});

test('an unanswered request times out instead of blocking the next ones', async (t) => {
  __setTimingForTesting({ heosRequestTimeoutMs: 100 });
  let answered = false;
  await connect(
    t,
    qobuzReceiver({
      overrides: {
        'browse/get_music_sources': () => {
          if (!answered) {
            answered = true;
            return []; // the receiver says nothing the first time
          }
          return undefined;
        },
      },
    }),
  );
  await assert.rejects(
    listQobuzPlaylists(ID),
    /no HEOS answer to browse\/get_music_sources within 100 ms/,
  );
  const { playlists } = await listQobuzPlaylists(ID);
  assert.equal(playlists.length, 2, 'the next request goes through');
});

test('HEOS not connected: Qobuz cannot be used', async () => {
  await assert.rejects(playQobuz('avr:none', { name: 'x' }, 'main'), /cannot use Qobuz/);
});
