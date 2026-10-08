// -----------------------------------------------------------------------------
// Imperative controls of one AVR, shared by every entry point that drives
// the receiver: the Gladys device commands (./commands.js), the
// announcements (./announcements.js), the scene actions (src/scenes/) and
// the dashboard widgets (src/widgets/). Each one sends over the open
// session of ./registry.js and throws a plain Error when it cannot — the
// caller decides how a failure surfaces (failed command, failed scene
// action, widget toast).
// -----------------------------------------------------------------------------

import {
  buildPowerCommand,
  buildSourceCommand,
  buildSoundModeCommand,
  buildVolumeCommand,
  buildQuickSelectCommand,
  normalizeZone,
  SOURCE_CODES,
  TUNER_COMMANDS,
} from '../denon/protocol.js';
import {
  buildPlayPresetCommand,
  buildSetVolumeCommand as buildHeosSetVolumeCommand,
} from '../heos/protocol.js';
import { HEOS_SOURCE_CODE, TUNER_SOURCE_CODE } from './features.js';
import {
  getHeos,
  getState,
  getTelnet,
  isHeosConnected,
  isTelnetConnected,
  settle,
  timing,
} from './registry.js';

/** The open Telnet session of one AVR, or a thrown "not connected". */
export function requireTelnet(externalId) {
  const telnet = getTelnet(externalId);
  if (!telnet?.isConnected()) {
    throw new Error(`${externalId} is not connected`);
  }
  return telnet;
}

/** Send one Telnet command, or throw. */
export function sendTelnet(externalId, command) {
  if (!requireTelnet(externalId).send(command)) {
    throw new Error(`Failed to send command to ${externalId}`);
  }
}

/** The matched, connected HEOS session of one AVR, or a thrown error naming why. */
export function requireHeos(externalId, what = 'use HEOS') {
  if (!isHeosConnected(externalId)) {
    throw new Error(
      `${externalId}: cannot ${what}, HEOS is not connected or this receiver has no matched player id`,
    );
  }
  return getHeos(externalId);
}

/** Send one HEOS command (`heos://` path), or throw. */
export function sendHeos(externalId, command, what) {
  const heos = requireHeos(externalId, what);
  if (!heos.client.sendCommand(command)) {
    throw new Error(`Failed to send HEOS command to ${externalId}`);
  }
}

/**
 * Before a HEOS stream (announcement, favorite): make sure the configured
 * zone (the main zone by default) is on and listening to HEOS. Without
 * this, HEOS starts the stream on whichever zone it last played on — waking
 * the receiver on Zone 2 while the main zone stays off was the real-world
 * symptom. Best-effort over the legacy Telnet session only: a HEOS-only
 * speaker (no Telnet at all) has a single zone anyway, so nothing to switch.
 * Uses the last state the receiver reported to skip commands (and the
 * settling delay) that wouldn't change anything. Resolves whether anything
 * was switched.
 */
export async function ensureZoneReadyForHeos(externalId, zone) {
  return ensureZoneOn(externalId, zone, HEOS_SOURCE_CODE);
}

async function ensureZoneOn(externalId, zone, sourceCode) {
  const telnet = getTelnet(externalId);
  if (!telnet?.isConnected()) {
    return false;
  }
  const state = getState(externalId);
  let switched = false;
  if (state.power !== 1) {
    telnet.send(buildPowerCommand(true, zone));
    switched = true;
  }
  if (sourceCode && state.source !== sourceCode) {
    telnet.send(buildSourceCommand(sourceCode, zone));
    switched = true;
  }
  if (switched) {
    await settle(timing.zoneSwitchDelayMs);
  }
  return switched;
}

/** Turn the configured zone on (pausing for it to wake up) or off. */
export async function setPower(externalId, on, zone) {
  sendTelnet(externalId, buildPowerCommand(on, normalizeZone(zone)));
  if (on && getState(externalId).power !== 1) {
    await settle(timing.zoneSwitchDelayMs);
  }
}

/** Switch the configured zone to one input, by its SI code. */
export function setSource(externalId, code, zone) {
  if (!SOURCE_CODES.some((source) => source.value === code)) {
    throw new Error(`Unknown input source "${code}"`);
  }
  sendTelnet(externalId, buildSourceCommand(code, normalizeZone(zone)));
}

/** Select a sound mode by its MS code (main zone only, like the receiver). */
export function setSoundMode(externalId, mode) {
  if (typeof mode !== 'string' || mode.trim() === '') {
    throw new Error('A sound mode is required');
  }
  sendTelnet(externalId, buildSoundModeCommand(mode.trim()));
}

/**
 * Set the volume, 0-100 %. Telnet's MV/Z2 command whenever that session is
 * up (authoritative, see ./commands.js), HEOS' own 0-100 scale otherwise (a
 * HEOS-only speaker).
 */
export function setVolume(externalId, percent, zone) {
  const level = Number(percent);
  if (!Number.isFinite(level)) {
    throw new Error(`Invalid volume "${percent}"`);
  }
  const clamped = Math.round(Math.max(0, Math.min(100, level)));
  if (isTelnetConnected(externalId)) {
    sendTelnet(externalId, buildVolumeCommand(clamped, normalizeZone(zone)));
    return;
  }
  const heos = requireHeos(externalId, 'set the volume');
  sendHeos(externalId, buildHeosSetVolumeCommand(heos.pid, clamped), 'set the volume');
}

/** Recall one of the receiver's Quick Select (Marantz: Smart Select) presets, 1-5. */
export function selectQuickSelect(externalId, number, zone) {
  sendTelnet(externalId, buildQuickSelectCommand(number, normalizeZone(zone)));
}

/**
 * One analog tuner command (a TUNER_COMMANDS key). The receiver ignores
 * TF/TP/TM while another input is selected, so the zone is first switched
 * on and to the tuner when its last reported state isn't — with the same
 * settling pause as before a HEOS stream, as the input switch takes a moment
 * to land.
 */
export async function sendTunerCommand(externalId, key, zone) {
  const command = TUNER_COMMANDS[key];
  if (!command) {
    throw new Error(`Unknown tuner command "${key}"`);
  }
  requireTelnet(externalId);
  await ensureZoneOn(externalId, normalizeZone(zone), TUNER_SOURCE_CODE);
  sendTelnet(externalId, command);
}

/** Switch the configured zone on and to the tuner input. */
export async function selectTuner(externalId, zone) {
  requireTelnet(externalId);
  await ensureZoneOn(externalId, normalizeZone(zone), TUNER_SOURCE_CODE);
}

/** Play the n-th HEOS favorite (1-based) on the configured zone. */
export async function playHeosFavorite(externalId, number, zone) {
  const heos = requireHeos(externalId, 'play a HEOS favorite');
  const command = buildPlayPresetCommand(heos.pid, number);
  await ensureZoneReadyForHeos(externalId, normalizeZone(zone));
  sendHeos(externalId, command, 'play a HEOS favorite');
}
