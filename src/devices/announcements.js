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
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeZone, percentToDenonVolume } from '../denon/protocol.js';
import {
  buildClearQueueCommand,
  buildGetNowPlayingMediaCommand,
  buildGetPlayStateCommand,
  buildPlayStreamCommand,
} from '../heos/protocol.js';
import { normalizeConfig } from '../config.js';
import { FEATURE, HEOS_SOURCE_CODE } from './features.js';
import {
  getHeos,
  getState,
  isTelnetConnected,
  onDeviceStateChange,
  registerResetHook,
  timing,
} from './registry.js';
import { ensureZoneReadyForHeos, requireHeos, setPower, setSource, setVolume } from './control.js';
import { NOW_PLAYING_MID_KEY, STREAM_RESULT_KEY } from './heos-session.js';

const logger = createLogger({ name: 'avr' });

// A play state seen by the poll this soon after the stream was sent may
// still be the one from BEFORE the announcement (music that was playing).
const POLL_GRACE_MS = 2_000;

// external_id -> the announcement in progress: the state to restore, the
// volume it was set to, its timers.
const pending = new Map();
let unsubscribe = null;

registerResetHook(() => {
  for (const entry of pending.values()) {
    stopTimers(entry);
  }
  pending.clear();
  unsubscribe = null;
});

function stopTimers(entry) {
  clearInterval(entry.pollTimer);
  clearTimeout(entry.startTimer);
  clearTimeout(entry.maxTimer);
}

function ensureListening() {
  if (!unsubscribe) {
    unsubscribe = onDeviceStateChange(handleStateChange);
  }
}

function handleStateChange(externalId, key, value) {
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
    entry.announcementVolume !== undefined &&
    snapshot.volume !== undefined &&
    stillAtAnnouncementVolume(state.volume, entry.announcementVolume)
  ) {
    setVolume(externalId, snapshot.volume, zone);
  }
  if (!isTelnetConnected(externalId)) {
    return; // A HEOS-only speaker: no input, no power to give back.
  }
  if (
    snapshot.source &&
    snapshot.source !== HEOS_SOURCE_CODE &&
    state.source === HEOS_SOURCE_CODE
  ) {
    setSource(externalId, snapshot.source, zone);
  }
  if (snapshot.power === 0 && state.power !== 0) {
    await setPower(externalId, false, zone, 'back to standby after an announcement');
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
  const entry = pending.get(externalId);
  if (entry) {
    stopTimers(entry);
    pending.delete(externalId);
  }
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
  if (config.announcement_restore) {
    pending.set(externalId, entry);
    ensureListening();
  }

  try {
    await ensureZoneReadyForHeos(externalId, zone);
    if (wantsVolume) {
      setVolume(externalId, volume, zone);
      // What the receiver will report back: 0-98 over Telnet, 0-100 on HEOS.
      entry.announcementVolume = isTelnetConnected(externalId)
        ? percentToDenonVolume(volume)
        : Math.round(Math.min(100, volume));
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
    finishAnnouncement(externalId, 'failed');
    throw err;
  }

  if (!pending.has(externalId)) {
    return;
  }
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
  entry.maxTimer = setTimeout(
    () => finishAnnouncement(externalId, 'timed out'),
    timing.announcementMaxMs,
  );
}
