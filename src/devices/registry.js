// -----------------------------------------------------------------------------
// Shared, in-memory state of every AVR the user created — the one place the
// other modules of this folder (and src/widgets/, src/scenes/) read and write
// it, so none of them has to own another's Maps:
//   - the open sessions: legacy Telnet client, HEOS session, connected host,
//     the Gladys device itself (for its name);
//   - the last known state of each receiver (`state`), fed by the sessions
//     and read back by the commands (toggles), the "Test connection" action,
//     the dashboard widgets and the scene triggers;
//   - the state-change listeners, notified only when a value actually moved;
//   - the tunable delays (overridden by tests, never in production).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'avr' });

// Delays every module reads at call time, so a test can shrink them.
const DEFAULT_TIMING = Object.freeze({
  // Pause between switching the configured zone on/to an input and the next
  // command, only paid when that switch was actually needed: a receiver
  // waking from standby takes about a second before it reliably takes the
  // next command (Denon's own protocol guidance), and a stream started before
  // the input switch has landed is exactly the "played on whichever zone HEOS
  // last used" case the switch is there to prevent.
  zoneSwitchDelayMs: 1500,
  // How often to actively re-query HEOS for playback state + now-playing
  // metadata while a player id is known, on top of reacting to its pushed
  // events. HEOS CLI connections are known to drop silently when idle (the
  // protocol has its own recommended heart_beat command for exactly this),
  // and even when the socket itself survives, there's no guarantee every
  // `event/player_*_changed` push actually reaches us — so treat the pushed
  // events as the fast path and this poll as the self-healing fallback that
  // guarantees eventual consistency either way, rather than trying to prove
  // which failure mode is real. Real-hardware feedback: without this, the
  // dashboard was observed stuck on "paused" indefinitely after playback
  // actually started elsewhere (the Qobuz app), even though HEOS commands
  // sent *from* Gladys (play/pause/next) worked fine.
  heosPollIntervalMs: 30_000,
  // While an announcement plays (./announcements.js): how often its end is
  // polled, how long a stream may take to start, and the hard cap after
  // which the previous state is restored whatever HEOS says.
  announcementPollMs: 1_000,
  announcementStartTimeoutMs: 15_000,
  announcementMaxMs: 180_000,
});

export const timing = { ...DEFAULT_TIMING };

/** Resolve after `ms` (no timer at all for 0, as tests set it). */
export function settle(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// external_id -> { telnet, heos, host, device }. `heos` is `{ client, pid }`:
// `pid` is null until a `get_players` reply matches our IP (or forever, on a
// non-HEOS model / unreachable HEOS CLI) — every caller must treat a
// missing/null pid as "fall back to legacy Telnet", never as an error.
const sessions = new Map();
// external_id -> last known state (feature keys of FEATURE + STATE).
const lastKnownState = new Map();
// Listeners of every state change of every AVR, see onDeviceStateChange().
const stateListeners = new Set();
// Cleanups of the modules that keep per-device state of their own
// (announcements, transport badge…), run by resetForTesting().
const resetHooks = new Set();

/** Open-or-update the session record of one AVR (shallow merge). */
export function setSession(externalId, fields) {
  sessions.set(externalId, { ...sessions.get(externalId), ...fields });
}

export function getSession(externalId) {
  return sessions.get(externalId);
}

export function hasSession(externalId) {
  return sessions.has(externalId);
}

/** The external_id of every AVR with an open session, in creation order. */
export function sessionIds() {
  return [...sessions.keys()];
}

export function deleteSession(externalId) {
  sessions.delete(externalId);
  lastKnownState.delete(externalId);
}

export function getTelnet(externalId) {
  return sessions.get(externalId)?.telnet;
}

export function getHeos(externalId) {
  return sessions.get(externalId)?.heos;
}

/** Whether a legacy Telnet session is up for this AVR. */
export function isTelnetConnected(externalId) {
  return getTelnet(externalId)?.isConnected() ?? false;
}

/** Whether HEOS is up AND matched to this AVR's player id. */
export function isHeosConnected(externalId) {
  const heos = getHeos(externalId);
  return heos?.pid != null && (heos.client?.isConnected() ?? false);
}

/** A copy of the last known state of one AVR (empty when unknown). */
export function getState(externalId) {
  return { ...lastKnownState.get(externalId) };
}

/**
 * Subscribe to the state changes of every AVR:
 * `listener(externalId, key, value, previous)` runs after the cache is
 * updated, only when `value` differs from `previous` (`previous` is
 * `undefined` for the first value after a (re)connect). Returns the
 * unsubscribe function. A throwing listener is logged, never propagated.
 */
export function onDeviceStateChange(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Notify the listeners directly — for a change that is not a state key (a session up/down). */
export function notifyStateChange(externalId, key, value, previous) {
  for (const listener of stateListeners) {
    try {
      listener(externalId, key, value, previous);
    } catch (err) {
      logger.error(`State change listener failed: ${err.message}`);
    }
  }
}

/** Merge `changes` into the last known state of one AVR, then notify what moved. */
export function updateState(externalId, changes) {
  const previous = lastKnownState.get(externalId) ?? {};
  lastKnownState.set(externalId, { ...previous, ...changes });
  for (const [key, value] of Object.entries(changes)) {
    if (previous[key] !== value) {
      notifyStateChange(externalId, key, value, previous[key]);
    }
  }
}

/**
 * What the dashboard widgets and the scene actions read for one AVR: its
 * name, whether its sessions are up, and a copy of its last known state.
 */
export function getDeviceSnapshot(externalId) {
  const session = sessions.get(externalId);
  return {
    externalId,
    known: session !== undefined,
    name: session?.device?.name ?? externalId,
    telnetConnected: isTelnetConnected(externalId),
    heosConnected: isHeosConnected(externalId),
    state: getState(externalId),
  };
}

/** Register a cleanup run by resetForTesting() (module-level per-device state). */
export function registerResetHook(hook) {
  resetHooks.add(hook);
}

// --- Test-only hooks (never used by production code) -------------------------

/** Inject a fake `{ send, isConnected }` Telnet client for one external_id. */
export function __setConnectionForTesting(externalId, telnetClient) {
  setSession(externalId, { telnet: telnetClient });
}

/** Seed the last-known-state cache of one external_id. */
export function __setLastKnownStateForTesting(externalId, state) {
  lastKnownState.set(externalId, state);
}

/** Inject a fake `{ pid, client: { sendCommand, isConnected } }` HEOS session. */
export function __setHeosConnectionForTesting(externalId, heosState) {
  setSession(externalId, { heos: heosState });
}

/** Override HEOS_POLL_INTERVAL_MS-like delay (reset by __clearConnectionsForTesting()). */
export function __setHeosPollIntervalMsForTesting(ms) {
  timing.heosPollIntervalMs = ms;
}

/** Override the zone-switch settling pause (reset by __clearConnectionsForTesting()). */
export function __setZoneSwitchDelayMsForTesting(ms) {
  timing.zoneSwitchDelayMs = ms;
}

/** Override any of the delays above (reset by __clearConnectionsForTesting()). */
export function __setTimingForTesting(overrides) {
  Object.assign(timing, overrides);
}

/** Drop every session, state, listener and per-module record between tests. */
export function __clearConnectionsForTesting() {
  for (const session of sessions.values()) {
    session.heos?.stop?.();
  }
  sessions.clear();
  lastKnownState.clear();
  stateListeners.clear();
  for (const hook of resetHooks) {
    hook();
  }
  Object.assign(timing, DEFAULT_TIMING);
}
