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
// stop/pause after having played (event or fast poll), a refused stream, a
// stream that never starts, or a hard cap — whichever comes first. What the
// receiver was playing on HEOS before (a radio, a playlist) is NOT resumed:
// clearing the HEOS queue (see buildClearQueueCommand()) loses it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeZone } from '../denon/protocol.js';
import {
  buildClearQueueCommand,
  buildGetPlayStateCommand,
  buildPlayStreamCommand,
} from '../heos/protocol.js';
import { normalizeConfig } from '../config.js';
import { FEATURE, HEOS_SOURCE_CODE } from './features.js';
import {
  getState,
  isTelnetConnected,
  onDeviceStateChange,
  registerResetHook,
  timing,
} from './registry.js';
import { ensureZoneReadyForHeos, requireHeos, setPower, setSource, setVolume } from './control.js';
import { STREAM_RESULT_KEY } from './heos-session.js';

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
  } else if (key === FEATURE.PLAYBACK_STATE) {
    if (value === 1) {
      entry.sawPlaying = true;
    } else if (entry.sawPlaying) {
      finishAnnouncement(externalId, 'over');
    }
  }
}

/** Is `volume` (what the receiver reports now) still the announcement's own? */
function stillAtAnnouncementVolume(volume, announcementVolume) {
  // The receiver's 0-98 scale rounds some percents by one (25 % reads back
  // as 26 %, see percentToDenonVolume()): one step apart is still ours.
  return volume === undefined || Math.abs(volume - announcementVolume) <= 1;
}

async function restore(externalId, entry) {
  const { snapshot, zone } = entry;
  const state = getState(externalId);
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
    await setPower(externalId, false, zone);
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

  // A second announcement while the first is still playing keeps the FIRST
  // one's snapshot: the state to give back is the one before both.
  let entry = pending.get(externalId);
  if (entry) {
    stopTimers(entry);
  } else {
    const state = getState(externalId);
    entry = { snapshot: { power: state.power, source: state.source, volume: state.volume } };
  }
  Object.assign(entry, { zone, tracking: false, sawPlaying: false });
  if (config.announcement_restore) {
    pending.set(externalId, entry);
    ensureListening();
  }

  try {
    await ensureZoneReadyForHeos(externalId, zone);
    if (wantsVolume) {
      setVolume(externalId, volume, zone);
      entry.announcementVolume = Math.round(Math.min(100, volume));
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
