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
  __setHeosConnectionForTesting,
  __setHeosPollIntervalMsForTesting,
  __clearConnectionsForTesting,
} from '../src/devices/avr.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { HEOS_PORT } from '../src/heos/protocol.js';

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
  assert.equal(device.features.length, 23);

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

  const sourceIndex = byKey[featureExternalId(device.external_id, FEATURE.SOURCE_INDEX)];
  assert.equal(sourceIndex.category, DEVICE_FEATURE_CATEGORIES.TELEVISION);
  assert.equal(sourceIndex.type, DEVICE_FEATURE_TYPES.SENSOR.INTEGER);
  assert.equal(sourceIndex.read_only, false);
  assert.equal(sourceIndex.min, 0);
  assert.equal(
    sourceIndex.max,
    source.supported_options.length - 1,
    'bounds match the number of visible dropdown entries, index 0-based',
  );

  const soundMode = byKey[featureExternalId(device.external_id, FEATURE.SOUND_MODE)];
  assert.equal(soundMode.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(soundMode.type, 'select');
  assert.equal(soundMode.read_only, false);
  assert.ok(soundMode.supported_options.length > 0);

  // Setup-menu remote-control keys: TELEVISION-category push buttons, no
  // dashboard box required (unlike MUSIC) — see the comment on REMOTE_KEYS
  // in src/devices/avr.js.
  const remoteKeyCases = [
    [FEATURE.CURSOR_UP, DEVICE_FEATURE_TYPES.TELEVISION.UP],
    [FEATURE.CURSOR_DOWN, DEVICE_FEATURE_TYPES.TELEVISION.DOWN],
    [FEATURE.CURSOR_LEFT, DEVICE_FEATURE_TYPES.TELEVISION.LEFT],
    [FEATURE.CURSOR_RIGHT, DEVICE_FEATURE_TYPES.TELEVISION.RIGHT],
    [FEATURE.ENTER, DEVICE_FEATURE_TYPES.TELEVISION.ENTER],
    [FEATURE.RETURN, DEVICE_FEATURE_TYPES.TELEVISION.RETURN],
    [FEATURE.INFO, DEVICE_FEATURE_TYPES.TELEVISION.INFO],
    [FEATURE.VOLUME_UP, DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_UP],
    [FEATURE.VOLUME_DOWN, DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_DOWN],
  ];
  for (const [key, type] of remoteKeyCases) {
    const feature = byKey[featureExternalId(device.external_id, key)];
    assert.equal(
      feature.category,
      DEVICE_FEATURE_CATEGORIES.TELEVISION,
      `${key} is a TELEVISION feature`,
    );
    assert.equal(feature.type, type, `${key} has the right push-button type`);
    assert.equal(feature.read_only, false, `${key} must be controllable to appear as a button`);
    assert.equal(feature.has_feedback, false, `${key} is fire-and-forget, no state to report back`);
  }

  // Menu is the one remote key that's a real toggle, not a fire-and-forget
  // press — see the comment on it in buildFeatures().
  const menu = byKey[featureExternalId(device.external_id, FEATURE.MENU)];
  assert.equal(menu.category, DEVICE_FEATURE_CATEGORIES.TELEVISION);
  assert.equal(menu.type, DEVICE_FEATURE_TYPES.TELEVISION.MENU);
  assert.equal(menu.read_only, false);
  assert.equal(
    menu.has_feedback,
    true,
    'unlike the other remote keys, Menu reports its open/closed state',
  );

  for (const key of [FEATURE.PLAY, FEATURE.PAUSE, FEATURE.NEXT, FEATURE.PREVIOUS]) {
    const button = byKey[featureExternalId(device.external_id, key)];
    assert.equal(button.category, DEVICE_FEATURE_CATEGORIES.MUSIC, `${key} is a MUSIC feature`);
    assert.equal(button.read_only, false, `${key} must be controllable to appear as a button`);
  }

  // Required by Gladys' Music dashboard box, not just informational — see
  // the comment above this feature in src/devices/avr.js: without it, the
  // box crashes during its own init and Play/Previous/Next never work.
  const playbackState = byKey[featureExternalId(device.external_id, FEATURE.PLAYBACK_STATE)];
  assert.equal(playbackState.category, DEVICE_FEATURE_CATEGORIES.MUSIC);
  assert.equal(playbackState.type, DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE);
  assert.equal(playbackState.read_only, true);

  const nowPlaying = byKey[featureExternalId(device.external_id, FEATURE.NOW_PLAYING)];
  assert.equal(nowPlaying.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(nowPlaying.type, DEVICE_FEATURE_TYPES.TEXT.TEXT);
  assert.equal(
    nowPlaying.read_only,
    true,
    'now playing is receiver-pushed only, never set by the user',
  );

  // Backs Gladys' "Speak on a speaker" scene action — its device picker
  // filters on exactly this category+type, see the comment on this feature
  // in src/devices/avr.js.
  const playNotification = byKey[featureExternalId(device.external_id, FEATURE.PLAY_NOTIFICATION)];
  assert.equal(playNotification.category, DEVICE_FEATURE_CATEGORIES.MUSIC);
  assert.equal(playNotification.type, DEVICE_FEATURE_TYPES.MUSIC.PLAY_NOTIFICATION);
  assert.equal(playNotification.read_only, false);
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

  const sourceIndex = device.features.find(
    (f) => f.external_id === featureExternalId(device.external_id, FEATURE.SOURCE_INDEX),
  );
  assert.equal(
    sourceIndex.max,
    source.supported_options.length - 1,
    'hiding GAME shrinks the visible list, so source_index bounds must shrink too',
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
  assert.equal(device.features.length, 23);
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

test('onSetValue routes source_index to the SI<code> of the visible entry at that position', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);
  const indexFeature = {
    external_id: featureExternalId(device.external_id, FEATURE.SOURCE_INDEX),
  };

  // Index 0 with no overrides is the first entry declared in buildFeatures()
  // (PHONO, per the "exposes power/volume/mute/source" test above).
  await onSetValue(gladys, { device, feature: indexFeature, value: 0 });
  assert.equal(telnet.sent.at(-1), 'SIPHONO');

  // With SAT/CBL hidden, the config threaded through onSetValue must use
  // the same shrunk/renumbered list as buildFeatures() did for this device
  // — index 5 (SAT/CBL's un-hidden position) now lands on the next entry.
  const config = { sourceOverrides: { 'SAT/CBL': '' } };
  await onSetValue(gladys, { device, feature: indexFeature, value: 5, config });
  assert.equal(
    telnet.sent.at(-1),
    'SIMPLAY',
    'MPLAY shifted down to index 5 once SAT/CBL is hidden',
  );
});

test('onSetValue rejects a source_index outside the visible range', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);
  const indexFeature = {
    external_id: featureExternalId(device.external_id, FEATURE.SOURCE_INDEX),
  };

  await assert.rejects(() => onSetValue(gladys, { device, feature: indexFeature, value: 999 }));
  await assert.rejects(() => onSetValue(gladys, { device, feature: indexFeature, value: -1 }));
  await assert.rejects(() =>
    onSetValue(gladys, { device, feature: indexFeature, value: 'not-a-number' }),
  );
  assert.deepEqual(telnet.sent, [], 'an out-of-range/invalid index must never reach the receiver');
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

test('onSetValue routes the Setup-menu remote keys to their fixed MN command, ignoring the value', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);

  const cases = [
    [FEATURE.CURSOR_UP, 'MNCUP'],
    [FEATURE.CURSOR_DOWN, 'MNCDN'],
    [FEATURE.CURSOR_LEFT, 'MNCLT'],
    [FEATURE.CURSOR_RIGHT, 'MNCRT'],
    [FEATURE.ENTER, 'MNENT'],
    [FEATURE.RETURN, 'MNRTN'],
    [FEATURE.INFO, 'MNINF'],
    [FEATURE.VOLUME_UP, 'MVUP'],
    [FEATURE.VOLUME_DOWN, 'MVDOWN'],
  ];
  for (const [key, expectedCommand] of cases) {
    const feature = { external_id: featureExternalId(device.external_id, key) };
    await onSetValue(gladys, { device, feature, value: 1 });
    assert.equal(telnet.sent.at(-1), expectedCommand, `${key} -> ${expectedCommand}`);
  }
});

test("onSetValue toggles Menu off the receiver's last-reported state, ignoring the incoming value", async () => {
  // Same toggle rationale as Mute: a single button press is a "pressed"
  // signal, not a target open/closed state.
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);
  const menuFeature = { external_id: featureExternalId(device.external_id, FEATURE.MENU) };

  __setLastKnownStateForTesting(device.external_id, { menu: 0 });
  await onSetValue(gladys, { device, feature: menuFeature, value: 0 });
  assert.equal(telnet.sent.at(-1), 'MNMEN ON');

  __setLastKnownStateForTesting(device.external_id, { menu: 1 });
  await onSetValue(gladys, { device, feature: menuFeature, value: 0 });
  assert.equal(telnet.sent.at(-1), 'MNMEN OFF');

  // Nothing known yet: defaults to "currently closed" -> first press opens.
  __setLastKnownStateForTesting(device.external_id, undefined);
  await onSetValue(gladys, { device, feature: menuFeature, value: 1 });
  assert.equal(telnet.sent.at(-1), 'MNMEN ON');
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

test('onSetValue routes the transport buttons to HEOS when a player id is known and connected', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);

  const heosSent = [];
  __setHeosConnectionForTesting(device.external_id, {
    pid: 12345,
    client: {
      sendCommand: (commandPath) => {
        heosSent.push(commandPath);
        return true;
      },
      isConnected: () => true,
    },
  });

  const cases = [
    [FEATURE.PLAY, 'player/set_play_state?pid=12345&state=play'],
    [FEATURE.PAUSE, 'player/set_play_state?pid=12345&state=pause'],
    [FEATURE.NEXT, 'player/play_next?pid=12345'],
    [FEATURE.PREVIOUS, 'player/play_previous?pid=12345'],
  ];
  for (const [key, expectedCommand] of cases) {
    const feature = { external_id: featureExternalId(device.external_id, key) };
    await onSetValue(gladys, { device, feature, value: 1 });
    assert.equal(heosSent.at(-1), expectedCommand, `${key} -> ${expectedCommand}`);
  }
  // None of these went through the legacy Telnet session.
  assert.deepEqual(telnet.sent, []);
});

test('onSetValue falls back to the legacy NS9x command when HEOS has no pid yet or is disconnected', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);
  __setHeosConnectionForTesting(device.external_id, {
    pid: null,
    client: { sendCommand: () => true, isConnected: () => true },
  });

  const playFeature = { external_id: featureExternalId(device.external_id, FEATURE.PLAY) };
  await onSetValue(gladys, { device, feature: playFeature, value: 1 });
  assert.equal(telnet.sent.at(-1), 'NS9A');

  __setHeosConnectionForTesting(device.external_id, {
    pid: 12345,
    client: { sendCommand: () => true, isConnected: () => false },
  });
  await onSetValue(gladys, { device, feature: playFeature, value: 1 });
  assert.equal(telnet.sent.at(-1), 'NS9A');
});

test('onSetValue plays a notification URL via HEOS browse/play_stream when a player id is matched', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);

  const heosSent = [];
  __setHeosConnectionForTesting(device.external_id, {
    pid: 12345,
    client: {
      sendCommand: (commandPath) => {
        heosSent.push(commandPath);
        return true;
      },
      isConnected: () => true,
    },
  });

  const feature = { external_id: featureExternalId(device.external_id, FEATURE.PLAY_NOTIFICATION) };
  await onSetValue(gladys, {
    device,
    feature,
    value: 'https://tts.example.com/announcement.mp3?token=abc&x=1',
  });

  assert.equal(
    heosSent.at(-1),
    'browse/play_stream?pid=12345&url=https%3A%2F%2Ftts.example.com%2Fannouncement.mp3%3Ftoken%3Dabc%26x%3D1',
  );
  // Never touches the legacy Telnet session: no NS9x/other equivalent exists.
  assert.deepEqual(telnet.sent, []);
});

test('onSetValue throws for a notification when no HEOS player id is matched or HEOS is disconnected', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(device.external_id, telnet);
  const feature = { external_id: featureExternalId(device.external_id, FEATURE.PLAY_NOTIFICATION) };

  __setHeosConnectionForTesting(device.external_id, {
    pid: null,
    client: { sendCommand: () => true, isConnected: () => true },
  });
  await assert.rejects(() =>
    onSetValue(gladys, { device, feature, value: 'https://x.test/a.mp3' }),
  );

  __setHeosConnectionForTesting(device.external_id, {
    pid: 12345,
    client: { sendCommand: () => true, isConnected: () => false },
  });
  await assert.rejects(() =>
    onSetValue(gladys, { device, feature, value: 'https://x.test/a.mp3' }),
  );
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

test('runTestConnectionAction reports the HEOS status: not connected, connected without a pid, and matched', async () => {
  const device = buildDiscoveredDevice(gladys, DISCOVERED);
  __setConnectionForTesting(device.external_id, createFakeTelnetClient());

  __setHeosConnectionForTesting(device.external_id, {
    pid: null,
    client: { sendCommand: () => true, isConnected: () => false },
  });
  let message = await runTestConnectionAction(gladys, { fields: { device: device.external_id } });
  assert.match(message.en, /HEOS: not connected/);
  assert.match(message.fr, /HEOS : non connecté/);

  __setHeosConnectionForTesting(device.external_id, {
    pid: null,
    client: { sendCommand: () => true, isConnected: () => true },
  });
  message = await runTestConnectionAction(gladys, { fields: { device: device.external_id } });
  assert.match(message.en, /no player id matched/);
  assert.match(message.fr, /aucun identifiant lecteur trouvé/);

  __setHeosConnectionForTesting(device.external_id, {
    pid: 12345,
    client: { sendCommand: () => true, isConnected: () => true },
  });
  message = await runTestConnectionAction(gladys, { fields: { device: device.external_id } });
  assert.match(message.en, /player id 12345 matched/);
  assert.match(message.fr, /identifiant lecteur 12345 trouvé/);
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
    socket.write(
      'PWON\rMV50\rMUOFF\rSITUNER\rMSMOVIE\rMNMEN ON\rNSE0Now Playing USB\rNSE1Come Away With Me\rNSE2Norah Jones\r',
    );
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
    const playbackStateId = featureExternalId(device.external_id, FEATURE.PLAYBACK_STATE);
    const nowPlayingId = featureExternalId(device.external_id, FEATURE.NOW_PLAYING);
    assert.ok(gladys.published.some((p) => p.featureExternalId === powerId && p.state === 1));
    assert.ok(
      gladys.published.some((p) => p.featureExternalId === playbackStateId && p.state === 1),
      'the "Now Playing ..." banner maps to playback_state = 1 (playing)',
    );
    assert.ok(gladys.published.some((p) => p.featureExternalId === volumeId));
    assert.ok(
      gladys.published.some((p) => p.featureExternalId === sourceId && p.state?.text === 'TUNER'),
    );
    const sourceIndexId = featureExternalId(device.external_id, FEATURE.SOURCE_INDEX);
    assert.ok(
      gladys.published.some((p) => p.featureExternalId === sourceIndexId && p.state === 2),
      'source_index is published in lockstep with source (TUNER is visible entry #2)',
    );
    assert.ok(
      gladys.published.some(
        (p) => p.featureExternalId === soundModeId && p.state?.text === 'MOVIE',
      ),
    );
    const menuId = featureExternalId(device.external_id, FEATURE.MENU);
    assert.ok(
      gladys.published.some((p) => p.featureExternalId === menuId && p.state === 1),
      "the receiver's own MNMEN push is published as a plain 0/1, same as power/mute",
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
    assert.match(message.en, /index 2/, 'TUNER is visible entry #2');
  } finally {
    disconnectDevice(device.external_id);
    server.close();
  }
});

// end-to-end: a source the current config hides must not get a bogus index
// published — the dashboard has nothing meaningful to show for it anyway.
test('connectDevice does not publish source_index when the reported source is hidden by source_overrides', async () => {
  const server = net.createServer((socket) => {
    socket.write('SITUNER\r');
  });
  const port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );

  const device = buildDiscoveredDevice(gladys, { ...DISCOVERED, host: '127.0.0.1' });
  const localConfig = normalizeConfig({ port, source_overrides: 'TUNER=' });
  // `gladys.published` is a single array shared by every test in this file
  // (DISCOVERED's fixed udn makes external_id deterministic across tests
  // too), so a snapshot before connecting is needed to see only this test's
  // publishes, not an unrelated earlier test's source_index for the same id.
  const publishedBefore = gladys.published.length;

  try {
    connectDevice(gladys, device, localConfig);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const sourceIndexId = featureExternalId(device.external_id, FEATURE.SOURCE_INDEX);
    assert.ok(
      !gladys.published.slice(publishedBefore).some((p) => p.featureExternalId === sourceIndexId),
      'TUNER is hidden, so it has no index in the visible list to publish',
    );
  } finally {
    disconnectDevice(device.external_id);
    server.close();
  }
});

// End-to-end: connectDevice() against BOTH a real fake Telnet server AND a
// real fake HEOS CLI server for the same host, exercising the precedence
// rule (HEOS wins once its player id is matched, legacy NSE0/NSE1/NSE2 must
// not overwrite it) and the periodic poll (see HEOS_POLL_INTERVAL_MS).
test('connectDevice: HEOS becomes authoritative for playback state and now playing once matched, and the poll timer keeps refreshing both', async () => {
  __setHeosPollIntervalMsForTesting(50);

  const telnetServer = net.createServer((socket) => {
    socket.write('PWON\r');
    // Arrives well after the HEOS handshake below should have completed —
    // must be ignored for playback_state/now_playing once HEOS has matched.
    setTimeout(() => {
      socket.write('NSE0Bluetooth Standby\rNSE1Wrong Title\rNSE2Wrong Artist\r');
    }, 150);
  });
  const telnetPort = await new Promise((resolve) =>
    telnetServer.listen(0, '127.0.0.1', () => resolve(telnetServer.address().port)),
  );

  const heosServer = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('player/get_players')) {
          socket.write(
            JSON.stringify({
              heos: { command: 'player/get_players', result: 'success', message: '' },
              payload: [{ pid: 999, ip: '127.0.0.1' }],
            }) + '\r\n',
          );
        } else if (line.includes('player/get_play_state')) {
          socket.write(
            JSON.stringify({
              heos: {
                command: 'player/get_play_state',
                result: 'success',
                message: 'pid=999&state=play',
              },
            }) + '\r\n',
          );
        } else if (line.includes('player/get_now_playing_media')) {
          socket.write(
            JSON.stringify({
              heos: {
                command: 'player/get_now_playing_media',
                result: 'success',
                message: 'pid=999',
              },
              payload: { song: 'HEOS Title', artist: 'HEOS Artist' },
            }) + '\r\n',
          );
        }
      }
    });
  });
  await new Promise((resolve) => heosServer.listen(HEOS_PORT, '127.0.0.1', resolve));

  const device = buildDiscoveredDevice(gladys, { ...DISCOVERED, host: '127.0.0.1' });
  const localConfig = normalizeConfig({ port: telnetPort });

  try {
    connectDevice(gladys, device, localConfig);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const playbackStateId = featureExternalId(device.external_id, FEATURE.PLAYBACK_STATE);
    const nowPlayingId = featureExternalId(device.external_id, FEATURE.NOW_PLAYING);

    assert.ok(
      gladys.published.some((p) => p.featureExternalId === playbackStateId && p.state === 1),
      'HEOS get_play_state (playing) is published',
    );
    assert.ok(
      gladys.published.some(
        (p) => p.featureExternalId === nowPlayingId && p.state?.text === 'HEOS Artist - HEOS Title',
      ),
      'HEOS get_now_playing_media is published',
    );
    assert.ok(
      !gladys.published.some((p) => p.featureExternalId === playbackStateId && p.state === 0),
      'the legacy NSE0 "Bluetooth Standby" banner must not overwrite HEOS-sourced playback state',
    );
    assert.ok(
      !gladys.published.some(
        (p) =>
          p.featureExternalId === nowPlayingId && p.state?.text === 'Wrong Artist - Wrong Title',
      ),
      'the legacy NSE1/NSE2 lines must not overwrite HEOS-sourced now playing',
    );

    // The 50ms poll interval should have re-sent get_play_state/
    // get_now_playing_media several times over the 400ms wait above,
    // republishing the same HEOS-sourced values each time.
    const publishCount = (id) => gladys.published.filter((p) => p.featureExternalId === id).length;
    assert.ok(publishCount(playbackStateId) >= 3, 'the poll timer re-fetches playback state');
    assert.ok(publishCount(nowPlayingId) >= 3, 'the poll timer re-fetches now playing');
  } finally {
    disconnectDevice(device.external_id);
    telnetServer.close();
    heosServer.close();
  }
});
