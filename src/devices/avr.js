// -----------------------------------------------------------------------------
// Device type: Denon/Marantz AVR (receiver) — the public face of this folder.
//
// An AVR is discovered dynamically (SSDP, see src/denon/discovery.js) and
// there can be zero, one or several of them on the LAN. The code is split by
// responsibility; this file only re-exports what index.js, src/widgets/,
// src/scenes/ and the tests use:
//   - ./features.js      what a device IS: feature keys, widget-only state
//                        keys, the discovery payload (buildFeatures());
//   - ./registry.js      the shared in-memory state: open sessions, last
//                        known state, state-change listeners, delays;
//   - ./session.js       the Telnet session ("AVR Control", port 23) and its
//                        lifecycle: connectDevice() / refreshDevice() /
//                        disconnectDevice(), driven by the device events;
//   - ./heos-session.js  the best-effort HEOS CLI session (port 1255);
//   - ./transport.js     the per-device "local / unreachable" badge;
//   - ./control.js       imperative controls shared by every entry point;
//   - ./commands.js      gladys.onSetValue() dispatch (Telnet vs HEOS);
//   - ./announcements.js "Speak on a speaker": volume, end, restore;
//   - ./actions.js       the Configuration screen's manifest actions.
// -----------------------------------------------------------------------------

export {
  DEVICE_TYPE,
  FEATURE,
  STATE,
  TUNER_SOURCE_CODE,
  HEOS_SOURCE_CODE,
  featureExternalId,
  sourceLabel,
  soundModeLabel,
  visibleSourceCodes,
  buildDiscoveredDevice,
  buildManualDevice,
} from './features.js';
export {
  getDeviceSnapshot,
  onDeviceStateChange,
  sessionIds,
  __setConnectionForTesting,
  __setLastKnownStateForTesting,
  __setHeosConnectionForTesting,
  __setHeosPollIntervalMsForTesting,
  __setZoneSwitchDelayMsForTesting,
  __setTimingForTesting,
  __clearConnectionsForTesting,
} from './registry.js';
export { connectDevice, refreshDevice, disconnectDevice, disconnectAllDevices } from './session.js';
export { onSetValue, runFeatureCommand } from './commands.js';
export { runTestConnectionAction, runSelectSourceAction } from './actions.js';
export {
  setPower,
  setSource,
  setSoundMode,
  setVolume,
  selectQuickSelect,
  selectTuner,
  sendTunerCommand,
  playHeosFavorite,
} from './control.js';
