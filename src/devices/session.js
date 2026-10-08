// -----------------------------------------------------------------------------
// The sessions of one Gladys-created AVR: the persistent legacy Telnet
// session ("AVR Control", port 23) and the best-effort HEOS one
// (./heos-session.js), opened by connectDevice() on gladys.onDeviceCreated /
// at startup, reopened by refreshDevice() on gladys.onDeviceUpdated when the
// IP changed, closed by disconnectDevice() on gladys.onDeviceDeleted.
//
// The Telnet session is push-driven: the receiver sends a line for every
// state change, from ANY controller (this integration, the physical remote,
// the Denon app...). connectDevice() seeds the initial state with one round
// of queries, then every line is parsed, cached (./registry.js) and
// republished as it arrives.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createTelnetClient } from '../denon/telnet.js';
import {
  parseLine,
  buildPowerQuery,
  buildVolumeQuery,
  buildMuteQuery,
  buildSourceQuery,
  buildSoundModeQuery,
  buildMenuQuery,
  buildQuickSelectQuery,
  buildTunerQueries,
  normalizeZone,
} from '../denon/protocol.js';
import {
  FEATURE,
  STATE,
  STATE_ONLY_KEYS,
  featureExternalId,
  ipAddressOf,
  visibleSourceCodes,
} from './features.js';
import {
  deleteSession,
  getSession,
  hasSession,
  sessionIds,
  setSession,
  updateState,
  getState,
} from './registry.js';
import { openHeosSession } from './heos-session.js';
import { forgetHealth, reportHealth } from './transport.js';
import { cancelAnnouncement } from './announcements.js';

const logger = createLogger({ name: 'avr' });

/**
 * The state queries for one zone, deduplicated: a secondary zone's bare
 * Z2?/Z3? answers power, volume and source at once, so it's only sent once.
 * Sound mode (MS?) is the main zone's, but reported whatever the zone — see
 * parseLine() in ../denon/protocol.js.
 */
export function initialQueries(zone) {
  return [
    ...new Set([
      buildPowerQuery(zone),
      buildVolumeQuery(zone),
      buildMuteQuery(zone),
      buildSourceQuery(zone),
      buildSoundModeQuery(),
    ]),
  ];
}

/**
 * Open the persistent sessions for one Gladys-created AVR device.
 * Idempotent: does nothing if a session is already open for this device.
 */
export function connectDevice(gladys, device, config) {
  const externalId = device.external_id;
  if (hasSession(externalId)) {
    return;
  }
  const host = ipAddressOf(device) || config.host;
  if (!host) {
    logger.warn(`No IP address known for ${externalId}, cannot connect`);
    return;
  }
  // Fixed for the lifetime of this session: index.js reconnects every
  // device when the `zone` config changes, see onConfigUpdated there.
  const zone = normalizeZone(config.zone);
  const port = config.port;

  // Declared before the Telnet client below so that its onLine handler can
  // read `heos.pid` — once HEOS has matched this receiver's player id, it
  // becomes the authoritative source for PLAYBACK_STATE/NOW_PLAYING and the
  // legacy NSE0/NSE1/NSE2 lines (which generally don't fire for HEOS-managed
  // playback anyway, per real-hardware feedback) must not overwrite it with
  // a stale or unrelated Net/USB-subsystem guess.
  let heos = null;

  const telnet = createTelnetClient({
    host,
    port,
    reconnectIntervalSeconds: config.reconnect_interval_seconds,
    onConnect: () => {
      logger.info(`${externalId}: connected (${zone} zone), seeding initial state`);
      for (const query of initialQueries(zone)) {
        telnet.send(query);
      }
      telnet.send(buildMenuQuery());
      // Widget-only state (src/widgets/): the current Quick Select and the
      // analog tuner. A receiver without one just ignores the query.
      telnet.send(buildQuickSelectQuery(zone));
      for (const query of buildTunerQueries()) {
        telnet.send(query);
      }
      reportHealth(gladys, externalId, { telnetUp: true, telnetFailures: 0, host, port });
    },
    onLine: (line) => {
      const update = parseLine(line, zone);
      if (!update) {
        return;
      }
      const isNowPlayingLine =
        update.feature === STATE.NOW_PLAYING_TITLE || update.feature === STATE.NOW_PLAYING_ARTIST;
      if (heos?.pid != null && (isNowPlayingLine || update.feature === FEATURE.PLAYBACK_STATE)) {
        // HEOS is authoritative once matched — see the comment above
        // `heos`. Not even cached: the widgets read the cache too.
        return;
      }
      const changes = { [update.feature]: update.value };
      if (isNowPlayingLine) {
        // The legacy NSE lines carry no album or artwork: drop whatever a
        // previous HEOS session left, it belongs to another track.
        changes[STATE.NOW_PLAYING_ALBUM] = '';
        changes[STATE.NOW_PLAYING_IMAGE_URL] = '';
      }
      updateState(externalId, changes);

      if (STATE_ONLY_KEYS.has(update.feature)) {
        return; // Widget-only state, see STATE.
      }

      // now_playing_title/artist are cached above like any other state, but
      // never published under their own name: NOW_PLAYING is the single
      // "Artist - Title" feature actually declared in buildFeatures().
      if (isNowPlayingLine) {
        const state = getState(externalId);
        publish(gladys, heos, featureExternalId(externalId, FEATURE.NOW_PLAYING), {
          text: [state[STATE.NOW_PLAYING_ARTIST], state[STATE.NOW_PLAYING_TITLE]]
            .filter(Boolean)
            .join(' - '),
        });
        return;
      }

      const isTextFeature =
        update.feature === FEATURE.SOURCE || update.feature === FEATURE.SOUND_MODE;
      publish(
        gladys,
        heos,
        featureExternalId(externalId, update.feature),
        isTextFeature ? { text: update.value } : update.value,
      );

      // Keep FEATURE.SOURCE_INDEX in lockstep with FEATURE.SOURCE — same
      // visible-list computation buildFeatures() used to build the dropdown
      // (see visibleSourceCodes()). A code that isn't in that list (hidden by
      // source_overrides, or one the static SOURCE_CODES table doesn't know)
      // has no index to report: skip the publish rather than send a bogus
      // one, leaving the last known good index in place.
      if (update.feature === FEATURE.SOURCE) {
        const index = visibleSourceCodes(config.sourceOverrides).findIndex(
          (code) => code.value === update.value,
        );
        if (index !== -1) {
          publish(gladys, heos, featureExternalId(externalId, FEATURE.SOURCE_INDEX), index);
        }
      }
    },
    onDisconnect: (consecutiveFailures) => {
      reportHealth(gladys, externalId, {
        telnetUp: false,
        telnetFailures: consecutiveFailures,
        host,
        port,
      });
    },
  });

  setSession(externalId, { telnet, host, device });

  heos = openHeosSession(gladys, device, {
    host,
    zone,
    config,
    isTelnetConnected: () => telnet.isConnected(),
    onMatchChange: (heosMatch) => reportHealth(gladys, externalId, { heosMatch, host, port }),
  });
  setSession(externalId, { heos });
}

/** Publish one legacy-Telnet-sourced state, dropping HEOS' dedup record for it. */
function publish(gladys, heos, id, value) {
  heos?.forget(id);
  gladys
    .publishState(id, value)
    .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));
}

/**
 * `onDeviceUpdated`: reopen the session only when the device's address
 * actually changed (a new DHCP lease picked up by a Discovery scan, then
 * "Update" clicked on the device) — connectDevice() alone is idempotent and
 * would keep talking to the old IP until the container restarts. A rename or
 * a room change keeps the session as is (the new name is kept for the
 * widgets); a device that had no session yet (no IP known before) gets one.
 */
export function refreshDevice(gladys, device, config) {
  const host = ipAddressOf(device) || config.host;
  // No usable address in the update: never tear down a session that works.
  if (!host) {
    return;
  }
  if (hasSession(device.external_id) && getSession(device.external_id).host === host) {
    setSession(device.external_id, { device });
    return;
  }
  disconnectDevice(device.external_id);
  connectDevice(gladys, device, config);
}

/** Close and forget the persistent sessions of one device, if any. */
export function disconnectDevice(externalId) {
  const session = getSession(externalId);
  session?.telnet?.stop();
  session?.heos?.stop?.();
  cancelAnnouncement(externalId);
  deleteSession(externalId);
  forgetHealth(externalId);
}

/** Close every open session (graceful shutdown). */
export function disconnectAllDevices() {
  for (const externalId of sessionIds()) {
    disconnectDevice(externalId);
  }
}
