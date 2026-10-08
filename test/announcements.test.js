import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playAnnouncement, isAnnouncing } from '../src/devices/announcements.js';
import { STREAM_RESULT_KEY } from '../src/devices/heos-session.js';
import {
  __clearConnectionsForTesting,
  __setConnectionForTesting,
  __setHeosConnectionForTesting,
  __setLastKnownStateForTesting,
  __setTimingForTesting,
  notifyStateChange,
  updateState,
} from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeHeosSession, createFakeTelnetClient } from '../test-fixtures/fakeClients.js';

const ID = 'avr:abc';
const URL = 'https://tts.example.com/a.mp3';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(state) {
  const telnet = createFakeTelnetClient();
  const heos = createFakeHeosSession(9);
  __setConnectionForTesting(ID, telnet);
  __setHeosConnectionForTesting(ID, heos);
  __setLastKnownStateForTesting(ID, state);
  return { telnet, heos };
}

test.beforeEach(() => {
  __setTimingForTesting({
    zoneSwitchDelayMs: 0,
    announcementPollMs: 10,
    announcementStartTimeoutMs: 200,
    announcementMaxMs: 1_000,
  });
});

test.afterEach(() => {
  __clearConnectionsForTesting();
});

test('announcement volume first, then restore volume, input and standby once HEOS stops', async () => {
  const { telnet, heos } = setup({ power: 0, source: 'TV', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 25 }));

  assert.deepEqual(telnet.sent, ['ZMON', 'SINET', 'MV25']);
  assert.deepEqual(heos.sent.slice(0, 2), [
    'player/clear_queue?pid=9',
    `browse/play_stream?pid=9&url=${URL}`,
  ]);
  assert.ok(isAnnouncing(ID));

  // What the receiver reports while it speaks (25 % reads back as 26 %).
  updateState(ID, { power: 1, source: 'NET', volume: 26, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();

  assert.ok(!isAnnouncing(ID));
  assert.deepEqual(telnet.sent.slice(3), ['MV39', 'SITV', 'ZMOFF']);
});

test('the volume is left alone when someone changed it during the announcement', async () => {
  const { telnet } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 30 }));
  updateState(ID, { volume: 50, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(telnet.sent, ['MV29'], 'only the announcement volume, nothing restored');
});

test('no announcement volume: input and power are still given back, the volume never touched', async () => {
  const { telnet } = setup({ power: 1, source: 'BD', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig());
  updateState(ID, { source: 'NET', playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(telnet.sent, ['SINET', 'SIBD']);
});

test('a second announcement keeps the state from before the first one', async () => {
  const { telnet } = setup({ power: 1, source: 'CD', volume: 40 });
  const config = normalizeConfig({ announcement_volume: 20 });
  await playAnnouncement(ID, URL, config);
  updateState(ID, { source: 'NET', volume: 20, playback_state: 1 });
  await playAnnouncement(ID, URL, config);
  updateState(ID, { playback_state: 0 });
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(telnet.sent, ['SINET', 'MV20', 'MV20', 'MV39', 'SICD']);
});

test('a stream HEOS refuses restores at once', async () => {
  const { telnet } = setup({ power: 1, source: 'CD' });
  await playAnnouncement(ID, URL, normalizeConfig());
  updateState(ID, { source: 'NET' });
  notifyStateChange(ID, STREAM_RESULT_KEY, 'fail');
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.deepEqual(telnet.sent, ['SINET', 'SICD']);
});

test('a stream that never starts is given up after the start timeout', async () => {
  const { telnet } = setup({ power: 1, source: 'CD' });
  await playAnnouncement(ID, URL, normalizeConfig());
  updateState(ID, { source: 'NET' });
  await tick(260);
  assert.ok(!isAnnouncing(ID));
  assert.deepEqual(telnet.sent, ['SINET', 'SICD']);
});

test('the fast poll asks HEOS for its play state while the announcement plays', async () => {
  const { heos } = setup({ power: 1, source: 'NET' });
  await playAnnouncement(ID, URL, normalizeConfig());
  await tick(45);
  assert.ok(heos.sent.filter((path) => path === 'player/get_play_state?pid=9').length >= 2);
});

test('announcement_restore off: the volume is set, nothing is tracked or restored', async () => {
  const { telnet } = setup({ power: 0, source: 'CD', volume: 40 });
  await playAnnouncement(
    ID,
    URL,
    normalizeConfig({ announcement_volume: 35, announcement_restore: false }),
  );
  assert.ok(!isAnnouncing(ID));
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(telnet.sent, ['ZMON', 'SINET', 'MV34']);
});

test('a HEOS-only speaker: volume set and restored over HEOS, no input or power to give back', async () => {
  const heos = createFakeHeosSession(9);
  __setHeosConnectionForTesting(ID, heos);
  __setLastKnownStateForTesting(ID, { volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 60 }));
  updateState(ID, { volume: 60, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(
    heos.sent.filter((path) => path.startsWith('player/set_volume')),
    ['player/set_volume?pid=9&level=60', 'player/set_volume?pid=9&level=40'],
  );
});

test('a failed send restores and rethrows; no HEOS at all throws before touching anything', async () => {
  const { telnet, heos } = setup({ power: 1, source: 'CD' });
  heos.client.sendCommand = () => false;
  await assert.rejects(() => playAnnouncement(ID, URL, normalizeConfig()), /clear the HEOS queue/);
  assert.ok(!isAnnouncing(ID));

  heos.setConnected(false);
  telnet.sent.length = 0;
  await assert.rejects(() => playAnnouncement(ID, URL, normalizeConfig()), /cannot speak/);
  assert.deepEqual(telnet.sent, []);
});
