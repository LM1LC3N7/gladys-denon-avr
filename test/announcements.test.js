import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playAnnouncement, isAnnouncing } from '../src/devices/announcements.js';
import { NOW_PLAYING_MID_KEY, STREAM_RESULT_KEY } from '../src/devices/heos-session.js';
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

  // What the receiver reports while it speaks: its own number, MV25 = 25.
  updateState(ID, { power: 1, source: 'NET', volume: 25, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();

  assert.ok(!isAnnouncing(ID));
  assert.deepEqual(telnet.sent.slice(3), ['MV40', 'SITV', 'ZMOFF']);
});

test('the volume is left alone when someone changed it during the announcement', async () => {
  const { telnet } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 30 }));
  updateState(ID, { volume: 50, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(telnet.sent, ['MV30'], 'only the announcement volume, nothing restored');
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
  assert.deepEqual(telnet.sent, ['SINET', 'MV20', 'MV20', 'MV40', 'SICD']);
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
  assert.deepEqual(telnet.sent, ['ZMON', 'SINET', 'MV35']);
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

// Forum topic 10722, post 39 (music from Lyrion on a Marantz PM7000N): the
// music came back slowly, and Pause then Play sometimes spoke the message
// again.
test('once over and silent, the HEOS queue holding the announcement is cleared', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig());
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  const stream = heos.sent.indexOf(`browse/play_stream?pid=9&url=${URL}`);
  assert.deepEqual(
    heos.sent.slice(stream + 1).filter((path) => path.startsWith('player/clear_queue')),
    ['player/clear_queue?pid=9'],
    'cleared again after the stream: a later Play has nothing to replay',
  );
});

test('music playing before: HEOS naming the announcement as its media proves it plays', async () => {
  const { telnet } = setup({ power: 1, source: 'NET', volume: 40, playback_state: 1 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 30 }));
  // The music's "play" carries on into the announcement's: no state change.
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, URL);
  updateState(ID, { volume: 30, playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID), 'over at once, not at the 15 s start timeout');
  assert.deepEqual(telnet.sent, ['MV30', 'MV40']);
});

test('another controller taking HEOS back ends the announcement; its queue is left alone', async () => {
  const { telnet, heos } = setup({ power: 1, source: 'NET', volume: 40, playback_state: 1 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 30 }));
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, encodeURIComponent(URL));
  updateState(ID, { volume: 30 });
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, 'http://lyrion.lan:9000/stream.mp3');
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.deepEqual(telnet.sent, ['MV30', 'MV40']);
  const stream = heos.sent.indexOf(`browse/play_stream?pid=9&url=${URL}`);
  assert.ok(!heos.sent.slice(stream + 1).some((path) => path.startsWith('player/clear_queue')));
});

test('a media answer that is not ours before the announcement plays changes nothing', async () => {
  setup({ power: 1, source: 'NET', playback_state: 1 });
  await playAnnouncement(ID, URL, normalizeConfig());
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, 'http://lyrion.lan:9000/stream.mp3');
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, '');
  await tick();
  assert.ok(isAnnouncing(ID), 'the music still named before HEOS switched to our stream');
});

test('the fast poll also asks HEOS what it plays', async () => {
  const { heos } = setup({ power: 1, source: 'NET' });
  await playAnnouncement(ID, URL, normalizeConfig());
  await tick(45);
  assert.ok(heos.sent.includes('player/get_now_playing_media?pid=9'));
});

test('another media named during the announcement: its queue is never cleared (r3 m3)', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig());
  updateState(ID, { playback_state: 1 });
  // A queue started from the HEOS app; HEOS passes through "stop" before playing it.
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, 'queue-item-from-the-heos-app');
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  const stream = heos.sent.indexOf(`browse/play_stream?pid=9&url=${URL}`);
  assert.ok(!heos.sent.slice(stream + 1).some((path) => path.startsWith('player/clear_queue')));
});

test('announcement at 100 % over Telnet: read back as 98, still ours, volume restored (r3 m7, M12)', async () => {
  const { telnet } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 100 }));
  updateState(ID, { volume: 98, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(telnet.sent, ['MV98', 'MV40']);
});

test('one unit off the announcement volume is still ours, two is the user (r3 m7, M21)', async () => {
  let { telnet } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 30 }));
  updateState(ID, { volume: 31, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(telnet.sent, ['MV30', 'MV40']);
  __clearConnectionsForTesting();
  ({ telnet } = setup({ power: 1, source: 'NET', volume: 40 }));
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 30 }));
  updateState(ID, { volume: 32, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.deepEqual(telnet.sent, ['MV30']);
});
