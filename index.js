// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration.
//
// Role of this file: wire the SDK to the AVR device logic (src/devices/,
// src/denon/). It holds NO Denon protocol knowledge itself — only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects and (re)opens the Telnet session of every AVR the user
//      already created.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { buildDiscoveredDevices } from './src/devices/index.js';
import {
  connectDevice,
  disconnectDevice,
  disconnectAllDevices,
  onSetValue as dispatchSetValue,
  runTestConnectionAction,
  runSelectSourceAction,
} from './src/devices/avr.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
// SSDP scan (mediated by the core, see src/denon/discovery.js) + the manual
// host fallback. Discovery does not open any Telnet session by itself —
// sessions only open for devices the user actually creates, see below.
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> SSDP scan for Denon/Marantz AVRs');
  await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));
});

// --- Command: the user acts on a controllable feature (power/volume/mute) ---
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  try {
    await dispatchSetValue(gladys, { device, feature, value, config });
  } catch (err) {
    // The SDK acks a thrown error back to Gladys core as a failed command,
    // but never logs it itself (checked against @gladysassistant/
    // integration-sdk's _runCommand: it catches, sends the ack, and moves
    // on) — and a scene that triggers this command swallows that failure
    // just as silently (server/lib/scene/scene.executeActions.js in Gladys
    // core: a non-AbortScene error is logger.warn()'d server-side and the
    // scene still reports as having run). Without this log line, a command
    // that throws before doing anything — e.g. FEATURE.PLAY_NOTIFICATION
    // when no HEOS player id is matched yet, see src/devices/avr.js — left
    // literally no trace anywhere a user could see, container logs
    // included: real-world feedback was a scene that "looked like it
    // worked" with the Denon staying completely silent.
    logger.error(`onSetValue failed for ${feature.external_id}: ${err.message}`);
    throw err;
  }
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', (fields) => runTestConnectionAction(gladys, { fields, config }));
gladys.onAction('select_source', (fields) => runSelectSourceAction(gladys, { fields }));

// --- Device lifecycle: open/close the Telnet session as devices come and go -
gladys.onDeviceCreated(async (device) => {
  logger.info(`Device created -> connecting ${device.external_id}`);
  connectDevice(gladys, device, config);
});

gladys.onDeviceDeleted(async (device) => {
  logger.info(`Device deleted -> disconnecting ${device.external_id}`);
  disconnectDevice(device.external_id);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle under the `gladys-sdk` name.
// This handler (re)opens the Telnet session of every AVR the user already
// created — connectDevice() is idempotent, so a WebSocket blip/reconnect
// never opens a second socket to the same receiver.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    const devices = await gladys.getDevices();
    for (const device of devices) {
      connectDevice(gladys, device, config);
    }
    // Re-publish discovery on every (re)connect, not just when the user
    // opens the Discovery tab and clicks "Scan": a new image version can
    // add/change features on an already-created device (e.g. the playback
    // buttons added in 1.0.4), and Gladys only ever shows that as an
    // "Update" button already sitting in the Discovery tab — it never
    // applies structure changes to an existing device on its own. Doing
    // this on every connect means that button is there the moment the
    // updated container starts, instead of requiring a manual scan first.
    await gladys
      .publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config))
      .catch((err) => logger.error(`publishDiscoveredDevices on connect failed: ${err.message}`));
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  // Deliberately NOT tearing down the Telnet sessions here: they are real
  // TCP connections to the receiver, independent of the Gladys WebSocket.
  // Publishing a state while briefly disconnected just fails and logs (see
  // src/devices/avr.js) — nothing to clean up, and reconnecting the
  // WebSocket must not bounce the AVR sessions.
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  disconnectAllDevices();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Denon/Marantz AVR integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
