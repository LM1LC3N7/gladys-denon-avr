// -----------------------------------------------------------------------------
// Scene triggers declared in the manifest `scene_triggers` (Gladys >= 5.1.0):
// something HAPPENED on a receiver, fired with gladys.publishSceneEvent().
// The core matches the event against the filters the scene author chose
// (`fields`) and exposes the declared `variables` to the scene's actions.
//
//   - source_changed: the input moved (from Gladys, the remote, the app…),
//     filterable by receiver and by the new input — what a device-feature
//     trigger cannot do on a text value;
//   - track_changed: a new title/artist started (HEOS or the legacy NET/USB
//     lines), with the track as variables.
//
// One event per transition, never on the first value seen after a
// (re)connect: a reconnect is not the input changing. Playback started /
// paused is NOT a trigger here — it is the numeric "Playback state" feature,
// which the core's device trigger already covers.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  FEATURE,
  STATE,
  getDeviceSnapshot,
  onDeviceStateChange,
  sourceLabel,
} from '../devices/avr.js';
import { plainLabel } from './actions.js';

const logger = createLogger({ name: 'scenes' });

export const SCENE_TRIGGER = Object.freeze({
  SOURCE_CHANGED: 'source_changed',
  TRACK_CHANGED: 'track_changed',
});

// Title and artist arrive as separate updates (two NSE lines, or one HEOS
// reply re-read on every poll): wait for both to settle before firing.
const DEFAULT_TRACK_DEBOUNCE_MS = 1_500;

// Bound of an event string value on the host API.
const MAX_VALUE_LENGTH = 1000;

function cap(text) {
  return String(text ?? '').slice(0, MAX_VALUE_LENGTH);
}

/**
 * Start firing the scene triggers. `getConfig()` returns the live config
 * (source overrides, for the labels). Returns `stop()`.
 */
export function startSceneTriggers(
  gladys,
  getConfig,
  { trackDebounceMs = DEFAULT_TRACK_DEBOUNCE_MS } = {},
) {
  const trackTimers = new Map();
  const lastTrack = new Map();

  function fire(key, data) {
    gladys
      .publishSceneEvent(key, data)
      .catch((err) => logger.warn(`publishSceneEvent ${key} failed: ${err.message}`));
  }

  function fireTrack(externalId) {
    trackTimers.delete(externalId);
    const { state } = getDeviceSnapshot(externalId);
    const title = state[STATE.NOW_PLAYING_TITLE] ?? '';
    const artist = state[STATE.NOW_PLAYING_ARTIST] ?? '';
    const track = `${title}\u0000${artist}`;
    const seenBefore = lastTrack.has(externalId);
    if (!title || lastTrack.get(externalId) === track) {
      return;
    }
    lastTrack.set(externalId, track);
    if (!seenBefore) {
      return; // The first track seen is the baseline, not a change.
    }
    fire(SCENE_TRIGGER.TRACK_CHANGED, {
      avr: externalId,
      title: cap(title),
      artist: cap(artist),
      album: cap(state[STATE.NOW_PLAYING_ALBUM]),
      source: state[FEATURE.SOURCE] ?? null,
    });
  }

  const unsubscribe = onDeviceStateChange((externalId, key, value, previous) => {
    if (key === FEATURE.SOURCE) {
      if (previous === undefined || value === previous) {
        return;
      }
      const overrides = getConfig().sourceOverrides ?? {};
      fire(SCENE_TRIGGER.SOURCE_CHANGED, {
        avr: externalId,
        source: value,
        source_label: cap(plainLabel(sourceLabel(value, overrides))),
        previous_source: previous,
        previous_source_label: cap(plainLabel(sourceLabel(previous, overrides))),
      });
      return;
    }
    if (key === STATE.NOW_PLAYING_TITLE || key === STATE.NOW_PLAYING_ARTIST) {
      clearTimeout(trackTimers.get(externalId));
      trackTimers.set(
        externalId,
        setTimeout(() => fireTrack(externalId), trackDebounceMs),
      );
    }
  });

  return function stop() {
    unsubscribe();
    for (const timer of trackTimers.values()) {
      clearTimeout(timer);
    }
    trackTimers.clear();
  };
}
