// -----------------------------------------------------------------------------
// Imperative controls of one AVR, shared by every entry point that drives
// the receiver: the Gladys device commands (./commands.js), the
// announcements (./announcements.js), the scene actions (src/scenes/) and
// the dashboard widgets (src/widgets/). Each one sends over the open
// session of ./registry.js and throws a plain Error when it cannot — the
// caller decides how a failure surfaces (failed command, failed scene
// action, widget toast).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  buildVolumeUpCommand,
  buildVolumeDownCommand,
  buildSourceCommand,
  buildSoundModeCommand,
  buildVolumeCommand,
  buildQuickSelectCommand,
  normalizeZone,
  SOURCE_CODES,
  TUNER_COMMANDS,
  ZONE,
} from '../denon/protocol.js';
import {
  buildPlayPresetCommand,
  buildSetVolumeCommand as buildHeosSetVolumeCommand,
  buildVolumeUpCommand as buildHeosVolumeUpCommand,
  buildVolumeDownCommand as buildHeosVolumeDownCommand,
} from '../heos/protocol.js';
import { HEOS_SOURCE_CODE, STATE, TUNER_SOURCE_CODE } from './features.js';
import { sendPower } from './power.js';
import {
  getHeos,
  getState,
  getTelnet,
  getSession,
  isHeosConnected,
  isTelnetConnected,
  registerResetHook,
  settle,
  timing,
} from './registry.js';

const logger = createLogger({ name: 'avr' });

/** Whether this device is driven as a HEOS-only speaker (./speaker.js). */
export function isHeosOnly(externalId) {
  return getSession(externalId)?.heosOnly === true;
}

/**
 * The error for a command a HEOS-only speaker cannot take (power, input,
 * sound mode, Setup menu, tuner...): HEOS CLI has no such command, and
 * nothing is sent.
 */
export function heosOnlyError(externalId, what = 'this command') {
  return new Error(
    `${externalId}: ${what} is not available on a HEOS speaker without AVR Control (Telnet); nothing sent`,
  );
}

/** The open Telnet session of one AVR, or a thrown "not connected". */
export function requireTelnet(externalId, what) {
  const telnet = getTelnet(externalId);
  if (!telnet?.isConnected()) {
    if (isHeosOnly(externalId)) {
      throw heosOnlyError(externalId, what);
    }
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
    // PWON on a receiver without zones, ZMON otherwise (./power.js).
    sendPower(telnet, externalId, true, zone, 'before a HEOS stream or the tuner');
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
export async function setPower(externalId, on, zone, origin = 'scene or widget') {
  if (
    !sendPower(
      requireTelnet(externalId, 'power on/off'),
      externalId,
      on,
      normalizeZone(zone),
      origin,
    )
  ) {
    throw new Error(`Failed to send command to ${externalId}`);
  }
  if (on && getState(externalId).power !== 1) {
    await settle(timing.zoneSwitchDelayMs);
  }
}

/** Switch the configured zone to one input, by its SI code. */
export function setSource(externalId, code, zone) {
  if (!SOURCE_CODES.some((source) => source.value === code)) {
    throw new Error(`Unknown input source "${code}"`);
  }
  requireTelnet(externalId, 'choosing an input');
  sendTelnet(externalId, buildSourceCommand(code, normalizeZone(zone)));
}

/** Select a sound mode by its MS code (main zone only, like the receiver). */
export function setSoundMode(externalId, mode) {
  if (typeof mode !== 'string' || mode.trim() === '') {
    throw new Error('A sound mode is required');
  }
  requireTelnet(externalId, 'choosing a sound mode');
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
  // Nothing tapped before this volume goes out after it.
  cancelPendingVolume(externalId);
  wantedVolumes.delete(externalId);
  if (isTelnetConnected(externalId)) {
    sendTelnet(externalId, buildVolumeCommand(clamped, normalizeZone(zone)));
    noteVolumeSent(externalId, 'telnet', clamped);
    return;
  }
  const heos = requireHeos(externalId, 'set the volume');
  sendHeos(externalId, buildHeosSetVolumeCommand(heos.pid, clamped), 'set the volume');
  noteVolumeSent(externalId, 'heos', clamped);
}

// --- Widget Vol −/+ ----------------------------------------------------------
//
// Forum topic 10722, post 37: quick Vol −/+ taps in a widget ended on
// "L'action a échoué", then every widget button of the integration stayed
// dead for up to a minute. Gladys core caps widget actions at 30 a minute
// per integration, and the content re-pull each successful action triggers
// at 30 a minute too (fixed window, refused calls counted): past either,
// every widget action answers 429 until the window ends. One tap was one
// remote step (MVUP, 0.5 dB), so a usual change took 20 taps or more.
//
// A widget tap now moves the volume by a real step, from the last WANTED
// level while taps follow each other (the receiver may not have reported
// the previous one yet), and the commands to one device are spaced by the
// receiver's own pace (~50 ms): taps that come faster collapse into one
// command carrying the last wanted level. The device feature Volume up/down
// (a Gladys remote control) keeps its one-step behavior.

// Telnet: 2 % of the 0-98 scale, about 2 dB (4 presses of the remote).
// HEOS: 5 %, the step its own volume_up uses by default.
export const WIDGET_VOLUME_STEP = Object.freeze({ telnet: 2, heos: 5 });

// external_id -> { level, route, at } the last wanted level, and
// external_id -> { lastSentAt, timer, send } the spaced sender.
const wantedVolumes = new Map();
const volumeSenders = new Map();
// Every volume timer alive, so a test can prove none outlives a disconnect.
const volumeTimers = new Set();

function clearVolumeTimer(sender) {
  if (sender?.timer) {
    clearTimeout(sender.timer);
    volumeTimers.delete(sender.timer);
    sender.timer = null;
  }
}

function forgetVolumeSender(externalId) {
  clearVolumeTimer(volumeSenders.get(externalId));
  volumeSenders.delete(externalId);
}

/** Cancel a volume send still waiting for its turn, keeping the pace. */
function cancelPendingVolume(externalId) {
  clearVolumeTimer(volumeSenders.get(externalId));
}

/** An absolute volume just sent: the next tap starts from it, at the receiver's pace. */
function noteVolumeSent(externalId, route, level) {
  const now = performance.now();
  wantedVolumes.set(externalId, { level, route, at: now });
  const sender = volumeSenders.get(externalId) ?? { lastSentAt: -Infinity, timer: null };
  sender.lastSentAt = now;
  volumeSenders.set(externalId, sender);
}

/** Volume sends still waiting for their turn (tests: none may outlive a disconnect). */
export function pendingVolumeSends() {
  return volumeTimers.size;
}

/** Drop the wanted volume and any spaced send of one device (disconnect). */
export function forgetVolume(externalId) {
  wantedVolumes.delete(externalId);
  forgetVolumeSender(externalId);
}

registerResetHook(() => {
  for (const externalId of [...volumeSenders.keys()]) {
    forgetVolumeSender(externalId);
  }
  wantedVolumes.clear();
});

/**
 * Send `send` now, or after the pause the receiver needs since the last
 * volume command — a later call replaces a send still waiting. Throws when
 * an immediate send fails; a delayed one that fails is logged.
 */
function sendVolumeSpaced(externalId, send) {
  const now = performance.now();
  const sender = volumeSenders.get(externalId) ?? { lastSentAt: -Infinity, timer: null };
  volumeSenders.set(externalId, sender);
  sender.send = send;
  if (sender.timer) {
    return; // The waiting send now carries this level.
  }
  const wait = sender.lastSentAt + timing.volumeGapMs - now;
  if (wait <= 0) {
    const previous = sender.lastSentAt;
    sender.lastSentAt = now;
    try {
      send();
    } catch (err) {
      sender.lastSentAt = previous; // Nothing went out: no pause owed.
      throw err;
    }
    return;
  }
  const timer = setTimeout(() => {
    volumeTimers.delete(timer);
    sender.timer = null;
    if (volumeSenders.get(externalId) !== sender) {
      return; // Forgotten meanwhile (disconnect): nothing goes out.
    }
    sender.lastSentAt = performance.now();
    try {
      sender.send();
    } catch (err) {
      wantedVolumes.delete(externalId);
      logger.warn(`${externalId}: volume not sent: ${err.message}`);
    }
  }, wait);
  sender.timer = timer;
  volumeTimers.add(timer);
}

/**
 * One widget Vol −/+ tap (`direction` +1 or -1): see the block comment
 * above. Without any known volume, one relative step as before.
 */
export function nudgeVolume(externalId, direction, zone) {
  const sign = direction < 0 ? -1 : 1;
  const route = isTelnetConnected(externalId) ? 'telnet' : 'heos';
  const heos = route === 'heos' ? requireHeos(externalId, 'change the volume') : null;
  const now = performance.now();
  const wanted = wantedVolumes.get(externalId);
  const state = getState(externalId);
  const normalizedZone = normalizeZone(zone);
  // The receiver's own "Max Volume" (MVMAX, main zone only, review r1 I4):
  // a wanted level past it would make the next Vol − taps dead.
  const ceiling =
    route === 'telnet' &&
    normalizedZone === ZONE.MAIN &&
    typeof state[STATE.VOLUME_MAX] === 'number' &&
    Number.isFinite(state[STATE.VOLUME_MAX])
      ? Math.max(0, Math.min(100, state[STATE.VOLUME_MAX]))
      : 100;
  const base =
    wanted && wanted.route === route && now - wanted.at < timing.volumeWantedMs
      ? wanted.level
      : state.volume;
  if (typeof base !== 'number' || !Number.isFinite(base)) {
    if (route === 'telnet') {
      const build = sign > 0 ? buildVolumeUpCommand : buildVolumeDownCommand;
      sendTelnet(externalId, build(normalizedZone));
    } else {
      const build = sign > 0 ? buildHeosVolumeUpCommand : buildHeosVolumeDownCommand;
      sendHeos(externalId, build(heos.pid), 'change the volume');
    }
    return;
  }
  const level = Math.round(
    Math.max(0, Math.min(ceiling, Math.min(ceiling, base) + sign * WIDGET_VOLUME_STEP[route])),
  );
  wantedVolumes.set(externalId, { level, route, at: now });
  try {
    sendVolumeSpaced(externalId, () =>
      route === 'telnet'
        ? sendTelnet(externalId, buildVolumeCommand(level, normalizedZone))
        : sendHeos(externalId, buildHeosSetVolumeCommand(heos.pid, level), 'change the volume'),
    );
  } catch (err) {
    // Nothing went out: the next tap starts again from the reported level.
    wantedVolumes.delete(externalId);
    throw err;
  }
}

/** Recall one of the receiver's Quick Select (Marantz: Smart Select) presets, 1-5. */
export function selectQuickSelect(externalId, number, zone) {
  requireTelnet(externalId, 'Quick Select');
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
  requireTelnet(externalId, 'the tuner');
  await ensureZoneOn(externalId, normalizeZone(zone), TUNER_SOURCE_CODE);
  sendTelnet(externalId, command);
}

/** Switch the configured zone on and to the tuner input. */
export async function selectTuner(externalId, zone) {
  requireTelnet(externalId, 'the tuner');
  await ensureZoneOn(externalId, normalizeZone(zone), TUNER_SOURCE_CODE);
}

/** Play the n-th HEOS favorite (1-based) on the configured zone. */
export async function playHeosFavorite(externalId, number, zone) {
  const heos = requireHeos(externalId, 'play a HEOS favorite');
  const command = buildPlayPresetCommand(heos.pid, number);
  await ensureZoneReadyForHeos(externalId, normalizeZone(zone));
  sendHeos(externalId, command, 'play a HEOS favorite');
}
