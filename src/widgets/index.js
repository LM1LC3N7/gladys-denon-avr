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
  adBreakInsights,
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
import { adBreaksContent } from './ad-breaks.js';
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
// A "Radio" widget showing the ad breaks also follows these.
WATCHED_KEYS[WIDGET.RADIO].push(FEATURE.AD_BREAK, FEATURE.PLAYBACK_STATE, STATE.NOW_PLAYING_TITLE);

export const WIDGETS_BY_STATE_KEY = Object.entries(WATCHED_KEYS).reduce((byKey, [widget, keys]) => {
  for (const key of keys) {
    (byKey[key] ??= []).push(widget);
  }
  return byKey;
}, {});

// Forum topic 10722, post 39: every nudge costs one content pull per open
// widget instance, out of the core's 30 pulls a minute per integration —
// the same budget the re-pull after each widget tap draws from. So a widget
// is nudged only for a device it showed in a pull since the module started
// (a Denon Home playing does not re-pull the PM7000N's Amplifier widget).
// The core drops its cache when the integration stops; a widget not pulled
// within this long after the start may still be cached by a core that saw
// no stop (a crash), so until then it is nudged for every device as before.
const NUDGE_EVERY_DEVICE_AFTER_START_MS = 5 * 60_000;

/**
 * Which devices each widget showed: `note()` on every pull, `shows()` before
 * a nudge. An instance without a picked receiver follows the first session
 * (resolveView), so it is nudged for that one and for any reachability change.
 */
export function createShownDevices({
  now = () => performance.now(),
  firstSession = () => sessionIds()[0],
} = {}) {
  const startedAt = now();
  const shown = new Map(); // widget key -> { ids: Set<externalId>, followsDefault }
  return {
    note(widget, settings) {
      const entry = shown.get(widget) ?? { ids: new Set(), followsDefault: false };
      shown.set(widget, entry);
      const picked = typeof settings?.avr === 'string' ? settings.avr.trim() : '';
      if (picked) {
        entry.ids.add(picked);
      } else {
        entry.followsDefault = true;
      }
    },
    shows(widget, externalId, stateKey) {
      const entry = shown.get(widget);
      if (!entry) {
        return now() - startedAt < NUDGE_EVERY_DEVICE_AFTER_START_MS;
      }
      if (entry.ids.has(externalId)) {
        return true;
      }
      return entry.followsDefault && (stateKey === 'connection' || externalId === firstSession());
    },
  };
}

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
      return settings?.show === 'ad_breaks'
        ? adBreaksContent(view, await adBreakInsights(view.externalId))
        : radioContent(view, settings);
    default:
      throw new Error(`Unknown widget "${key}"`);
  }
}

/**
 * Register every widget handler on the SDK. `getConfig()` returns the live,
 * normalized config. Returns `stop()` (graceful shutdown).
 */
export function registerWidgets(
  gladys,
  getConfig,
  { artwork = createArtworkCache(), shown = createShownDevices(), refresherOptions } = {},
) {
  for (const key of Object.values(WIDGET)) {
    gladys.onWidgetGet(key, ({ settings }) => {
      shown.note(key, settings);
      return buildWidgetContent(key, settings, getConfig(), { artwork });
    });
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

  const refresher = createRefresher((key) => gladys.requestWidgetRefresh(key), refresherOptions);
  const unsubscribe = onDeviceStateChange((externalId, stateKey, value) => {
    for (const widget of WIDGETS_BY_STATE_KEY[stateKey] ?? []) {
      if (shown.shows(widget, externalId, stateKey)) {
        refresher.request(widget);
      }
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
