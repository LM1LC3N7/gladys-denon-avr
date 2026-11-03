import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SAMPLE_RATE,
  FRAME_SECONDS,
  bandFrames,
  encodeFrames,
  decodeFrames,
} from '../src/adbreak/bands.js';
import {
  createJingleListener,
  findSharedJingle,
  findSharedJingleInWorker,
  stationFile,
} from '../src/adbreak/jingles.js';
import { radioAudio, jingleAudio } from '../test-fixtures/audio.js';

const AD_JINGLE = jingleAudio(999, 400, 3500);

/** A spawn() stand-in: every "ffmpeg" started, fed by the test. */
function fakeSpawn() {
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    children.push(child);
    return child;
  };
  return { spawnImpl, children };
}

/** Write PCM to a fake ffmpeg's stdout, as raw s16le bytes. */
function emitAudio(child, pcm) {
  child.stdout.emit('data', Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/**
 * Play PCM in a fake ffmpeg the way a stream arrives: its duration elapses
 * (the mocked clock moves on), then it is all decoded "now".
 */
function playAudio(t, child, pcm) {
  t.mock.timers.tick((pcm.length / SAMPLE_RATE) * 1000);
  emitAudio(child, pcm);
}

/** `seconds` of radio with AD_JINGLE dropped at each of `jingleAt` (seconds). */
function radioWithJingles(seconds, seed, jingleAt) {
  const audio = radioAudio(seconds, seed);
  for (const at of jingleAt) {
    audio.set(AD_JINGLE, Math.round(at * SAMPLE_RATE));
  }
  return audio;
}

// The real search, in-thread (the worker is tested on its own below).
const findInThread = async (encoded) =>
  findSharedJingle(encoded.map((s) => ({ frames: decodeFrames(s), anchor: s.anchor })));

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'adbreak-jingles-'));
}

test('stationFile keeps short keys readable and hashes long ones under the name limit', () => {
  assert.equal(stationFile('/d', 'tunein:s6586'), path.join('/d', 'tunein_s6586.json'));
  const long = `url:https://example.com/${'x'.repeat(400)}`;
  const file = path.basename(stationFile('/d', long));
  assert.ok(file.length < 100, file);
  assert.notEqual(file, path.basename(stationFile('/d', `${long}y`)));
});

test('findSharedJingleInWorker runs the search off the main thread', async () => {
  const samples = [1, 2, 3].map((seed) => {
    const audio = radioWithJingles(30, seed, [12]);
    return { anchor: Math.round(10 / FRAME_SECONDS), ...encodeFrames(bandFrames(audio)) };
  });
  const found = await findSharedJingleInWorker(samples);
  assert.ok(found, 'the shared jingle is found');
  assert.equal(found.support, 3);
  assert.ok(Math.abs(found.offsetSeconds - 2) < 0.5, `offset ${found.offsetSeconds}`);
  await assert.rejects(findSharedJingleInWorker([{ anchor: 0 }]));
});

test('a station jingle is learned from its breaks, observed, activated, saved, then dropped', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const storeDir = await tempDir();
  const { spawnImpl, children } = fakeSpawn();
  const hits = [];
  let changes = 0;
  const options = {
    stationKey: 'tunein:s6586',
    streamUrl: 'http://radio.example/stream',
    onHit: (hit) => hits.push(hit),
    onChange: () => {
      changes += 1;
    },
    spawnImpl,
    findJingle: findInThread,
    storeDir,
  };
  const listener = createJingleListener(options);
  await listener.ready;
  try {
    assert.equal(children.length, 1);
    assert.equal(children[0].args.at(children[0].args.indexOf('-i') + 1), options.streamUrl);
    assert.ok(children[0].args.includes('-protocol_whitelist'));
    children[0].stderr.emit('data', Buffer.from('some ffmpeg warning'));

    // 3 breaks of 150 s in 600 s of radio, each opening with the jingle
    // 12 s after the song end. Everything arrives at once: frames are
    // dated back from "now".
    const audio = radioWithJingles(600, 7, [32, 232, 432]);
    // An odd byte split across two chunks must not shift the samples.
    const bytes = Buffer.from(audio.buffer);
    t.mock.timers.tick(600_000);
    children[0].stdout.emit('data', bytes.subarray(0, 1001));
    children[0].stdout.emit('data', bytes.subarray(1001));
    const end = Date.now();
    const begin = end - 600_000;
    for (const k of [0, 1, 2]) {
      const songEndedAt = begin + (20 + 200 * k) * 1000;
      await listener.learnFromBreak({ songEndedAt, nextSongAt: songEndedAt + 150_000 });
    }
    assert.equal(listener.hasActive('start'), false, 'observed first, not trusted yet');
    const saved = JSON.parse(await fs.readFile(stationFile(storeDir, options.stationKey), 'utf8'));
    assert.ok(saved.jingles.start, 'the candidate is saved');
    assert.ok(Math.abs(saved.jingles.start.offsetSeconds - 12) <= 1);
    assert.equal(saved.jingles.end, null, 'a sound far from the next song is no end jingle');
    assert.equal(saved.samples.start.length, 3);

    // Heard twice more (over 90 s apart): two observed hits...
    playAudio(t, children[0], radioWithJingles(200, 8, [20, 130]));
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.side === 'start' && !h.active && h.score >= 0.5));
    // ...confirmed when no song followed them: the jingle becomes active.
    listener.tick(Date.now() + 400_000);
    assert.equal(listener.hasActive('start'), true);
    assert.equal(changes, 1);
    await listener.settled();

    // A second listener of the same station starts from the saved state.
    const reloaded = createJingleListener({ ...options, onHit: () => {} });
    await reloaded.ready;
    assert.equal(reloaded.hasActive('start'), true);
    reloaded.stop();

    // Two more airings, each followed by a song within 60 s: not breaks.
    hits.length = 0;
    playAudio(t, children[0], radioWithJingles(200, 9, [20, 130]));
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.active));
    for (const hit of hits) {
      listener.onSongStarted(hit.at + 10_000);
    }
    assert.equal(listener.hasActive('start'), false, 'too many false alarms: dropped');
    assert.equal(changes, 2);
  } finally {
    listener.stop();
    await listener.settled();
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});

test('"it\'s an ad" right after an observed hit confirms it, and is learned from', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const storeDir = await tempDir();
  const { spawnImpl, children } = fakeSpawn();
  const hits = [];
  let pending = 0;
  const listener = createJingleListener({
    stationKey: 'url:http://radio.example/notitles',
    streamUrl: 'http://radio.example/notitles',
    onHit: (hit) => hits.push(hit),
    context: () => ({ hasSongs: false, inAdWindow: () => false, inBreak: false }),
    spawnImpl,
    findJingle: async (samples) => {
      pending = samples.length;
      return findInThread(samples);
    },
    storeDir,
  });
  await listener.ready;
  try {
    // Three presses right after the jingle: a candidate from the press samples.
    playAudio(t, children[0], radioWithJingles(400, 11, [50, 180, 310]));
    const begin = Date.now() - 400_000;
    for (const jingleAt of [50, 180, 310]) {
      await listener.learnFromMark(begin + (jingleAt + 3) * 1000);
    }
    assert.equal(pending, 3);
    // Heard again, then pressed: the press confirms that hit at once.
    playAudio(t, children[0], radioWithJingles(100, 12, [40]));
    assert.equal(hits.length, 1);
    await listener.learnFromMark(hits[0].at + 2000);
    // Without titles, a hit nobody pressed for is judged on the schedule.
    playAudio(t, children[0], radioWithJingles(200, 13, [150]));
    assert.equal(hits.length, 2);
    listener.tick(Date.now() + 400_000);
    await listener.settled();
    const saved = JSON.parse(
      await fs.readFile(stationFile(storeDir, 'url:http://radio.example/notitles'), 'utf8'),
    );
    assert.deepEqual(
      [saved.jingles.start.hits, saved.jingles.start.confirmed],
      [2, 1],
      'the pressed hit confirmed, the other outside any ad window not',
    );
  } finally {
    listener.stop();
    await listener.settled();
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});

test('ffmpeg is restarted with a growing delay, and never again once stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storeDir = await tempDir();
  const { spawnImpl, children } = fakeSpawn();
  const listener = createJingleListener({
    stationKey: 'tunein:s1',
    streamUrl: 'http://radio.example/dead',
    onHit: () => {},
    spawnImpl,
    findJingle: findInThread,
    storeDir,
  });
  try {
    children[0].emit('exit', 1);
    t.mock.timers.tick(10_000);
    assert.equal(children.length, 2, 'first restart after 10 s');
    children[1].emit('exit', 1);
    t.mock.timers.tick(10_000);
    assert.equal(children.length, 2, 'the second one waits longer');
    t.mock.timers.tick(10_000);
    assert.equal(children.length, 3);
    // A stream decoded for a while resets the delay.
    emitAudio(children[2], radioAudio(61, 3));
    children[2].emit('exit', 0);
    t.mock.timers.tick(10_000);
    assert.equal(children.length, 4);
    // ffmpeg missing: jingle learning is off for good.
    children[3].emit('error', new Error('spawn ffmpeg ENOENT'));
    children[3].emit('exit', null);
    t.mock.timers.tick(RESTART_MAX_MS_FOR_TEST);
    assert.equal(children.length, 4);
  } finally {
    listener.stop();
    t.mock.timers.reset();
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});

const RESTART_MAX_MS_FOR_TEST = 10 * 60_000;

test('learning stops with the listener: a break after stop() is not sampled', async () => {
  const storeDir = await tempDir();
  const { spawnImpl, children } = fakeSpawn();
  let searches = 0;
  const listener = createJingleListener({
    stationKey: 'tunein:s2',
    streamUrl: 'http://radio.example/s2',
    onHit: () => {},
    spawnImpl,
    findJingle: async () => {
      searches += 1;
      return null;
    },
    storeDir,
  });
  emitAudio(children[0], radioAudio(300, 5));
  listener.stop();
  const begin = Date.now() - 300_000;
  await listener.learnFromBreak({ songEndedAt: begin + 20_000, nextSongAt: begin + 200_000 });
  await listener.learnFromMark(begin + 100_000);
  assert.equal(searches, 0);
  await fs.rm(storeDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Recall of an active jingle: missed breaks, reliability, demotion (1.2.3).
// -----------------------------------------------------------------------------

const END_JINGLE = jingleAudio(555, 3000, 600);
const NEW_JINGLE = jingleAudio(321, 900, 2500);

/** A learned template of `jingle`, as findSharedJingle() makes it. */
function templateOf(jingle) {
  const samples = [21, 22, 23].map((seed) => {
    const audio = radioAudio(30, seed);
    audio.set(jingle, 12 * SAMPLE_RATE);
    return { frames: bandFrames(audio), anchor: Math.round(10 / FRAME_SECONDS) };
  });
  const { frames } = findSharedJingle(samples);
  return { ...encodeFrames(frames), frames: frames.length };
}

const START_TEMPLATE = templateOf(AD_JINGLE);
const END_TEMPLATE = templateOf(END_JINGLE);

/**
 * A state file as saved by 1.2.2 (no record of missed breaks): both
 * jingles active, confirmed on their hits.
 */
async function writeOldState(storeDir, stationKey, records = {}) {
  const jingle = (template, offsetSeconds, record) => ({
    template,
    offsetSeconds,
    support: 3,
    score: 0.8,
    hits: 6,
    confirmed: 6,
    active: true,
    learnedAt: Date.now() - 86_400_000,
    ...(record === undefined ? {} : { record }),
  });
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(
    stationFile(storeDir, stationKey),
    JSON.stringify({
      version: 2,
      samples: { start: [], end: [] },
      jingles: {
        start: jingle(START_TEMPLATE, 12, records.start),
        end: jingle(END_TEMPLATE, -8, records.end),
      },
    }),
  );
}

/**
 * One break heard in full: the song ends 20 s into 220 s of radio, the next
 * one starts at 200 s (the end jingle out of the start-side sample). `start` (12 s after the song end) and `end` (8 s
 * before the next song): the jingle sounds aired, if any.
 */
async function playBreak(
  t,
  child,
  listener,
  seed,
  { start = null, end = null, startAt = 32, endAt = 192, breakHandled = true } = {},
) {
  const audio = radioAudio(220, seed);
  if (start) {
    audio.set(start, startAt * SAMPLE_RATE);
  }
  if (end) {
    audio.set(end, endAt * SAMPLE_RATE);
  }
  playAudio(t, child, audio);
  const begin = Date.now() - 220_000;
  await listener.learnFromBreak({
    songEndedAt: begin + 20_000,
    nextSongAt: begin + 200_000,
    breakHandled,
  });
}

async function recallSetUp(t, stationKey, findJingle = findInThread, records = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const storeDir = await tempDir();
  t.after(() => fs.rm(storeDir, { recursive: true, force: true }));
  await writeOldState(storeDir, stationKey, records);
  const { spawnImpl, children } = fakeSpawn();
  const counts = { changes: 0 };
  const listener = createJingleListener({
    stationKey,
    streamUrl: 'http://radio.example/stream',
    onHit: () => {},
    onChange: () => {
      counts.changes += 1;
    },
    spawnImpl,
    findJingle,
    storeDir,
  });
  t.after(async () => {
    listener.stop();
    await listener.settled();
  });
  await listener.ready;
  const saved = async () =>
    JSON.parse(await fs.readFile(stationFile(storeDir, stationKey), 'utf8'));
  return { listener, child: children[0], counts, saved };
}

test('an active start jingle never heard: learned talk, demoted, then replaced', async (t) => {
  // New sounds are searched for once the jingle is demoted (a quicker test).
  let searching = false;
  const { listener, child, counts, saved } = await recallSetUp(t, 'tunein:s1', (samples) =>
    searching ? findInThread(samples) : null,
  );
  // A 1.2.2 file loads: active, with an empty record, hence not reliable.
  assert.equal(listener.hasActive('start'), true);
  assert.deepEqual(listener.state().jingles.start.record, []);
  assert.equal(listener.hasReliable('start'), false, 'too new to tell: the learned talk');

  // Three breaks without the start jingle (the end one airs): misses.
  for (const seed of [31, 32, 33]) {
    await playBreak(t, child, listener, seed, { end: END_JINGLE });
  }
  assert.deepEqual(listener.state().jingles.start.record, [false, false, false]);
  assert.equal(listener.hasActive('start'), true, 'not demoted yet: 3 of 6 is not more than half');
  assert.deepEqual(listener.state().jingles.end.record, [true, true, true]);
  assert.deepEqual((await saved()).jingles.start.record, [false, false, false], 'persisted');
  assert.equal(counts.changes, 0);

  // A fourth miss: more than half of the last 6 recorded breaks.
  await playBreak(t, child, listener, 34, { end: END_JINGLE });
  const demoted = listener.state().jingles.start;
  assert.equal(demoted.active, false, 'back to observation');
  assert.deepEqual([demoted.hits, demoted.confirmed, demoted.record], [0, 0, []]);
  assert.equal(demoted.template.data, START_TEMPLATE.data, 'it keeps its template');
  assert.equal(typeof demoted.demotedAt, 'number');
  assert.equal(counts.changes, 1, 'the detector is refreshed');
  assert.equal((await saved()).jingles.start.active, false);

  searching = true;
  // The end jingle, heard in 4 breaks, stays active (not reliable before 5).
  assert.equal(listener.hasReliable('end'), false);
  // Observed, the old start jingle is no longer judged on breaks; a new
  // sound shared by the next breaks replaces it.
  for (const seed of [35, 36, 37, 38]) {
    await playBreak(t, child, listener, seed, { start: NEW_JINGLE, end: END_JINGLE });
  }
  await listener.settled();
  const replaced = listener.state().jingles.start;
  assert.notEqual(replaced.template.data, START_TEMPLATE.data, 'a different sound now');
  assert.equal(replaced.active, false, 'observed first');
  assert.ok(Math.abs(replaced.offsetSeconds - 12) <= 1, `offset ${replaced.offsetSeconds}`);
  assert.deepEqual(replaced.record, []);
  assert.equal(listener.hasReliable('end'), true, 'the end jingle, heard 8 times of 8');
  assert.equal(counts.changes, 2, 'the end jingle became reliable');
});

test('a reliable start jingle keeps the 90 s wait, until it misses too often', async (t) => {
  // No new sound searched for here (a quicker test).
  const { listener, child, counts } = await recallSetUp(t, 'tunein:s2', async () => null);
  for (const [i, seed] of [41, 42, 43, 44].entries()) {
    await playBreak(t, child, listener, seed, { start: AD_JINGLE });
    assert.equal(listener.hasReliable('start'), false, `${i + 1} breaks: too few`);
  }
  // The end jingle missed every time: demoted after its fourth miss.
  assert.equal(listener.hasActive('end'), false);
  assert.equal(counts.changes, 1);
  await playBreak(t, child, listener, 45, { start: AD_JINGLE });
  assert.equal(listener.hasReliable('start'), true, 'heard in 5 of 5');
  assert.equal(counts.changes, 2);
  // One miss: 5 of 6 is still over 80 %.
  await playBreak(t, child, listener, 46);
  assert.equal(listener.hasReliable('start'), true);
  // Two: 5 of 7 is not.
  await playBreak(t, child, listener, 47);
  assert.equal(listener.hasReliable('start'), false);
  assert.equal(listener.hasActive('start'), true, 'still active: its hits still start breaks');
  assert.equal(counts.changes, 3);
  // Only the last RECORD_BREAKS are kept.
  for (const seed of [48, 49, 50, 51]) {
    await playBreak(t, child, listener, seed, { start: AD_JINGLE });
  }
  assert.deepEqual(listener.state().jingles.start.record, [
    true,
    true,
    true,
    true,
    false,
    false,
    true,
    true,
    true,
    true,
  ]);
  assert.equal(listener.hasReliable('start'), true, '8 of 10');
});

test('a break not fully heard (stream gap, listener started late) is not a miss', async (t) => {
  const { listener, child } = await recallSetUp(t, 'tunein:s3');
  // The stream stalls 30 s in the middle of the start range.
  playAudio(t, child, radioAudio(60, 61));
  t.mock.timers.tick(30_000);
  playAudio(t, child, radioAudio(200, 62));
  const end = Date.now();
  await listener.learnFromBreak({
    songEndedAt: end - 270_000,
    nextSongAt: end - 30_000,
    breakHandled: true,
  });
  // The song ended before the listener started.
  await listener.learnFromBreak({
    songEndedAt: end - 900_000,
    nextSongAt: end - 300_000,
    breakHandled: true,
  });
  assert.deepEqual(listener.state().jingles.start.record, []);
  // The end range (heard in full, no end jingle in it) is a miss.
  assert.deepEqual(listener.state().jingles.end.record, [false]);
  // A near miss is still a miss: the jingle buried under loud talk (~0.4).
  const talk = radioAudio(2, 78);
  const buried = Int16Array.from(AD_JINGLE, (v, i) => v * 0.3 + talk[i]);
  await playBreak(t, child, listener, 63, { start: buried, end: END_JINGLE });
  assert.deepEqual(listener.state().jingles.start.record, [false]);
  assert.deepEqual(listener.state().jingles.end.record, [false, true]);
});

test('a jingle aired a few seconds off (receiver lag) is heard, not missed', async (t) => {
  const { listener, child } = await recallSetUp(t, 'tunein:s4', async () => null);
  // The decoded stream runs ahead of the receiver: the jingle 6 s before
  // the song end as the receiver dates it.
  await playBreak(t, child, listener, 71, { start: AD_JINGLE, startAt: 14, end: END_JINGLE });
  assert.deepEqual(listener.state().jingles.start.record, [true]);
  assert.deepEqual(listener.state().jingles.end.record, [true]);
  // Deep in the break (105 s after the song end): not a start jingle.
  await playBreak(t, child, listener, 72, { start: AD_JINGLE, startAt: 125, end: END_JINGLE });
  assert.deepEqual(listener.state().jingles.start.record, [true, false]);
});

test('a saved record is read back, and misses count over the last 6 breaks only', async (t) => {
  const T = true;
  const F = false;
  const { listener, child, counts, saved } = await recallSetUp(
    t,
    'tunein:s5',
    async () => null,
    // 11 saved (an older bug, a hand edit): the last 10 kept.
    { start: [T, T, F, F, F, T, T, T, T, T, T], end: [T, T, F, F, F, T] },
  );
  assert.deepEqual(listener.state().jingles.start.record, [T, F, F, F, T, T, T, T, T, T]);
  assert.equal(listener.hasReliable('start'), false, '7 of 10');
  assert.equal(listener.hasReliable('end'), false, '3 of 6');
  await playBreak(t, child, listener, 81);
  // Start: 1 miss in its last 6, still active; end: 4 of its last 6, demoted.
  assert.deepEqual(listener.state().jingles.start.record, [F, F, F, T, T, T, T, T, T, F]);
  assert.equal(listener.hasActive('start'), true);
  assert.equal(listener.hasActive('end'), false);
  assert.equal(counts.changes, 1);
  assert.equal((await saved()).jingles.end.active, false);
});

test('a long gap the detector did not take for a break judges no jingle', async (t) => {
  // Louis's case: both jingles air in every real break. Between the breaks,
  // the host talks 200 s or more (a feature, an interview), outside the ad
  // windows or in a window already used: no break was started there.
  const { listener, child, counts } = await recallSetUp(t, 'tunein:s6', async () => null);
  const real = { start: AD_JINGLE, end: END_JINGLE };
  const talk = { breakHandled: false };
  const order = [real, talk, real, talk, talk, real, talk, talk, talk, talk, real, real, talk];
  for (const [i, gap] of order.entries()) {
    await playBreak(t, child, listener, 100 + i, gap);
  }
  const breaks = order.filter((gap) => gap === real).length;
  for (const side of ['start', 'end']) {
    const jingle = listener.state().jingles[side];
    assert.equal(jingle.active, true, `${side}: never demoted by host talk`);
    assert.deepEqual(jingle.record, Array(breaks).fill(true), side);
    assert.equal(listener.hasReliable(side), true, `${side}: heard in ${breaks} of ${breaks}`);
  }
  assert.equal(counts.changes, 2, 'each jingle became reliable, nothing else');
});

test('a break the detector started without the jingles is a miss on both sides', async (t) => {
  // Opened by the ad window (the start jingle did not air), no end jingle.
  const { listener, child } = await recallSetUp(t, 'tunein:s7', async () => null);
  await playBreak(t, child, listener, 120);
  assert.deepEqual(listener.state().jingles.start.record, [false]);
  assert.deepEqual(listener.state().jingles.end.record, [false]);
  // Not passed at all (an older caller): not a break, nothing judged.
  playAudio(t, child, radioAudio(220, 121));
  const begin = Date.now() - 220_000;
  await listener.learnFromBreak({ songEndedAt: begin + 20_000, nextSongAt: begin + 200_000 });
  assert.deepEqual(listener.state().jingles.start.record, [false]);
  assert.deepEqual(listener.state().jingles.end.record, [false]);
});

test('the end jingle is heard up to 150 s before the next song, as its hits are confirmed', async (t) => {
  const { listener, child } = await recallSetUp(t, 'tunein:s8', async () => null);
  // The host talks after the ads: the end jingle 90 s, then 140 s before
  // the next song (at 200 s), still in the range that confirms its hits.
  await playBreak(t, child, listener, 130, { start: AD_JINGLE, end: END_JINGLE, endAt: 110 });
  await playBreak(t, child, listener, 131, { start: AD_JINGLE, end: END_JINGLE, endAt: 60 });
  assert.deepEqual(listener.state().jingles.end.record, [true, true]);
  // 165 s before it: beyond 150 s and its 10 s margin.
  await playBreak(t, child, listener, 132, { start: AD_JINGLE, end: END_JINGLE, endAt: 35 });
  assert.deepEqual(listener.state().jingles.end.record, [true, true, false]);
});

test('the start range keeps its 10 s margin on each side', async (t) => {
  const { listener, child } = await recallSetUp(t, 'tunein:s9', async () => null);
  // 9 s before the song end: heard. 101 s after it (90 s + 10 s + 1 s): missed.
  await playBreak(t, child, listener, 140, { start: AD_JINGLE, startAt: 11, end: END_JINGLE });
  await playBreak(t, child, listener, 141, { start: AD_JINGLE, startAt: 121, end: END_JINGLE });
  // 99 s after it: heard.
  await playBreak(t, child, listener, 142, { start: AD_JINGLE, startAt: 119, end: END_JINGLE });
  assert.deepEqual(listener.state().jingles.start.record, [true, false, true]);
});

test('a jingle under loud talk (score ~0.45) is a miss: heard needs a hit score', async (t) => {
  const { listener, child } = await recallSetUp(t, 'tunein:s10', async () => null);
  const talk = radioAudio(2, 78);
  const buried = Int16Array.from(AD_JINGLE, (v, i) => v * 0.4 + talk[i]);
  await playBreak(t, child, listener, 150, { start: buried, end: END_JINGLE });
  assert.deepEqual(listener.state().jingles.start.record, [false]);
});

test('demotion counts the last 6 breaks exactly', async (t) => {
  const T = true;
  const F = false;
  const { listener, child } = await recallSetUp(t, 'tunein:s11', async () => null, {
    // Start: 3 misses in 5; one more makes 4 of the last 6 (not 3 of 5).
    start: [F, T, F, F, T],
    // End: 4 misses in 6; heard once more, its last 6 hold 3 (not 4 of 7).
    end: [F, F, F, F, T, T],
  });
  await playBreak(t, child, listener, 160, { end: END_JINGLE });
  assert.equal(listener.hasActive('start'), false, '4 misses in the last 6: demoted');
  assert.equal(listener.hasActive('end'), true, '3 misses in the last 6: kept');
  assert.deepEqual(listener.state().jingles.end.record, [F, F, F, F, T, T, T]);
});

test('reliable needs 80 %: 7 of 9 is not, 8 of 10 is', async (t) => {
  const T = true;
  const F = false;
  const { listener, child, counts } = await recallSetUp(t, 'tunein:s12', async () => null, {
    start: [F, T, T, F, T, T, T, T],
  });
  assert.equal(listener.hasReliable('start'), false, '6 of 8');
  await playBreak(t, child, listener, 170, { start: AD_JINGLE, end: END_JINGLE });
  assert.equal(listener.hasReliable('start'), false, '7 of 9 (78 %)');
  await playBreak(t, child, listener, 171, { start: AD_JINGLE, end: END_JINGLE });
  assert.equal(listener.hasReliable('start'), true, '8 of 10');
  assert.equal(counts.changes, 1);
});

for (const [i, bad] of [null, 'abc', { 0: true }, 3].entries()) {
  test(`a bad saved record (${JSON.stringify(bad)}) loads empty and learning goes on`, async (t) => {
    const { listener, child } = await recallSetUp(t, `tunein:bad${i}`, async () => null, {
      start: bad,
      end: bad,
    });
    assert.deepEqual(listener.state().jingles.start.record, []);
    assert.equal(listener.hasActive('start'), true);
    await playBreak(t, child, listener, 180 + i, { start: AD_JINGLE, end: END_JINGLE });
    assert.deepEqual(listener.state().jingles.start.record, [true]);
    assert.deepEqual(listener.state().jingles.end.record, [true]);
  });
}
