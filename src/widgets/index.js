// -----------------------------------------------------------------------------
// Dashboard widgets: registers the SDK handlers (before connect()) and nudges
// Gladys to re-pull a widget when the state it shows changed.
//
// Each widget instance shows the receiver picked in its `avr` setting (a
// `source: "devices"` select whose value is the device external_id), else
// the first receiver with an open session. Gladys pulls the content
// (onWidgetGet, cached core-side per settings and language), fetches the
// declared images (onWidgetGetImage) and relays button taps
// (onWidgetAction); the live volume tiles follow the device feature with no
// nudge at all.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  FEATURE,
  STATE,
  getDeviceSnapshot,
  onDeviceStateChange,
  sessionIds,
} from '../devices/avr.js';
import { WIDGET, emptyContent } from './common.js';
import {
  amplifierContent,
  nowPlayingContent,
  radioContent,
  remoteContent,
  shortcutsContent,
} from './content.js';
import { runWidgetAction } from './actions.js';
import { createArtworkCache } from './artwork.js';
import { createRefresher } from './refresh.js';

const logger = createLogger({ name: 'widgets' });

// Which state keys each widget shows — a change re-pulls only those
// widgets. 'connection' is the transport badge moving (reachability).
const WATCHED_KEYS = {
  [WIDGET.NOW_PLAYING]: [
    FEATURE.POWER,
    FEATURE.SOURCE,
    FEATURE.SOUND_MODE,
    FEATURE.MUTE,
    FEATURE.PLAYBACK_STATE,
    STATE.NOW_PLAYING_TITLE,
    STATE.NOW_PLAYING_ARTIST,
    STATE.NOW_PLAYING_ALBUM,
    STATE.NOW_PLAYING_IMAGE_URL,
    'connection',
  ],
  [WIDGET.SHORTCUTS]: [FEATURE.SOURCE, FEATURE.SOUND_MODE, STATE.QUICK_SELECT, 'connection'],
  [WIDGET.AMPLIFIER]: [
    FEATURE.POWER,
    FEATURE.SOURCE,
    FEATURE.SOUND_MODE,
    FEATURE.MUTE,
    'connection',
  ],
  [WIDGET.REMOTE]: [FEATURE.MENU, 'connection'],
  [WIDGET.RADIO]: [
    FEATURE.POWER,
    FEATURE.SOURCE,
    STATE.TUNER_FREQUENCY,
    STATE.TUNER_PRESET,
    STATE.TUNER_BAND,
    STATE.TUNER_MODE,
    'connection',
  ],
};

export const WIDGETS_BY_STATE_KEY = Object.entries(WATCHED_KEYS).reduce((byKey, [widget, keys]) => {
  for (const key of keys) {
    (byKey[key] ??= []).push(widget);
  }
  return byKey;
}, {});

// Longest wait for a cover download inside onWidgetGet (Gladys awaits 15 s).
const ARTWORK_WAIT_MS = 5_000;

/**
 * What a widget shows: the receiver picked in its settings, else the first
 * one — `{ view }`, or `{ reason }` ('none' | 'unknown') when there is none.
 */
export function resolveView(settings, config) {
  const picked = typeof settings?.avr === 'string' ? settings.avr.trim() : '';
  const externalId = picked || sessionIds()[0];
  if (!externalId) {
    return { reason: 'none' };
  }
  const snapshot = getDeviceSnapshot(externalId);
  if (!snapshot.known) {
    return { reason: picked ? 'unknown' : 'none' };
  }
  return { view: { ...snapshot, sourceOverrides: config.sourceOverrides ?? {} } };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The content of one widget instance (async: the cover may be downloaded). */
export async function buildWidgetContent(key, settings, config, { artwork }) {
  const { view, reason } = resolveView(settings, config);
  if (!view) {
    return emptyContent(reason);
  }
  switch (key) {
    case WIDGET.NOW_PLAYING: {
      const url = view.state[STATE.NOW_PLAYING_IMAGE_URL];
      const artworkKey = url ? await withTimeout(artwork.prepare(url), ARTWORK_WAIT_MS) : null;
      return nowPlayingContent(view, artworkKey);
    }
    case WIDGET.SHORTCUTS:
      return shortcutsContent(view, settings);
    case WIDGET.AMPLIFIER:
      return amplifierContent(view);
    case WIDGET.REMOTE:
      return remoteContent(view, settings);
    case WIDGET.RADIO:
      return radioContent(view, settings);
    default:
      throw new Error(`Unknown widget "${key}"`);
  }
}

/**
 * Register every widget handler on the SDK. `getConfig()` returns the live,
 * normalized config. Returns `stop()` (graceful shutdown).
 */
export function registerWidgets(gladys, getConfig, { artwork = createArtworkCache() } = {}) {
  for (const key of Object.values(WIDGET)) {
    gladys.onWidgetGet(key, ({ settings }) =>
      buildWidgetContent(key, settings, getConfig(), { artwork }),
    );
    gladys.onWidgetAction(key, (actionKey, params) =>
      runWidgetAction(gladys, actionKey, params, getConfig()),
    );
  }
  gladys.onWidgetGetImage(async (imageKey) => {
    const image = artwork.get(imageKey);
    if (!image) {
      throw new Error(`Unknown image "${imageKey}"`);
    }
    return image;
  });

  const refresher = createRefresher((key) => gladys.requestWidgetRefresh(key));
  const unsubscribe = onDeviceStateChange((externalId, stateKey, value) => {
    for (const widget of WIDGETS_BY_STATE_KEY[stateKey] ?? []) {
      refresher.request(widget);
    }
    // Download the new cover ahead of the pull the nudge above triggers.
    if (stateKey === STATE.NOW_PLAYING_IMAGE_URL && value) {
      artwork.prepare(value).catch((err) => logger.debug(err.message));
    }
  });

  return function stop() {
    unsubscribe();
    refresher.stop();
  };
}
