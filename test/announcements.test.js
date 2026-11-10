import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __announcementRunsForTesting,
  cancelAnnouncement,
  isAnnouncing,
  playAnnouncement,
} from '../src/devices/announcements.js';
import { setPower } from '../src/devices/control.js';
import { onSetValue } from '../src/devices/commands.js';
import { FEATURE } from '../src/devices/features.js';
import { NOW_PLAYING_MID_KEY, STREAM_RESULT_KEY } from '../src/devices/heos-session.js';
import {
  __clearConnectionsForTesting,
  pendingStateWaits,
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
    // Fake receivers report nothing back unless a test says so.
    wakeConfirmMs: 0,
    wakeSettleMs: 0,
    announcementVolumeConfirmMs: 0,
  });
});

test.afterEach(() => {
  __clearConnectionsForTesting();
});

// Forum topic 10722, post 42: putting the HDMI input back before the
// standby sent a CEC <Routing Change> that woke the player on it (Shield),
// which switched the receiver and the TV back on.
test('back to standby: the volume is restored, the input is NOT put back before PWSTANDBY/ZMOFF', async () => {
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
  assert.deepEqual(telnet.sent.slice(3), ['MV40', 'ZMOFF'], 'no SITV: it would wake the TV player');
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

const clearsAfterStream = (heos) => {
  const stream = heos.sent.indexOf(`browse/play_stream?pid=9&url=${URL}`);
  return heos.sent.slice(stream + 1).filter((path) => path.startsWith('player/clear_queue')).length;
};

test('the announcement named, then other media: that queue is never cleared (r3 m3)', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig());
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, URL);
  // A queue started from the HEOS app: HEOS names it while stopped, before it plays.
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, 'queue-item-from-the-heos-app');
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.equal(clearsAfterStream(heos), 0);
});

test('a mid that is never the URL (internal id): the queue is still cleared (r4 I1)', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig());
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, 'heos-internal-id-42');
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.equal(clearsAfterStream(heos), 1);
});

test('only the mid of the music before seen: the queue is still cleared (r4 I1)', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig());
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, 'http://lyrion.lan:9000/stream.mp3');
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.equal(clearsAfterStream(heos), 1);
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

// Review denon-heos r5 m1: holds `entry.lastMid &&` in the queue guard. An
// empty mid after the announcement's own (HEOS between two items, or nothing
// named any more) is no other media: the queue is ours, cleared once.
test('announcement named, then an empty mid, then stop: exactly one clear_queue (r5 m1)', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 40, playback_state: 1 });
  await playAnnouncement(ID, URL, normalizeConfig());
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, URL);
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, '');
  assert.ok(isAnnouncing(ID), 'an empty mid does not end the announcement');
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.equal(clearsAfterStream(heos), 1);
});

// Accepted limits, pinned so that a change of behaviour is a deliberate one
// (real HEOS event order not checked on hardware, TODO.md "Still open").
test('a queue HEOS names only after the announcement "stop" is cleared (r5 m2, accepted)', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 40, playback_state: 1 });
  await playAnnouncement(ID, URL, normalizeConfig());
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, URL);
  updateState(ID, { playback_state: 0 });
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, 'queue-item-from-the-heos-app');
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.equal(clearsAfterStream(heos), 1);
});

test('a queue named before HEOS ever named the announcement is cleared (r4 m1, accepted)', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 40 });
  await playAnnouncement(ID, URL, normalizeConfig());
  notifyStateChange(ID, NOW_PLAYING_MID_KEY, 'queue-item-from-the-heos-app');
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.equal(clearsAfterStream(heos), 1);
});

// --- Wake from standby (forum topic 10722, post 42, AVR-S650H) ---------------

// Every wait of a test is bounded: a regression fails, never hangs.
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolve once `check()` is true, polled every 5 ms, or reject after `ms`. */
async function until(check, ms, what) {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > ms) {
      throw new Error(`${what}: not within ${ms} ms`);
    }
    await tick(5);
  }
}

const STREAM = `browse/play_stream?pid=9&url=${URL}`;

function wakeTiming(overrides = {}) {
  __setTimingForTesting({
    wakeConfirmMs: 2_000,
    wakeSettleMs: 40,
    announcementVolumeConfirmMs: 2_000,
    announcementVolumeRetryMs: 60,
    announcementAckMs: 5_000,
    ...overrides,
  });
}

test('from standby: nothing but the power command until the receiver reports it on', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 0, source: 'TV', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  await tick(120);
  assert.deepEqual(telnet.sent, ['ZMON'], 'no input, no volume while it wakes');
  assert.ok(!heos.sent.includes(STREAM), 'no stream while it wakes');

  updateState(ID, { power: 1 });
  await tick(10);
  assert.deepEqual(telnet.sent, ['ZMON'], 'a short pause after the power report');
  await until(() => telnet.sent.includes('MV50'), 1_000, 'volume after the pause');
  assert.deepEqual(telnet.sent.slice(0, 3), ['ZMON', 'SINET', 'MV50']);
  updateState(ID, { volume: 50 });
  await within(done, 1_000, 'announcement');
  assert.ok(heos.sent.includes(STREAM));
});

test('from standby: the stream waits for the volume read back, sent again until then', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'first volume');
  // The waking receiver ignored it, reports its old volume.
  updateState(ID, { volume: 21 });
  await tick(150);
  assert.ok(!heos.sent.includes(STREAM), 'no stream before the volume is read back');
  assert.ok(
    telnet.sent.filter((command) => command === 'MV50').length >= 2,
    'the volume is sent again',
  );
  updateState(ID, { volume: 50 });
  await within(done, 1_000, 'announcement');
  assert.deepEqual(heos.sent.slice(-2), ['player/clear_queue?pid=9', STREAM]);
});

test('from standby, nothing reported back: the announcement goes on after bounded waits', async () => {
  wakeTiming({ wakeConfirmMs: 150, announcementVolumeConfirmMs: 150 });
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const started = performance.now();
  await within(
    playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 })),
    2_000,
    'announcement',
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 280, `fallback waits kept (${Math.round(elapsed)} ms)`);
  assert.ok(heos.sent.includes(STREAM), 'the stream still goes out');
  assert.equal(telnet.sent[0], 'ZMON');
  assert.equal(pendingStateWaits(), 0, 'no wait left behind');
});

test('from standby: the scene action is answered within the ack budget, the rest goes on', async () => {
  wakeTiming({ announcementAckMs: 50 });
  const { heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const started = performance.now();
  await within(
    playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 })),
    1_000,
    'ack',
  );
  assert.ok(performance.now() - started < 500, 'answered before the receiver woke');
  assert.ok(!heos.sent.includes(STREAM));
  updateState(ID, { power: 1 });
  updateState(ID, { volume: 50 });
  await until(() => heos.sent.includes(STREAM), 1_000, 'stream after the ack');
});

test('from standby: a second announcement during the wake sends one stream, its own', async () => {
  wakeTiming();
  const { heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const config = normalizeConfig({ announcement_volume: 50 });
  const first = playAnnouncement(ID, 'https://tts.example.com/first.mp3', config);
  await tick(20);
  const second = playAnnouncement(ID, URL, config);
  updateState(ID, { power: 1 });
  await tick(80);
  updateState(ID, { volume: 50 });
  await within(Promise.all([first, second]), 1_000, 'both announcements');
  const streams = heos.sent.filter((path) => path.startsWith('browse/play_stream'));
  assert.deepEqual(streams, [STREAM]);
});

test('from standby, no announcement volume: a second announcement during the wake sends one stream', async () => {
  wakeTiming();
  const { heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const first = playAnnouncement(ID, 'https://tts.example.com/first.mp3', normalizeConfig());
  await tick(20);
  const second = playAnnouncement(ID, URL, normalizeConfig());
  updateState(ID, { power: 1 });
  await within(Promise.all([first, second]), 1_000, 'both announcements');
  const streams = heos.sent.filter((path) => path.startsWith('browse/play_stream'));
  assert.deepEqual(streams, [STREAM]);
});

test('receiver already on: volume and stream at once, no wait for any read back', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 1, source: 'NET', volume: 20 });
  await within(
    playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 })),
    300,
    'announcement',
  );
  assert.deepEqual(telnet.sent, ['MV50']);
  assert.ok(heos.sent.includes(STREAM));
});

test('a state wait ends at its deadline and at a reset, never later', async () => {
  const { waitForState } = await import('../src/devices/registry.js');
  setup({ power: 0 });
  assert.equal(
    await within(
      waitForState(ID, (s) => s.power === 1, 30),
      500,
      'deadline',
    ),
    false,
  );
  const waiting = waitForState(ID, (s) => s.power === 1, 10_000);
  assert.equal(pendingStateWaits(), 1);
  __clearConnectionsForTesting();
  assert.equal(await within(waiting, 500, 'reset'), false);
  assert.equal(pendingStateWaits(), 0);
});

// --- Review denon-125-r1 ------------------------------------------------------

const ann = (url = URL) => `browse/play_stream?pid=9&url=${url}`;
const streams = (heos) => heos.sent.filter((path) => path.startsWith('browse/play_stream'));
const mvs = (telnet) => telnet.sent.filter((command) => command.startsWith('MV'));

test('r1 I1: a second announcement just after the power report still waits for the pause and the volume', async () => {
  wakeTiming({ wakeSettleMs: 150 });
  const { telnet, heos } = setup({ power: 0, source: 'TV', volume: 20 });
  const config = normalizeConfig({ announcement_volume: 50 });
  const first = playAnnouncement(ID, 'https://tts.example.com/first.mp3', config);
  await tick(20);
  updateState(ID, { power: 1 });
  await tick(50);
  const second = playAnnouncement(ID, URL, config);
  await tick(40);
  assert.deepEqual(telnet.sent, ['ZMON'], 'one power command, nothing during the pause');
  await until(() => telnet.sent.includes('MV50'), 1_000, 'volume after the pause');
  assert.deepEqual(streams(heos), [], 'no stream before the volume is read back');
  updateState(ID, { volume: 50 });
  await within(Promise.all([first, second]), 1_000, 'both announcements');
  assert.deepEqual(streams(heos), [ann()]);
  assert.equal(telnet.sent.filter((command) => command === 'SINET').length, 1, 'one input switch');
});

test('r1 I1: an announcement soon after a wake (receiver on) still waits for its volume', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const config = normalizeConfig({ announcement_volume: 50, announcement_restore: false });
  const first = playAnnouncement(ID, 'https://tts.example.com/first.mp3', config);
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'first volume');
  updateState(ID, { volume: 50 });
  await within(first, 1_000, 'first');
  updateState(ID, { volume: 30 }); // The receiver moved it meanwhile.
  const second = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 60 }));
  await tick(30);
  assert.ok(!streams(heos).includes(ann()), 'no stream before its volume is read back');
  updateState(ID, { volume: 60 });
  await within(second, 1_000, 'second');
  assert.ok(streams(heos).includes(ann()));
});

test('r1 I2: the user switching off during the wake stops the announcement at once', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  await tick(20);
  await setPower(ID, false, 'main', 'scene');
  updateState(ID, { power: 1 }); // A late report of the power-on.
  await within(done, 1_000, 'announcement');
  await tick(150);
  assert.deepEqual(telnet.sent, ['ZMON', 'ZMOFF'], 'nothing after the user power-off');
  assert.deepEqual(streams(heos), []);
  assert.ok(!isAnnouncing(ID));
  assert.equal(pendingStateWaits(), 0);
});

test('r1 I2: a power-off from Gladys during the volume read back stops it too', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'volume');
  const device = { external_id: ID, features: [] };
  await onSetValue({}, { device, feature: { external_id: `${ID}:${FEATURE.POWER}` }, value: 0 });
  await within(done, 1_000, 'announcement');
  await tick(150);
  assert.deepEqual(mvs(telnet), ['MV50'], 'not sent again');
  assert.deepEqual(streams(heos), []);
});

test('r1 I2: the remote switching off (power 1 then 0) stops it, restore off as well', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const done = playAnnouncement(
    ID,
    URL,
    normalizeConfig({ announcement_volume: 50, announcement_restore: false }),
  );
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'volume');
  updateState(ID, { power: 0 });
  await within(done, 1_000, 'announcement');
  await tick(150);
  assert.deepEqual(mvs(telnet), ['MV50']);
  assert.deepEqual(streams(heos), []);
});

test('r1 I3: a receiver that never reports its power on is still put back in standby', async () => {
  wakeTiming({ wakeConfirmMs: 60, announcementVolumeConfirmMs: 60 });
  const { telnet } = setup({ power: 0, source: 'TV', volume: 20 });
  await within(
    playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 })),
    1_000,
    'announcement',
  );
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.equal(telnet.sent.at(-1), 'ZMOFF');
  assert.ok(!telnet.sent.includes('SITV'));
});

test('r1 I4: a device removed during the wake (cancelAnnouncement) sends nothing more', async () => {
  wakeTiming({ announcementAckMs: 30 });
  const { telnet, heos } = setup({ power: 0, source: 'TV', volume: 20 });
  await within(
    playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 })),
    1_000,
    'ack',
  );
  cancelAnnouncement(ID);
  updateState(ID, { power: 1 });
  await tick(200);
  updateState(ID, { volume: 50 });
  await tick(50);
  assert.deepEqual(telnet.sent, ['ZMON']);
  assert.deepEqual(streams(heos), []);
});

test('r1 I4: a second announcement during the volume read back: one stream, the newer', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const config = normalizeConfig({ announcement_volume: 50 });
  const first = playAnnouncement(ID, 'https://tts.example.com/first.mp3', config);
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'first volume');
  const second = playAnnouncement(ID, URL, config);
  await tick(10);
  updateState(ID, { volume: 50 });
  await within(Promise.all([first, second]), 1_000, 'both announcements');
  assert.deepEqual(streams(heos), [ann()]);
});

test('r1 I4: an error after the ack is logged, never an unhandled rejection', async (t) => {
  wakeTiming({ announcementAckMs: 30 });
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const { heos } = setup({ power: 0, source: 'NET', volume: 20 });
  heos.client.sendCommand = () => false;
  await within(
    playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 })),
    1_000,
    'ack',
  );
  updateState(ID, { power: 1 });
  updateState(ID, { volume: 50 });
  await until(() => errors.some((line) => /announcement failed/.test(line)), 1_000, 'logged');
  await tick(20);
  assert.deepEqual(rejections, []);
  assert.ok(errors.some((line) => /clear the HEOS queue/.test(line)));
});

test('r1 I4: restore off, nothing tracked: no fast poll after the stream', async () => {
  const { heos } = setup({ power: 1, source: 'NET', volume: 20 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_restore: false }));
  await tick(40);
  assert.ok(!heos.sent.some((path) => path.startsWith('player/get_play_state')));
});

test('r1 M1: a user volume during the read back stops the resends and is kept at the end', async () => {
  wakeTiming();
  const { telnet } = setup({ power: 0, source: 'NET', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'volume');
  const device = { external_id: ID, features: [] };
  await onSetValue({}, { device, feature: { external_id: `${ID}:${FEATURE.VOLUME}` }, value: 35 });
  updateState(ID, { volume: 35 });
  await within(done, 2_000, 'announcement');
  assert.deepEqual(mvs(telnet), ['MV50', 'MV35'], 'the announcement volume not sent again');
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!telnet.sent.includes('MV20'), 'the user volume is kept');
});

test('r1 M2: a half step, or the Max Volume below the announcement volume, counts as read back', async () => {
  wakeTiming({ announcementVolumeRetryMs: 500 });
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'volume');
  updateState(ID, { volume: 49.5 });
  await within(done, 300, 'half step');
  assert.ok(streams(heos).includes(ann()));

  __clearConnectionsForTesting();
  wakeTiming({ announcementVolumeRetryMs: 500 });
  const capped = setup({ power: 0, source: 'NET', volume: 20, volume_max: 40 });
  const second = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  updateState(ID, { power: 1 });
  await until(() => capped.telnet.sent.includes('MV50'), 1_000, 'volume');
  updateState(ID, { volume: 40 });
  await within(second, 300, 'capped');
  assert.ok(streams(capped.heos).includes(ann()));
});

test('r1 M3: Telnet lost during the read back: the volume is not sent over HEOS', async () => {
  wakeTiming();
  const { telnet, heos } = setup({ power: 0, source: 'NET', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'volume');
  telnet.setConnected(false);
  await within(done, 1_000, 'announcement');
  assert.ok(!heos.sent.some((path) => path.startsWith('player/set_volume')));
  assert.ok(streams(heos).includes(ann()));
});

test('r1 M5: no run token left once an announcement is over', async () => {
  wakeTiming();
  setup({ power: 1, source: 'NET', volume: 20 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_restore: false }));
  assert.equal(__announcementRunsForTesting(), 0);
});

test('r1 I2: switched off during the pause after the power report: no input switch either', async () => {
  wakeTiming({ wakeSettleMs: 100 });
  const { telnet, heos } = setup({ power: 0, source: 'TV', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  updateState(ID, { power: 1 });
  await tick(30);
  await setPower(ID, false, 'main', 'widget');
  await within(done, 1_000, 'announcement');
  await tick(150);
  assert.deepEqual(telnet.sent, ['ZMON', 'ZMOFF']);
  assert.deepEqual(streams(heos), []);
});

test('r1: switched on by the user during the announcement: no standby at the end', async () => {
  wakeTiming();
  const { telnet } = setup({ power: 0, source: 'NET', volume: 20 });
  const done = playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  updateState(ID, { power: 1 });
  await until(() => telnet.sent.includes('MV50'), 1_000, 'volume');
  updateState(ID, { volume: 50 });
  await within(done, 1_000, 'announcement');
  const device = { external_id: ID, features: [] };
  await onSetValue({}, { device, feature: { external_id: `${ID}:${FEATURE.POWER}` }, value: 1 });
  updateState(ID, { playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.ok(!telnet.sent.includes('ZMOFF'), 'left on');
});

test('r1 M1: a user volume next to the announcement one is still kept at the end', async () => {
  const { telnet } = setup({ power: 1, source: 'NET', volume: 20 });
  await playAnnouncement(ID, URL, normalizeConfig({ announcement_volume: 50 }));
  const device = { external_id: ID, features: [] };
  await onSetValue({}, { device, feature: { external_id: `${ID}:${FEATURE.VOLUME}` }, value: 51 });
  updateState(ID, { volume: 51, playback_state: 1 });
  updateState(ID, { playback_state: 0 });
  await tick();
  assert.ok(!isAnnouncing(ID));
  assert.deepEqual(mvs(telnet), ['MV50', 'MV51'], 'MV20 never sent over the user volume');
});
