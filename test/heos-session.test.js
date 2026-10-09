import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openHeosSession, HEOS_MATCH, STREAM_RESULT_KEY } from '../src/devices/heos-session.js';
import {
  __clearConnectionsForTesting,
  getState,
  onDeviceStateChange,
} from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

const DEVICE = { external_id: 'avr:heos', name: 'Denon Home' };
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake HEOS CLI: answers get_players with `players`, records every
 * command, and lets the test push raw JSON lines.
 */
async function startFakeHeos(players) {
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
        if (line.includes('player/get_players')) {
          socket.write(
            `${JSON.stringify({ heos: { command: 'player/get_players', result: 'success', message: '' }, payload: players })}\r\n`,
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
    push(heos, payload) {
      client.write(`${JSON.stringify({ heos, payload })}\r\n`);
    },
    close() {
      client?.destroy();
      server.close();
    },
  };
}

test.afterEach(() => {
  __clearConnectionsForTesting();
});

test('a HEOS-only speaker: matched, then volume/mute events, stream results and now-playing re-fetch', async () => {
  const heosServer = await startFakeHeos([{ pid: 77, ip: '127.0.0.1', name: 'Denon Home' }]);
  const gladys = createFakeGladys();
  const matches = [];
  const notified = [];
  const unsubscribe = onDeviceStateChange((id, key, value) => notified.push([key, value]));
  const session = openHeosSession(gladys, DEVICE, {
    host: '127.0.0.1',
    zone: 'main',
    config: normalizeConfig(),
    isTelnetConnected: () => false,
    onMatchChange: (match) => matches.push(match),
    port: heosServer.port,
  });
  try {
    await tick(150);
    assert.equal(session.pid, 77);
    assert.deepEqual(matches, [HEOS_MATCH.MATCHED]);
    assert.ok(heosServer.received.includes('heos://player/get_volume?pid=77'));

    heosServer.push({
      command: 'event/player_volume_changed',
      message: 'pid=77&level=33&mute=on',
    });
    heosServer.push({ command: 'event/player_volume_changed', message: 'pid=12&level=99' });
    heosServer.push({
      command: 'browse/play_stream',
      result: 'fail',
      message: 'pid=77&eid=2&text=bad',
    });
    heosServer.push({ command: 'browse/play_stream', result: 'success', message: 'pid=77' });
    heosServer.push({ command: 'browse/play_preset', result: 'success', message: 'pid=77' });
    heosServer.push({ command: 'event/player_now_playing_changed', message: 'pid=77' });
    await tick(150);

    assert.equal(getState(DEVICE.external_id).volume, 33, 'another pid is ignored');
    assert.equal(getState(DEVICE.external_id).mute, 1);
    assert.deepEqual(
      gladys.published.map((p) => [p.featureExternalId, p.state]),
      [
        ['avr:heos:volume', 33],
        ['avr:heos:mute', 1],
      ],
    );
    assert.deepEqual(
      notified.filter(([key]) => key === STREAM_RESULT_KEY).map(([, value]) => value),
      ['fail', 'ok'],
    );
    assert.equal(
      heosServer.received.filter((line) => line === 'heos://player/get_now_playing_media?pid=77')
        .length,
      2,
      'fetched once on match, once more on the change event',
    );

    heosServer.close();
    await tick(100);
    assert.equal(session.pid, null);
    assert.deepEqual(matches, [HEOS_MATCH.MATCHED, HEOS_MATCH.NONE]);
  } finally {
    unsubscribe();
    session.stop();
    heosServer.close();
  }
});

test('HEOS answering with no player at our IP reports UNMATCHED; Telnet up keeps volume off HEOS', async () => {
  const heosServer = await startFakeHeos([{ pid: 1, ip: '10.9.9.9' }]);
  const gladys = createFakeGladys();
  const matches = [];
  const session = openHeosSession(gladys, DEVICE, {
    host: '127.0.0.1',
    zone: 'main',
    config: normalizeConfig(),
    isTelnetConnected: () => true,
    onMatchChange: (match) => matches.push(match),
    port: heosServer.port,
  });
  try {
    await tick(150);
    assert.equal(session.pid, null);
    assert.deepEqual(matches, [HEOS_MATCH.UNMATCHED]);
    session.forget('anything');
  } finally {
    session.stop();
    heosServer.close();
  }
});
