import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStats,
  recordBreak,
  recordMarkOffset,
  learnedWindows,
  learnedSchedule,
  windowsAt,
  isInWindow,
  preBreakTalkSeconds,
  preBreakTalkByHour,
  typicalBreakSeconds,
  DEFAULT_PRE_BREAK_TALK_SECONDS,
} from '../src/adbreak/stats.js';
import { createAdBreakDetector, MAX_BREAK_SECONDS } from '../src/adbreak/detector.js';
import {
  SAMPLE_RATE,
  FRAME_SECONDS,
  bandFrames,
  createBandStream,
  normalizedWindow,
  dot,
  encodeFrames,
  decodeFrames,
} from '../src/adbreak/bands.js';
import { findSharedJingle, hitVerdict } from '../src/adbreak/jingles.js';
import {
  identifyStation,
  parseIndesRadiosEvent,
  breaksFromHistory,
  discoverFeed,
  fetchPlaylistHistory,
  lookupDurationSeconds,
} from '../src/adbreak/sources.js';

// Local wall-clock time on a fixed day: the learned minute of the hour is local.
const at = (h, m, s = 0) => new Date(2026, 9, 7, h, m, s).getTime();

// The 32 break start minutes actually measured on OUI FM's playlist history.
const OUIFM_BREAK_MINUTES = [
  36, 38, 38, 40, 11, 44, 41, 11, 42, 13, 44, 47, 13, 34, 39, 44, 12, 44, 44, 14, 42, 10, 35, 10,
  42, 10, 10, 9, 42, 13, 44, 13,
];

test('learnedWindows finds the two OUI FM ad windows from its measured breaks', () => {
  let stats = emptyStats();
  OUIFM_BREAK_MINUTES.forEach((minute, i) => {
    stats = recordBreak(stats, {
      startedAt: at(i % 24, minute),
      durationSeconds: 360,
      source: 'auto',
    });
  });
  const windows = learnedWindows(stats);
  assert.equal(windows.length, 2);
  for (const minute of [9, 10, 13, 14, 35, 42, 44, 45]) {
    assert.ok(
      isInWindow(minute, windows),
      `:${minute} should be in a window (${JSON.stringify(windows)})`,
    );
  }
  for (const minute of [0, 5, 20, 25, 30, 52, 57]) {
    assert.ok(
      !isInWindow(minute, windows),
      `:${minute} should be outside (${JSON.stringify(windows)})`,
    );
  }
  assert.equal(typicalBreakSeconds(stats), 360);
});

test('learnedWindows falls back to the seed windows until enough breaks are learned', () => {
  const seed = [[9, 15]];
  let stats = emptyStats();
  assert.deepEqual(learnedWindows(stats, seed), seed);
  stats = recordBreak(stats, { startedAt: at(10, 30), durationSeconds: 300, source: 'auto' });
  assert.deepEqual(learnedWindows(stats, seed), seed);
});

test('learnedWindows follows the breaks of the last days, not the old schedule', () => {
  const now = at(12, 0);
  const days = (n) => n * 86_400_000;
  let stats = emptyStats();
  for (let i = 0; i < 10; i++) {
    // The old schedule (three weeks ago) at :20, the current one at :40.
    stats = recordBreak(stats, {
      startedAt: at(10, 20) - days(21),
      durationSeconds: 300,
      source: 'auto',
    });
    stats = recordBreak(stats, {
      startedAt: at(10, 40) - days(i % 3),
      durationSeconds: 300,
      source: 'auto',
    });
  }
  const windows = learnedWindows(stats, [], now);
  assert.ok(isInWindow(40, windows), JSON.stringify(windows));
  assert.ok(!isInWindow(20, windows), JSON.stringify(windows));
});

test('learnedSchedule learns the hours with ads, and weekends apart', () => {
  // Two weeks of history: on weekdays, breaks at :12 and :40 from 6h to
  // 20h; on weekends at :25 only, from 9h to 19h. Nothing at night.
  const end = new Date(2026, 9, 19, 0, 0).getTime(); // a Monday, midnight
  const coveredFrom = end - 14 * 86_400_000;
  let stats = emptyStats();
  for (let day = 0; day < 14; day++) {
    const midnight = coveredFrom + day * 86_400_000;
    const weekend = [0, 6].includes(new Date(midnight).getDay());
    for (let hour = weekend ? 9 : 6; hour < (weekend ? 19 : 21); hour++) {
      for (const minute of weekend ? [25] : [12, 40]) {
        const startedAt = midnight + hour * 3_600_000 + minute * 60_000;
        stats = recordBreak(stats, { startedAt, durationSeconds: 300, source: 'history' });
      }
    }
  }
  const schedule = learnedSchedule(stats, { coveredFrom, now: end });
  const tuesday = (h, m) => new Date(2026, 9, 13, h, m).getTime();
  const saturday = (h, m) => new Date(2026, 9, 17, h, m).getTime();
  assert.ok(isInWindow(12, windowsAt(schedule, tuesday(10, 12))));
  assert.ok(isInWindow(40, windowsAt(schedule, tuesday(10, 40))));
  assert.deepEqual(windowsAt(schedule, tuesday(23, 12)), [], 'no ads at night');
  assert.deepEqual(windowsAt(schedule, tuesday(3, 40)), [], 'no ads at night');
  assert.ok(isInWindow(25, windowsAt(schedule, saturday(10, 25))));
  assert.ok(!isInWindow(40, windowsAt(schedule, saturday(10, 40))), 'weekend schedule');
  assert.deepEqual(windowsAt(schedule, saturday(7, 25)), [], 'weekend mornings have none');
});

test('learnedSchedule without a full coverage (no history) keeps every hour', () => {
  let stats = emptyStats();
  for (const minute of OUIFM_BREAK_MINUTES) {
    stats = recordBreak(stats, { startedAt: at(10, minute), durationSeconds: 300, source: 'auto' });
  }
  const schedule = learnedSchedule(stats, { now: at(12, 0) });
  assert.equal(schedule.hours, null);
  assert.ok(isInWindow(40, windowsAt(schedule, at(23, 40))));
});

test('learnedWindows keeps a window wrapping past the hour in one piece', () => {
  let stats = emptyStats();
  for (const minute of [58, 59, 0, 1, 58, 59, 0, 1]) {
    stats = recordBreak(stats, { startedAt: at(10, minute), durationSeconds: 300, source: 'auto' });
  }
  const windows = learnedWindows(stats);
  assert.equal(windows.length, 1);
  for (const minute of [57, 58, 59, 0, 1, 2]) {
    assert.ok(isInWindow(minute, windows), `:${minute} in ${JSON.stringify(windows)}`);
  }
  assert.ok(!isInWindow(30, windows));
});

test('preBreakTalkSeconds learns the median host talk from manual marks', () => {
  let stats = emptyStats();
  assert.equal(preBreakTalkSeconds(stats), DEFAULT_PRE_BREAK_TALK_SECONDS);
  for (const offset of [30, 40, 50, 9999]) {
    stats = recordMarkOffset(stats, offset); // 9999 is out of range: ignored
  }
  assert.equal(preBreakTalkSeconds(stats), 40);
});

test('preBreakTalkByHour learns a shorter host talk for the hours it was marked at', () => {
  let stats = emptyStats();
  for (const [offset, hour] of [
    [2, 7],
    [4, 7],
    [3, 8],
    [45, 13],
    [40, 17],
  ]) {
    stats = recordMarkOffset(stats, offset, at(hour, 10));
  }
  const byHour = preBreakTalkByHour(stats);
  assert.equal(byHour[7], 3); // morning: no host, ads right after the song
  assert.equal(byHour[8], 3); // 7h and 8h marks are within ±1 hour
  assert.equal(byHour[13], preBreakTalkSeconds(stats)); // one mark only: all-day median
  assert.equal(byHour[13], 4);
});

test('the detector uses the host talk learned for the hour the song ended at', () => {
  const byHour = new Array(24).fill(45);
  byHour[7] = 3;
  const h = harness({ preBreakTalkByHour: byHour });
  h.setTime(at(7, 8));
  h.detector.onTrack({ startedAt: at(7, 8), durationSeconds: 120 }); // ends 7:10, in window
  h.runUntil(at(7, 10, 3));
  assert.deepEqual(h.events, [['start', 'song_ended_in_window']]);
});

function harness(stationOverrides = {}) {
  let clock = at(12, 0);
  const events = [];
  const detector = createAdBreakDetector({
    now: () => clock,
    onBreakStart: (info) => events.push(['start', info.reason]),
    onBreakEnd: (info) => events.push(['end', info.reason]),
    onGap: (info) => events.push(['gap', Math.round(info.gapSeconds)]),
    onMark: (info) => events.push(['mark', info.offsetSeconds, info.durationSeconds]),
  });
  detector.setStation({
    key: 'tunein:s6586',
    hasMetadata: true,
    windows: [
      [9, 15],
      [34, 48],
    ],
    preBreakTalkSeconds: 45,
    ...stationOverrides,
  });
  return {
    detector,
    events,
    setTime(t) {
      clock = t;
    },
    runUntil(t) {
      while (clock < t) {
        clock += 1000;
        detector.tick();
      }
    },
  };
}

test('a song ending inside an ad window starts a break after the usual host talk', () => {
  const h = harness();
  h.setTime(at(12, 40));
  h.detector.onTrack({ startedAt: at(12, 40), durationSeconds: 192 }); // ends 12:43:12
  h.runUntil(at(12, 43, 56));
  assert.deepEqual(h.events, []);
  h.runUntil(at(12, 43, 57)); // 12:43:12 + 45 s
  assert.deepEqual(h.events, [['start', 'song_ended_in_window']]);
  h.detector.onTrack({ startedAt: at(12, 49, 45), durationSeconds: 201 });
  assert.deepEqual(h.events.slice(1), [
    ['gap', 393],
    ['end', 'next_song'],
  ]);
});

test('outside an ad window only a long silence counts as a break (host talk is spared)', () => {
  const h = harness();
  h.setTime(at(12, 28));
  h.detector.onTrack({ startedAt: at(12, 27, 45), durationSeconds: 168 }); // ends 12:30:33
  h.runUntil(at(12, 32, 14)); // the host talked 101 s, then the next song
  h.detector.onTrack({ startedAt: at(12, 32, 14), durationSeconds: 183 });
  assert.deepEqual(h.events, [['gap', 101]]);
});

test('outside an ad window even a long talk is not a break, only the jingle starts one', () => {
  const h = harness();
  h.setTime(at(12, 17));
  h.detector.onTrack({ startedAt: at(12, 17), durationSeconds: 180 }); // ends 12:20
  h.runUntil(at(12, 26)); // a 6 min feature, no music
  assert.deepEqual(h.events, []);
  h.detector.jingleStart(); // ... until an ad jingle (once learned)
  assert.deepEqual(h.events, [['start', 'start_jingle']]);
});

test('in an hour without ads, a song ending in a window is not a break', () => {
  const hours = Array.from({ length: 24 }, (_, h) => h < 21);
  const windows = [
    [9, 15],
    [34, 48],
  ];
  const h = harness({
    schedule: {
      windows: { week: windows, sat: windows, sun: windows },
      hours: { week: hours, sat: hours, sun: hours },
    },
  });
  h.setTime(at(22, 36));
  h.detector.onTrack({ startedAt: at(22, 34), durationSeconds: 120 }); // ends 22:36
  h.runUntil(at(22, 42)); // a long late-evening talk
  assert.deepEqual(h.events, []);
});

test('a short false break (the host, then a song) does not use the window up', () => {
  const h = harness();
  h.setTime(at(12, 36));
  h.detector.onTrack({ startedAt: at(12, 34), durationSeconds: 120 }); // ends 12:36
  h.runUntil(at(12, 36, 46));
  h.detector.onTrack({ startedAt: at(12, 37, 10), durationSeconds: 180 }); // ends 12:40:10
  h.runUntil(at(12, 40, 56));
  assert.deepEqual(
    h.events.filter(([e]) => e !== 'gap'),
    [
      ['start', 'song_ended_in_window'],
      ['end', 'next_song'],
      ['start', 'song_ended_in_window'],
    ],
  );
});

test('a window already used by a break is not trusted again for a second one', () => {
  const h = harness();
  h.setTime(at(12, 40));
  h.detector.onTrack({ startedAt: at(12, 38), durationSeconds: 120 }); // ends 12:40
  h.runUntil(at(12, 44)); // a real break
  h.detector.onTrack({ startedAt: at(12, 44), durationSeconds: 120 }); // ends 12:46, same window
  h.runUntil(at(12, 47, 30));
  assert.deepEqual(
    h.events.filter(([kind]) => kind === 'start'),
    [['start', 'song_ended_in_window']],
  );
});

test('a break never outlasts MAX_BREAK_SECONDS', () => {
  const h = harness();
  h.setTime(at(12, 10));
  h.detector.onTrack({ startedAt: at(12, 7), durationSeconds: 180 }); // ends 12:10
  h.runUntil(at(12, 10) + (45 + MAX_BREAK_SECONDS + 2) * 1000);
  assert.deepEqual(h.events, [
    ['start', 'song_ended_in_window'],
    ['end', 'timeout'],
  ]);
});

test('without a known song end, nothing is ever detected automatically', () => {
  const h = harness();
  h.setTime(at(12, 10));
  h.detector.onTrack({ startedAt: at(12, 7), durationSeconds: null });
  h.runUntil(at(12, 30));
  assert.deepEqual(h.events, []);
});

test('changing station ends a running break', () => {
  const h = harness();
  h.setTime(at(12, 10));
  h.detector.onTrack({ startedAt: at(12, 7), durationSeconds: 180 });
  h.runUntil(at(12, 11));
  h.detector.setStation(null);
  assert.deepEqual(h.events, [
    ['start', 'song_ended_in_window'],
    ['end', 'station_changed'],
  ]);
});

test('on a station with metadata, a manual mark starts the break and records the host talk', () => {
  const h = harness();
  h.setTime(at(12, 20));
  h.detector.onTrack({ startedAt: at(12, 17), durationSeconds: 180 }); // ends 12:20, no window
  h.runUntil(at(12, 20, 38));
  h.detector.mark();
  assert.deepEqual(h.events, [
    ['mark', 38, null],
    ['start', 'manual'],
  ]);
});

test('on a station without metadata, the mark toggles the break and measures it', () => {
  const h = harness({ hasMetadata: false, windows: [] });
  h.setTime(at(12, 12));
  h.detector.mark();
  h.runUntil(at(12, 16));
  h.detector.mark();
  assert.deepEqual(h.events, [
    ['mark', null, null],
    ['start', 'manual'],
    ['mark', null, 240],
    ['end', 'manual'],
  ]);
});

test('without metadata, a learned window opening starts a break of the typical length', () => {
  const h = harness({ hasMetadata: false, windows: [[12, 15]], typicalBreakSeconds: 300 });
  h.setTime(at(12, 11, 58));
  h.runUntil(at(12, 12, 1));
  assert.deepEqual(h.events, [['start', 'schedule']]);
  h.runUntil(at(12, 17, 2));
  assert.deepEqual(h.events.at(-1), ['end', 'timeout']);
});

test('identifyStation recognizes OUI FM through TuneIn and its stream lag', () => {
  const station = identifyStation({
    type: 'station',
    song: '',
    station: 'OUI FM',
    artist: '',
    album_id: 's6586',
    mid: 'http://ouifm.ice.infomaniak.ch/ouifm-high.aac',
  });
  assert.equal(station.key, 'tunein:s6586');
  assert.equal(station.name, 'OUI FM');
  assert.equal(station.tuneinId, 's6586');
  assert.equal(station.lagSeconds, 3);
});

test('identifyStation recognizes the OUI FM HLS stream played as a URL, with its larger lag', () => {
  const station = identifyStation({
    type: 'song',
    song: 'Url Stream',
    artist: 'Url Stream',
    mid: 'https://ouifm.radiohls.infomaniak.com/ouifm/manifest.m3u8',
  });
  assert.equal(station.key, 'tunein:s6586'); // same statistics as through TuneIn
  assert.equal(station.lagSeconds, 40);
  assert.equal(station.heosTitle, ''); // "Url Stream" is a placeholder, not a title
});

test('identifyStation passes through HEOS metadata for any other station', () => {
  const station = identifyStation({
    type: 'station',
    song: 'Rock Steady',
    station: 'Radio Paradise',
    artist: 'Aretha Franklin',
    album_id: 's13606',
    mid: 'https://stream.radioparadise.com/ti-main-320',
  });
  assert.equal(station.key, 'tunein:s13606');
  assert.equal(station.tuneinId, 's13606');
  assert.equal(station.heosTitle, 'Rock Steady');
  assert.equal(station.heosArtist, 'Aretha Franklin');
});

test('identifyStation ignores non-radio playback', () => {
  assert.equal(identifyStation({ type: 'song', song: 'X', artist: 'Y', mid: '1234' }), null);
  assert.equal(identifyStation(null), null);
});

test('parseIndesRadiosEvent reads the live feed lines', () => {
  assert.deepEqual(
    parseIndesRadiosEvent(
      'data: {"artist":"KINGS OF LEON","durationInSeconds":"201","title":"SEX ON FIRE","type":"song"}',
    ),
    { title: 'SEX ON FIRE', artist: 'KINGS OF LEON', durationSeconds: 201, type: 'song' },
  );
  assert.equal(parseIndesRadiosEvent(': keep-alive'), null);
  assert.equal(parseIndesRadiosEvent('data: not json'), null);
});

test('controller: a feed song change is applied only once the stream lag has elapsed', async (t) => {
  process.env.AD_BREAK_STATS_FILE = `${process.env.TMPDIR || '/tmp'}/adbreak-test-${process.pid}.json`;
  process.env.AD_BREAK_JINGLES = 'off'; // no ffmpeg/stream in unit tests
  const { createAdBreakController, __resetStoreForTesting } =
    await import('../src/adbreak/index.js');
  __resetStoreForTesting();
  const encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('feed.tunein.com/profiles/s6586')) {
      return { ok: true, json: async () => ({ Link: { WebUrl: 'http://www.ouifm.fr' } }) };
    }
    if (String(url) === 'https://www.ouifm.fr/') {
      return { ok: true, url, text: async () => OUIFM_PAGE };
    }
    if (String(url).includes('/api/TitleDiffusions')) {
      return { ok: true, json: async () => [] };
    }
    // The live feed: one song, then stays open.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"artist":"QUEEN","title":"BICYCLE RACE","durationInSeconds":"184"}\n\n',
          ),
        );
      },
    });
    return { ok: true, status: 200, body };
  });

  const published = [];
  const controller = createAdBreakController({
    name: 'test',
    getConfig: () => ({ ad_break_detection: true, ad_break_auto_duck: false }),
    getVolume: () => 30,
    setVolume: () => true,
    publishAdBreak: () => {},
    publishNowPlaying: (text) => published.push([Date.now(), text]),
  });
  const startedAt = Date.now();
  controller.onNowPlayingMedia({
    type: 'station',
    station: 'OUI FM',
    album_id: 's6586',
    mid: 'http://ouifm.ice.infomaniak.ch/ouifm-high.aac', // TuneIn/Icecast: 3 s lag
  });
  controller.onPlayState(true);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200)); // feed discovery (async)
    assert.equal(controller.providesNowPlaying(), true);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.deepEqual(published, [], 'not before the 3 s stream lag');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(published.length, 1);
    assert.equal(published[0][1], 'QUEEN - BICYCLE RACE');
    assert.ok(published[0][0] - startedAt >= 2900);
  } finally {
    controller.stop();
  }
});

// Trimmed from the real www.ouifm.fr page data: the main station comes first
// in `zones`, its webradios follow elsewhere in the page.
const OUIFM_PAGE =
  '<script id="__NEXT_DATA__">{"ENDPOINT":"/graphql","zones":[{"group":null,"id":"PduHlGne1L",' +
  '"label":"National","stream":{"hd":"x","idMds":"2174546520932614531","label":"Oüi FM",' +
  '"type":"RADIO"}}],"webradios":[{"idMds":"3134161803443976427","label":"Oüi FM Classic Rock"}]}</script>';

test('discoverFeed finds the live feed of a TuneIn station through its website', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('feed.tunein.com/profiles/s6586')) {
      return { ok: true, json: async () => ({ Link: { WebUrl: 'http://www.ouifm.fr' } }) };
    }
    return { ok: true, url: 'https://www.ouifm.fr/', text: async () => OUIFM_PAGE };
  };
  assert.deepEqual(await discoverFeed('s6586', fetchImpl), {
    type: 'indesradios',
    site: 'https://www.ouifm.fr',
    mdsId: '2174546520932614531',
  });
});

test('discoverFeed returns null for a website on another platform', async () => {
  const fetchImpl = async (url) =>
    url.includes('feed.tunein.com')
      ? { ok: true, json: async () => ({ Link: { WebUrl: 'https://www.energyfm.net/' } }) }
      : { ok: true, url, text: async () => '<html>no platform data</html>' };
  assert.equal(await discoverFeed('s45495', fetchImpl), null);
});

test('breaksFromHistory keeps only the gaps long enough to be ad breaks', () => {
  const songs = [
    { startedAt: at(12, 0), d: 200 }, // ends 12:03:20, next at 12:03:25: 5 s gap
    { startedAt: at(12, 3, 25), d: 180 }, // ends 12:06:25, next at 12:13:05: 400 s
    { startedAt: at(12, 13, 5), d: null }, // unknown duration: skipped
    { startedAt: at(12, 20) },
  ];
  assert.deepEqual(
    breaksFromHistory(songs, (s) => s.d, { min: 200, max: 900 }),
    [{ startedAt: at(12, 6, 25), durationSeconds: 400 }],
  );
});

// Deterministic pseudo-random "radio": a new mix of tones and noise every
// 0.25 s (its spectrum keeps changing, like voice and music), never twice
// the same. Jingles are fixed sounds dropped in at different places.
function rng(seed) {
  // mulberry32: a plain LCG repeats itself within seconds of audio.
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function radioAudio(seconds, seed) {
  const random = rng(seed);
  const out = new Int16Array(seconds * SAMPLE_RATE);
  let lowpassed = 0;
  for (let s = 0; s < out.length;) {
    // Segments of 80-300 ms, 1-6 tones, noise of a random color.
    const length = Math.round(SAMPLE_RATE * (0.08 + random() * 0.22));
    const tones = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({
      f: 150 + random() * 4500,
      a: random() * 4000,
    }));
    const noise = random() * 4000;
    const color = random();
    for (let i = s; i < Math.min(s + length, out.length); i++) {
      lowpassed = color * lowpassed + (1 - color) * (random() - 0.5);
      let v = lowpassed * noise * 2;
      for (const { f, a } of tones) {
        v += a * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
      }
      out[i] = v;
    }
    s += length;
  }
  return out;
}
// A 2 s jingle: a rising chirp over a noise "swoosh" (seeded: always the same).
function jingleAudio(seed, fromHz, toHz) {
  const random = rng(seed);
  const n = 2 * SAMPLE_RATE;
  let phase = 0;
  return Int16Array.from({ length: n }, (_, i) => {
    phase += (2 * Math.PI * (fromHz + ((toHz - fromHz) * i) / n)) / SAMPLE_RATE;
    return 8000 * Math.sin(phase) + (random() - 0.5) * 6000 * Math.sin((Math.PI * i) / n);
  });
}
const AD_JINGLE = jingleAudio(999, 400, 3500);
const SPONSOR_TAG = jingleAudio(777, 3000, 800);
function breakSample(seed, sounds) {
  const audio = radioAudio(60, seed);
  for (const [sound, atSeconds] of sounds) {
    audio.set(sound, atSeconds * SAMPLE_RATE);
  }
  // The anchor (song end) is 10 s into the sample.
  return { frames: bandFrames(audio), anchor: Math.round(10 / FRAME_SECONDS) };
}

test('hitVerdict: with titles, a song right after a start hit disproves it', () => {
  const hit = { side: 'start', at: 0 };
  assert.equal(hitVerdict(hit, { now: 30_000, songAt: 30_000, hasSongs: true }), false);
  assert.equal(hitVerdict(hit, { now: 100_000, hasSongs: true }), null);
  assert.equal(hitVerdict(hit, { now: 151_000, hasSongs: true }), true);
  const end = { side: 'end', at: 0 };
  assert.equal(hitVerdict(end, { now: 90_000, songAt: 90_000, hasSongs: true }), true);
  assert.equal(hitVerdict(end, { now: 151_000, hasSongs: true }), false);
});

test('hitVerdict: without titles, a hit is checked against the schedule and the presses', () => {
  const late = { now: 151_000, hasSongs: false };
  assert.equal(hitVerdict({ side: 'start', at: 0, inAdWindow: false }, late), false);
  assert.equal(hitVerdict({ side: 'start', at: 0, inAdWindow: true }, late), true);
  assert.equal(
    hitVerdict({ side: 'start', at: 0, inAdWindow: false }, { now: 100_000, hasSongs: false }),
    null,
  );
  assert.equal(
    hitVerdict({ side: 'start', at: 0, marked: true }, { now: 10_000, hasSongs: false }),
    true,
  );
  assert.equal(hitVerdict({ side: 'end', at: 0, inBreak: false }, late), false);
  assert.equal(hitVerdict({ side: 'end', at: 0, inBreak: true }, late), true);
});

test('findSharedJingle finds the sound every break shares, wherever the host stopped talking', () => {
  const samples = [
    breakSample(11, [[AD_JINGLE, 15]]),
    breakSample(22, [[AD_JINGLE, 40]]),
    breakSample(33, [[AD_JINGLE, 25]]),
  ];
  const jingle = findSharedJingle(samples);
  assert.ok(jingle, 'a shared jingle is found');
  assert.equal(jingle.support, 3);
  // Median position: the jingle at 15 s from the anchor, give or take its length.
  assert.ok(jingle.offsetSeconds >= 13 && jingle.offsetSeconds <= 18, `${jingle.offsetSeconds}`);
  // The template recognizes the jingle in a new break, and not the rest.
  const template = normalizedWindow(jingle.frames, 0, jingle.frames.length);
  const fresh = breakSample(44, [[AD_JINGLE, 30]]).frames;
  const scores = [];
  for (let i = 0; i + jingle.frames.length <= fresh.length; i++) {
    const w = normalizedWindow(fresh, i, jingle.frames.length);
    scores.push(w ? dot(w, template) : 0);
  }
  const best = scores.indexOf(Math.max(...scores));
  assert.ok(Math.abs(best * FRAME_SECONDS - 30) < 2, `found at ${best * FRAME_SECONDS} s`);
  assert.ok(scores[best] > 0.5);
  const elsewhere = scores.filter((_, i) => Math.abs(i * FRAME_SECONDS - 30) > 3);
  assert.ok(Math.max(...elsewhere) < 0.5, `max elsewhere ${Math.max(...elsewhere)}`);
});

test('findSharedJingle prefers the earliest of the shared sounds', () => {
  const samples = [
    breakSample(11, [
      [AD_JINGLE, 15],
      [SPONSOR_TAG, 45],
    ]),
    breakSample(22, [
      [AD_JINGLE, 20],
      [SPONSOR_TAG, 38],
    ]),
    breakSample(33, [
      [AD_JINGLE, 12],
      [SPONSOR_TAG, 50],
    ]),
  ];
  const jingle = findSharedJingle(samples);
  assert.ok(jingle);
  // The ad jingle (median 15 s after the song end), not the sponsor tag.
  assert.ok(jingle.offsetSeconds < 25, `${jingle.offsetSeconds}`);
});

test('findSharedJingle finds nothing in breaks that share no sound', () => {
  const samples = [11, 22, 33].map((seed) => breakSample(seed, []));
  assert.equal(findSharedJingle(samples), null);
});

test('band frames: streaming equals batch, storage round-trips', () => {
  const audio = radioAudio(5, 5);
  const batch = bandFrames(audio);
  const streamed = [];
  const stream = createBandStream((frame) => streamed.push(frame));
  for (let i = 0; i < audio.length; i += 1000) {
    stream.push(audio.subarray(i, i + 1000));
  }
  assert.equal(streamed.length, batch.length);
  assert.deepEqual(streamed[17], batch[17]);
  const decoded = decodeFrames(encodeFrames(batch));
  assert.equal(decoded.length, batch.length);
  const a = normalizedWindow(batch, 0, 30);
  const b = normalizedWindow(decoded, 0, 30);
  assert.ok(dot(a, b) > 0.99);
});

test('fetchPlaylistHistory pages back from the oldest song of each page', async () => {
  const HOUR = 3_600_000;
  const now = Date.now();
  const dates = [];
  // Each page: 3 songs, 20 min apart, before the requested date.
  const fetchImpl = async (url) => {
    const date = Number(new URL(url).searchParams.get('date'));
    dates.push(date);
    const items = [1, 2, 3].map((k) => ({
      id: `${date - k * 1_200_000}`,
      timestamp: new Date(date - k * 1_200_000).toISOString(),
      title: { artist: 'A', title: `T${k}`, deezerId: null },
    }));
    return { ok: true, json: async () => items };
  };
  const songs = await fetchPlaylistHistory({ site: 'https://x', mdsId: '1', hours: 3, fetchImpl });
  assert.equal(dates.length, 3);
  assert.equal(dates[1], dates[0] - HOUR);
  assert.ok(songs[0].startedAt <= now - 3 * HOUR);
  assert.ok(songs.every((s, i) => i === 0 || s.startedAt > songs[i - 1].startedAt));
});

test('lookupDurationSeconds picks the result matching artist and title', async () => {
  const fetchImpl = async () => ({
    json: async () => ({
      data: [
        {
          title: 'Special K (Live)',
          title_short: 'Special K',
          artist: { name: 'Placebo' },
          duration: 300,
        },
        {
          title: 'Special K',
          title_short: 'Special K',
          artist: { name: 'Placebo' },
          duration: 232,
        },
      ].reverse(),
    }),
  });
  assert.equal(await lookupDurationSeconds('PLACEBO', 'SPECIAL K', fetchImpl), 232);
  const other = async () => ({
    json: async () => ({ data: [{ title: 'X', artist: { name: 'Someone else' }, duration: 100 }] }),
  });
  assert.equal(await lookupDurationSeconds('NOBODY', 'NOTHING', other), null);
});

test('identifyStation decodes a URL-encoded station name', () => {
  const station = identifyStation({
    type: 'station',
    station: 'OUI%20FM',
    album_id: 's6586',
    mid: 'http://ouifm.ice.infomaniak.ch/ouifm-high.aac',
  });
  assert.equal(station.name, 'OUI FM');
});
