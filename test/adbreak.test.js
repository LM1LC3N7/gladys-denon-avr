import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStats,
  recordBreak,
  recordMarkOffset,
  learnedWindows,
  isInWindow,
  preBreakTalkSeconds,
  preBreakTalkByHour,
  typicalBreakSeconds,
  DEFAULT_PRE_BREAK_TALK_SECONDS,
} from '../src/adbreak/stats.js';
import {
  createAdBreakDetector,
  OUTSIDE_WINDOW_GRACE_SECONDS,
  MAX_BREAK_SECONDS,
} from '../src/adbreak/detector.js';
import {
  identifyStation,
  parseIndesRadiosEvent,
  breaksFromHistory,
  discoverFeed,
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

test('outside an ad window a silence longer than the host ever talks is a break', () => {
  const h = harness();
  h.setTime(at(12, 17));
  h.detector.onTrack({ startedAt: at(12, 17), durationSeconds: 180 }); // ends 12:20
  h.runUntil(at(12, 20) + OUTSIDE_WINDOW_GRACE_SECONDS * 1000 - 1000);
  assert.deepEqual(h.events, []);
  h.runUntil(at(12, 20) + OUTSIDE_WINDOW_GRACE_SECONDS * 1000);
  assert.deepEqual(h.events, [['start', 'song_ended_long_silence']]);
});

test('a window already used by a break is not trusted again for a second one', () => {
  const h = harness();
  h.setTime(at(12, 40));
  h.detector.onTrack({ startedAt: at(12, 38), durationSeconds: 120 }); // ends 12:40
  h.runUntil(at(12, 40, 46));
  h.detector.onTrack({ startedAt: at(12, 41), durationSeconds: 60 }); // ends 12:42, same window
  h.runUntil(at(12, 43));
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
