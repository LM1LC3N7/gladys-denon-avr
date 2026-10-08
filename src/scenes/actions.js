// -----------------------------------------------------------------------------
// Scene actions declared in the manifest `scene_actions` (Gladys >= 5.1.0):
// cards of the scene editor's action picker, run by the core with the
// resolved fields (scene variables substituted, defaults applied, validated
// against the declaration). A handler resolves the declared `outputs` (or
// nothing); a throw fails that action only — the scene logs it and goes on.
//
// Keys are forever: a published key is never renamed (a renamed key is a
// removed key for every scene using it). Keep them in sync with the
// manifest — test/manifest.test.js checks it.
// -----------------------------------------------------------------------------

import { normalizeZone } from '../denon/protocol.js';
import {
  FEATURE,
  STATE,
  getDeviceSnapshot,
  playHeosFavorite,
  selectQuickSelect,
  setPower,
  setSoundMode,
  setSource,
  setVolume,
  sourceLabel,
} from '../devices/avr.js';

export const SCENE_ACTION = Object.freeze({
  QUICK_SELECT: 'quick_select',
  PLAY_HEOS_FAVORITE: 'play_heos_favorite',
  SET_AMP: 'set_amp',
  GET_STATE: 'get_state',
});

/** The English text of a label that may be a plain string or `{ en, fr }`. */
export function plainLabel(label) {
  return typeof label === 'string' ? label : (label?.en ?? '');
}

/** The snapshot of the AVR a scene action targets, or a thrown error. */
function targetAvr(fields) {
  const snapshot = getDeviceSnapshot(String(fields?.avr ?? ''));
  if (!snapshot.known) {
    throw new Error(`Unknown AVR "${fields?.avr}": it is not added in Gladys or not connected`);
  }
  return snapshot;
}

/**
 * The handlers, by scene action key. `getConfig()` returns the live,
 * normalized integration config (zone, source overrides).
 */
export function createSceneActionHandlers(getConfig) {
  return {
    [SCENE_ACTION.QUICK_SELECT]: async (fields) => {
      const { externalId } = targetAvr(fields);
      selectQuickSelect(externalId, Number(fields.preset), normalizeZone(getConfig().zone));
    },

    [SCENE_ACTION.PLAY_HEOS_FAVORITE]: async (fields) => {
      const { externalId } = targetAvr(fields);
      await playHeosFavorite(externalId, Number(fields.favorite), normalizeZone(getConfig().zone));
    },

    // One card for the usual "watch a movie" setup: power, input, sound mode
    // and volume, each optional. Power on first (with the wake-up pause),
    // power off alone — the other settings are moot on a receiver in standby.
    [SCENE_ACTION.SET_AMP]: async (fields) => {
      const { externalId } = targetAvr(fields);
      const zone = normalizeZone(getConfig().zone);
      if (fields.power === 'off') {
        await setPower(externalId, false, zone);
        return;
      }
      if (fields.power === 'on') {
        await setPower(externalId, true, zone);
      }
      if (fields.source) {
        setSource(externalId, fields.source, zone);
      }
      if (fields.sound_mode) {
        setSoundMode(externalId, fields.sound_mode);
      }
      if (fields.volume !== undefined && fields.volume !== null && fields.volume !== '') {
        setVolume(externalId, fields.volume, zone);
      }
    },

    // Reads the receiver for the following actions of the scene: the core's
    // "Continue only if" then gates on an output — the text ones (input,
    // sound mode, title) being what a device-feature condition cannot test.
    [SCENE_ACTION.GET_STATE]: async (fields) => {
      const { state, telnetConnected, heosConnected } = targetAvr(fields);
      const sourceOverrides = getConfig().sourceOverrides ?? {};
      return {
        reachable: telnetConnected || heosConnected,
        power: state[FEATURE.POWER] === 1,
        volume: state[FEATURE.VOLUME] ?? null,
        muted: state[FEATURE.MUTE] === 1,
        source: state[FEATURE.SOURCE] ?? '',
        source_label: state[FEATURE.SOURCE]
          ? plainLabel(sourceLabel(state[FEATURE.SOURCE], sourceOverrides))
          : '',
        // The MS code, as set_amp takes it ("MOVIE", "PURE DIRECT"…).
        sound_mode: state[FEATURE.SOUND_MODE] ?? '',
        quick_select: state[STATE.QUICK_SELECT] ?? null,
        playing: state[FEATURE.PLAYBACK_STATE] === 1,
        title: state[STATE.NOW_PLAYING_TITLE] ?? '',
        artist: state[STATE.NOW_PLAYING_ARTIST] ?? '',
      };
    },
  };
}

/** Register every scene action handler on the SDK (before connect()). */
export function registerSceneActions(gladys, getConfig) {
  for (const [key, handler] of Object.entries(createSceneActionHandlers(getConfig))) {
    gladys.onSceneAction(key, handler);
  }
}
