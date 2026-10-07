// -----------------------------------------------------------------------------
// Ad-break detector: a small clock-driven state machine, one per receiver.
//
// Inputs (all times in epoch ms, already shifted to what the receiver is
// actually playing — see the lag handling in index.js of this folder):
//   - setStation(): what is playing changed (or stopped);
//   - onTrack(): a new song started, with its duration when known;
//   - mark(): the user pressed "it's an ad";
//   - tick(): called every second.
// Outputs: onBreakStart / onBreakEnd callbacks, plus onGap / onMark so the
// caller can feed the per-station statistics (stats.js).
//
// The rule, validated by ear on OUI FM: radio metadata never says "ad", only
// "song X started, lasts N s". Once a song is over with no next song, the
// station is either in an ad break or the host is talking. Host talk between
// songs lasts up to ~2 min, so outside the station's learned ad windows we
// wait OUTSIDE_WINDOW_GRACE_SECONDS before calling it a break; inside a
// window (where breaks statistically happen) we only wait for the usual host
// talk before the ad jingle (learned, ~45 s by default). The next song ends
// the break.
// -----------------------------------------------------------------------------

import { isInWindow, DEFAULT_PRE_BREAK_TALK_SECONDS } from './stats.js';

export const OUTSIDE_WINDOW_GRACE_SECONDS = 150;
// Safety net: never keep the volume down longer than this, whatever happens
// (stream switched to a talk show, metadata feed stalled...). Longest break
// measured on OUI FM: 495 s.
export const MAX_BREAK_SECONDS = 600;
// A window already "used" by a break is not trusted again for this long:
// stations air one break per window, so a second long silence in the same
// window is more likely the host than a second ad break.
const WINDOW_REUSE_MS = 20 * 60 * 1000;
// Without metadata (manual marks only), a predicted break lasts this long
// unless the station's measured typical length says otherwise.
export const DEFAULT_BREAK_SECONDS = 240;

/**
 * @param {object} opts
 * @param {() => number} [opts.now]
 * @param {(info: {reason: string, songEndedAt: number|null}) => void} opts.onBreakStart
 * @param {(info: {reason: string}) => void} opts.onBreakEnd
 * @param {(info: {songEndedAt: number, gapSeconds: number}) => void} [opts.onGap]
 *   every measured gap between the end of a song and the start of the next one
 * @param {(info: {at: number, offsetSeconds: number|null, durationSeconds: number|null}) => void} [opts.onMark]
 */
export function createAdBreakDetector({
  now = () => Date.now(),
  onBreakStart,
  onBreakEnd,
  onGap,
  onMark,
}) {
  let station = null;
  let track = null; // { startedAt, durationSeconds }
  let breakState = null; // { startedAt, songEndedAt, reason }
  let lastBreakAt = 0;

  function songEnd() {
    return track?.durationSeconds > 0 ? track.startedAt + track.durationSeconds * 1000 : null;
  }

  function startBreak(reason, songEndedAt) {
    if (track) {
      // One break per song end at most: once it ends (timeout, manual...),
      // the same silence must not start another one.
      track.breakHandled = true;
    }
    breakState = { startedAt: now(), songEndedAt, reason };
    lastBreakAt = now();
    onBreakStart({ reason, songEndedAt });
  }

  function endBreak(reason) {
    if (!breakState) {
      return;
    }
    breakState = null;
    onBreakEnd({ reason });
  }

  return {
    /**
     * @param {null | {key: string, hasMetadata: boolean, windows: Array<[number, number]>,
     *   preBreakTalkSeconds?: number, typicalBreakSeconds?: number|null}} next
     */
    setStation(next) {
      const changed = next?.key !== station?.key;
      station = next;
      if (changed) {
        track = null;
        endBreak('station_changed');
      }
    },

    onTrack({ startedAt, durationSeconds }) {
      const previousEnd = songEnd();
      if (previousEnd !== null) {
        const gapSeconds = (startedAt - previousEnd) / 1000;
        onGap?.({ songEndedAt: previousEnd, gapSeconds });
      }
      track = { startedAt, durationSeconds: Number(durationSeconds) || null };
      endBreak('next_song');
    },

    /** Manual "it's an ad" — toggles the break on a station without metadata. */
    mark() {
      const at = now();
      if (breakState && station && !station.hasMetadata) {
        const durationSeconds = Math.round((at - breakState.startedAt) / 1000);
        onMark?.({ at: breakState.startedAt, offsetSeconds: null, durationSeconds });
        endBreak('manual');
        return;
      }
      const end = songEnd();
      onMark?.({
        at,
        offsetSeconds: end !== null && at >= end ? Math.round((at - end) / 1000) : null,
        durationSeconds: null,
      });
      if (!breakState) {
        startBreak('manual', end);
      }
    },

    tick() {
      if (!station) {
        return;
      }
      const t = now();
      if (breakState) {
        const limit = station.hasMetadata
          ? MAX_BREAK_SECONDS
          : Math.min(MAX_BREAK_SECONDS, station.typicalBreakSeconds || DEFAULT_BREAK_SECONDS);
        if (t - breakState.startedAt > limit * 1000) {
          endBreak('timeout');
        }
        return;
      }
      const windowFresh = t - lastBreakAt > WINDOW_REUSE_MS;
      if (station.hasMetadata) {
        const end = songEnd();
        if (end === null || t < end || track.breakHandled) {
          return;
        }
        const inWindow = windowFresh && isInWindow(new Date(end).getMinutes(), station.windows);
        const graceSeconds = inWindow
          ? (station.preBreakTalkSeconds ?? DEFAULT_PRE_BREAK_TALK_SECONDS)
          : OUTSIDE_WINDOW_GRACE_SECONDS;
        if (t >= end + graceSeconds * 1000) {
          startBreak(inWindow ? 'song_ended_in_window' : 'song_ended_long_silence', end);
        }
        return;
      }
      // No metadata: only the learned schedule (from manual marks) is known.
      // Start at the opening minute of a window, once per window.
      const date = new Date(t);
      const opensNow = station.windows.some(([from]) => from % 60 === date.getMinutes());
      if (windowFresh && opensNow) {
        startBreak('schedule', null);
      }
    },

    isInBreak() {
      return breakState !== null;
    },
  };
}
