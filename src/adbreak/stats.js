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
// Manual "it's an ad" marks (the AD_BREAK_MARK button) feed the same
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
const MAX_BREAKS = 200;
const MAX_MARK_OFFSETS = 50;

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
  const breaks = [...stats.breaks, { at: startedAt, minute, durationSeconds, source }];
  return { ...stats, breaks: breaks.slice(-MAX_BREAKS) };
}

/**
 * Record how long after the end of the last song a manual "it's an ad" mark
 * came — i.e. how long the host talked before the ad jingle.
 */
export function recordMarkOffset(stats, offsetSeconds) {
  if (!(offsetSeconds >= 0 && offsetSeconds <= BREAK_MIN_SECONDS)) {
    return stats;
  }
  const markOffsets = [...stats.markOffsets, Math.round(offsetSeconds)];
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
 */
export function learnedWindows(stats, seedWindows = []) {
  if (stats.breaks.length < MIN_BREAKS_FOR_WINDOWS) {
    return seedWindows;
  }
  const counts = new Array(60).fill(0);
  for (const { minute } of stats.breaks) {
    counts[minute] += 1;
  }
  // Smooth over ±1 minute: a break starting at :13 one day and :14 the next
  // is the same slot, and a song ending a few seconds either side of the
  // minute boundary must not flip the decision.
  const threshold = Math.max(2, stats.breaks.length * WINDOW_MIN_SHARE);
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

/** Is `minute` (0-59) inside one of `windows`? */
export function isInWindow(minute, windows) {
  return windows.some(([from, to]) => (minute >= from && minute < to) || minute + 60 < to);
}

/** Median host talk between the last song and the ad jingle, or the default. */
export function preBreakTalkSeconds(stats) {
  return stats.markOffsets.length >= 3 ? median(stats.markOffsets) : DEFAULT_PRE_BREAK_TALK_SECONDS;
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
