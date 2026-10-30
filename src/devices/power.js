// -----------------------------------------------------------------------------
// Main-zone power on receivers with and without zones.
//
// An AV receiver drives its main zone with ZMON/ZMOFF (see ZONE in
// ../denon/protocol.js for why never PWON/PWSTANDBY there). A stereo network
// model (Marantz PM7000N, M-CR610/611, Denon DRA-100...) has no zones:
// it ignores ZM? and ZMON/ZMOFF and only knows PWON/PWSTANDBY/PW? (forum
// topic 10722, post 35: On/Off did nothing on a PM7000N). Which kind of
// receiver a session talks to is detected here, per device, from what it
// answers right after each Telnet connect (./session.js sends both ZM? and
// PW?):
//   - a ZMON/ZMOFF line, ever: POWER_MODE.ZONE, kept for good (the safe
//     mode: PW commands would also wake or cut Zone 2 on an AVR);
//   - a PWON/PWSTANDBY line and no ZM line within timing.powerProbeMs:
//     POWER_MODE.SYSTEM;
//   - nothing at all: the mode stays what it was (UNKNOWN = ZONE commands).
// The mode is remembered per device across Telnet reconnects, and forgotten
// when the device's session is closed (deleted, new IP, restart).
//
// Every power command sent is logged at info level with the exact command,
// and followed for timing.powerConfirmMs: without a power report back, the
// device badge turns "degraded" with the command that went unanswered.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { POWER_MODE, buildPowerCommand } from '../denon/protocol.js';
import { getSession, registerResetHook, timing } from './registry.js';

const logger = createLogger({ name: 'avr' });

// external_id -> POWER_MODE (UNKNOWN when absent).
const modes = new Map();
// external_id -> { timer, value, command }: a power command awaiting its report.
const pending = new Map();

registerResetHook(() => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
  }
  pending.clear();
  modes.clear();
});

const MODE_TEXT = {
  [POWER_MODE.UNKNOWN]: 'zones not detected yet: ZMON/ZMOFF',
  [POWER_MODE.ZONE]: 'receiver with zones: ZMON/ZMOFF',
  [POWER_MODE.SYSTEM]: 'receiver without zones: PWON/PWSTANDBY',
};

/** The detected power mode of one receiver (POWER_MODE.UNKNOWN until known). */
export function getPowerMode(externalId) {
  return modes.get(externalId) ?? POWER_MODE.UNKNOWN;
}

/** One line describing the power mode, for the logs and "Test connection". */
export function describePowerMode(externalId) {
  return MODE_TEXT[getPowerMode(externalId)];
}

/** Record the detected power mode of one receiver; logged when it changes. */
export function setPowerMode(externalId, mode, reason) {
  if (getPowerMode(externalId) === mode) {
    return;
  }
  modes.set(externalId, mode);
  logger.info(`${externalId}: ${reason}, power mode is now "${MODE_TEXT[mode]}"`);
}

/** Forget everything about one receiver's power (session closed). */
export function forgetPower(externalId) {
  modes.delete(externalId);
  clearTimeout(pending.get(externalId)?.timer);
  pending.delete(externalId);
}

/** The power command for one receiver, zone and wanted state, in its detected mode. */
export function powerCommandFor(externalId, on, zone) {
  return buildPowerCommand(on, zone, getPowerMode(externalId));
}

/** Ask the current session of one receiver to update its badge. */
function reportPower(externalId, powerUnconfirmed) {
  getSession(externalId)?.reportPower?.(powerUnconfirmed);
}

/**
 * Send the power command of one receiver over `telnet` (whatever its
 * connection state: the caller decides how a refusal surfaces), log it at
 * info level and follow its confirmation. Resolves whether it was written.
 */
export function sendPower(telnet, externalId, on, zone, origin) {
  const command = powerCommandFor(externalId, on, zone);
  if (!telnet.send(command)) {
    logger.warn(
      `${externalId}: power ${on ? 'on' : 'off'} (${origin}): ${command} NOT sent, not connected`,
    );
    return false;
  }
  logger.info(
    `${externalId}: power ${on ? 'on' : 'off'} (${origin}) -> sent ${command} (${describePowerMode(externalId)})`,
  );
  clearTimeout(pending.get(externalId)?.timer);
  const value = on ? 1 : 0;
  // Replaced (cleared) by a newer power command, a report or forgetPower().
  const timer = setTimeout(() => {
    pending.delete(externalId);
    logger.warn(
      `${externalId}: the receiver did not report its power after ${command} (${timing.powerConfirmMs} ms)`,
    );
    reportPower(externalId, command);
  }, timing.powerConfirmMs);
  timer.unref?.();
  pending.set(externalId, { timer, value, command });
  return true;
}

/**
 * A power state the receiver reported (parsed by ./session.js): confirms
 * the command awaiting this value, and clears a "not confirmed" badge — the
 * receiver does report its power after all.
 */
export function notePowerReport(externalId, value) {
  const entry = pending.get(externalId);
  if (entry && entry.value !== value) {
    return; // An older state still on its way: the command is not confirmed yet.
  }
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(externalId);
  }
  reportPower(externalId, null);
}
