// -----------------------------------------------------------------------------
// Ad-break controller: one per receiver. Glues the station identification and
// song feeds (sources.js), the learned per-station statistics (stats.js) and
// the detector state machine (detector.js) to the receiver itself, through
// the few callbacks src/devices/avr.js hands it (read/set the HEOS volume,
// publish the "ad break" state and the now-playing text).
//
// What it does with a detected break, by config:
//   - always: publishes the AD_BREAK state (true/false), so a Gladys scene can
//     react to it however the user likes;
//   - ad_break_auto_duck (default on): lowers the volume by
//     ad_break_volume_drop for the break, then restores it — unless the user
//     changed the volume in the meantime (then the user's choice wins).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createAdBreakDetector } from './detector.js';
import { createJingleListener, readJingleState } from './jingles.js';
import { describeStation } from './insights.js';
import {
  identifyStation,
  discoverFeed,
  followIndesRadiosFeed,
  fetchPlaylistHistory,
  breaksFromHistory,
  lookupDurationById,
  lookupDurationSeconds,
} from './sources.js';
import {
  BREAK_MIN_SECONDS,
  BREAK_MAX_SECONDS,
  emptyStats,
  recordBreak,
  recordMarkOffset,
  learnedWindows,
  learnedSchedule,
  LEARNING_DAYS,
  preBreakTalkSeconds,
  preBreakTalkByHour,
  typicalBreakSeconds,
  loadStatsStore,
  saveStatsStore,
} from './stats.js';

const logger = createLogger({ name: 'ad-break' });

// The integration container's only writable volume (see the Dockerfile).
const STATS_FILE = process.env.AD_BREAK_STATS_FILE || '/data/ad-breaks.json';

// Shared by every receiver: a station's schedule does not depend on which
// receiver plays it. Loaded once, saved after every change — one save at a
// time (two receivers, or the history and a live break, may save together).
let storePromise = null;
let saving = Promise.resolve();
function getStore() {
  storePromise ??= loadStatsStore(STATS_FILE);
  return storePromise;
}
function persist(store) {
  saving = saving
    .then(() => saveStatsStore(STATS_FILE, store))
    .catch((err) =>
      logger.warn(`Cannot save ad-break statistics to ${STATS_FILE}: ${err.message}`),
    );
  return saving;
}

/**
 * What was learned of every station (see insights.js), the most listened
 * first — the "Ad-break report" action of the Configuration screen.
 */
export async function adBreakReport(now = Date.now()) {
  const store = await getStore();
  const stations = await Promise.all(
    Object.entries(store)
      .filter(([, stats]) => Array.isArray(stats?.breaks))
      .map(async ([key, stats]) =>
        describeStation({ key, stats, jingles: await readJingleState(key), now }),
      ),
  );
  return stations
    .filter((s) => s.breaksLearned > 0 || s.jingles.start.state !== 'none')
    .sort((a, b) => b.breaksLearned - a.breaksLearned);
}

/** Test hook: forget the cached store (and optionally point at another file). */
export function __resetStoreForTesting() {
  storePromise = null;
}

const TICK_MS = 1000;
// How often a station's feed is looked for again when it had none.
const RECHECK_MS = 7 * 24 * 3_600_000;
// While a station is followed, its playlist history is read again this
// often (only the part not read yet): a continuous learning of its ad
// breaks, see LEARNING_DAYS in stats.js.
const HISTORY_REFRESH_MS = 3_600_000;
// A volume restore the receiver could not take (HEOS down) is retried this
// long, then given up.
const RESTORE_RETRY_MS = 3_600_000;
// Announcement URLs remembered, so a "Speak on a speaker" stream is never
// taken for a radio station.
const IGNORED_URLS = 10;

/**
 * @param {object} opts
 * @param {string} opts.name               for logs
 * @param {() => object} opts.getConfig    current normalized config
 * @param {() => number|null} opts.getVolume  current HEOS volume level (0-100), null if unknown
 * @param {(level: number) => boolean} opts.setVolume
 * @param {(inBreak: boolean) => void} opts.publishAdBreak
 * @param {(text: string) => void} opts.publishNowPlaying
 * @param {typeof createJingleListener} [opts.createJingles] (tests)
 */
export function createAdBreakController({
  name,
  getConfig,
  getVolume,
  setVolume,
  publishAdBreak,
  publishNowPlaying,
  createJingles = createJingleListener,
}) {
  let stopped = false;
  let station = null; // result of identifyStation(), plus feed and hasMetadata
  let lastStation = null; // the last one played, shown once it stops
  let playing = false;
  let feed = null; // live song feed of feedFor (also what shows its titles)
  let feedFor = null;
  let historyTimer = null; // hourly playlist-history learning of historyFor
  let historyFor = null;
  let lastHeosTitle = null;
  let duck = null; // { saved, ducked } while the volume is lowered by us
  let pendingRestore = null; // { saved, ducked, since }: a restore not taken yet
  let jingles = null; // jingle listener of the station playing, see jingles.js
  let lastPlayed = null; // last feed song applied: { station, startedAt, durationSeconds }
  const pendingTracks = new Set(); // feed song changes waiting for the stream lag
  const ignoredUrls = []; // streams the announcements played, newest last

  // Detection runs (learning, Deezer, the jingles, the volume) only while a
  // station plays with ad_break_detection on: off, it costs nothing.
  const detecting = () =>
    !stopped && playing && Boolean(station) && getConfig().ad_break_detection === true;

  // Give the volume back, unless the user changed it meanwhile. Not taken
  // (HEOS down, volume unknown until it reconnects): retried every tick.
  function restoreVolume(lowered) {
    const current = getVolume();
    if (current !== null && current !== undefined && current !== lowered.ducked) {
      logger.info(`${name}: volume changed by hand during the break (${current}), leaving it`);
      pendingRestore = null;
      return;
    }
    if (current != null && setVolume(lowered.saved)) {
      logger.info(`${name}: volume restored ${current} -> ${lowered.saved}`);
      pendingRestore = null;
      return;
    }
    if (!pendingRestore) {
      logger.warn(`${name}: cannot restore the volume to ${lowered.saved} yet, will retry`);
    }
    pendingRestore = { ...lowered, since: pendingRestore?.since ?? Date.now() };
  }

  function retryRestore() {
    if (!pendingRestore) {
      return;
    }
    if (Date.now() - pendingRestore.since > RESTORE_RETRY_MS) {
      logger.warn(`${name}: giving up restoring the volume to ${pendingRestore.saved}`);
      pendingRestore = null;
      return;
    }
    restoreVolume(pendingRestore);
  }

  const detector = createAdBreakDetector({
    onBreakStart({ reason }) {
      logger.info(`${name}: ad break started on ${station?.name} (${reason})`);
      publishAdBreak(true);
      const config = getConfig();
      if (!config.ad_break_auto_duck) {
        return;
      }
      const saved = getVolume();
      if (saved == null) {
        logger.warn(`${name}: volume unknown, not lowering it for the ad break`);
        return;
      }
      if (pendingRestore) {
        const lowered = pendingRestore;
        pendingRestore = null;
        if (saved === lowered.ducked) {
          // Still lowered from a break whose restore was not taken: keep it.
          duck = { saved: lowered.saved, ducked: lowered.ducked };
          return;
        }
      }
      // Never below ad_break_min_volume: ads turned down, not muted (real
      // feedback: 27 -> 7 was far too quiet).
      const ducked = Math.max(config.ad_break_min_volume, saved - config.ad_break_volume_drop);
      if (ducked >= saved) {
        logger.info(`${name}: volume ${saved} already at/below the ad-break minimum, leaving it`);
        return;
      }
      if (setVolume(ducked)) {
        duck = { saved, ducked };
        logger.info(`${name}: volume lowered ${saved} -> ${ducked} for the ad break`);
      }
    },
    onBreakEnd({ reason }) {
      logger.info(`${name}: ad break ended on ${station?.name ?? 'the station'} (${reason})`);
      publishAdBreak(false);
      if (duck) {
        const lowered = duck;
        duck = null;
        restoreVolume(lowered);
      }
    },
    onGap({ songEndedAt, gapSeconds }) {
      if (gapSeconds >= BREAK_MIN_SECONDS && gapSeconds <= BREAK_MAX_SECONDS) {
        jingles
          ?.learnFromBreak({ songEndedAt, nextSongAt: songEndedAt + gapSeconds * 1000 })
          .catch((err) => logger.warn(`${name}: jingle learning failed: ${err.message}`));
        updateStats((stats) =>
          recordBreak(stats, {
            startedAt: songEndedAt,
            durationSeconds: Math.round(gapSeconds),
            source: 'auto',
          }),
        );
      }
    },
    onMark({ at, offsetSeconds, durationSeconds, endedAt }) {
      // A press teaches the jingles too: the start one, or the end one when
      // it ends a manual break (a station without titles).
      jingles
        ?.learnFromMark(
          durationSeconds == null ? at : endedAt,
          durationSeconds == null ? 'start' : 'end',
        )
        .catch((err) => logger.warn(`${name}: jingle learning failed: ${err.message}`));
      const hasMetadata = station?.hasMetadata;
      updateStats((stats) => {
        let next = offsetSeconds != null ? recordMarkOffset(stats, offsetSeconds, at) : stats;
        // On a station with song metadata the break itself is measured from
        // the song gap (onGap): only the host-talk offset is learned here.
        if (!hasMetadata && durationSeconds != null) {
          next = recordBreak(next, { startedAt: at, durationSeconds, source: 'manual' });
        }
        return next;
      });
    },
  });

  const ticker = setInterval(() => {
    detector.tick();
    jingles?.tick();
    retryRestore();
  }, TICK_MS);
  ticker.unref?.();

  // Fire-and-forget async work: an error is logged, never left unhandled.
  const background = (promise, what) =>
    promise.catch((err) => logger.warn(`${name}: ${what} failed: ${err.message}`));

  async function stationContext(target) {
    const store = await getStore();
    const stats = store[target.key] ?? emptyStats();
    return {
      key: target.key,
      hasMetadata: target.hasMetadata,
      windows: learnedWindows(stats),
      schedule: learnedSchedule(stats, { coveredFrom: stats.historyFrom ?? null }),
      preBreakTalkSeconds: preBreakTalkSeconds(stats),
      preBreakTalkByHour: preBreakTalkByHour(stats),
      typicalBreakSeconds: typicalBreakSeconds(stats),
      hasStartJingle: jingles?.hasActive('start') ?? false,
    };
  }

  // The jingle listener decodes the station's stream: only while detecting,
  // with the jingles setting on.
  function syncJingles() {
    const wanted =
      detecting() &&
      station.streamUrl &&
      getConfig().ad_break_jingles !== false &&
      process.env.AD_BREAK_JINGLES !== 'off'
        ? station
        : null;
    if (jingles?.station === wanted) {
      return;
    }
    jingles?.stop();
    jingles = null;
    if (!wanted) {
      return;
    }
    const listener = createJingles({
      stationKey: wanted.key,
      streamUrl: wanted.streamUrl,
      onHit: ({ side, active }) => {
        if (!active || station !== wanted) {
          return; // Observed hits only feed the learning (see jingles.js).
        }
        if (side === 'start') {
          detector.jingleStart();
        } else {
          detector.jingleEnd();
        }
      },
      onChange: () => background(refreshDetectorStation(), 'detector refresh'),
      context: () => ({
        hasSongs: Boolean(wanted.hasMetadata),
        inAdWindow: (at) => detector.isAdTime(at),
        inBreak: detector.isInBreak(),
      }),
    });
    jingles = Object.assign(listener, { station: wanted });
    background(
      listener.ready.then(() => refreshDetectorStation()),
      'detector refresh',
    );
  }

  async function refreshDetectorStation() {
    syncJingles();
    if (!detecting()) {
      detector.setStation(null);
      return;
    }
    const target = station;
    const context = await stationContext(target);
    if (station === target && detecting()) {
      detector.setStation(context);
    }
  }

  async function updateStats(fn) {
    if (!detecting()) {
      return;
    }
    const { key, name } = station;
    const store = await getStore();
    store[key] = { ...fn(store[key] ?? emptyStats()), name };
    await persist(store);
    await refreshDetectorStation();
  }

  function stopHistory() {
    clearInterval(historyTimer);
    historyTimer = null;
    historyFor = null;
  }

  function stopFeed() {
    feed?.stop();
    feed = null;
    feedFor = null;
    stopHistory();
    for (const timer of pendingTracks) {
      clearTimeout(timer);
    }
    pendingTracks.clear();
  }

  // The live song feed of a station that has one: followed while it plays
  // (detection on or not: it is also what shows its real titles); its
  // playlist history is learned from only with detection on.
  function syncFeed() {
    const wanted = !stopped && playing && station?.feed ? station : null;
    if (feedFor !== wanted) {
      stopFeed();
      if (wanted) {
        feedFor = wanted;
        feed = followIndesRadiosFeed({
          site: wanted.feed.site,
          mdsId: wanted.feed.mdsId,
          onTrack: (track) => onFeedTrack(track, wanted),
        });
        logger.info(`${name}: ${wanted.name}: following its live song feed (${wanted.feed.site})`);
      }
    }
    const learning = feedFor && detecting() ? feedFor : null;
    if (historyFor !== learning) {
      stopHistory();
      if (learning) {
        historyFor = learning;
        const learn = () => background(learnFromHistory(learning), 'playlist history');
        historyTimer = setInterval(learn, HISTORY_REFRESH_MS);
        historyTimer.unref?.();
        learn();
      }
    }
  }

  // A feed runs ahead of what the receiver plays by the stream's buffering
  // (station.lagSeconds): apply each song change only when it is actually
  // heard — otherwise the end of a break (hence the volume restore) would
  // land during the last ads, ~40 s early on an HLS stream.
  function onFeedTrack(track, current) {
    const playedAt = track.startedAt + current.lagSeconds * 1000;
    const timer = setTimeout(
      () => {
        pendingTracks.delete(timer);
        if (station !== current) {
          return;
        }
        // The stream itself carries no title: show the feed's instead of
        // the bare station name HEOS reports.
        publishNowPlaying([track.artist, track.title].filter(Boolean).join(' - '));
        lastPlayed = {
          station: current,
          startedAt: playedAt,
          durationSeconds: track.durationSeconds,
        };
        if (detecting()) {
          detector.onTrack({ startedAt: playedAt, durationSeconds: track.durationSeconds });
          jingles?.onSongStarted(playedAt);
        }
      },
      Math.max(0, playedAt - Date.now()),
    );
    pendingTracks.add(timer);
  }

  function switchStation(next) {
    stopFeed();
    lastHeosTitle = null;
    station = next ? { ...next, feed: null, hasMetadata: false, feedLookup: false } : null;
    lastStation = station ?? lastStation;
    logger.info(
      `${name}: now playing ${station ? `${station.name} (${station.key})` : 'no radio station'}`,
    );
  }

  // Look up (once per station played, cached in the statistics store and
  // re-checked weekly when absent) whether this TuneIn station has a live
  // song feed: only once it actually plays.
  function lookUpFeed() {
    if (!playing || stopped || !station?.tuneinId || station.feedLookup) {
      return;
    }
    const current = station;
    current.feedLookup = true;
    background(
      resolveFeed(current).catch((err) => {
        current.feedLookup = false; // Tried again on the next play.
        throw err;
      }),
      `song feed lookup for ${current.name}`,
    );
  }

  async function resolveFeed(current) {
    const store = await getStore();
    let info = store[current.key]?.feed;
    if (!info || (info.none && Date.now() - info.checkedAt > RECHECK_MS)) {
      const found = await discoverFeed(current.tuneinId);
      info = found ? { ...found, checkedAt: Date.now() } : { none: true, checkedAt: Date.now() };
      store[current.key] = {
        ...(store[current.key] ?? emptyStats()),
        name: current.name,
        feed: info,
      };
      await persist(store);
    }
    if (station !== current || info.none) {
      return;
    }
    current.feed = info;
    current.hasMetadata = true;
    syncFeed();
    await refreshDetectorStation();
  }

  // Learn from the days of playlist the station already published, instead
  // of only from what is heard here: a new station's ad windows are known
  // within a minute of first playing it. Then, every HISTORY_REFRESH_MS,
  // the hours published since.
  async function learnFromHistory(current) {
    const store = await getStore();
    // Never read with its coverage (historyFrom): read it all.
    const readUntil =
      store[current.key]?.historyFrom != null ? store[current.key].historyReadUntil : 0;
    if (Date.now() - readUntil < HISTORY_REFRESH_MS) {
      return; // Read recently (the station was just paused and resumed).
    }
    const stillLearning = () => historyFor === current;
    // One hour of overlap: the song before the first new one is needed to
    // measure the gap after it.
    const hours = Math.min(LEARNING_DAYS * 24, Math.ceil((Date.now() - readUntil) / 3_600_000) + 1);
    const readAt = Date.now();
    const { site, mdsId } = current.feed;
    const songs = await fetchPlaylistHistory({ site, mdsId, hours });
    // The history has no durations: Deezer's, by track id or else by a
    // search, politely (Deezer allows 50 requests per 5 s).
    const keyOf = (s) => s.deezerId || `${s.artist}\n${s.title}`.toLowerCase();
    const unique = [...new Map(songs.map((s) => [keyOf(s), s])).values()];
    const durations = new Map();
    for (let i = 0; i < unique.length; i += 5) {
      if (!stillLearning()) {
        return;
      }
      await Promise.all(
        unique.slice(i, i + 5).map(async (s) => {
          const duration =
            (s.deezerId && (await lookupDurationById(s.deezerId))) ||
            (await lookupDurationSeconds(s.artist, s.title));
          durations.set(keyOf(s), duration);
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    if (!stillLearning()) {
      return;
    }
    const found = breaksFromHistory(songs, (s) => durations.get(keyOf(s)), {
      min: BREAK_MIN_SECONDS,
      max: BREAK_MAX_SECONDS,
    });
    let stats = store[current.key] ?? emptyStats();
    let added = 0;
    for (const brk of found) {
      // Already known (heard live, or read in a previous pass)?
      if (!stats.breaks.some((b) => Math.abs(b.at - brk.startedAt) < 3 * 60_000)) {
        stats = recordBreak(stats, { ...brk, source: 'history' });
        added += 1;
      }
    }
    // The history covers every hour since historyFrom (an hour without break
    // in it had none): what learnedSchedule needs to learn the hours with
    // ads. A read that does not reach back to the previous one leaves a
    // hole: the coverage restarts.
    const oldest = songs.length ? Math.min(...songs.map((s) => s.startedAt)) : readAt;
    const continuous = stats.historyFrom != null && oldest <= readUntil;
    const historyFrom = continuous ? stats.historyFrom : oldest;
    store[current.key] = { ...stats, name: current.name, historyReadUntil: readAt, historyFrom };
    await persist(store);
    logger.info(
      `${name}: ${current.name}: ${added} new ad breaks from ${songs.length} songs of the last ${hours} h of playlist history`,
    );
    if (station === current) {
      await refreshDetectorStation();
    }
  }

  // Everything that depends on the station, the play state or the config.
  function sync() {
    lookUpFeed();
    syncFeed();
    background(refreshDetectorStation(), 'detector refresh');
  }

  return {
    /** Feed every HEOS get_now_playing_media payload here. */
    onNowPlayingMedia(payload) {
      if (stopped) {
        return;
      }
      let next = identifyStation(payload);
      if (next?.streamUrl && ignoredUrls.includes(next.streamUrl)) {
        next = null; // An announcement, not a station.
      }
      if ((next?.key ?? null) !== (station?.key ?? null)) {
        switchStation(next);
        sync();
      }
      if (!station || station.feed || !next.heosTitle) {
        return;
      }
      // Metadata straight from HEOS: every title change is a new song.
      const title = `${next.heosArtist}\n${next.heosTitle}`;
      if (title === lastHeosTitle) {
        return;
      }
      const firstTitle = lastHeosTitle === null;
      lastHeosTitle = title;
      if (!station.hasMetadata) {
        station.hasMetadata = true;
        background(refreshDetectorStation(), 'detector refresh');
      }
      if (firstTitle || !detecting()) {
        return; // Joined mid-song: its start time (hence its end) is unknown.
      }
      const startedAt = Date.now();
      const current = station;
      background(
        lookupDurationSeconds(next.heosArtist, next.heosTitle).then((durationSeconds) => {
          if (station === current && detecting()) {
            detector.onTrack({ startedAt, durationSeconds });
            jingles?.onSongStarted(startedAt);
          }
        }),
        'song duration lookup',
      );
    },

    /** HEOS play state: only learn/act while actually playing. */
    onPlayState(isPlaying) {
      if (stopped || isPlaying === playing) {
        return;
      }
      playing = isPlaying;
      lookUpFeed();
      syncFeed();
      background(
        refreshDetectorStation().then(() => {
          // Paused, the detector forgot the song: give it back the one
          // playing now, so that resuming during a break (or just before
          // one) is caught without waiting for the next song.
          if (detecting() && lastPlayed && lastPlayed.station === station) {
            detector.onTrack(lastPlayed);
          }
        }),
        'detector refresh',
      );
    },

    /** The user said "it's an ad" (the AD_BREAK switch turned on). */
    mark() {
      if (!detecting()) {
        logger.warn(
          `${name}: "it's an ad" ignored: no radio station playing, or detection switched off`,
        );
        return;
      }
      detector.mark();
    },

    /**
     * The user switched the "Radio ad break" state: on = "it's an ad" (the
     * same as mark()), off = the break is over (restores the volume; on a
     * station without titles, also teaches the break length and its end
     * jingle). The state is published back either way, so a switch that
     * could not apply (no radio playing) falls back.
     */
    setAdBreak(on) {
      if (on && !detector.isInBreak()) {
        this.mark();
      } else if (!on && detector.isInBreak()) {
        if (station && !station.hasMetadata) {
          detector.mark();
        } else {
          detector.end();
        }
      }
      publishAdBreak(detector.isInBreak());
    },

    /**
     * An announcement is about to play `url` on this receiver: end a break
     * first (volume restored, so the announcement snapshots the real one)
     * and never take that stream for a station.
     * @returns {number|null} the volume to give back after the announcement
     *   when it was lowered for a break (HEOS level), else null
     */
    interruptForAnnouncement(url) {
      if (typeof url === 'string' && url) {
        ignoredUrls.push(url);
        ignoredUrls.splice(0, ignoredUrls.length - IGNORED_URLS);
      }
      const saved = duck?.saved ?? pendingRestore?.saved ?? null;
      detector.end('announcement');
      return saved;
    },

    /**
     * What is known of the ad breaks of the station playing, else of the
     * last one played (see insights.js), plus the live state: detection
     * on, playing, in a break since when, the volume lowered.
     */
    async insights(now = Date.now()) {
      const config = getConfig();
      const live = {
        detection: config.ad_break_detection === true,
        jinglesEnabled: config.ad_break_jingles !== false,
        autoDuck: config.ad_break_auto_duck !== false,
        playing: Boolean(station) && playing,
        inBreak: detector.isInBreak(),
        breakSince: detector.breakStartedAt(),
        ducked: duck ? { ...duck } : null,
      };
      const target = station ?? lastStation;
      if (!target) {
        return { ...live, station: null };
      }
      const store = await getStore();
      const jingleState =
        jingles?.station?.key === target.key ? jingles.state() : await readJingleState(target.key);
      return {
        ...live,
        songSource: target.feed ? 'feed' : target.hasMetadata ? 'heos' : 'none',
        station: describeStation({
          key: target.key,
          name: target.name,
          stats: store[target.key] ?? emptyStats(),
          jingles: jingleState,
          now,
        }),
      };
    },

    /** True while a station feed (not HEOS) supplies the now-playing text. */
    providesNowPlaying() {
      return feed !== null;
    },

    /** Config changed (detection switched on/off...): apply it, same station. */
    onConfigUpdated() {
      if (!stopped) {
        sync();
      }
    },

    /**
     * Stop everything — call it while the HEOS connection is still up: a
     * break in progress ends here, and its volume is restored through it.
     */
    stop() {
      stopped = true;
      clearInterval(ticker);
      stopFeed();
      jingles?.stop();
      jingles = null;
      detector.setStation(null);
      detector.end('stopped');
      station = null;
      playing = false;
    },
  };
}
