import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Before the import: the module reads where to keep its statistics.
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'adbreak-controller-'));
process.env.AD_BREAK_STATS_FILE = path.join(DIR, 'ad-breaks.json');
process.env.AD_BREAK_JINGLES_DIR = path.join(DIR, 'ad-jingles');
delete process.env.AD_BREAK_JINGLES;
const { createAdBreakController, adBreakReport, __resetStoreForTesting } =
  await import('../src/adbreak/index.js');

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const STREAM = { type: 'station', station: 'Radio X', mid: 'http://radio.example/live?token=1' };
const titled = (artist, song) => ({ ...STREAM, artist, song });
const OUIFM = {
  type: 'station',
  station: 'OUI FM',
  album_id: 's6586',
  mid: 'http://ouifm.ice.infomaniak.ch/ouifm-high.aac',
};
const OUIFM_PAGE = '"zones":[{"stream":{"idMds":"2174546520932614531"}}]';

/** Jingle listeners stand-ins, see createJingleListener() for the real one. */
function fakeJingles() {
  const made = [];
  const create = (opts) => {
    const listener = {
      opts,
      stopped: false,
      marks: [],
      ready: Promise.resolve(),
      tick() {},
      onSongStarted() {},
      hasActive: () => false,
      state: () => ({
        version: 2,
        samples: { start: [{}], end: [] },
        jingles: { start: null, end: null },
      }),
      learnFromBreak: async () => {},
      learnFromMark: async (at, side) => {
        listener.marks.push(side);
      },
      stop() {
        listener.stopped = true;
      },
    };
    made.push(listener);
    return listener;
  };
  return { create, made };
}

/** A controller over a fake receiver: its volume, what it published. */
function setUp(t, config = {}) {
  rmSync(process.env.AD_BREAK_STATS_FILE, { force: true });
  __resetStoreForTesting();
  const receiver = { volume: 50, accepts: true, sets: [], published: [], nowPlaying: [] };
  const settings = {
    ad_break_detection: true,
    ad_break_auto_duck: true,
    ad_break_jingles: true,
    ad_break_volume_drop: 20,
    ad_break_min_volume: 20,
    ...config,
  };
  const jingles = fakeJingles();
  const fetches = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetches.push(String(url));
    if (String(url).includes('api.deezer.com/search')) {
      return {
        ok: true,
        json: async () => ({ data: [{ duration: 200, artist: { name: 'A' }, title: 'B' }] }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const controller = createAdBreakController({
    name: 'test',
    getConfig: () => settings,
    getVolume: () => receiver.volume,
    setVolume: (level) => {
      receiver.sets.push(level);
      if (receiver.accepts) {
        receiver.volume = level;
      }
      return receiver.accepts;
    },
    publishAdBreak: (inBreak) => receiver.published.push(inBreak),
    publishNowPlaying: (text) => receiver.nowPlaying.push(text),
    createJingles: jingles.create,
  });
  t.after(() => controller.stop());
  return { controller, receiver, settings, jingles, fetches };
}

test.after(() => fs.rm(DIR, { recursive: true, force: true }));

test('detection off: nothing is learned, looked up or decoded, and the switch is refused', async (t) => {
  const { controller, receiver, jingles, fetches } = setUp(t, { ad_break_detection: false });
  controller.onNowPlayingMedia(titled('A', 'one'));
  controller.onPlayState(true);
  controller.onNowPlayingMedia(titled('A', 'two'));
  await wait();
  controller.setAdBreak(true);
  assert.deepEqual(fetches, []);
  assert.equal(jingles.made.length, 0);
  assert.deepEqual(receiver.sets, []);
  assert.deepEqual(receiver.published, [false]);
});

test('a manual break lowers the volume, a failed restore is retried until taken', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { controller, receiver, jingles } = setUp(t);
  controller.onNowPlayingMedia(STREAM);
  controller.onPlayState(true);
  await wait();
  assert.equal(jingles.made.length, 1, 'the stream is decoded for its jingles');
  assert.equal(jingles.made[0].opts.stationKey, 'url:http://radio.example/live', 'no token');
  assert.equal(jingles.made[0].opts.streamUrl, STREAM.mid);

  controller.setAdBreak(true);
  assert.deepEqual(receiver.sets, [30]);
  assert.deepEqual(receiver.published, [true, true]);

  // The end of the break, while HEOS is down: retried every second.
  receiver.accepts = false;
  controller.setAdBreak(false);
  assert.deepEqual(receiver.sets, [30, 50]);
  assert.equal(receiver.published.at(-1), false);
  t.mock.timers.tick(1000);
  assert.deepEqual(receiver.sets, [30, 50, 50]);
  receiver.accepts = true;
  t.mock.timers.tick(1000);
  assert.equal(receiver.volume, 50);
  t.mock.timers.tick(5000);
  assert.equal(receiver.sets.length, 4, 'no more retries once restored');
  assert.deepEqual(jingles.made[0].marks, ['start', 'end'], 'both presses teach a jingle');

  // A station without titles learns the break it was told about.
  await wait(100);
  const saved = JSON.parse(await fs.readFile(process.env.AD_BREAK_STATS_FILE, 'utf8'));
  assert.equal(saved['url:http://radio.example/live'].breaks.length, 1);
});

test('a volume changed by hand wins; an unknown one is waited for, then given up', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const { controller, receiver } = setUp(t, { ad_break_jingles: false });
  controller.onNowPlayingMedia(STREAM);
  controller.onPlayState(true);
  await wait();

  controller.setAdBreak(true);
  receiver.volume = 45; // the user turned it up a bit
  controller.setAdBreak(false);
  assert.deepEqual(receiver.sets, [30]);

  controller.setAdBreak(true);
  assert.deepEqual(receiver.sets, [30, 25], '45 - 20, above the minimum');
  receiver.volume = null; // HEOS lost: the real level is unknown
  controller.setAdBreak(false);
  t.mock.timers.tick(60_000);
  assert.deepEqual(receiver.sets, [30, 25], 'never set blind');
  // A new break meanwhile keeps the volume it is still lowered to.
  receiver.volume = 25;
  controller.setAdBreak(true);
  assert.deepEqual(receiver.sets, [30, 25]);
  receiver.volume = null;
  controller.setAdBreak(false);
  t.mock.timers.tick(3_601_000);
  receiver.volume = 25;
  t.mock.timers.tick(1000);
  assert.deepEqual(receiver.sets, [30, 25], 'given up after an hour');
});

test('below the minimum, or with ducking off, the volume is left alone', async (t) => {
  const { controller, receiver, settings } = setUp(t, { ad_break_jingles: false });
  controller.onNowPlayingMedia(STREAM);
  controller.onPlayState(true);
  await wait();
  receiver.volume = 15;
  controller.setAdBreak(true);
  controller.setAdBreak(false);
  settings.ad_break_auto_duck = false;
  receiver.volume = 50;
  controller.setAdBreak(true);
  controller.setAdBreak(false);
  receiver.volume = null;
  settings.ad_break_auto_duck = true;
  controller.setAdBreak(true);
  controller.setAdBreak(false);
  assert.deepEqual(receiver.sets, []);
  assert.deepEqual(receiver.published, [
    true,
    true,
    false,
    false,
    true,
    true,
    false,
    false,
    true,
    true,
    false,
    false,
  ]);
});

test('learned jingles start and end the break; an announcement ends it first', async (t) => {
  const { controller, receiver, jingles } = setUp(t);
  controller.onNowPlayingMedia(STREAM);
  controller.onPlayState(true);
  await wait();
  const [listener] = jingles.made;
  const context = listener.opts.context();
  assert.equal(context.hasSongs, false);
  assert.equal(context.inBreak, false);
  assert.equal(context.inAdWindow(Date.now()), false);
  listener.opts.onHit({ side: 'start', active: false });
  assert.deepEqual(receiver.sets, [], 'an observed jingle only feeds the learning');
  listener.opts.onHit({ side: 'start', active: true });
  assert.deepEqual(receiver.sets, [30]);
  listener.opts.onHit({ side: 'end', active: true });
  assert.deepEqual(receiver.sets, [30, 50]);
  listener.opts.onChange();

  listener.opts.onHit({ side: 'start', active: true });
  const tts = 'http://gladys.local/api/v1/tts.mp3';
  assert.equal(controller.interruptForAnnouncement(tts), 50, 'the volume to give back');
  assert.deepEqual(receiver.sets, [30, 50, 30, 50]);
  assert.equal(controller.interruptForAnnouncement(tts), null, 'no break any more');
  // The announcement stream is not a station: the stream decoding stops.
  controller.onNowPlayingMedia({ type: 'station', mid: tts });
  await wait();
  assert.equal(listener.stopped, true);
  assert.equal(jingles.made.length, 1);
});

test('song titles from HEOS feed the detector, only while detection is on', async (t) => {
  const { controller, settings, jingles, fetches } = setUp(t);
  controller.onPlayState(true);
  controller.onNowPlayingMedia(titled('A', 'one')); // joined mid-song: no lookup
  await wait();
  controller.onNowPlayingMedia(titled('A', 'one')); // same song
  controller.onNowPlayingMedia(titled('A', 'B'));
  await wait();
  assert.equal(fetches.filter((u) => u.includes('deezer')).length, 1);

  settings.ad_break_detection = false;
  controller.onConfigUpdated();
  await wait();
  assert.equal(jingles.made[0].stopped, true, 'switched off: the stream decoding stops');
  controller.onNowPlayingMedia(titled('A', 'C'));
  await wait();
  assert.equal(fetches.filter((u) => u.includes('deezer')).length, 1);
  controller.setAdBreak(true);
  assert.equal(controller.providesNowPlaying(), false);
});

test('a station feed is followed only while playing, its history learned only with detection on', async (t) => {
  const { controller, settings, fetches, receiver } = setUp(t, {
    ad_break_detection: false,
    ad_break_jingles: false,
  });
  const encoder = new TextEncoder();
  const feeds = [];
  globalThis.fetch.mock.mockImplementation(async (url, options) => {
    fetches.push(String(url));
    if (String(url).includes('feed.tunein.com/profiles/s6586')) {
      return { ok: true, json: async () => ({ Link: { WebUrl: 'http://www.ouifm.fr' } }) };
    }
    if (String(url) === 'https://www.ouifm.fr/') {
      return { ok: true, url, text: async () => OUIFM_PAGE };
    }
    if (String(url).includes('/api/TitleDiffusions?size=60')) {
      // Three songs of 200 s, each followed by a 300 s gap: two breaks.
      const now = Date.now();
      const items = [1000, 500, 0].map((ago, i) => ({
        id: i,
        timestamp: new Date(now - (ago + 10) * 1000).toISOString(),
        title: { artist: 'A', title: `T${i}`, deezerId: `${i}` },
      }));
      return { ok: true, json: async () => items };
    }
    if (String(url).includes('api.deezer.com/track/')) {
      return { ok: true, json: async () => ({ duration: 200 }) };
    }
    if (String(url).includes('/api/TitleDiffusions')) {
      return { ok: true, json: async () => [] };
    }
    feeds.push(options.signal);
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(encoder.encode('data: {"artist":"QUEEN","title":"BICYCLE RACE"}\n\n'));
      },
    });
    return { ok: true, status: 200, body };
  });
  controller.onNowPlayingMedia(OUIFM);
  await wait();
  assert.deepEqual(fetches, [], 'nothing looked up before it plays');
  controller.onPlayState(true);
  await wait(100);
  assert.equal(controller.providesNowPlaying(), true);
  assert.equal(feeds.length, 1);
  assert.equal(fetches.filter((u) => u.includes('size=60')).length, 0, 'no history learning');

  controller.onPlayState(false);
  assert.equal(controller.providesNowPlaying(), false);
  assert.equal(feeds[0].aborted, true, 'paused: the feed is closed');

  settings.ad_break_detection = true;
  controller.onConfigUpdated();
  controller.onPlayState(true);
  await wait(800);
  assert.equal(feeds.length, 2);
  assert.ok(
    fetches.some((u) => u.includes('size=60')),
    'the playlist history is read',
  );
  const saved = JSON.parse(await fs.readFile(process.env.AD_BREAK_STATS_FILE, 'utf8'));
  assert.deepEqual(
    saved['tunein:s6586'].breaks.map((b) => [b.durationSeconds, b.source]),
    [
      [300, 'history'],
      [300, 'history'],
    ],
  );
  assert.equal(saved['tunein:s6586'].feed.mdsId, '2174546520932614531');
  assert.equal(
    fetches.filter((u) => u.includes('feed.tunein.com')).length,
    1,
    'the feed lookup is cached',
  );
  assert.deepEqual(receiver.published, []);
});

test('stop() during a break restores the volume, and in-flight lookups start nothing after it', async (t) => {
  const { controller, receiver, jingles, fetches } = setUp(t);
  let release;
  const discovery = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch.mock.mockImplementation(async (url) => {
    fetches.push(String(url));
    if (String(url).includes('feed.tunein.com/profiles/s6586')) {
      await discovery;
      return { ok: true, json: async () => ({ Link: { WebUrl: 'http://www.ouifm.fr' } }) };
    }
    if (String(url) === 'https://www.ouifm.fr/') {
      return { ok: true, url, text: async () => OUIFM_PAGE };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  controller.onNowPlayingMedia(OUIFM);
  controller.onPlayState(true);
  await wait();
  controller.setAdBreak(true);
  assert.deepEqual(receiver.sets, [30]);

  controller.stop();
  assert.deepEqual(receiver.sets, [30, 50], 'restored on the way out');
  assert.equal(receiver.published.at(-1), false);
  assert.equal(jingles.made[0].stopped, true);
  release();
  await wait(100);
  assert.equal(fetches.filter((u) => u.includes('/ws/metas')).length, 0, 'no feed after stop()');
  assert.equal(jingles.made.length, 1, 'no new stream decoding after stop()');
  controller.onNowPlayingMedia(STREAM);
  controller.onPlayState(false);
  controller.onConfigUpdated();
  assert.equal(jingles.made.length, 1);
});

test('a long gap between two HEOS songs is learned as a break; a break switched off by hand', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { controller, receiver, jingles } = setUp(t);
  controller.onPlayState(true);
  controller.onNowPlayingMedia(titled('A', 'one')); // joined mid-song
  await wait();
  controller.onNowPlayingMedia(titled('A', 'B')); // 200 s long (Deezer)
  await wait();
  t.mock.timers.tick(500_000);
  controller.onNowPlayingMedia(titled('A', 'B2')); // 300 s after its end
  await wait(100);
  const saved = JSON.parse(await fs.readFile(process.env.AD_BREAK_STATS_FILE, 'utf8'));
  const [brk] = saved['url:http://radio.example/live'].breaks;
  assert.equal(brk.durationSeconds, 300);

  controller.setAdBreak(true);
  assert.deepEqual(receiver.sets, [30]);
  controller.setAdBreak(false);
  assert.deepEqual(receiver.sets, [30, 50]);
  assert.deepEqual(jingles.made[0].marks, ['start'], 'with titles, only the start is taught');
});

test('insights: the station playing, else the last one, and every station in the report', async (t) => {
  const { controller, receiver } = setUp(t);
  assert.deepEqual(await controller.insights(), {
    detection: true,
    jinglesEnabled: true,
    autoDuck: true,
    playing: false,
    inBreak: false,
    breakSince: null,
    ducked: null,
    station: null,
  });
  controller.onNowPlayingMedia(STREAM);
  controller.onPlayState(true);
  await wait();
  controller.setAdBreak(true);
  const during = await controller.insights();
  assert.equal(during.inBreak, true);
  assert.ok(during.breakSince <= Date.now());
  assert.deepEqual(during.ducked, { saved: 50, ducked: 30 });
  assert.equal(during.songSource, 'none');
  assert.equal(during.station.name, 'Radio X');
  assert.equal(during.station.jingles.start.samples, 1, 'the live listener state');
  controller.setAdBreak(false);
  await wait(100);

  controller.onNowPlayingMedia({ type: 'station', mid: 'http://other.example/x' });
  controller.onNowPlayingMedia({ type: 'song', mid: 'local' }); // no radio any more
  const after = await controller.insights();
  assert.equal(after.playing, false);
  assert.equal(after.station.key, 'url:http://other.example/x', 'the last station played');
  assert.equal(after.station.jingles.start.state, 'none', 'read from the (missing) file');
  assert.equal(receiver.volume, 50);

  const report = await adBreakReport();
  assert.deepEqual(
    report.map((s) => [s.key, s.name, s.breaksLearned]),
    [['url:http://radio.example/live', 'Radio X', 1]],
  );
});
