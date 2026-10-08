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
import { createJingleListener } from './jingles.js';
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
// receiver plays it. Loaded once, saved after every change.
let storePromise = null;
function getStore() {
  storePromise ??= loadStatsStore(STATS_FILE);
  return storePromise;
}
async function persist(store) {
  try {
    await saveStatsStore(STATS_FILE, store);
  } catch (err) {
    logger.warn(`Cannot save ad-break statistics to ${STATS_FILE}: ${err.message}`);
  }
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

/**
 * @param {object} opts
 * @param {string} opts.name               for logs
 * @param {() => object} opts.getConfig    current normalized config
 * @param {() => number|null} opts.getVolume  current HEOS volume level (0-100), null if unknown
 * @param {(level: number) => boolean} opts.setVolume
 * @param {(inBreak: boolean) => void} opts.publishAdBreak
 * @param {(text: string) => void} opts.publishNowPlaying
 */
export function createAdBreakController({
  name,
  getConfig,
  getVolume,
  setVolume,
  publishAdBreak,
  publishNowPlaying,
}) {
  let station = null; // result of identifyStation(), plus hasMetadata
  let playing = false;
  let feed = null;
  let lastHeosTitle = null;
  let duck = null; // { saved, ducked } while the volume is lowered by us
  let jingles = null; // jingle listener of the station playing, see jingles.js
  let historyTimer = null;
  let lastPlayed = null; // last feed song applied: { station, startedAt, durationSeconds }
  const pendingTracks = new Set(); // feed song changes waiting for the stream lag

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
      logger.info(`${name}: ad break ended on ${station?.name} (${reason})`);
      publishAdBreak(false);
      if (!duck) {
        return;
      }
      const current = getVolume();
      if (current === duck.ducked) {
        setVolume(duck.saved);
        logger.info(`${name}: volume restored ${current} -> ${duck.saved}`);
      } else {
        logger.info(`${name}: volume changed by hand during the break (${current}), leaving it`);
      }
      duck = null;
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
      updateStats((stats) => {
        let next = offsetSeconds != null ? recordMarkOffset(stats, offsetSeconds, at) : stats;
        // On a station with song metadata the break itself is measured from
        // the song gap (onGap): only the host-talk offset is learned here.
        if (!station?.hasMetadata && durationSeconds != null) {
          next = recordBreak(next, { startedAt: at, durationSeconds, source: 'manual' });
        }
        return next;
      });
    },
  });

  const ticker = setInterval(() => {
    detector.tick();
    jingles?.tick();
  }, TICK_MS);
  ticker.unref?.();

  async function stationContext() {
    const store = await getStore();
    const stats = store[station.key] ?? emptyStats();
    return {
      key: station.key,
      hasMetadata: station.hasMetadata,
      windows: learnedWindows(stats),
      schedule: learnedSchedule(stats, { coveredFrom: stats.historyFrom ?? null }),
      preBreakTalkSeconds: preBreakTalkSeconds(stats),
      preBreakTalkByHour: preBreakTalkByHour(stats),
      typicalBreakSeconds: typicalBreakSeconds(stats),
      hasStartJingle: jingles?.hasActive('start') ?? false,
    };
  }

  // The jingle listener decodes the station's stream: only while it plays
  // with detection on.
  function syncJingles() {
    const wanted =
      station?.streamUrl &&
      playing &&
      getConfig().ad_break_detection &&
      process.env.AD_BREAK_JINGLES !== 'off'
        ? station
        : null;
    if (jingles && jingles.station === wanted) {
      return;
    }
    jingles?.stop();
    jingles = null;
    if (!wanted) {
      return;
    }
    const listener = createJingleListener({
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
      onChange: () => refreshDetectorStation(),
      context: () => ({
        hasSongs: Boolean(wanted.hasMetadata),
        inAdWindow: (at) => detector.isAdTime(at),
        inBreak: detector.isInBreak(),
      }),
    });
    jingles = Object.assign(listener, { station: wanted });
    listener.ready.then(() => refreshDetectorStation());
  }

  async function refreshDetectorStation() {
    syncJingles();
    if (!station || !playing || !getConfig().ad_break_detection) {
      detector.setStation(null);
      return;
    }
    const target = station;
    const context = await stationContext();
    if (station === target) {
      detector.setStation(context);
    }
  }

  async function updateStats(fn) {
    if (!station) {
      return;
    }
    const key = station.key;
    const store = await getStore();
    store[key] = fn(store[key] ?? emptyStats());
    await persist(store);
    await refreshDetectorStation();
  }

  function stopFeed() {
    feed?.stop();
    feed = null;
    clearInterval(historyTimer);
    historyTimer = null;
    for (const timer of pendingTracks) {
      clearTimeout(timer);
    }
    pendingTracks.clear();
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
        detector.onTrack({ startedAt: playedAt, durationSeconds: track.durationSeconds });
        jingles?.onSongStarted(playedAt);
      },
      Math.max(0, playedAt - Date.now()),
    );
    pendingTracks.add(timer);
  }

  function switchStation(next) {
    stopFeed();
    lastHeosTitle = null;
    station = next ? { ...next, feed: null, hasMetadata: false } : null;
    logger.info(
      `${name}: now playing ${station ? `${station.name} (${station.key})` : 'no radio station'}`,
    );
    if (station?.tuneinId) {
      resolveFeed(station).catch((err) =>
        logger.warn(`${name}: song feed lookup failed for ${station?.name}: ${err.message}`),
      );
    }
  }

  // Find (once, then cached in the statistics store and re-checked weekly
  // when absent) whether this TuneIn station has a live song feed, follow
  // it, and learn the ad windows from its playlist history right away.
  // Followed even with detection off: the feed is also what shows the real
  // song instead of the bare station name.
  async function resolveFeed(current) {
    const store = await getStore();
    let info = store[current.key]?.feed;
    if (!info || (info.none && Date.now() - info.checkedAt > RECHECK_MS)) {
      const found = await discoverFeed(current.tuneinId);
      info = found ? { ...found, checkedAt: Date.now() } : { none: true, checkedAt: Date.now() };
      store[current.key] = { ...(store[current.key] ?? emptyStats()), feed: info };
      await persist(store);
    }
    if (station !== current || info.none) {
      return;
    }
    current.feed = info;
    current.hasMetadata = true;
    feed = followIndesRadiosFeed({
      site: info.site,
      mdsId: info.mdsId,
      onTrack: (track) => onFeedTrack(track, current),
    });
    logger.info(`${name}: ${current.name}: following its live song feed (${info.site})`);
    await refreshDetectorStation();
    const learn = () =>
      learnFromHistory(current).catch((err) =>
        logger.warn(`${name}: ${current.name}: playlist history failed: ${err.message}`),
      );
    historyTimer = setInterval(learn, HISTORY_REFRESH_MS);
    historyTimer.unref?.();
    await learn();
  }

  // Learn from the days of playlist the station already published, instead
  // of only from what is heard here: a new station's ad windows are known
  // within a minute of first playing it. Then, every HISTORY_REFRESH_MS,
  // the hours published since: the station is learned continuously, even
  // while nobody listens to it.
  async function learnFromHistory(current) {
    const store = await getStore();
    // Never read with its coverage (historyFrom): read it all.
    const readUntil =
      store[current.key]?.historyFrom != null ? store[current.key].historyReadUntil : 0;
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
    store[current.key] = { ...stats, historyReadUntil: readAt, historyFrom };
    await persist(store);
    logger.info(
      `${name}: ${current.name}: ${added} new ad breaks from ${songs.length} songs of the last ${hours} h of playlist history`,
    );
    if (station === current) {
      await refreshDetectorStation();
    }
  }

  return {
    /** Feed every HEOS get_now_playing_media payload here. */
    onNowPlayingMedia(payload) {
      const next = identifyStation(payload);
      if ((next?.key ?? null) !== (station?.key ?? null)) {
        switchStation(next);
        refreshDetectorStation();
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
        refreshDetectorStation();
      }
      if (firstTitle) {
        return; // Joined mid-song: its start time (hence its end) is unknown.
      }
      const startedAt = Date.now();
      const current = station;
      lookupDurationSeconds(next.heosArtist, next.heosTitle).then((durationSeconds) => {
        if (station === current) {
          detector.onTrack({ startedAt, durationSeconds });
          jingles?.onSongStarted(startedAt);
        }
      });
    },

    /** HEOS play state: only learn/act while actually playing. */
    onPlayState(isPlaying) {
      if (isPlaying !== playing) {
        playing = isPlaying;
        refreshDetectorStation().then(() => {
          // Paused, the detector forgot the song: give it back the one
          // playing now, so that resuming during a break (or just before
          // one) is caught without waiting for the next song.
          if (playing && lastPlayed && lastPlayed.station === station) {
            detector.onTrack(lastPlayed);
          }
        });
      }
    },

    /** The user pressed "it's an ad" (AD_BREAK_MARK). */
    mark() {
      if (!station) {
        logger.warn(`${name}: "it's an ad" pressed but no radio station is playing`);
        return;
      }
      detector.mark();
    },

    /** True while a station feed (not HEOS) supplies the now-playing text. */
    providesNowPlaying() {
      return feed !== null;
    },

    /** Config changed (detection switched on/off...). */
    onConfigUpdated() {
      const current = station;
      station = null;
      switchStation(current);
      refreshDetectorStation();
    },

    stop() {
      clearInterval(ticker);
      stopFeed();
      jingles?.stop();
      jingles = null;
      detector.setStation(null);
    },
  };
}
