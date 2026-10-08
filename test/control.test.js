import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setPower,
  setSource,
  setSoundMode,
  setVolume,
  selectQuickSelect,
  selectTuner,
  sendTunerCommand,
  playHeosFavorite,
  ensureZoneReadyForHeos,
} from '../src/devices/control.js';
import {
  __clearConnectionsForTesting,
  __setConnectionForTesting,
  __setHeosConnectionForTesting,
  __setLastKnownStateForTesting,
  __setZoneSwitchDelayMsForTesting,
} from '../src/devices/registry.js';
import { createFakeHeosSession, createFakeTelnetClient } from '../test-fixtures/fakeClients.js';

const ID = 'avr:abc';

test.beforeEach(() => {
  __setZoneSwitchDelayMsForTesting(0);
});

test.afterEach(() => {
  __clearConnectionsForTesting();
});

test('setPower / setSource / setSoundMode send to the configured zone over Telnet', async () => {
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(ID, telnet);
  await setPower(ID, true, 'main');
  await setPower(ID, false, 'zone2');
  setSource(ID, 'SAT/CBL', 'main');
  setSource(ID, 'TUNER', 'zone3');
  setSoundMode(ID, ' MOVIE ');
  assert.deepEqual(telnet.sent, ['ZMON', 'Z2OFF', 'SISAT/CBL', 'Z3TUNER', 'MSMOVIE']);
});

test('setSource refuses an unknown input, setSoundMode an empty one, both without sending', () => {
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(ID, telnet);
  assert.throws(() => setSource(ID, 'NOPE', 'main'), /Unknown input source/);
  assert.throws(() => setSoundMode(ID, ''), /sound mode is required/);
  assert.deepEqual(telnet.sent, []);
});

test('controls throw a clear error when the receiver is not connected', async () => {
  assert.throws(() => setSource(ID, 'CD', 'main'), /is not connected/);
  await assert.rejects(() => setPower(ID, true, 'main'), /is not connected/);
  const telnet = createFakeTelnetClient();
  telnet.setConnected(false);
  __setConnectionForTesting(ID, telnet);
  assert.throws(() => selectQuickSelect(ID, 1, 'main'), /is not connected/);
});

test('setVolume: Telnet when it is up (clamped, rounded), HEOS otherwise, error when neither', () => {
  const telnet = createFakeTelnetClient();
  const heos = createFakeHeosSession(7);
  __setConnectionForTesting(ID, telnet);
  __setHeosConnectionForTesting(ID, heos);
  setVolume(ID, 50, 'main');
  setVolume(ID, 150, 'zone2');
  assert.deepEqual(telnet.sent, ['MV49', 'Z298']);
  assert.deepEqual(heos.sent, []);

  telnet.setConnected(false);
  setVolume(ID, 33.6, 'main');
  assert.deepEqual(heos.sent, ['player/set_volume?pid=7&level=34']);

  heos.setConnected(false);
  assert.throws(() => setVolume(ID, 20, 'main'), /cannot set the volume/);
  assert.throws(() => setVolume(ID, 'loud', 'main'), /Invalid volume/);
});

test('selectQuickSelect sends MSQUICK<n> (Z2QUICK<n> for Zone 2), refuses outside 1-5', () => {
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(ID, telnet);
  selectQuickSelect(ID, 3, 'main');
  selectQuickSelect(ID, '2', 'zone2');
  assert.throws(() => selectQuickSelect(ID, 6, 'main'), /does not exist/);
  assert.deepEqual(telnet.sent, ['MSQUICK3', 'Z2QUICK2']);
});

test('sendTunerCommand switches the zone on and to TUNER first, only when needed', async () => {
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(ID, telnet);
  __setLastKnownStateForTesting(ID, { power: 0, source: 'NET' });
  await sendTunerCommand(ID, 'frequency_up', 'main');
  assert.deepEqual(telnet.sent, ['ZMON', 'SITUNER', 'TFANUP']);

  telnet.sent.length = 0;
  __setLastKnownStateForTesting(ID, { power: 1, source: 'TUNER' });
  await sendTunerCommand(ID, 'preset_down', 'main');
  await selectTuner(ID, 'main');
  assert.deepEqual(telnet.sent, ['TPANDOWN']);

  await assert.rejects(() => sendTunerCommand(ID, 'rewind', 'main'), /Unknown tuner command/);
});

test('playHeosFavorite readies the zone for HEOS, then plays the preset; needs a matched pid', async () => {
  const telnet = createFakeTelnetClient();
  const heos = createFakeHeosSession(42);
  __setConnectionForTesting(ID, telnet);
  __setHeosConnectionForTesting(ID, heos);
  __setLastKnownStateForTesting(ID, { power: 1, source: 'TV' });
  await playHeosFavorite(ID, 2, 'main');
  assert.deepEqual(telnet.sent, ['SINET']);
  assert.deepEqual(heos.sent, ['browse/play_preset?pid=42&preset=2']);
  await assert.rejects(() => playHeosFavorite(ID, 0, 'main'), /does not exist/);

  heos.setConnected(false);
  await assert.rejects(() => playHeosFavorite(ID, 1, 'main'), /cannot play a HEOS favorite/);
});

test('ensureZoneReadyForHeos does nothing (and resolves false) without a Telnet session', async () => {
  assert.equal(await ensureZoneReadyForHeos(ID, 'main'), false);
});
