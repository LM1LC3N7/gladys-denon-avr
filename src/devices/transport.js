// -----------------------------------------------------------------------------
// Per-device transport badge (SDK publishTransports(), Gladys >= 4.84): one
// "local" / "unreachable" badge per AVR on its device card, with an orange
// "degraded" dot and a tooltip when it works but not in the nominal mode.
//
// Replaces the integration-wide setConnectionStatus(false, "Cannot reach…")
// each Telnet session used to send: with two receivers, one unreachable and
// one fine, that single status flapped between the two messages and could
// never say WHICH device was the problem. The integration status now only
// says whether the integration itself is up (index.js).
//
// What each receiver shows:
//   - Telnet up                       -> local (nominal);
//   - Telnet up, a power command left unanswered (./power.js)
//                                     -> local, degraded (names the command);
//   - Telnet up, HEOS answering but no player at this IP
//                                     -> local, degraded ("Speak on a speaker"
//                                        cannot work: multi-NIC / IP mismatch);
//   - HEOS-only speaker (./speaker.js), HEOS matched
//                                     -> local (nominal: a Denon Home has no
//                                        Telnet to miss, forum topic 10722,
//                                        post 37);
//   - Telnet down (past the failure threshold), HEOS matched
//                                     -> local, degraded (an AVR whose port
//                                        23 is off or held elsewhere);
//   - Telnet and HEOS both down       -> unreachable.
// A Telnet session still within its first failed attempts publishes nothing
// yet (a receiver waking up is not "unreachable").
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { HEOS_MATCH } from './heos-session.js';
import { notifyStateChange, registerResetHook } from './registry.js';

const logger = createLogger({ name: 'avr' });

// Consecutive failed/dropped Telnet attempts before a receiver is reported
// as not reachable over Telnet (the backoff makes 3 attempts ~1 min).
export const CONNECTION_FAILURE_THRESHOLD = 3;

// external_id -> { telnetUp, telnetFailures, heosMatch, heosOnly, powerUnconfirmed, host, port, published }
const health = new Map();
registerResetHook(() => health.clear());

const MESSAGES = {
  powerUnconfirmed: (command) => ({
    en: `Power command ${command} sent, but the receiver did not report its power back: on/off is not confirmed.`,
    fr: `Commande d'alimentation ${command} envoyée, mais l'ampli n'a pas renvoyé son état : marche/arrêt non confirmé.`,
  }),
  heosUnmatched: (host) => ({
    en: `HEOS answers but lists no player at ${host}: "Speak on a speaker" and HEOS playback cannot work.`,
    fr: `HEOS répond mais n'a aucun lecteur à ${host} : « Parler sur une enceinte » et la lecture HEOS ne fonctionneront pas.`,
  }),
  heosOnly: (host, port) => ({
    en: `AVR Control (Telnet ${host}:${port}) unreachable: only volume, mute, playback and announcements (HEOS) work.`,
    fr: `Contrôle AVR (Telnet ${host}:${port}) injoignable : seuls le volume, la sourdine, la lecture et les annonces (HEOS) fonctionnent.`,
  }),
  speakerUnreachable: (host) => ({
    en: `Cannot reach the HEOS speaker at ${host} (port 1255). Check that it is powered and on the network.`,
    fr: `Impossible de joindre l'enceinte HEOS ${host} (port 1255). Vérifiez qu'elle est alimentée et sur le réseau.`,
  }),
  unreachable: (host, port) => ({
    en: `Cannot reach ${host}:${port}. Check that the receiver is powered and its network standby is on.`,
    fr: `Impossible de joindre ${host}:${port}. Vérifiez que l'ampli est alimenté et que sa veille réseau est active.`,
  }),
};

/** The badge entry of one receiver, or null when it is too early to say. Pure. */
export function computeTransport(
  externalId,
  { telnetUp, telnetFailures, heosMatch, heosOnly, powerUnconfirmed, host, port },
) {
  if (telnetUp) {
    if (powerUnconfirmed) {
      return {
        external_id: externalId,
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: MESSAGES.powerUnconfirmed(powerUnconfirmed),
      };
    }
    if (heosMatch === HEOS_MATCH.UNMATCHED) {
      return {
        external_id: externalId,
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: MESSAGES.heosUnmatched(host),
      };
    }
    return { external_id: externalId, transport: DEVICE_TRANSPORTS.LOCAL };
  }
  if (heosOnly) {
    // A speaker's reachability is HEOS's (review r1, I2): its Telnet is
    // only retried every few minutes and says nothing.
    return heosMatch === HEOS_MATCH.MATCHED
      ? { external_id: externalId, transport: DEVICE_TRANSPORTS.LOCAL }
      : {
          external_id: externalId,
          transport: DEVICE_TRANSPORTS.UNREACHABLE,
          message: MESSAGES.speakerUnreachable(host),
        };
  }
  // An AVR whose Telnet is still in its first failed attempts is not
  // reported yet: HEOS often answers first, and a receiver that is waking
  // up, or a HEOS speaker not recognized yet, must not flash the orange dot.
  if (heosMatch === HEOS_MATCH.MATCHED && telnetFailures >= CONNECTION_FAILURE_THRESHOLD) {
    return {
      external_id: externalId,
      transport: DEVICE_TRANSPORTS.LOCAL,
      degraded: true,
      message: MESSAGES.heosOnly(host, port),
    };
  }
  if (telnetFailures >= CONNECTION_FAILURE_THRESHOLD) {
    return {
      external_id: externalId,
      transport: DEVICE_TRANSPORTS.UNREACHABLE,
      message: MESSAGES.unreachable(host, port),
    };
  }
  return null;
}

/**
 * Record what one receiver's sessions just reported and publish its badge
 * when it changed. Fire-and-forget: a failed publish is logged and retried
 * on the next change.
 */
export function reportHealth(gladys, externalId, changes) {
  const previous = health.get(externalId) ?? {
    telnetUp: false,
    telnetFailures: 0,
    heosMatch: HEOS_MATCH.NONE,
    published: null,
  };
  const current = { ...previous, ...changes };
  health.set(externalId, current);
  const entry = computeTransport(externalId, current);
  const key = entry && JSON.stringify(entry);
  if (!entry || key === previous.published) {
    return;
  }
  current.published = key;
  // The widgets show the same reachability: let them re-pull.
  notifyStateChange(externalId, 'connection', entry.transport, undefined);
  gladys.publishTransports([entry]).catch((err) => {
    current.published = null;
    logger.warn(`publishTransports failed for ${externalId}: ${err.message}`);
  });
}

/** Forget one receiver (device deleted or session reopened). */
export function forgetHealth(externalId) {
  health.delete(externalId);
}
