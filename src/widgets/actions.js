// -----------------------------------------------------------------------------
// The widget buttons (gladys.onWidgetAction): what each action key declared
// by ./content.js does. Gladys sends back only the `params` declared in the
// last content it rendered — never user input — but nothing is trusted
// anyway: the action key must be one of the buttons below, `params.avr` a
// receiver with an open session, a shortcut target one of the options.
//
// Feature-like keys go through runFeatureCommand() — the exact routing of a
// Gladys device control (Telnet vs HEOS, mute/menu toggles).
// -----------------------------------------------------------------------------

import { normalizeZone } from '../denon/protocol.js';
import {
  FEATURE,
  STATE,
  getDeviceSnapshot,
  playHeosFavorite,
  runFeatureCommand,
  selectQuickSelect,
  selectTuner,
  sendTunerCommand,
  setSource,
} from '../devices/avr.js';
import { REMOTE_BUTTONS } from './common.js';
import { parseShortcutTarget } from './content.js';

// Buttons that are one feature of the device, with the value they send.
const FEATURE_BUTTONS = {
  previous: { feature: FEATURE.PREVIOUS, value: 1 },
  play: { feature: FEATURE.PLAY, value: 1 },
  pause: { feature: FEATURE.PAUSE, value: 1 },
  next: { feature: FEATURE.NEXT, value: 1 },
  ...Object.fromEntries(
    REMOTE_BUTTONS.map((button) => [
      button.value,
      { feature: button.feature, value: button.featureValue ?? 1 },
    ]),
  ),
};

const TUNER_BUTTONS = new Set(['frequency_down', 'frequency_up', 'preset_down', 'preset_up']);

/**
 * Run one widget action. Resolves an optional toast, throws (shown as a
 * failed action) when it cannot.
 */
export async function runWidgetAction(gladys, actionKey, params, config) {
  const snapshot = getDeviceSnapshot(String(params?.avr ?? ''));
  if (!snapshot.known) {
    throw new Error('This receiver is no longer added in Gladys');
  }
  const { externalId, state } = snapshot;
  const zone = normalizeZone(config.zone);

  if (FEATURE_BUTTONS[actionKey]) {
    const { feature, value } = FEATURE_BUTTONS[actionKey];
    await runFeatureCommand(gladys, externalId, feature, value, config);
    return undefined;
  }

  if (/^slot_[1-4]$/.test(actionKey)) {
    const target = parseShortcutTarget(params.target);
    if (!target) {
      throw new Error(`Unknown shortcut "${params.target}"`);
    }
    if (target.kind === 'source') {
      setSource(externalId, target.code, zone);
    } else if (target.kind === 'quick') {
      selectQuickSelect(externalId, target.number, zone);
    } else {
      await playHeosFavorite(externalId, target.number, zone);
    }
    return undefined;
  }

  if (TUNER_BUTTONS.has(actionKey)) {
    await sendTunerCommand(externalId, actionKey, zone);
    return undefined;
  }
  if (actionKey === 'band_toggle') {
    await sendTunerCommand(
      externalId,
      state[STATE.TUNER_BAND] === 'AM' ? 'band_fm' : 'band_am',
      zone,
    );
    return undefined;
  }
  if (actionKey === 'mode_toggle') {
    await sendTunerCommand(
      externalId,
      state[STATE.TUNER_MODE] === 'AUTO' ? 'mode_manual' : 'mode_auto',
      zone,
    );
    return undefined;
  }
  if (actionKey === 'tuner') {
    await selectTuner(externalId, zone);
    return undefined;
  }

  throw new Error(`Unknown widget button "${actionKey}"`);
}
