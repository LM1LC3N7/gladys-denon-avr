// HEOS-only speakers (forum topic 10722, post 37: a Denon Home 150 with
// port 23 refused): recognized, driven over HEOS only, quiet logs, a nominal
// badge — and never at the expense of an AVR that has Telnet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  HEOS_ONLY_REFUSALS,
  HEOS_ONLY_TELNET_RETRY_MS,
  decideHeosOnly,
  isHeosOnlyModel,
} from '../src/devices/speaker.js';
import { computeTransport } from '../src/devices/transport.js';
import { HEOS_MATCH } from '../src/devices/heos-session.js';
import {
  FEATURE,
  buildDiscoveredDevice,
  buildManualDevice,
  connectDevice,
  disconnectDevice,
  getDeviceSnapshot,
  onSetValue,
  runTestConnectionAction,
  featureExternalId,
  setPower,
  setSource,
  __clearConnectionsForTesting,
} from '../src/devices/avr.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { createTelnetClient } from '../src/denon/telnet.js';
import { normalizeConfig } from '../src/config.js';
import {
  amplifierContent,
  remoteContent,
  radioContent,
  shortcutsContent,
} from '../src/widgets/content.js';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

// connectDevice() reads Deviceinfo.xml and /data (src/devices/power.js):
// neither on this machine's real ports nor in its real /data.
process.env.DENON_DEVICEINFO_PORTS = '';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'denon-speaker-'));
process.env.DENON_POWER_FILE = path.join(dataDir, 'power-modes.json');
test.after(() => fs.rm(dataDir, { recursive: true, force: true }));
test.afterEach(() => __clearConnectionsForTesting());

/** Resolve once `check()` is true, reject past `ms` (a test fails, never hangs). */
async function until(check, ms = 5_000, what = 'condition') {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** A port nothing listens on: connecting is refused (ECONNREFUSED). */
async function refusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A fake HEOS CLI listing one player at 127.0.0.1 with `model`. */
async function fakeHeosSpeaker(t, { model = 'Denon Home 150', pid = 77 } = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        received.push(line);
        const reply = (command, message, payload) =>
          socket.write(
            `${JSON.stringify({ heos: { command, result: 'success', message }, payload })}\r\n`,
          );
        if (line.includes('player/get_players')) {
          reply('player/get_players', '', [{ pid, ip: '127.0.0.1', model, name: 'Salon' }]);
        } else if (line.includes('player/get_volume')) {
          reply('player/get_volume', `pid=${pid}&level=20`);
        } else if (line.includes('player/get_mute')) {
          reply('player/get_mute', `pid=${pid}&state=off`);
        } else if (line.includes('player/get_play_state')) {
          reply('player/get_play_state', `pid=${pid}&state=stop`);
        }
      }
    });
  });
  const port = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(resolve);
      }),
  );
  return { port, received };
}

async function openSpeaker(t, { model, telnetPort } = {}) {
  const heos = await fakeHeosSpeaker(t, { model });
  process.env.DENON_HEOS_PORT = String(heos.port);
  const gladys = createFakeGladys();
  const device = buildManualDevice(gladys, '127.0.0.1');
  const port = telnetPort ?? (await refusedPort());
  connectDevice(gladys, device, normalizeConfig({ port, reconnect_interval_seconds: 1 }));
  t.after(() => disconnectDevice(device.external_id));
  return { gladys, device, heos };
}

// --- Pure rules ---------------------------------------------------------------

test('isHeosOnlyModel: HEOS speakers yes, receivers and amps never', () => {
  for (const model of ['Denon Home 150', 'Denon Home Sound Bar 550', 'HEOS 1', 'HEOS Link HS2']) {
    assert.equal(isHeosOnlyModel(model), true, model);
  }
  for (const model of [
    'HEOS AVR',
    'Denon AVR-X2700H',
    'AVR-S970H',
    'Marantz SR6015',
    'Marantz PM7000N',
    'Marantz NR1711',
    'Marantz CINEMA 50',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isHeosOnlyModel(model), false, String(model));
  }
});

test('decideHeosOnly: Telnet ever up, or HEOS not matched, is never a speaker', () => {
  const base = { telnetEverUp: false, refusals: 1, heosMatched: true, model: 'Denon Home 150' };
  assert.equal(decideHeosOnly(base), true);
  assert.equal(decideHeosOnly({ ...base, telnetEverUp: true }), false);
  assert.equal(decideHeosOnly({ ...base, heosMatched: false }), false);
  assert.equal(decideHeosOnly({ ...base, refusals: 0 }), false);
  // A known AVR with port 23 refused stays an AVR, however long.
  assert.equal(decideHeosOnly({ ...base, model: 'Marantz PM7000N', refusals: 50 }), false);
  // Unknown model: only after HEOS_ONLY_REFUSALS refusals in a row.
  const unknown = { ...base, model: null };
  assert.equal(decideHeosOnly({ ...unknown, refusals: HEOS_ONLY_REFUSALS - 1 }), false);
  assert.equal(decideHeosOnly({ ...unknown, refusals: HEOS_ONLY_REFUSALS }), true);
});

test('computeTransport: a matched HEOS speaker is nominal; an AVR without Telnet stays degraded', () => {
  const base = {
    telnetUp: false,
    telnetFailures: 5,
    heosMatch: HEOS_MATCH.MATCHED,
    host: 'h',
    port: 23,
  };
  assert.deepEqual(computeTransport('s', { ...base, heosOnly: true }), {
    external_id: 's',
    transport: 'local',
  });
  assert.equal(computeTransport('s', { ...base, heosOnly: false }).degraded, true);
  const lost = computeTransport('s', { ...base, heosOnly: true, heosMatch: HEOS_MATCH.NONE });
  assert.equal(lost.transport, 'unreachable');
  assert.match(lost.message.fr, /enceinte HEOS h \(port 1255\)/);
});

test('telnet client: tells a refused port, and takes a longer retry delay when asked', async (t) => {
  const port = await refusedPort();
  const closes = [];
  const client = createTelnetClient({
    host: '127.0.0.1',
    port,
    reconnectIntervalSeconds: 1,
    reconnectDelayMs: () => HEOS_ONLY_TELNET_RETRY_MS,
    onDisconnect: (failures, info) => closes.push({ failures, ...info }),
  });
  t.after(() => client.stop());
  await until(() => closes.length >= 1, 3_000, 'the refused attempt');
  // The second attempt would come after 1 s with the default backoff.
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.deepEqual(closes, [{ failures: 1, refused: true }]);
});

test('telnet client: a port refused again and again logs one warning, not one per attempt', async (t) => {
  const port = await refusedPort();
  const warnings = [];
  const original = console.error;
  console.error = (...args) => {
    const line = args.join(' ');
    if (line.includes(`:${port}`)) {
      warnings.push(line);
    }
    original(...args);
  };
  t.after(() => {
    console.error = original;
  });
  let closes = 0;
  const client = createTelnetClient({
    host: '127.0.0.1',
    port,
    reconnectIntervalSeconds: 1,
    reconnectDelayMs: () => 50,
    onDisconnect: () => {
      closes += 1;
    },
  });
  t.after(() => client.stop());
  await until(() => closes >= 4, 3_000, 'four refused attempts');
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /ECONNREFUSED.*logged once while it repeats/);
});

// --- Discovery ----------------------------------------------------------------

test('Discovery offers a Denon Home only what HEOS can do', () => {
  const gladys = createFakeGladys();
  const speaker = buildDiscoveredDevice(gladys, {
    udn: 'home-1',
    host: '192.168.1.30',
    friendlyName: 'Salon',
    modelName: 'Denon Home 150',
  });
  const keys = speaker.features.map((f) => f.external_id.split(':').pop());
  for (const missing of [FEATURE.POWER, FEATURE.SOURCE, FEATURE.SOUND_MODE, FEATURE.MENU]) {
    assert.ok(!keys.includes(missing), `${missing} is not offered`);
  }
  for (const kept of [
    FEATURE.VOLUME,
    FEATURE.MUTE,
    FEATURE.PLAY,
    FEATURE.PAUSE,
    FEATURE.PLAY_NOTIFICATION,
  ]) {
    assert.ok(keys.includes(kept), `${kept} is offered`);
  }
  const avr = buildDiscoveredDevice(gladys, {
    udn: 'pm-1',
    host: '192.168.1.42',
    friendlyName: 'Ampli',
    modelName: 'Marantz PM7000N',
  });
  assert.ok(
    avr.features.some((f) => f.external_id.endsWith(':power')),
    'an amp keeps its power',
  );
});

// --- End to end, on a fake HEOS speaker with port 23 refused ------------------

test('a Denon Home: HEOS-only after the first refusal, nominal badge, power refused, nothing sent', async (t) => {
  const { gladys, device, heos } = await openSpeaker(t);
  const id = device.external_id;
  await until(() => getDeviceSnapshot(id).heosOnly, 5_000, 'the HEOS-only mode');
  await until(() => gladys.transports.length > 0, 2_000, 'a badge');
  assert.deepEqual(gladys.transports.at(-1), { external_id: id, transport: 'local' });
  assert.ok(
    !gladys.transports.some((entry) => entry.degraded),
    'never the orange dot of a degraded badge',
  );

  const sentBefore = heos.received.length;
  await assert.rejects(
    onSetValue(gladys, {
      device,
      feature: { external_id: featureExternalId(id, FEATURE.POWER) },
      value: 1,
      config: normalizeConfig(),
    }),
    /power on\/off is not available on a HEOS speaker without AVR Control.*nothing sent/,
  );
  await assert.rejects(setPower(id, true, 'main'), /not available on a HEOS speaker/);
  assert.throws(() => setSource(id, 'CD', 'main'), /not available on a HEOS speaker/);
  assert.equal(heos.received.length, sentBefore, 'nothing sent for power or input');
  assert.ok(!gladys.transports.some((entry) => entry.degraded), 'still no orange dot');

  // Volume and playback go through HEOS.
  await onSetValue(gladys, {
    device,
    feature: { external_id: featureExternalId(id, FEATURE.VOLUME) },
    value: 33,
    config: normalizeConfig(),
  });
  await onSetValue(gladys, {
    device,
    feature: { external_id: featureExternalId(id, FEATURE.PLAY) },
    value: 1,
    config: normalizeConfig(),
  });
  await until(
    () => heos.received.some((line) => line.includes('player/set_play_state?pid=77&state=play')),
    2_000,
    'the HEOS play command',
  );
  assert.ok(heos.received.some((line) => line.includes('player/set_volume?pid=77&level=33')));

  // A new Discovery offers the speaker features: "Update" drops power...
  const discovered = await buildDiscoveredDevices(
    { ...gladys, scanNetwork: async () => [] },
    normalizeConfig({ host: '127.0.0.1' }),
  );
  const offered = discovered.find((d) => d.external_id === id);
  assert.ok(offered, 'the manual host is offered');
  assert.ok(!offered.features.some((f) => f.external_id.endsWith(':power')));

  // "Test connection" says what it is and what works.
  const report = await runTestConnectionAction(gladys, { fields: { device: id } });
  assert.match(report.fr, /Enceinte HEOS \(Denon Home 150\).*lecteur 77/);
});

test('an AVR that answers Telnet is never HEOS-only, even if HEOS calls it a Denon Home', async (t) => {
  const sockets = new Set();
  const telnetServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.resume();
  });
  const telnetPort = await listen(telnetServer);
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        telnetServer.close(resolve);
      }),
  );
  const { gladys, device } = await openSpeaker(t, { model: 'Denon Home 150', telnetPort });
  const id = device.external_id;
  await until(() => getDeviceSnapshot(id).telnetConnected, 3_000, 'Telnet up');
  await until(() => getDeviceSnapshot(id).heosConnected, 3_000, 'HEOS matched');
  assert.equal(getDeviceSnapshot(id).heosOnly, false);
  await onSetValue(gladys, {
    device,
    feature: { external_id: featureExternalId(id, FEATURE.POWER) },
    value: 1,
    config: normalizeConfig(),
  });
});

test('an amplifier with port 23 refused (Marantz PM7000N on HEOS) stays an amplifier', async (t) => {
  const { gladys, device } = await openSpeaker(t, { model: 'Marantz PM7000N' });
  const id = device.external_id;
  await until(() => getDeviceSnapshot(id).heosConnected, 3_000, 'HEOS matched');
  await until(
    () => gladys.transports.some((entry) => entry.degraded),
    5_000,
    'the degraded "Telnet unreachable" badge',
  );
  assert.equal(getDeviceSnapshot(id).heosOnly, false);
  await assert.rejects(
    onSetValue(gladys, {
      device,
      feature: { external_id: featureExternalId(id, FEATURE.POWER) },
      value: 1,
      config: normalizeConfig(),
    }),
    /is not connected/,
  );
});

// --- Widgets ------------------------------------------------------------------

function speakerView(state = {}) {
  return {
    externalId: 'avr:home',
    known: true,
    name: 'Denon Home',
    telnetConnected: false,
    heosConnected: true,
    heosOnly: true,
    state: { volume: 20, mute: 0, playback_state: 0, ...state },
    sourceOverrides: {},
  };
}

test('widgets of a HEOS speaker: no power button, only what HEOS can do, state says so', () => {
  const amp = amplifierContent(speakerView());
  assert.deepEqual(validateWidgetContent(amp), []);
  const actions = amp.components.filter((c) => c.type === 'button').map((c) => c.action.key);
  assert.deepEqual(actions, ['play', 'volume_down', 'volume_up', 'mute']);
  const power = amp.components.find((c) => c.type === 'status').items[0];
  assert.deepEqual(power.value, { en: 'Not controllable (HEOS)', fr: 'Non pilotable (HEOS)' });
  assert.equal(
    amplifierContent(speakerView({ playback_state: 1 })).components.find((c) => c.type === 'button')
      .action.key,
    'pause',
  );

  const remote = remoteContent(speakerView(), { key_1: 'volume_down', key_2: 'menu' });
  assert.deepEqual(validateWidgetContent(remote), []);
  assert.deepEqual(
    remote.components.filter((c) => c.type === 'button').map((c) => c.action.key),
    ['volume_down'],
  );
  assert.ok(remote.components.some((c) => c.type === 'text' && /Vol/.test(c.text.en)));

  const shortcuts = shortcutsContent(speakerView(), { slot_1: 'favorite:2' });
  assert.deepEqual(validateWidgetContent(shortcuts), []);
  assert.deepEqual(
    shortcuts.components.filter((c) => c.type === 'button').map((c) => c.action.params.target),
    ['favorite:2'],
  );

  const radio = radioContent(speakerView());
  assert.deepEqual(validateWidgetContent(radio), []);
  assert.ok(!radio.components.some((c) => c.type === 'button'));
});
