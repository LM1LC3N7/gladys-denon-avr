import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Before the imports: where the ad-break statistics go, and no ffmpeg.
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'heos-adbreak-'));
process.env.AD_BREAK_STATS_FILE = path.join(DIR, 'ad-breaks.json');
process.env.AD_BREAK_JINGLES = 'off';
const { openHeosSession, applyConfig } = await import('../src/devices/heos-session.js');
const { onSetValue } = await import('../src/devices/commands.js');
const { playAnnouncement, cancelAnnouncement } = await import('../src/devices/announcements.js');
const { __clearConnectionsForTesting, __setHeosConnectionForTesting } =
  await import('../src/devices/registry.js');
const { normalizeConfig } = await import('../src/config.js');
const { createFakeGladys } = await import('../test-fixtures/fakeGladys.js');

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ID = 'avr:radio';
const AD_BREAK = `${ID}:ad_break`;
const STATION = { type: 'station', station: 'Radio X', mid: 'http://radio.example/live' };

/** A fake HEOS CLI with one player (pid 5): records commands, pushes lines. */
async function startFakeHeos() {
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
            `${JSON.stringify({ heos: { command: 'player/get_players', result: 'success', message: '' }, payload: [{ pid: 5, ip: '127.0.0.1' }] })}\r\n`,
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
    push(command, message, payload) {
      client.write(
        `${JSON.stringify({ heos: { command, result: 'success', message }, payload })}\r\n`,
      );
    },
    close() {
      client?.destroy();
      server.close();
    },
  };
}

test.afterEach(() => __clearConnectionsForTesting());
test.after(() => fs.rm(DIR, { recursive: true, force: true }));

async function playingRadio({ features, config = { ad_break_detection: true } } = {}) {
  const heos = await startFakeHeos();
  const gladys = createFakeGladys();
  const device = { external_id: ID, name: 'Radio', features };
  const settings = normalizeConfig(config);
  const session = openHeosSession(gladys, device, {
    host: '127.0.0.1',
    zone: 'main',
    config: settings,
    isTelnetConnected: () => false,
    onMatchChange: () => {},
    port: heos.port,
  });
  __setHeosConnectionForTesting(ID, session);
  await tick(100);
  heos.push('player/get_volume', 'pid=5&level=50');
  heos.push('player/get_play_state', 'pid=5&state=play');
  heos.push('player/get_now_playing_media', 'pid=5', STATION);
  await tick(100);
  return { heos, gladys, device, session, settings };
}

const setVolumes = (heos) =>
  heos.received.filter((line) => line.startsWith('heos://player/set_volume'));

test('the "Radio ad break" switch lowers the volume over HEOS; stopping the session gives it back', async () => {
  const { heos, gladys, device, session, settings } = await playingRadio({
    features: [{ external_id: AD_BREAK }],
  });
  try {
    await onSetValue(gladys, {
      device,
      feature: { external_id: AD_BREAK },
      value: 1,
      config: settings,
    });
    await tick(50);
    assert.deepEqual(setVolumes(heos), ['heos://player/set_volume?pid=5&level=30']);
    assert.deepEqual(
      gladys.published.filter((p) => p.featureExternalId === AD_BREAK).map((p) => p.state),
      [1, 1],
    );
    applyConfig(settings); // hot reload, same settings: the break goes on
    session.stop();
    await tick(50);
    assert.deepEqual(setVolumes(heos), [
      'heos://player/set_volume?pid=5&level=30',
      'heos://player/set_volume?pid=5&level=50',
    ]);
  } finally {
    session.stop();
    heos.close();
  }
});

test('a device not updated since the feature exists gets no state; an announcement ends the break first', async () => {
  const { heos, gladys, device, session, settings } = await playingRadio({
    features: [{ external_id: `${ID}:power` }],
    config: { ad_break_detection: true, announcement_volume: 60 },
  });
  try {
    await onSetValue(gladys, {
      device,
      feature: { external_id: AD_BREAK },
      value: 1,
      config: settings,
    });
    assert.equal(gladys.published.filter((p) => p.featureExternalId === AD_BREAK).length, 0);
    await tick(50);
    heos.push('event/player_volume_changed', 'pid=5&level=30&mute=off');
    await tick(50);

    const tts = 'http://gladys.local/tts.mp3';
    await playAnnouncement(ID, tts, settings);
    await tick(50);
    const lines = heos.received;
    const restore = lines.indexOf('heos://player/set_volume?pid=5&level=50');
    const stream = lines.findIndex((l) => l.startsWith('heos://browse/play_stream'));
    assert.ok(restore !== -1 && restore < stream, 'volume back before the announcement plays');
    // HEOS now reports the announcement stream: not a station.
    heos.push('player/get_now_playing_media', 'pid=5', { type: 'station', mid: tts });
    await tick(50);
    assert.equal(session.adBreak.providesNowPlaying(), false);
  } finally {
    cancelAnnouncement(ID);
    session.stop();
    heos.close();
  }
});

test('a lost HEOS connection forgets the volume; the switch on an unknown device is refused', async () => {
  const { heos, gladys, session, settings } = await playingRadio();
  try {
    assert.equal(session.volume, 50);
    heos.close();
    await tick(100);
    assert.equal(session.volume, null);
    await assert.rejects(
      onSetValue(gladys, {
        device: { external_id: 'avr:other' },
        feature: { external_id: 'avr:other:ad_break' },
        value: 1,
        config: settings,
      }),
      /not connected/,
    );
  } finally {
    session.stop();
  }
});
