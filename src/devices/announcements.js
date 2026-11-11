// -----------------------------------------------------------------------------
// "Speak on a speaker" (Gladys' PLAY_NOTIFICATION scene action), with an
// announcement volume and a return to the previous state afterwards.
//
// Gladys hands an external integration the ready-made TTS file URL only:
// the volume the scene asks for is dropped by the core's proxy service for
// external integrations (externalIntegration.registerProxyService.js
// forwards `value`, never `options`; integration-sdk-js issue #33). Two
// config keys make up for it:
//   - `announcement_volume` (0 = keep the current volume): set before the
//     stream starts;
//   - `announcement_restore` (default on): once HEOS reports the stream
//     over, the volume, the input and the power state the receiver had
//     before are put back — the announcement used to leave the receiver on
//     the NET input, switched on, at whatever volume (forum topic 10722).
//
// The end of an announcement is HEOS' own play state going back to
// stop/pause after having played (event or fast poll), HEOS playing
// something else after it (another controller took the player back), a
// refused stream, a stream that never starts, or a hard cap — whichever
// comes first. What the receiver was playing on HEOS before (a radio, a
// playlist, a UPnP/AirPlay sender) is NOT resumed: clearing the HEOS queue
// (see buildClearQueueCommand()) loses it.
//
// Forum topic 10722, post 39 (music from Lyrion, Marantz PM7000N):
//   - play_stream leaves the announcement in the HEOS queue, so a later
//     Play replayed it; once it is over and nothing plays, the queue is
//     cleared again;
//   - music already playing before kept the play state at "play", so the
//     announcement's own "play" was no change, and a poll answer in the
//     first 2 s was not trusted (it may be the music's): a short message
//     was only seen as over by the 15 s "never started" timer. HEOS naming
//     the announcement URL as its current media now proves it plays.
//
// Forum topic 10722, post 42 (Nvidia Shield -> AVR-S650H -> TV, HDMI-CEC):
//   - from standby, the receiver takes 4-5 s to wake: the volume sent 1.5 s
//     after PWON was ignored and the first seconds of the message lost. The
//     announcement now waits for the receiver to report its power on, then
//     for the announcement volume to be read back (sent again meanwhile),
//     each wait bounded (control.js wakeZoneForHeos(), `timing.wake*`);
//   - post 44: the pause after the power report is the `wake_delay_seconds`
//     setting (0-15 s, 4 s by default: the AVR-S650H still lost 2 s of the
//     message after 2 s). Worst case from standby, all waits bounded: 5 s
//     (power report) + 15 s (pause) + the input switch + 4 s (volume read
//     back) = about 25 s before the stream; the scene action is answered
//     after 3 s whatever happens. A power-off ends the pause at once.
//   - going back to standby no longer puts the input back first: selecting
//     an HDMI input sends a CEC <Routing Change> that woke the player on it,
//     which switched receiver and TV back on. The input is given back only
//     when the receiver was on before the announcement.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeZone, percentToDenonVolume, ZONE } from '../denon/protocol.js';
import {
  buildClearQueueCommand,
  buildGetNowPlayingMediaCommand,
  buildGetPlayStateCommand,
  buildPlayStreamCommand,
} from '../heos/protocol.js';
import { normalizeConfig, wakeDelayMs } from '../config.js';
import { FEATURE, HEOS_SOURCE_CODE, STATE } from './features.js';
import {
  getHeos,
  getState,
  isTelnetConnected,
  onDeviceStateChange,
  registerResetHook,
  registerUserCommandHook,
  timing,
  waitForState,
} from './registry.js';
import {
  cancelWake,
  requireHeos,
  setPower,
  setSource,
  setVolume,
  wakeZoneForHeos,
} from './control.js';
import { NOW_PLAYING_MID_KEY, STREAM_RESULT_KEY } from './heos-session.js';

const logger = createLogger({ name: 'avr' });

// A play state seen by the poll this soon after the stream was sent may
// still be the one from BEFORE the announcement (music that was playing).
const POLL_GRACE_MS = 2_000;

// external_id -> the announcement in progress: the state to restore, the
// volume it was set to, its timers.
const pending = new Map();
// external_id -> the token of the latest playAnnouncement() call: an older
// call still waking the receiver stops at its next step, never sends its
// stream after a newer one.
const runs = new Map();
// Every entry with live timers, pending or not: a reset stops them all.
const timed = new Set();
let unsubscribe = null;

registerResetHook(() => {
  for (const entry of [...pending.values(), ...timed]) {
    stopTimers(entry);
  }
  pending.clear();
  runs.clear();
  unsubscribe = null;
});

function stopTimers(entry) {
  clearInterval(entry.pollTimer);
  clearTimeout(entry.startTimer);
  clearTimeout(entry.maxTimer);
  timed.delete(entry);
}

function ensureListening() {
  if (!unsubscribe) {
    unsubscribe = onDeviceStateChange(handleStateChange);
  }
}

/**
 * The user switched the receiver off (device command, scene, widget, or its
 * remote: a power report 1 -> 0) while an announcement wakes it, waits or
 * plays (review denon-125-r1 I2): the announcement stops at once, nothing is
 * sent after it and nothing is restored (the user wants it off).
 */
function stopByUser(externalId, why) {
  const entry = pending.get(externalId);
  if (!entry && !runs.has(externalId)) {
    return;
  }
  logger.info(`${externalId}: ${why}, the announcement stops, nothing restored`);
  cancelAnnouncement(externalId);
  if (entry) {
    forgetAnnouncementStream(externalId, entry);
  }
}

registerUserCommandHook((externalId, kind) => {
  if (kind === 'power-off') {
    stopByUser(externalId, 'switched off by the user');
    return;
  }
  const run = runs.get(externalId);
  const entry = pending.get(externalId);
  if (kind === 'volume') {
    // Not overwritten by the announcement volume sent again, nor given back
    // at the end: the user's volume stays (review denon-125-r1 M1).
    if (run) {
      run.userVolume = true;
    }
    if (entry) {
      entry.userVolume = true;
    }
  } else if (kind === 'power-on' && entry) {
    entry.snapshot.power = 1; // Switched on by the user: no standby at the end.
  }
});

function handleStateChange(externalId, key, value, previous) {
  if (key === FEATURE.POWER && value === 0 && previous === 1) {
    stopByUser(externalId, 'switched off (remote or front panel)');
    return;
  }
  const entry = pending.get(externalId);
  if (!entry || !entry.tracking) {
    return;
  }
  if (key === STREAM_RESULT_KEY && value === 'fail') {
    finishAnnouncement(externalId, 'stream refused');
  } else if (key === NOW_PLAYING_MID_KEY) {
    entry.lastMid = value;
    const ours = isAnnouncementMedia(value, entry.url);
    if (ours) {
      entry.mediaSeen = true;
      if (getState(externalId).playback_state === 1) {
        entry.sawPlaying = true;
      }
    } else if (entry.mediaSeen && value) {
      finishAnnouncement(externalId, 'replaced by other playback');
    }
  } else if (key === FEATURE.PLAYBACK_STATE) {
    if (value === 1) {
      entry.sawPlaying = true;
    } else if (entry.sawPlaying) {
      finishAnnouncement(externalId, 'over');
    }
  }
}

/** Whether HEOS' current media id is the announcement's stream URL. */
function isAnnouncementMedia(mid, url) {
  if (typeof mid !== 'string' || mid === '' || !url) {
    return false;
  }
  if (mid === url) {
    return true;
  }
  try {
    return decodeURIComponent(mid) === url;
  } catch {
    return false;
  }
}

/** Is `volume` (what the receiver reports now) still the announcement's own? */
function stillAtAnnouncementVolume(volume, announcementVolume) {
  // A remote press during the announcement moves it by half a step; a
  // change of more than one unit is the user's, kept.
  return volume === undefined || Math.abs(volume - announcementVolume) <= 1;
}

/**
 * The announcement over and nothing playing: empty the HEOS queue it was
 * appended to, so no later Play speaks it again (forum topic 10722, post 39).
 * Skipped while something plays (the hard cap on a long stream, another
 * controller that took over: its queue is not ours to clear).
 */
function forgetAnnouncementStream(externalId, entry) {
  if (!entry.streamSent || getState(externalId).playback_state === 1) {
    return;
  }
  // HEOS named the announcement, then other media (a queue started from the
  // HEOS app during it, review r3 m3): that queue is not ours to clear. A mid
  // never seen as the URL (internal id, or only the music's from before)
  // proves nothing: the queue is cleared (review r4 I1).
  if (entry.mediaSeen && entry.lastMid && !isAnnouncementMedia(entry.lastMid, entry.url)) {
    return;
  }
  const heos = getHeos(externalId);
  if (heos?.pid != null && heos.client?.isConnected?.() !== false) {
    heos.client.sendCommand(buildClearQueueCommand(heos.pid));
  }
}

async function restore(externalId, entry) {
  const { snapshot, zone } = entry;
  const state = getState(externalId);
  forgetAnnouncementStream(externalId, entry);
  if (
    !entry.userVolume &&
    entry.announcementVolume !== undefined &&
    snapshot.volume !== undefined &&
    stillAtAnnouncementVolume(state.volume, entry.announcementVolume)
  ) {
    setVolume(externalId, snapshot.volume, zone);
  }
  if (!isTelnetConnected(externalId)) {
    return; // A HEOS-only speaker: no input, no power to give back.
  }
  // Going back to standby: the input is NOT put back (forum topic 10722,
  // post 42). Selecting an HDMI input sends a CEC <Routing Change> to the
  // player on it, which woke up and switched receiver and TV back on right
  // after the standby. The receiver sleeps on the network input instead; a
  // player woken later by CEC selects its own input anyway.
  if (
    snapshot.power !== 0 &&
    snapshot.source &&
    snapshot.source !== HEOS_SOURCE_CODE &&
    state.source === HEOS_SOURCE_CODE
  ) {
    setSource(externalId, snapshot.source, zone);
  }
  // `woke`: the integration sent the power command itself. A receiver that
  // never reported it on still gets its standby (review denon-125-r1 I3);
  // a standby on a receiver already in standby changes nothing.
  if (snapshot.power === 0 && (state.power !== 0 || entry.woke)) {
    await setPower(externalId, false, zone, 'back to standby after an announcement', {
      fromAnnouncement: true,
    });
  }
}

/** End the announcement of one receiver and give its previous state back. */
export function finishAnnouncement(externalId, reason) {
  const entry = pending.get(externalId);
  if (!entry) {
    return;
  }
  pending.delete(externalId);
  stopTimers(entry);
  logger.info(`${externalId}: announcement ${reason}, restoring the previous state`);
  restore(externalId, entry).catch((err) =>
    logger.error(`${externalId}: restoring the state after an announcement failed: ${err.message}`),
  );
}

/** Drop the announcement of one receiver without restoring anything (device gone). */
export function cancelAnnouncement(externalId) {
  runs.delete(externalId);
  cancelWake(externalId);
  const entry = pending.get(externalId);
  if (entry) {
    stopTimers(entry);
    pending.delete(externalId);
  }
}

/** Announcement runs still holding their token (tests: none once over, review r1 M5). */
export function __announcementRunsForTesting() {
  return runs.size;
}

/** Whether an announcement is in progress on this receiver (widgets, tests). */
export function isAnnouncing(externalId) {
  return pending.has(externalId);
}

/**
 * Play one TTS file URL on a receiver through HEOS (browse/play_stream), the
 * same mechanism TuneIn/direct URL playback uses — so this only works once
 * a HEOS pid is matched: a non-HEOS model, or one with the HEOS CLI
 * unreachable, cannot be made to speak an arbitrary URL at all.
 */
export async function playAnnouncement(externalId, url, config = normalizeConfig()) {
  const heos = requireHeos(externalId, 'speak');
  const run = {};
  runs.set(externalId, run);
  // The token is dropped once this run is over (review denon-125-r1 M5).
  const work = runAnnouncement(externalId, url, config, heos, run).finally(() => {
    if (runs.get(externalId) === run) {
      runs.delete(externalId);
    }
  });
  // A receiver waking from standby takes longer than Gladys waits for the
  // answer (5 s): past `timing.announcementAckMs` the scene action is
  // answered and the announcement goes on, its errors logged.
  let budgetTimer;
  const budget = new Promise((resolve) => {
    budgetTimer = setTimeout(() => resolve(LATE), timing.announcementAckMs);
  });
  try {
    if ((await Promise.race([work, budget])) === LATE) {
      logger.info(`${externalId}: the receiver is still waking up, the announcement goes on`);
      work.catch((err) => logger.error(`${externalId}: announcement failed: ${err.message}`));
    }
  } finally {
    clearTimeout(budgetTimer);
  }
}

const LATE = Symbol('late');

/**
 * Wait until the receiver reports the announcement volume, sending it again
 * every `timing.announcementVolumeRetryMs`, for `timing.announcementVolumeConfirmMs`
 * at most. Only after a wake from standby (a receiver already on takes it at
 * once), and only when the volume reported before is not already it: a read
 * back equal to it would prove nothing. Within one unit counts (a half step,
 * review denon-125-r1 M2), and so does the receiver's own Max Volume (MVMAX,
 * main zone) when it is below. Stops sending as soon as the user sets a
 * volume (M1), and when Telnet is gone (M3: the HEOS route has another
 * scale). Resolves whether it was read back.
 */
async function confirmAnnouncementVolume(externalId, volume, zone, target, run) {
  const isCurrent = () => runs.get(externalId) === run;
  const state = getState(externalId);
  const max = state[STATE.VOLUME_MAX];
  const goal =
    zone === ZONE.MAIN && typeof max === 'number' && Number.isFinite(max)
      ? Math.min(target, Math.floor(max))
      : target;
  const reached = (level) => typeof level === 'number' && Math.abs(level - goal) <= 1;
  if (reached(state.volume)) {
    return true;
  }
  const deadline = performance.now() + timing.announcementVolumeConfirmMs;
  const retry = Math.max(10, timing.announcementVolumeRetryMs);
  for (;;) {
    const left = deadline - performance.now();
    if (await waitForState(externalId, (now) => reached(now.volume), Math.min(left, retry))) {
      return true;
    }
    if (!isCurrent() || run.userVolume) {
      return false;
    }
    if (deadline - performance.now() <= 0) {
      break;
    }
    if (!isTelnetConnected(externalId)) {
      logger.warn(`${externalId}: Telnet lost, the announcement volume is not sent again`);
      return false;
    }
    setVolume(externalId, volume, zone);
  }
  logger.warn(
    `${externalId}: announcement volume not read back after ${timing.announcementVolumeConfirmMs} ms, the announcement goes on`,
  );
  return false;
}

async function runAnnouncement(externalId, url, config, heos, run) {
  const isCurrent = () => runs.get(externalId) === run;
  const zone = normalizeZone(config.zone);
  const volume = Number(config.announcement_volume);
  const wantsVolume = Number.isFinite(volume) && volume > 0;

  // A radio ad break in progress ends first (src/adbreak/): its lowered
  // volume must not be what the announcement snapshots and gives back.
  const adBreakVolume = heos.adBreak?.interruptForAnnouncement(url) ?? null;
  // A second announcement while the first is still playing keeps the FIRST
  // one's snapshot: the state to give back is the one before both.
  let entry = pending.get(externalId);
  if (entry) {
    stopTimers(entry);
  } else {
    const state = getState(externalId);
    entry = {
      snapshot: { power: state.power, source: state.source, volume: adBreakVolume ?? state.volume },
    };
  }
  Object.assign(entry, {
    zone,
    url,
    tracking: false,
    sawPlaying: false,
    mediaSeen: false,
    lastMid: '',
    streamSent: false,
  });
  // Always listening: a power-off from the remote stops the announcement,
  // restore or not.
  ensureListening();
  if (config.announcement_restore) {
    pending.set(externalId, entry);
  }

  try {
    const { woke, cancelled } = await wakeZoneForHeos(externalId, zone, wakeDelayMs(config));
    // The integration sent (or joined) the power command: standby at the end.
    entry.woke = entry.woke || woke;
    if (!isCurrent() || cancelled) {
      return; // A newer announcement took over: it sends the stream.
    }
    if (wantsVolume) {
      setVolume(externalId, volume, zone);
      // What the receiver will report back: 0-98 over Telnet, 0-100 on HEOS.
      entry.announcementVolume = isTelnetConnected(externalId)
        ? percentToDenonVolume(volume)
        : Math.round(Math.min(100, volume));
      if (woke && isTelnetConnected(externalId)) {
        await confirmAnnouncementVolume(externalId, volume, zone, entry.announcementVolume, run);
        if (!isCurrent()) {
          return;
        }
      }
    }
    // Real-hardware feedback: browse/play_stream appends to the queue rather
    // than replacing it, so triggering this scene action more than once in
    // quick succession queued every announcement instead of replacing the
    // previous one — clearing the queue first is what actually makes each
    // new announcement the only thing that plays. See the comment on
    // buildClearQueueCommand() for the accepted tradeoff (this also clears
    // any other HEOS content genuinely queued).
    if (!heos.client.sendCommand(buildClearQueueCommand(heos.pid))) {
      throw new Error(`Failed to clear the HEOS queue on ${externalId}`);
    }
    if (!heos.client.sendCommand(buildPlayStreamCommand(heos.pid, url))) {
      throw new Error(`Failed to send HEOS play_stream command to ${externalId}`);
    }
    entry.streamSent = true;
  } catch (err) {
    if (isCurrent()) {
      finishAnnouncement(externalId, 'failed');
    }
    throw err;
  }

  if (pending.get(externalId) !== entry) {
    return;
  }
  // One set of timers per entry, whatever ran before: a timer overwritten
  // here would never be cleared.
  stopTimers(entry);
  timed.add(entry);
  const startedAt = Date.now();
  entry.tracking = true;
  // HEOS pushes player_state_changed, but nothing guarantees it arrives (see
  // timing.heosPollIntervalMs): poll the play state fast while it matters.
  entry.pollTimer = setInterval(() => {
    if (Date.now() - startedAt >= POLL_GRACE_MS && getState(externalId).playback_state === 1) {
      entry.sawPlaying = true;
    }
    heos.client.sendCommand(buildGetPlayStateCommand(heos.pid));
    heos.client.sendCommand(buildGetNowPlayingMediaCommand(heos.pid));
  }, timing.announcementPollMs);
  entry.startTimer = setTimeout(() => {
    if (!entry.sawPlaying) {
      finishAnnouncement(externalId, 'never started');
    }
  }, timing.announcementStartTimeoutMs);
  // The hard cap ends this entry's own timers whatever happened to it: no
  // poll outlives it, even for an entry no longer pending.
  entry.maxTimer = setTimeout(() => {
    stopTimers(entry);
    finishAnnouncement(externalId, 'timed out');
  }, timing.announcementMaxMs);
}
