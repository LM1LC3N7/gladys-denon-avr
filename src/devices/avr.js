// -----------------------------------------------------------------------------
// Device type: Denon/Marantz AVR (receiver)
//
// Unlike the template's fixed demo devices, an AVR is discovered dynamically
// (SSDP, see src/denon/discovery.js) and there can be zero, one or several of
// them on the LAN. So instead of ONE static blueprint object, this module
// exposes:
//   - buildDiscoveredDevice() / buildManualDevice() to build discovery payloads
//   - a small connection registry (external_id -> Telnet client) driven by the
//     device lifecycle: connectDevice() on gladys.onDeviceCreated / at startup
//     (for devices the user already created), disconnectDevice() on
//     gladys.onDeviceDeleted
//   - onSetValue() / runTestConnectionAction() / runSelectSourceAction() that
//     look up the right connection from that registry
//
// The Telnet session is push-driven: the receiver sends a line for every
// state change, from ANY controller (this integration, the physical remote,
// the Denon app...). connectDevice() seeds the initial state with one round
// of queries, then every line is parsed and republished as it arrives.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createTelnetClient } from '../denon/telnet.js';
import {
  parseLine,
  buildPowerQuery,
  buildPowerCommand,
  buildVolumeQuery,
  buildVolumeCommand,
  buildMuteQuery,
  buildMuteCommand,
  buildSourceQuery,
  buildSourceCommand,
  SOURCE_CODES,
} from '../denon/protocol.js';

// DEVICE_FEATURE_TYPES.TEXT.SELECT ('select'): a dynamic dropdown among
// string values the integration itself declares via `supported_options`
// (Gladys core #2567 — installed TV apps, HDMI sources...), exactly our
// case. Not in this SDK's constants yet (^0.9.0 predates it; the string is
// stable and mirrors server/utils/constants.js), so it's spelled out here
// rather than imported. Requires a Gladys core recent enough to know the
// 'select' feature type — see the Source feature below.
const TEXT_SELECT_TYPE = 'select';

export const DEVICE_TYPE = 'avr';

export const FEATURE = {
  POWER: 'power',
  VOLUME: 'volume',
  MUTE: 'mute',
  SOURCE: 'source',
};

const CONNECTION_FAILURE_THRESHOLD = 3;

const logger = createLogger({ name: DEVICE_TYPE });

// external_id -> Telnet client (one persistent session per AVR the user created).
const connections = new Map();
// external_id -> last known state, used by the "Test connection" action.
const lastKnownState = new Map();

export function featureExternalId(deviceExternalId, key) {
  return `${deviceExternalId}:${key}`;
}

function ipAddressOf(device) {
  return (device.params ?? []).find((p) => p.name === 'IP_ADDRESS')?.value;
}

function buildFeatures(deviceExternalId) {
  return [
    {
      name: 'Power',
      external_id: featureExternalId(deviceExternalId, FEATURE.POWER),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type: DEVICE_FEATURE_TYPES.TELEVISION.BINARY,
      // min/max are NOT NULL in Gladys' database for every feature, binary
      // ones included — omitting them passes the store validator and CI
      // fine, then fails with a 422 ("max cannot be null") the moment a user
      // clicks "add" on a real Gladys instance. 0/1 is the binary range.
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Volume',
      external_id: featureExternalId(deviceExternalId, FEATURE.VOLUME),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type: DEVICE_FEATURE_TYPES.TELEVISION.VOLUME,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Mute',
      external_id: featureExternalId(deviceExternalId, FEATURE.MUTE),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type: DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_MUTE,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      // A dropdown of the receiver's own input codes (TEXT.SELECT — see the
      // TEXT_SELECT_TYPE note above), NOT the generic TELEVISION.SOURCE type:
      // that one is a one-shot remote-control button in Gladys' front-end
      // (same family as VOLUME_MUTE, no meaningful value), so it could never
      // represent a specific input — only TEXT.SELECT actually renders a
      // real select with our supported_options. The value published/set is
      // the verbatim SI code, so it stays correct for inputs the static
      // SOURCE_CODES list did not anticipate. The `select_source` manifest
      // action (see gladys-assistant-integration.json) is kept as a second,
      // equivalent path — this dashboard control needs a fairly recent
      // Gladys core (TEXT.SELECT/supported_options); on an older one this
      // feature type may be rejected outright, so both routes existing
      // matters, not just redundancy.
      name: 'Source',
      external_id: featureExternalId(deviceExternalId, FEATURE.SOURCE),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: TEXT_SELECT_TYPE,
      supported_options: SOURCE_CODES.map((code) => ({ value: code.value, label: code.value })),
      // Placeholder range: min/max are NOT NULL for every feature even when
      // they carry no real meaning for a select value (see the Power
      // feature above for why this must never be omitted).
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
    },
  ];
}

/** Build the discovery payload for one SSDP-discovered receiver. */
export function buildDiscoveredDevice(gladys, discovered) {
  const ids = gladys.externalIds(DEVICE_TYPE, discovered.udn);
  const name = discovered.modelName
    ? `${discovered.friendlyName} (${discovered.modelName})`
    : discovered.friendlyName;
  return {
    name,
    external_id: ids.device,
    params: [{ name: 'IP_ADDRESS', value: discovered.host }],
    features: buildFeatures(ids.device),
  };
}

/** Build the discovery payload for a manually-configured host (SSDP fallback). */
export function buildManualDevice(gladys, host) {
  const ids = gladys.externalIds(DEVICE_TYPE, `manual:${host}`);
  return {
    name: `Denon/Marantz AVR (${host})`,
    external_id: ids.device,
    params: [{ name: 'IP_ADDRESS', value: host }],
    features: buildFeatures(ids.device),
  };
}

/**
 * Open the persistent Telnet session for one Gladys-created AVR device.
 * Idempotent: does nothing if a session is already open for this device.
 */
export function connectDevice(gladys, device, config) {
  if (connections.has(device.external_id)) {
    return;
  }
  const host = ipAddressOf(device) || config.host;
  if (!host) {
    logger.warn(`No IP address known for ${device.external_id}, cannot connect`);
    return;
  }

  const telnet = createTelnetClient({
    host,
    port: config.port,
    reconnectIntervalSeconds: config.reconnect_interval_seconds,
    onConnect: () => {
      logger.info(`${device.external_id}: connected, seeding initial state`);
      telnet.send(buildPowerQuery());
      telnet.send(buildVolumeQuery());
      telnet.send(buildMuteQuery());
      telnet.send(buildSourceQuery());
      gladys.setConnectionStatus(true).catch(() => {});
    },
    onLine: (line) => {
      const update = parseLine(line);
      if (!update) {
        return;
      }
      const state = { ...lastKnownState.get(device.external_id) };
      state[update.feature] = update.value;
      lastKnownState.set(device.external_id, state);

      const id = featureExternalId(device.external_id, update.feature);
      const value = update.feature === FEATURE.SOURCE ? { text: update.value } : update.value;
      gladys
        .publishState(id, value)
        .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));
    },
    onDisconnect: (consecutiveFailures) => {
      if (consecutiveFailures >= CONNECTION_FAILURE_THRESHOLD) {
        gladys
          .setConnectionStatus(false, {
            en: `Cannot reach ${host}:${config.port} (${device.external_id}).`,
            fr: `Impossible de joindre ${host}:${config.port} (${device.external_id}).`,
          })
          .catch(() => {});
      }
    },
  });

  connections.set(device.external_id, telnet);
}

/**
 * Test-only hook: inject a fake `{ send, isConnected }` client for a given
 * external_id, so onSetValue()/the manifest actions can be unit tested
 * without a real socket (mirrors the template's `simulateLanSession` hook
 * in src/devices/plug.js). Not used by production code.
 */
export function __setConnectionForTesting(externalId, telnetClient) {
  connections.set(externalId, telnetClient);
}

/**
 * Test-only hook: seed the last-known-state cache for a given external_id,
 * so the MUTE toggle logic in onSetValue() can be tested without a real
 * receiver pushing state back over Telnet. Not used by production code.
 */
export function __setLastKnownStateForTesting(externalId, state) {
  lastKnownState.set(externalId, state);
}

/** Test-only hook: drop every registered connection between tests. */
export function __clearConnectionsForTesting() {
  connections.clear();
  lastKnownState.clear();
}

/** Close and forget the persistent session of one device, if any. */
export function disconnectDevice(externalId) {
  connections.get(externalId)?.stop();
  connections.delete(externalId);
  lastKnownState.delete(externalId);
}

/** Close every open session (graceful shutdown). */
export function disconnectAllDevices() {
  for (const externalId of connections.keys()) {
    disconnectDevice(externalId);
  }
}

/** Dispatch a user command (`onSetValue`) to the right device's Telnet session. */
export async function onSetValue(gladys, { device, feature, value }) {
  const telnet = connections.get(device.external_id);
  if (!telnet || !telnet.isConnected()) {
    throw new Error(`${device.external_id} is not connected`);
  }

  const key = feature.external_id.slice(device.external_id.length + 1);
  let command;
  if (key === FEATURE.POWER) {
    command = buildPowerCommand(value === 1);
  } else if (key === FEATURE.VOLUME) {
    command = buildVolumeCommand(value);
  } else if (key === FEATURE.MUTE) {
    // DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_MUTE is a remote-control button
    // (same family as VOLUME_UP/VOLUME_DOWN), not a stateful switch like
    // POWER's BINARY type — `value` is not a target state to set, it's just
    // a "button pressed" signal (observed constant across presses on a real
    // instance: trusting it as a target made every press send the same
    // command, so the second press never undid the first). Toggle off the
    // receiver's own last-reported mute state instead.
    const currentlyMuted = lastKnownState.get(device.external_id)?.mute === 1;
    command = buildMuteCommand(!currentlyMuted);
  } else if (key === FEATURE.SOURCE) {
    // TEXT.SELECT features carry their state as the selected option's own
    // string value (not the `number` the SDK types suggest — checked
    // against the Gladys core: device.setValue forwards it as-is, string or
    // number, to the integration), so `value` is already the SI code.
    command = buildSourceCommand(value);
  } else {
    throw new Error(`Feature "${key}" is not controllable`);
  }

  if (!telnet.send(command)) {
    throw new Error(`Failed to send command to ${device.external_id}`);
  }
}

/** `test_connection` manifest action: query the device and report its last known state. */
export async function runTestConnectionAction(gladys, { fields }) {
  const externalId = fields.device;
  const telnet = connections.get(externalId);
  if (!telnet || !telnet.isConnected()) {
    return {
      en: 'Not connected to this AVR. Check the host/network and the integration logs.',
      fr: "Pas de connexion à cet ampli. Vérifiez l'hôte/le réseau et les logs de l'intégration.",
    };
  }

  telnet.send(buildPowerQuery());
  telnet.send(buildVolumeQuery());
  telnet.send(buildMuteQuery());
  telnet.send(buildSourceQuery());
  // Bounded pause: the replies are asynchronous pushed lines, not a
  // request/response pair — give them a moment to land before reading the
  // (fresh-by-then) cache back.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const state = lastKnownState.get(externalId) ?? {};
  const power = state.power === 1 ? 'ON' : state.power === 0 ? 'STANDBY' : '?';
  const mute = state.mute === 1 ? 'ON' : state.mute === 0 ? 'OFF' : '?';
  return {
    en: `Power: ${power}, Volume: ${state.volume ?? '?'}%, Mute: ${mute}, Source: ${state.source ?? '?'}.`,
    fr: `Alimentation : ${power}, Volume : ${state.volume ?? '?'}%, Muet : ${mute}, Source : ${state.source ?? '?'}.`,
  };
}

/** `select_source` manifest action: switch the receiver's input. */
export async function runSelectSourceAction(gladys, { fields }) {
  const telnet = connections.get(fields.device);
  if (!telnet || !telnet.isConnected()) {
    throw new Error('This AVR is not connected');
  }
  if (!telnet.send(buildSourceCommand(fields.source))) {
    throw new Error('Failed to send the source command');
  }
  return {
    en: `Source command sent: ${fields.source}.`,
    fr: `Commande source envoyée : ${fields.source}.`,
  };
}
