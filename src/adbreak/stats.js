// -----------------------------------------------------------------------------
// Per-station ad-break statistics, learned from real listening.
//
// Every "no music" gap long enough to be an ad break (see BREAK_MIN_SECONDS)
// is recorded with the minute of the hour it started at; the minutes where
// breaks keep landing become that station's "ad windows" (e.g. :09–:14 and
// :34–:47 for OUI FM, measured over 3 days of its own playlist history).
// Inside a window a song ending with no next song is very likely an ad break,
// so the detector (see detector.js) can react within seconds instead of
// waiting long enough to rule out the host simply talking.
//
// Manual "it's an ad" marks (switching the AD_BREAK state on by hand) feed the same
// histogram, which is what makes a station with no metadata at all (no song
// boundaries to learn from) usable too, and — on a station that does have
// metadata — also teach how long the host typically talks between the last
// song and the ad jingle.
//
// Everything here is pure (plain objects in, plain objects out) except
// loadStatsStore()/saveStatsStore(), so the learning logic is unit-testable
// without a filesystem.
// -----------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

// A gap between the end of a song and the start of the next one is counted as
// an ad break when it lasts this long. Measured on OUI FM: host talk between
// songs ran 40–130 s, actual ad breaks 250–495 s (32 breaks over 3 days).
export const BREAK_MIN_SECONDS = 200;
export const BREAK_MAX_SECONDS = 900;

// Keep a bounded history per station: enough for a few weeks of listening,
// and a schedule change is learned as the old samples roll off.
const MAX_BREAKS = 1000; // OUI FM: ~30 breaks a day, LEARNING_DAYS of them
const MAX_MARK_OFFSETS = 50;

// The windows follow the station as it is now: they are learned from the
// breaks of the last LEARNING_DAYS days only (kept up to date from the
// playlist history, see index.js), so a schedule change is picked up within
// days. Two weeks: every day of the week is seen twice (weekends differ).
// A station with too few recent breaks (no history, little listening)
// falls back to all the breaks recorded.
export const LEARNING_DAYS = 14;

// Below this many recorded breaks the histogram is too thin to trust: fall
// back to the station's built-in seed windows (if any), else no window.
export const MIN_BREAKS_FOR_WINDOWS = 6;
// A minute of the hour belongs to a window once this share of all recorded
// breaks started in it (or right next to it, see the smoothing below).
const WINDOW_MIN_SHARE = 0.04;

export const DEFAULT_PRE_BREAK_TALK_SECONDS = 45;

/** Empty statistics for one station. */
export function emptyStats() {
  return { breaks: [], markOffsets: [] };
}

/**
 * Record one ad break.
 * @param {{breaks: Array, markOffsets: Array}} stats
 * @param {{startedAt: number, durationSeconds?: number|null, source: 'auto'|'manual'}} brk
 *   startedAt in epoch ms (local wall clock: the minute of the hour is what is learned).
 */
export function recordBreak(stats, { startedAt, durationSeconds = null, source }) {
  const minute = new Date(startedAt).getMinutes();
  const breaks = [...stats.breaks, { at: startedAt, minute, durationSeconds, source }]
    .filter((b) => b.at >= startedAt - 2 * LEARNING_DAYS * 86_400_000)
    .sort((a, b) => a.at - b.at);
  return { ...stats, breaks: breaks.slice(-MAX_BREAKS) };
}

/**
 * Record how long after the end of the last song a manual "it's an ad" mark
 * came — i.e. how long the host talked before the ad jingle.
 */
export function recordMarkOffset(stats, offsetSeconds, at = Date.now()) {
  if (!(offsetSeconds >= 0 && offsetSeconds <= BREAK_MIN_SECONDS)) {
    return stats;
  }
  // The hour is kept because host talk depends on the time of day (real
  // feedback: on OUI FM mornings have no host at all, the ads start right
  // after the song).
  const hour = new Date(at).getHours();
  const markOffsets = [...stats.markOffsets, { offset: Math.round(offsetSeconds), hour }];
  return { ...stats, markOffsets: markOffsets.slice(-MAX_MARK_OFFSETS) };
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Ad windows as `[startMinute, endMinute)` pairs (endMinute may exceed 60 for
 * a window wrapping past the hour, e.g. [58, 63] = :58–:02).
 * @param {{breaks: Array}} stats
 * @param {Array<[number, number]>} [seedWindows] used until enough breaks are learned
 * @param {number} [now]
 */
export function learnedWindows(stats, seedWindows = [], now = Date.now()) {
  const recent = stats.breaks.filter((b) => b.at >= now - LEARNING_DAYS * 86_400_000);
  const breaks = recent.length >= MIN_BREAKS_FOR_WINDOWS ? recent : stats.breaks;
  if (breaks.length < MIN_BREAKS_FOR_WINDOWS) {
    return seedWindows;
  }
  const counts = new Array(60).fill(0);
  for (const { minute } of breaks) {
    counts[minute] += 1;
  }
  // Smooth over ±1 minute: a break starting at :13 one day and :14 the next
  // is the same slot, and a song ending a few seconds either side of the
  // minute boundary must not flip the decision.
  const threshold = Math.max(2, breaks.length * WINDOW_MIN_SHARE);
  const inWindow = counts.map(
    (_, m) => counts[(m + 59) % 60] + counts[m] + counts[(m + 1) % 60] >= threshold,
  );
  if (inWindow.every(Boolean)) {
    return []; // No structure at all (e.g. continuous talk show): no window.
  }
  // Merge consecutive minutes into windows, starting the scan right after an
  // out-of-window minute so a window wrapping past :59 stays in one piece.
  const start = inWindow.findIndex((v) => !v);
  const windows = [];
  let open = null;
  for (let i = 1; i <= 60; i++) {
    const minute = start + i;
    if (inWindow[minute % 60]) {
      open ??= minute;
    } else if (open !== null) {
      windows.push([open % 60, (open % 60) + (minute - open)]);
      open = null;
    }
  }
  return windows.sort((a, b) => a[0] - b[0]);
}

// Day types: stations run one schedule on weekdays and others on weekends.
const DAY_TYPES = ['sun', 'week', 'week', 'week', 'week', 'week', 'sat'];
export function dayType(time) {
  return DAY_TYPES[new Date(time).getDay()];
}

// An hour of a day type has ads when breaks were heard in it on at least
// this share of the days it was covered (on OUI FM: every hour from 6h to
// 21h Paris time, then almost never at night).
const HOUR_MIN_SHARE = 0.5;

/**
 * The station's ad schedule by day type: the minute windows (from the
 * breaks of that day type, else of all days) and, when the playlist history
 * covers every hour since `coveredFrom` (so an hour without break really had
 * none), the hours of the day that have ads.
 * @param {{breaks: Array}} stats
 * @param {{coveredFrom?: number|null, now?: number, seedWindows?: Array}} [opts]
 * @returns {{windows: Record<string, Array>, hours: Record<string, boolean[]>|null}}
 */
export function learnedSchedule(
  stats,
  { coveredFrom = null, now = Date.now(), seedWindows = [] } = {},
) {
  const since = now - LEARNING_DAYS * 86_400_000;
  const recent = stats.breaks.filter((b) => b.at >= since);
  const all = learnedWindows(stats, seedWindows, now);
  const windows = {};
  for (const type of ['week', 'sat', 'sun']) {
    const ofType = recent.filter((b) => dayType(b.at) === type);
    windows[type] =
      ofType.length >= MIN_BREAKS_FOR_WINDOWS ? learnedWindows({ breaks: ofType }, all, now) : all;
  }
  if (coveredFrom == null || recent.length < MIN_BREAKS_FOR_WINDOWS) {
    return { windows, hours: null };
  }
  // Every full hour covered: was there a break in it?
  const slots = {}; // "type hour" -> { covered, withBreak }
  const withBreak = new Set(recent.map((b) => Math.floor(b.at / 3_600_000)));
  const first = Math.ceil(Math.max(coveredFrom, since) / 3_600_000);
  const last = Math.floor(now / 3_600_000);
  for (let h = first; h < last; h++) {
    const key = `${dayType(h * 3_600_000)} ${new Date(h * 3_600_000).getHours()}`;
    slots[key] ??= { covered: 0, withBreak: 0 };
    slots[key].covered += 1;
    slots[key].withBreak += withBreak.has(h) ? 1 : 0;
  }
  const hours = {};
  for (const type of ['week', 'sat', 'sun']) {
    hours[type] = Array.from({ length: 24 }, (_, hour) => {
      let slot = slots[`${type} ${hour}`];
      if (!slot) {
        // That day type not covered yet (e.g. no weekend read): all days.
        slot = { covered: 0, withBreak: 0 };
        for (const t of ['week', 'sat', 'sun']) {
          slot.covered += slots[`${t} ${hour}`]?.covered ?? 0;
          slot.withBreak += slots[`${t} ${hour}`]?.withBreak ?? 0;
        }
      }
      return slot.covered === 0 || slot.withBreak / slot.covered >= HOUR_MIN_SHARE;
    });
  }
  return { windows, hours };
}

/** The ad windows that apply at `time` (none in an hour without ads). */
export function windowsAt(schedule, time) {
  const type = dayType(time);
  if (schedule.hours && !schedule.hours[type][new Date(time).getHours()]) {
    return [];
  }
  return schedule.windows[type];
}

/** Is `minute` (0-59) inside one of `windows`? */
export function isInWindow(minute, windows) {
  return windows.some(([from, to]) => (minute >= from && minute < to) || minute + 60 < to);
}

/** Median host talk between the last song and the ad jingle, or the default. */
export function preBreakTalkSeconds(stats) {
  const offsets = stats.markOffsets.map((m) => (typeof m === 'number' ? m : m.offset));
  return offsets.length >= 3 ? median(offsets) : DEFAULT_PRE_BREAK_TALK_SECONDS;
}

/**
 * Host talk before the ad jingle, per hour of the day (24 entries): the
 * median of the marks made within ±1 hour once there are at least 2 of
 * them, else the all-day value.
 */
export function preBreakTalkByHour(stats) {
  const fallback = preBreakTalkSeconds(stats);
  const marks = stats.markOffsets.filter((m) => typeof m === 'object' && m !== null);
  return Array.from({ length: 24 }, (_, hour) => {
    const near = marks
      .filter((m) => Math.min(Math.abs(m.hour - hour), 24 - Math.abs(m.hour - hour)) <= 1)
      .map((m) => m.offset);
    return near.length >= 2 ? median(near) : fallback;
  });
}

/** Median ad-break length, or null if none was measured yet. */
export function typicalBreakSeconds(stats) {
  return median(stats.breaks.map((b) => b.durationSeconds).filter((d) => d > 0));
}

/**
 * Load every station's statistics from `file` (missing/corrupt file = no
 * statistics yet, never an error: the integration must start regardless).
 */
export async function loadStatsStore(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist every station's statistics (atomic: write then rename). */
export async function saveStatsStore(file, store) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store));
  await fs.rename(tmp, file);
}
