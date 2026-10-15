import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  ADD_TO_QUEUE,
  buildAddContainerToQueueCommand,
  buildBrowseCommand,
  buildSearchCommand,
  escapeHeosValue,
  isCommandUnderProcess,
  parseMessage,
} from '../src/heos/protocol.js';
import {
  findQobuzSource,
  fold,
  libraryContainers,
  pickByName,
  pickCriteria,
  browseItems,
} from '../src/heos/qobuz.js';
import { openHeosSession, HeosCommandError } from '../src/devices/heos-session.js';
import { playQobuz, listQobuzPlaylists, QobuzUnavailableError } from '../src/devices/qobuz.js';
import { runQobuzCheckAction } from '../src/devices/actions.js';
import {
  __clearConnectionsForTesting,
  __setHeosConnectionForTesting,
  __setTimingForTesting,
} from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

const ID = 'avr:qobuz';
const PID = 42;
const QOBUZ_SID = 32;
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Pure helpers ------------------------------------------------------------

test('HEOS parameters: & = % escaped, nothing else', () => {
  assert.equal(escapeHeosValue('Café & Soirée = 100%'), 'Café %26 Soirée %3D 100%25');
  assert.equal(
    buildSearchCommand(32, 2, 'Rock & Roll', [0, 19]),
    'browse/search?sid=32&search=Rock %26 Roll&scid=2&range=0,19',
  );
  assert.equal(buildBrowseCommand(32), 'browse/browse?sid=32');
  assert.equal(buildBrowseCommand(32, 'A&B', [0, 49]), 'browse/browse?sid=32&cid=A%26B&range=0,49');
  assert.equal(
    buildAddContainerToQueueCommand(7, 32, 'PL1'),
    `browse/add_to_queue?pid=7&sid=32&cid=PL1&aid=${ADD_TO_QUEUE.REPLACE_AND_PLAY}`,
  );
});

test('"command under process" is recognized (pyheos fixture)', () => {
  const parsed = parseMessage(
    '{"heos": {"command": "player/clear_queue", "result": "success", "message": "command under process&pid=1"}}',
  );
  assert.equal(isCommandUnderProcess(parsed), true);
  assert.equal(isCommandUnderProcess({ message: { pid: '1' } }), false);
});

test('the Qobuz source is found by name, its sign-in read from `available`', () => {
  const payload = [
    { name: 'Pandora', sid: 1, type: 'music_service', available: 'true' },
    { name: 'Qobuz', sid: 32, type: 'music_service', available: 'true', service_username: 'x' },
  ];
  assert.deepEqual(findQobuzSource(payload), { sid: 32, name: 'Qobuz', available: true });
  assert.equal(findQobuzSource([{ name: 'Qobuz', sid: 32, available: 'false' }]).available, false);
  assert.equal(findQobuzSource([{ name: 'TIDAL', sid: 10 }]), null);
  assert.equal(findQobuzSource(undefined), null);
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

test('the containers worth opening: playlists first, then the library-like ones', () => {
  const items = browseItems([
    { container: 'yes', playable: 'no', cid: 'NEW', name: 'Nouveautés' },
    { container: 'yes', playable: 'no', cid: 'LIB', name: 'Ma bibliothèque' },
    { container: 'yes', playable: 'no', cid: 'PL', name: 'Mes playlists' },
    { container: 'yes', playable: 'yes', cid: 'X', type: 'playlist', name: 'Playlist jouable' },
  ]);
  assert.deepEqual(
    libraryContainers(items).map((item) => item.cid),
    ['PL', 'LIB'],
  );
});

test('the search criteria are picked by name', () => {
  const criteria = [
    { name: 'Artist', scid: 1 },
    { name: 'Albums', scid: 2 },
    { name: 'Playlist', scid: 6 },
  ];
  assert.equal(pickCriteria(criteria, 'album'), 2);
  assert.equal(pickCriteria(criteria, 'playlist'), 6);
  assert.equal(pickCriteria([{ name: 'Artist', scid: 1 }], 'album'), null);
});

// --- Against a fake HEOS CLI ---------------------------------------------------

const container = (cid, name) => ({
  container: 'yes',
  type: 'container',
  cid,
  playable: 'no',
  name,
});
const playlist = (cid, name) => ({
  container: 'yes',
  type: 'playlist',
  cid,
  playable: 'yes',
  name,
});

/** The answers of a receiver with Qobuz signed in; `overrides` per command replace them. */
function qobuzReceiver(overrides = {}) {
  return (command, params) => {
    if (overrides[command]) {
      return overrides[command](params);
    }
    switch (command) {
      case 'browse/get_music_sources':
        return [
          {
            payload: [
              { name: 'TuneIn', sid: 3, type: 'music_service', available: 'true' },
              { name: 'Qobuz', sid: QOBUZ_SID, type: 'music_service', available: 'true' },
            ],
          },
        ];
      case 'browse/browse':
        if (!params.cid) {
          // A slow service: the placeholder first, then the answer.
          return [
            { message: `command under process&sid=${QOBUZ_SID}` },
            { payload: [container('MYQ', 'My Qobuz'), container('NEW', 'New releases')] },
          ];
        }
        if (params.cid === 'MYQ') {
          return [{ payload: [container('MYPL', 'My Playlists'), container('ALB', 'Albums')] }];
        }
        if (params.cid === 'MYPL') {
          return [
            {
              payload: [playlist('PL1', 'Jazz du matin'), playlist('PL2', 'Café & Soirée')],
              message: `sid=${QOBUZ_SID}&cid=MYPL&returned=2&count=2`,
            },
          ];
        }
        return [{ payload: [] }];
      case 'browse/get_search_criteria':
        return [
          {
            payload: [
              { name: 'Artist', scid: 1, wildcard: 'no' },
              { name: 'Album', scid: 2, wildcard: 'no' },
              { name: 'Playlist', scid: 6, wildcard: 'no' },
            ],
          },
        ];
      case 'browse/search':
        if (params.scid === '2') {
          return [
            {
              payload: [
                {
                  container: 'yes',
                  type: 'album',
                  cid: 'AL1',
                  playable: 'yes',
                  name: 'Kind of Blue',
                  artist: 'Miles Davis',
                },
              ],
            },
          ];
        }
        return [{ payload: [playlist('CAT1', 'Les essentiels du rock')] }];
      case 'browse/add_to_queue':
        return [{}];
      default:
        return [{}];
    }
  };
}

/** A fake HEOS CLI answering `respond(command, params)` (a list of partial replies). */
async function startFakeHeos(respond) {
  const received = [];
  let client = null;
  const server = net.createServer((socket) => {
    client = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        received.push(line);
        const path = line.replace(/^heos:\/\//, '');
        const [command, query = ''] = path.split('?');
        const params = Object.fromEntries(
          query
            .split('&')
            .filter(Boolean)
            .map((pair) => [
              pair.slice(0, pair.indexOf('=')),
              decodeURIComponent(pair.slice(pair.indexOf('=') + 1)),
            ]),
        );
        const replies =
          command === 'player/get_players'
            ? [{ payload: [{ pid: PID, ip: '127.0.0.1', name: 'Salon' }] }]
            : respond(command, params);
        for (const reply of replies ?? []) {
          const echoed = Object.entries(params)
            .filter(([key]) => ['pid', 'sid', 'cid', 'scid', 'aid'].includes(key))
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join('&');
          socket.write(
            `${JSON.stringify({
              heos: {
                command,
                result: reply.result ?? 'success',
                message: reply.message ?? echoed,
              },
              ...(reply.payload ? { payload: reply.payload } : {}),
            })}\r\n`,
          );
        }
      }
    });
  });
  const port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
  return {
    port,
    received,
    close() {
      client?.destroy();
      server.close();
    },
  };
}

/** A matched HEOS session of `ID` against the fake, registered like a real one. */
async function connect(t, respond) {
  const fake = await startFakeHeos(respond);
  const session = openHeosSession(
    createFakeGladys(),
    { external_id: ID, name: 'Salon' },
    {
      host: '127.0.0.1',
      zone: 'main',
      config: normalizeConfig(),
      isTelnetConnected: () => false,
      port: fake.port,
    },
  );
  __setHeosConnectionForTesting(ID, session);
  t.after(() => {
    session.stop();
    fake.close();
  });
  for (let i = 0; i < 50 && session.pid == null; i += 1) {
    await tick(10);
  }
  assert.equal(session.pid, PID);
  return fake;
}

const sentOf = (fake, prefix) =>
  fake.received.filter((line) => line.startsWith(`heos://${prefix}`));

test.afterEach(() => {
  __clearConnectionsForTesting();
});

test('a playlist of the library: My Qobuz > My Playlists, played by its name, the queue replaced', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(ID, { kind: 'playlist', name: 'jazz DU matin' }, 'main');
  assert.deepEqual(result, { played: 'Jazz du matin', artist: '' });
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), [
    `heos://browse/add_to_queue?pid=${PID}&sid=${QOBUZ_SID}&cid=PL1&aid=4`,
  ]);
  assert.deepEqual(sentOf(fake, 'browse/search'), [], 'found in the library, no search');
  // The library is cached: a second scene does not browse it again.
  const browses = sentOf(fake, 'browse/browse').length;
  await playQobuz(ID, { kind: 'playlist', name: 'café & soirée' }, 'main');
  assert.equal(sentOf(fake, 'browse/browse').length, browses);
  assert.ok(sentOf(fake, 'browse/add_to_queue')[1].includes('cid=PL2'));
});

test('a playlist not in the library comes from the catalog search', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(ID, { kind: 'playlist', name: 'essentiels du rock' }, 'main');
  assert.equal(result.played, 'Les essentiels du rock');
  assert.ok(sentOf(fake, 'browse/search')[0].includes('&scid=6'), 'the Playlist criteria');
  assert.ok(sentOf(fake, 'browse/add_to_queue')[0].includes('cid=CAT1'));
});

test('an album: the catalog search, with its artist', async (t) => {
  const fake = await connect(t, qobuzReceiver());
  const result = await playQobuz(ID, { kind: 'album', name: 'kind of blue' }, 'main');
  assert.deepEqual(result, { played: 'Kind of Blue', artist: 'Miles Davis' });
  assert.ok(sentOf(fake, 'browse/search')[0].includes('search=kind of blue&scid=2'));
  assert.deepEqual(sentOf(fake, 'browse/browse'), [], 'an album never browses the library');
});

test('nothing matching: a clear error, nothing played', async (t) => {
  const fake = await connect(t, qobuzReceiver({ 'browse/search': () => [{ payload: [] }] }));
  await assert.rejects(
    playQobuz(ID, { kind: 'playlist', name: 'Inconnue' }, 'main'),
    /No Qobuz playlist named "Inconnue"/,
  );
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
  await assert.rejects(playQobuz(ID, { kind: 'album', name: ' ' }, 'main'), /name is required/);
  await assert.rejects(playQobuz(ID, { kind: 'track', name: 'x' }, 'main'), /Unknown Qobuz kind/);
});

test('Qobuz missing or signed out in HEOS: QobuzUnavailableError, and the check says what to do', async (t) => {
  await connect(
    t,
    qobuzReceiver({
      'browse/get_music_sources': () => [
        { payload: [{ name: 'TuneIn', sid: 3, available: 'true' }] },
      ],
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
      'browse/get_music_sources': () => [
        { payload: [{ name: 'Qobuz', sid: 32, available: 'false' }] },
      ],
    }),
  );
  const check = await runQobuzCheckAction({ fields: { device: ID } });
  assert.match(check.fr, /aucun compte Qobuz n'y est connecté/);
});

test('a refused browse (HEOS account signed out, eid 8) is reported, never hangs', async (t) => {
  await connect(
    t,
    qobuzReceiver({
      'browse/browse': () => [{ result: 'fail', message: 'eid=8&text=User not logged in' }],
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
  await connect(t, qobuzReceiver());
  const check = await runQobuzCheckAction({ fields: { device: ID } });
  assert.equal(
    check.fr,
    'Qobuz trouvé (source HEOS 32). Premier niveau : My Qobuz, New releases. 2 playlists : Jazz du matin, Café & Soirée.',
  );
});

test('an unanswered request times out instead of blocking the next ones', async (t) => {
  __setTimingForTesting({ heosRequestTimeoutMs: 100 });
  let answered = false;
  await connect(
    t,
    qobuzReceiver({
      'browse/get_music_sources': () => {
        if (!answered) {
          answered = true;
          return []; // the receiver says nothing the first time
        }
        return [{ payload: [{ name: 'Qobuz', sid: 32, available: 'true' }] }];
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
