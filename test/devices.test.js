import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  FEATURE,
  featureExternalId,
  buildDiscoveredDevice,
  buildManualDevice,
  connectDevice,
  disconnectDevice,
  onSetValue,
  runTestConnectionAction,
  runSelectSourceAction,
  __setConnectionForTesting,
  __setLastKnownStateForTesting,
  __clearConnectionsForTesting,
} from '../src/devices/avr.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

const gladys = createFakeGladys();

const DISCOVERED = {
  udn: 'abc-123',
  host: '192.168.1.50',
  friendlyName: 'Denon AVR-S970H',
  modelName: 'AVR-S970H',
};

test.afterEach(() => {
  __clearConnectionsForTesting();
});

function createFakeTelnetClient() {
  const sent = [];
  let connected = true;
  return {
    sent,
    send(command) {
      if (!connected) {
        return false;
      }
      sent.push(command);
      return true;
    },
    isConnected: () => connected,
    stop: () => {
      connected = false;
    },
    setConnected(value) {
      connected = value;
    },
  };
}

test('buildDiscoveredDevice exposes power/volume/mute/source with the right categories', () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  assert.equal(device.name, 'Denon AVR-S970H (AVR-S970H)');
  assert.ok(device.external_id.includes('abc-123'));
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '192.168.1.50' }]);
  assert.equal(device.features.length, 10);

  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id, f]));
  const power = byKey[featureExternalId(device.external_id, FEATURE.POWER)];
  assert.equal(power.category, DEVICE_FEATURE_CATEGORIES.TELEVISION);
  assert.equal(power.type, DEVICE_FEATURE_TYPES.TELEVISION.BINARY);
  assert.equal(power.read_only, false);
  assert.equal(power.min, 0);
  assert.equal(power.max, 1);

  const volume = byKey[featureExternalId(device.external_id, FEATURE.VOLUME)];
  assert.equal(volume.type, DEVICE_FEATURE_TYPES.TELEVISION.VOLUME);
  assert.equal(volume.unit, DEVICE_FEATURE_UNITS.PERCENT);
  assert.equal(volume.min, 0);
  assert.equal(volume.max, 100);

  const mute = byKey[featureExternalId(device.external_id, FEATURE.MUTE)];
  assert.equal(mute.type, DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_MUTE);
  assert.equal(mute.min, 0);
  assert.equal(mute.max, 1);

  const source = byKey[featureExternalId(device.external_id, FEATURE.SOURCE)];
  assert.equal(source.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(source.type, 'select'); // TEXT.SELECT, not in this SDK version's constants
  assert.equal(source.read_only, false, 'the dashboard dropdown sets the source directly');
  assert.equal(source.min, 0);
  assert.equal(source.max, 1);
  assert.ok(Array.isArray(source.supported_options) && source.supported_options.length > 0);
  assert.deepEqual(source.supported_options[0], { value: 'PHONO', label: 'PHONO' });
  // Every SI code must be representable, and only once.
  const optionValues = source.supported_options.map((o) => o.value);
  assert.equal(new Set(optionValues).size, optionValues.length);

  const soundMode = byKey[featureExternalId(device.external_id, FEATURE.SOUND_MODE)];
  assert.equal(soundMode.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(soundMode.type, 'select');
  assert.equal(soundMode.read_only, false);
  assert.ok(soundMode.supported_options.length > 0);

  for (const key of [FEATURE.PLAY, FEATURE.PAUSE, FEATURE.NEXT, FEATURE.PREVIOUS]) {
    const button = byKey[featureExternalId(device.external_id, key)];
    assert.equal(button.category, DEVICE_FEATURE_CATEGORIES.MUSIC, `${key} is a MUSIC feature`);
    assert.equal(button.read_only, false, `${key} must be controllable to appear as a button`);
  }

  const nowPlaying = byKey[featureExternalId(device.external_id, FEATURE.NOW_PLAYING)];
  assert.equal(nowPlaying.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(nowPlaying.type, DEVICE_FEATURE_TYPES.TEXT.TEXT);
  assert.equal(
    nowPlaying.read_only,
    true,
    'now playing is receiver-pushed only, never set by the user',
  );
});

test('buildDiscoveredDevice applies source_overrides: renames one entry, hides another, leaves the rest untouched', () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED, { 'SAT/CBL': 'Chromecast', GAME: '' });
  const source = device.features.find(
    (f) => f.external_id === featureExternalId(device.external_id, FEATURE.SOURCE),
  );
  const byValue = Object.fromEntries(source.supported_options.map((o) => [o.value, o]));

  assert.equal(
    byValue['SAT/CBL'].label,
    'Chromecast',
    'renamed, value (the SI code sent over Telnet) unchanged',
  );
  assert.equal(byValue.GAME, undefined, 'hidden entries are dropped entirely, not just relabeled');
  assert.equal(
    byValue.TUNER.label,
    'TUNER',
    'an entry with no override keeps its SI code as the label',
  );
});

test('every feature declares a non-null min/max (Gladys rejects a null one at "add device" time, not at publish)', () => {
  for (const device of [
    buildDiscoveredDevice(gladys, DISCOVERED),
    buildManualDevice(gladys, '192.168.1.77'),
  ]) {
    for (const feature of device.features) {
      assert.notEqual(feature.min, undefined, `${feature.name}.min must be set`);
      assert.notEqual(feature.max, undefined, `${feature.name}.max must be set`);
    }
  }
});

test('buildManualDevice builds a stable device keyed on the configured host', () => {
  const device = buildManualDevice(gladys, '192.168.1.77');
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '192.168.1.77' }]);
  assert.equal(device.features.length, 10);
});

test('onSetValue routes power/volume to the right telnet command', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);

  const powerFeature = { external_id: featureExternalId(device.external_id, FEATURE.POWER) };
  await onSetValue(gladys, { device, feature: powerFeature, value: 1 });
  assert.equal(telnet.sent.at(-1), 'PWON');

  const volumeFeature = { external_id: featureExternalId(device.external_id, FEATURE.VOLUME) };
  await onSetValue(gladys, { device, feature: volumeFeature, value: 50 });
  assert.equal(telnet.sent.at(-1), 'MV49');
});

test("onSetValue toggles mute off the receiver's last-reported state, ignoring the incoming value", async () => {
  // TELEVISION.VOLUME_MUTE is a remote-control button, not a stateful
  // switch: Gladys sends a "pressed" signal, not a target on/off value —
  // this is exactly the bug a real receiver surfaced (every press sent the
  // same command). `value` must have zero effect on which command is sent.
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);
  const muteFeature = { external_id: featureExternalId(device.external_id, FEATURE.MUTE) };

  __setLastKnownStateForTesting(device.external_id, { mute: 0 });
  await onSetValue(gladys, { device, feature: muteFeature, value: 0 });
  assert.equal(telnet.sent.at(-1), 'MUON');

  __setLastKnownStateForTesting(device.external_id, { mute: 1 });
  await onSetValue(gladys, { device, feature: muteFeature, value: 0 });
  assert.equal(telnet.sent.at(-1), 'MUOFF');

  // Nothing known yet (fresh device, receiver hasn't reported a state):
  // defaults to "currently unmuted" -> first press mutes.
  __setLastKnownStateForTesting(device.external_id, undefined);
  await onSetValue(gladys, { device, feature: muteFeature, value: 1 });
  assert.equal(telnet.sent.at(-1), 'MUON');
});

test('onSetValue routes the source dropdown to SI<code>, using the value as-is (a string, not a number)', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);
  const sourceFeature = { external_id: featureExternalId(device.external_id, FEATURE.SOURCE) };

  await onSetValue(gladys, { device, feature: sourceFeature, value: 'NET' });
  assert.equal(telnet.sent.at(-1), 'SINET');
});

test('onSetValue routes the sound mode dropdown to MS<mode>', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);
  const soundModeFeature = {
    external_id: featureExternalId(device.external_id, FEATURE.SOUND_MODE),
  };

  await onSetValue(gladys, { device, feature: soundModeFeature, value: 'MOVIE' });
  assert.equal(telnet.sent.at(-1), 'MSMOVIE');
});

test('onSetValue routes the transport buttons to their fixed NS9x command, ignoring the value', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);

  const cases = [
    [FEATURE.PLAY, 'NS9A'],
    [FEATURE.PAUSE, 'NS9B'],
    [FEATURE.NEXT, 'NS9D'],
    [FEATURE.PREVIOUS, 'NS9E'],
  ];
  for (const [key, expectedCommand] of cases) {
    const feature = { external_id: featureExternalId(device.external_id, key) };
    await onSetValue(gladys, { device, feature, value: 1 });
    assert.equal(telnet.sent.at(-1), expectedCommand, `${key} -> ${expectedCommand}`);
  }
});

test('onSetValue throws when the device has no open connection', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const powerFeature = { external_id: featureExternalId(device.external_id, FEATURE.POWER) };
  await assert.rejects(() => onSetValue(gladys, { device, feature: powerFeature, value: 1 }));
});

test('runSelectSourceAction sends SI<code> and reports it back', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);

  const message = await runSelectSourceAction(gladys, {
    fields: { device: device.external_id, source: 'TUNER' },
  });
  assert.equal(telnet.sent.at(-1), 'SITUNER');
  assert.match(message.en, /TUNER/);
});

test('runSelectSourceAction throws when not connected', async () => {
  await assert.rejects(() =>
    runSelectSourceAction(gladys, { fields: { device: 'unknown', source: 'TUNER' } }),
  );
});

test('runTestConnectionAction reports "not connected" without a session', async () => {
  const message = await runTestConnectionAction(gladys, { fields: { device: 'unknown' } });
  assert.match(message.en, /not connected/i);
});

test('disconnectDevice makes onSetValue fail again', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  __setConnectionForTesting(device.external_id, createFakeTelnetClient());
  disconnectDevice(device.external_id);
  const powerFeature = { external_id: featureExternalId(device.external_id, FEATURE.POWER) };
  await assert.rejects(() => onSetValue(gladys, { device, feature: powerFeature, value: 1 }));
});

// End-to-end: connectDevice() against a real (local, fake) AVR Telnet
// server, exercising the whole push path down to gladys.publishState() and
// the "Test connection" action's summary.
test('connectDevice publishes the state pushed by a real Telnet session', async () => {
  const server = net.createServer((socket) => {
    socket.write('PWON\rMV50\rMUOFF\rSITUNER\rMSMOVIE\rNSE1Come Away With Me\rNSE2Norah Jones\r');
  });
  const port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );

  const device = buildDiscoveredDevice(gladys, { ...DISCOVERED, host: '127.0.0.1' });
  const localConfig = normalizeConfig({ port });

  try {
    connectDevice(gladys, device, localConfig);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const powerId = featureExternalId(device.external_id, FEATURE.POWER);
    const volumeId = featureExternalId(device.external_id, FEATURE.VOLUME);
    const sourceId = featureExternalId(device.external_id, FEATURE.SOURCE);
    const soundModeId = featureExternalId(device.external_id, FEATURE.SOUND_MODE);
    const nowPlayingId = featureExternalId(device.external_id, FEATURE.NOW_PLAYING);
    assert.ok(gladys.published.some((p) => p.featureExternalId === powerId && p.state === 1));
    assert.ok(gladys.published.some((p) => p.featureExternalId === volumeId));
    assert.ok(
      gladys.published.some((p) => p.featureExternalId === sourceId && p.state?.text === 'TUNER'),
    );
    assert.ok(
      gladys.published.some(
        (p) => p.featureExternalId === soundModeId && p.state?.text === 'MOVIE',
      ),
    );
    assert.ok(
      gladys.published.some(
        (p) =>
          p.featureExternalId === nowPlayingId &&
          p.state?.text === 'Norah Jones - Come Away With Me',
      ),
      'now playing combines artist and title regardless of the order the two lines arrive in',
    );

    const message = await runTestConnectionAction(gladys, {
      fields: { device: device.external_id },
    });
    assert.match(message.en, /Power: ON/);
    assert.match(message.en, /TUNER/);
  } finally {
    disconnectDevice(device.external_id);
    server.close();
  }
});
