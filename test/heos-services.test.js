import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaItems } from '@gladysassistant/integration-sdk';
import { buildPlayInputCommand } from '../src/heos/protocol.js';
import {
  findService,
  isBrowsable,
  isSpotify,
  searchableCandidates,
  serviceLabel,
  sourceList,
} from '../src/heos/services.js';
import { decodeMediaId } from '../src/heos/media.js';
import { createMusicHandlers } from '../src/devices/music.js';
import { playFromService, ServiceUnavailableError } from '../src/devices/qobuz.js';
import { createSceneActionHandlers } from '../src/scenes/actions.js';
import { __clearConnectionsForTesting, __setTimingForTesting } from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { FAKE_PID as PID, connectFakeHeos, sentOf } from '../test-fixtures/fakeHeos.js';
import { ACCOUNT, QOBUZ, qobuzReceiver } from '../test-fixtures/qobuzReceiver.js';
import {
  DEEZER,
  NAS_SERVER,
  OTHER_PLAYER,
  TIDAL,
  TUNEIN,
  USB_SERVER,
} from '../test-fixtures/heosServices.js';

const ID = 'avr:services';
const DEVICE = { external_id: ID, selector: 'salon', params: [] };

test.afterEach(() => {
  __clearConnectionsForTesting();
});

function setup(config = {}) {
  const gladys = createFakeGladys();
  return { gladys, music: createMusicHandlers(gladys, () => normalizeConfig(config)) };
}

const searchedSids = (fake) =>
  sentOf(fake, 'browse/search').map((line) => Number(/sid=(-?\d+)/.exec(line)[1]));

// --- Pure helpers ------------------------------------------------------------

const LIST = sourceList([
  { name: 'Pandora', sid: 1, available: 'false' },
  { name: 'TuneIn', sid: 3, available: 'true', service_username: ACCOUNT },
  { name: 'Spotify', sid: '4', available: 'true' },
  { name: 'Deezer', sid: 5, available: 'true' },
  { name: 'Tidal', sid: 10, available: 'true' },
  { name: '', sid: 30, available: 'true' },
  { name: 'Local Music', sid: 1024, type: 'heos_server' },
  { name: 'broken', sid: 'x' },
  { name: 'no sid' },
]);

test('the sources list: numeric ids, availability, never the account', () => {
  assert.deepEqual(
    LIST.map((source) => [source.sid, source.available]),
    [
      [1, false],
      [3, true],
      [4, true],
      [5, true],
      [10, true],
      [30, true],
      [1024, true],
    ],
  );
  assert.ok(!JSON.stringify(LIST).includes(ACCOUNT));
  assert.deepEqual(sourceList(undefined), []);
});

test('a service is found by its key, its name, or its spec id when unnamed', () => {
  assert.equal(findService(LIST, 'tidal').sid, 10);
  assert.equal(findService(LIST, 'DEEZER').sid, 5);
  assert.equal(findService(LIST, 'qobuz').sid, 30, 'unnamed id 30');
  assert.equal(findService(LIST, 'amazon'), null);
  assert.equal(findService(LIST, 'Local'), LIST[6], 'a free name');
  assert.equal(findService(LIST, 'local music'), LIST[6]);
  assert.equal(findService(LIST, ''), null);
  const renamed = sourceList([
    { name: 'TIDAL Masters', sid: 99 },
    { name: 'Deezer', sid: 10 },
  ]);
  assert.equal(findService(renamed, 'tidal').sid, 99, 'by name first');
  assert.equal(
    findService(sourceList([{ name: 'Deezer', sid: 10 }]), 'tidal'),
    null,
    'id 10 named Deezer is not TIDAL',
  );
  assert.equal(serviceLabel('iheartradio'), 'iHeartRadio');
  assert.equal(serviceLabel('Other'), 'Other');
});

test('Spotify is listed but not browsable; searchable services in a fixed order', () => {
  assert.equal(isSpotify(LIST[2]), true);
  assert.equal(isBrowsable(LIST[2]), false);
  assert.equal(isBrowsable(LIST[3]), true);
  assert.deepEqual(
    searchableCandidates(LIST).map((source) => source.sid),
    [30, 10, 5, 3],
    'Qobuz, TIDAL, Deezer, then as listed; not signed out, not Spotify, not HEOS sources',
  );
});

test('play_input: the player that has the input only when it is another one', () => {
  assert.equal(
    buildPlayInputCommand(42, 'inputs/aux_in_1', 77),
    'browse/play_input?pid=42&spid=77&input=inputs/aux_in_1',
  );
  assert.equal(
    buildPlayInputCommand(42, 'inputs/aux_in_1', 42),
    'browse/play_input?pid=42&input=inputs/aux_in_1',
  );
  assert.equal(
    buildPlayInputCommand(42, 'inputs/optical_in_1'),
    'browse/play_input?pid=42&input=inputs/optical_in_1',
  );
});

// --- The catalog of every source -----------------------------------------------

async function child(music, parent, title) {
  const page = await music.browse(DEVICE, { parentId: parent?.id ?? null, offset: 0, limit: 50 });
  assert.deepEqual(validateMediaItems(page.items), []);
  const item = page.items.find((entry) => entry.title === title);
  assert.ok(item, `"${title}" in ${page.items.map((entry) => entry.title).join(', ')}`);
  return item;
}

test('Deezer: My Playlists, a playlist played next', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const deezer = await child(music, null, 'Deezer');
  const playlists = await child(music, deezer, 'My Playlists');
  const running = await child(music, playlists, 'Running');
  assert.equal(running.type, 'playlist');
  await music.play(DEVICE, { id: running.id, type: 'playlist' }, 'next');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${DEEZER}&cid=Playlists-9081&aid=2`,
  ]);
});

test('TuneIn: a station browsed in a container is played with that container', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const tunein = await child(music, null, 'TuneIn');
  const local = await child(music, tunein, 'Local Radio');
  const fip = await child(music, local, 'FIP');
  assert.equal(fip.type, 'radio');
  await music.play(DEVICE, { id: fip.id, type: 'radio' }, 'replace');
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), [
    `heos://browse/play_stream?pid=${PID}&sid=${TUNEIN}&cid=LOCAL&mid=s6566&name=FIP`,
  ]);
});

test('Local Music: the media servers are sources of their own, browsed by their id', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const local = await child(music, null, 'Local Music');
  const usb = await child(music, local, 'AVR-S970H USB');
  const nas = await child(music, local, 'Synology');
  assert.deepEqual(
    [usb.type, usb.browsable, usb.playable, decodeMediaId(usb.id).sid, decodeMediaId(nas.id).sid],
    ['folder', true, false, USB_SERVER, NAS_SERVER],
  );
  await child(music, usb, 'Music');
  assert.equal(sentOf(fake, 'browse/browse').at(-1), `heos://browse/browse?sid=${USB_SERVER}`);
});

test('AUX inputs: an input of this player or of another one, played with play_input', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const aux = await child(music, null, 'AUX Input');
  const salon = await child(music, aux, 'Salon');
  const cuisine = await child(music, aux, 'Cuisine');
  const own = await child(music, salon, 'AUX In');
  const other = await child(music, cuisine, 'Optical In');
  await music.play(DEVICE, { id: own.id, type: 'radio' }, 'append');
  await music.play(DEVICE, { id: other.id, type: 'radio' }, 'replace');
  assert.deepEqual(sentOf(fake, 'browse/play_input'), [
    `heos://browse/play_input?pid=${PID}&input=inputs/aux_in_1`,
    `heos://browse/play_input?pid=${PID}&spid=${OTHER_PLAYER}&input=inputs/optical_in_1`,
  ]);
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), [], 'an input is not a station');
});

test('History: a playable container', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  const history = await child(music, null, 'History');
  const tracks = await child(music, history, 'TRACKS');
  assert.equal(tracks.playable, true);
  await music.play(DEVICE, { id: tracks.id, type: 'folder' }, 'replace');
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].endsWith('sid=1026&cid=TRACKS&aid=4'));
});

// --- The search over the services ------------------------------------------------

test('search, automatic: Qobuz only when it is signed in', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup();
  await music.search(DEVICE, { query: 'Céline Dion', type: 'album', limit: 10 });
  assert.deepEqual(searchedSids(fake), [QOBUZ]);
});

test('search, automatic without Qobuz: every service that can search, named in the subtitles', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver({ qobuz: false }));
  const { music } = setup();
  const { items } = await music.search(DEVICE, { query: 'Céline Dion', type: null, limit: 20 });
  assert.deepEqual(
    [...new Set(searchedSids(fake))],
    [TIDAL, DEEZER],
    'TIDAL then Deezer; TuneIn has no artist/album/playlist/track criteria',
  );
  assert.deepEqual(
    items.map((item) => [item.type, item.title, item.subtitle ?? '']),
    [
      ['artist', 'Céline Dion', 'Tidal'],
      ['album', 'Dernier album · Latest album : Céline Dion (Tidal)', 'Céline Dion'],
      ['album', 'Courage (Deluxe Edition)', 'Céline Dion · Tidal'],
    ],
  );
  assert.deepEqual(validateMediaItems(items), []);
  assert.deepEqual(
    sentOf(fake, 'browse/get_search_criteria').map((line) => Number(/sid=(-?\d+)/.exec(line)[1])),
    [TIDAL, DEEZER, TUNEIN],
    'no criteria asked to Spotify, Amazon (signed out) nor the HEOS sources',
  );
});

test('search, a radio in TuneIn; then played', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver({ qobuz: false }));
  const { music } = setup();
  const { items } = await music.search(DEVICE, { query: 'fip', type: 'radio', limit: 10 });
  assert.deepEqual(
    items.map((item) => [item.type, item.title, item.subtitle]),
    [
      ['radio', 'FIP', 'TuneIn'],
      ['radio', 'FIP Rock', 'TuneIn'],
    ],
  );
  assert.deepEqual(searchedSids(fake), [TUNEIN]);
  await music.play(DEVICE, { id: items[0].id, type: 'radio' });
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), [
    `heos://browse/play_stream?pid=${PID}&sid=${TUNEIN}&mid=s6566&name=FIP`,
  ]);
});

test('search, the preferred service only; one not signed in falls back to every service', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const deezer = setup({ music_search_service: 'deezer' }).music;
  const tracks = await deezer.search(DEVICE, { query: 'creep', type: 'track', limit: 10 });
  assert.deepEqual(searchedSids(fake), [DEEZER]);
  assert.equal(tracks.items[0].subtitle, 'Radiohead · Pablo Honey', 'one service: not named');
  await deezer.play(DEVICE, { id: tracks.items[0].id, type: 'track' }, 'append');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${DEEZER}&cid=SEARCHED_TRACKS-creep&mid=138547415&aid=3`,
  ]);
  t.mock.method(console, 'log', () => {});
  const amazon = setup({ music_search_service: 'amazon' }).music;
  await amazon.search(DEVICE, { query: 'creep', type: 'track', limit: 10 });
  assert.deepEqual(searchedSids(fake).slice(1), [QOBUZ, TIDAL, DEEZER]);
});

test('search, every service: Qobuz too, in order', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const { music } = setup({ music_search_service: 'all' });
  await music.search(DEVICE, { query: 'courage', type: 'album', limit: 10 });
  assert.deepEqual(searchedSids(fake), [QOBUZ, TIDAL, DEEZER]);
});

test('search: no service can search, a clear error', async (t) => {
  await connectFakeHeos(
    t,
    ID,
    qobuzReceiver({
      overrides: {
        'browse/get_music_sources': () => [
          { payload: [{ name: 'Amazon', sid: 13, available: 'true' }] },
        ],
      },
    }),
  );
  const { music } = setup();
  await assert.rejects(
    music.search(DEVICE, { query: 'x' }),
    /No signed-in HEOS music service can search/,
  );
});

test('search: past the time budget, no new HEOS search is started', async (t) => {
  __setTimingForTesting({ musicSearchBudgetMs: -1 });
  const fake = await connectFakeHeos(t, ID, qobuzReceiver({ qobuz: false }));
  const { music } = setup();
  await assert.rejects(
    music.search(DEVICE, { query: 'dernier album de Céline Dion', limit: 10 }),
    /HEOS did not answer the search in time \(Gladys waits 10 s\)/,
  );
  assert.deepEqual(searchedSids(fake), []);
  assert.deepEqual(sentOf(fake, 'browse/get_search_criteria'), [], 'not even the criteria');
});

test('"dernier album de …" in TIDAL: offered first, resolved by the album search', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver({ qobuz: false }));
  const { music } = setup();
  const { items } = await music.search(DEVICE, {
    query: 'dernier album de Céline Dion',
    limit: 10,
  });
  assert.equal(items[0].title, 'Dernier album de Céline Dion (Tidal)');
  await music.play(DEVICE, { id: items[0].id, type: 'album' }, 'replace');
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${TIDAL}&cid=LIBALBUM-120914587&aid=4`,
  ]);
});

// --- The scene action ------------------------------------------------------------

test('scene action, any service: an album from TIDAL, a track from Deezer, a TuneIn radio', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const handlers = createSceneActionHandlers(() => normalizeConfig());
  const album = await handlers.play_heos_service({
    avr: ID,
    service: 'tidal',
    kind: 'latest_album',
    name: 'Céline Dion',
  });
  assert.deepEqual(album, {
    played: 'Courage (Deluxe Edition)',
    artist: 'Céline Dion',
    type: 'album',
    method: 'album_search',
    service: 'Tidal',
  });
  const track = await handlers.play_heos_service({
    avr: ID,
    service: 'deezer',
    kind: 'track',
    name: 'Creep',
    artist: 'Radiohead',
    mode: 'next',
  });
  assert.equal(track.played, 'Creep');
  const radio = await handlers.play_heos_service({
    avr: ID,
    service: 'tunein',
    kind: 'radio',
    name: 'fip',
  });
  assert.deepEqual(radio, {
    played: 'FIP',
    artist: '',
    type: 'radio',
    method: 'search',
    service: 'TuneIn',
  });
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${TIDAL}&cid=LIBALBUM-120914587&aid=4`,
    `heos://browse/add_to_queue?pid=${PID}&sid=${DEEZER}&cid=SEARCHED_TRACKS-Creep&mid=138547415&aid=2`,
  ]);
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), [
    `heos://browse/play_stream?pid=${PID}&sid=${TUNEIN}&mid=s6566&name=FIP`,
  ]);
});

test('scene action: a playlist of the user found in the service library (TIDAL My Music)', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const result = await playFromService(ID, { service: 'tidal', name: 'workout' }, 'main');
  assert.equal(result.method, 'library');
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].endsWith('cid=LIBPLAYLIST-5f1a&aid=4'));
});

test('scene action: signed out, missing, Spotify and a missing radio are clear errors', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  await assert.rejects(playFromService(ID, { service: 'amazon', name: 'x' }, 'main'), (err) => {
    assert.ok(err instanceof ServiceUnavailableError);
    assert.equal(err.reason, 'signed_out');
    assert.match(err.message, /Amazon Music is listed by HEOS but not signed in/);
    return true;
  });
  await assert.rejects(
    playFromService(ID, { service: 'soundcloud', name: 'x' }, 'main'),
    /HEOS lists no SoundCloud source/,
  );
  await assert.rejects(
    playFromService(ID, { service: 'Spotify', name: 'x' }, 'main'),
    /Spotify is Spotify Connect only in HEOS/,
  );
  await assert.rejects(
    playFromService(ID, { service: 'tunein', kind: 'radio', name: 'Radio Inconnue' }, 'main'),
    /No TuneIn radio named "Radio Inconnue"/,
  );
  await assert.rejects(
    playFromService(ID, { service: 'tidal', kind: 'video', name: 'x' }, 'main'),
    /Unknown kind "video"/,
  );
  assert.deepEqual(sentOf(fake, 'browse/play_stream'), []);
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
});

test('play_qobuz stays Qobuz: no service field, no radio kind, same outputs', async (t) => {
  await connectFakeHeos(t, ID, qobuzReceiver());
  const handlers = createSceneActionHandlers(() => normalizeConfig());
  const outputs = await handlers.play_qobuz({
    avr: ID,
    kind: 'playlist',
    name: 'Jazz du matin',
    service: 'tidal',
  });
  assert.deepEqual(outputs, {
    played: 'Jazz du matin',
    artist: '',
    type: 'playlist',
    method: 'library',
  });
  await assert.rejects(
    handlers.play_qobuz({ avr: ID, kind: 'radio', name: 'fip' }),
    /Unknown Qobuz kind "radio"/,
  );
});
