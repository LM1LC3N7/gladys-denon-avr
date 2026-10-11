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
