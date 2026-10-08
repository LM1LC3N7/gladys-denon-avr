// -----------------------------------------------------------------------------
// The content of each dashboard widget — pure functions of a "view" (what
// the integration knows of one receiver, see ./index.js#viewOf()) and the
// widget instance's settings. Every button is a widget action carrying the
// receiver's external_id (`params.avr`); ./actions.js maps it back to a
// command and refuses anything it did not declare.
//
//   A now_playing  artwork, title, artist/station, input, sound mode, live
//                  volume; ⏮ ⏯ ⏭ and mute — what the core "Music" box
//                  cannot show (no title, no artwork, and no volume for an
//                  AVR, whose volume is a TELEVISION feature);
//   B shortcuts    4 one-tap targets: inputs, Quick Selects, HEOS favorites;
//   C amplifier    power, input, sound mode, mute at a glance, live volume;
//                  power, vol −/+ and mute;
//   D remote       4 remote keys of the user's choice (arrows by default) —
//                  several instances side by side make a full pad;
//   E radio        the analog tuner: frequency, preset, band, tuning mode.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { describeTunerFrequency } from '../denon/protocol.js';
import { FEATURE, STATE, TUNER_SOURCE_CODE, sourceLabel } from '../devices/avr.js';
import {
  CURRENT_ICON,
  RADIO_BUTTONS,
  RADIO_DEFAULTS,
  REMOTE_BUTTONS,
  REMOTE_DEFAULTS,
  SHORTCUT_DEFAULTS,
  SHORTCUT_TARGETS,
  TEXTS,
  WIDGET,
  WIDGET_TTL_SECONDS,
  actionButton,
  chosenSlots,
  fit,
  heading,
  isReachable,
  powerStatus,
  sourceAndModeItems,
  volumeTile,
} from './common.js';

function paramsOf(view) {
  return { avr: view.externalId };
}

function muteButton(view) {
  const muted = view.state[FEATURE.MUTE] === 1;
  return actionButton(TEXTS.mute, 'mute', paramsOf(view), muted ? CURRENT_ICON : 'volume-x');
}

/** A — "Now playing". `artworkKey` is an image key ready to serve, or null. */
export function nowPlayingContent(view, artworkKey = null) {
  const { state } = view;
  const title = state[STATE.NOW_PLAYING_TITLE];
  const artist = state[STATE.NOW_PLAYING_ARTIST];
  const album = state[STATE.NOW_PLAYING_ALBUM];
  const playing = state[FEATURE.PLAYBACK_STATE] === 1;

  const components = [heading(title || view.name), volumeTile(view)];
  if (artworkKey) {
    components.push({
      type: 'image',
      key: artworkKey,
      alt: fit(title || TEXTS.nothingPlaying, 100),
      fit: 'contain',
    });
  }

  const items = [];
  if (!isReachable(view)) {
    items.push(powerStatus(view));
  }
  if (title) {
    if (artist) {
      items.push({ label: TEXTS.artist, value: fit(artist, 40) });
    }
    if (album) {
      items.push({ label: TEXTS.album, value: fit(album, 40) });
    }
  } else {
    items.push({ label: TEXTS.playback, value: TEXTS.nothingPlaying });
  }
  items.push(...sourceAndModeItems(view));
  components.push({ type: 'status', items });

  const params = paramsOf(view);
  components.push(
    actionButton(TEXTS.previous, 'previous', params, 'skip-back'),
    playing
      ? actionButton(TEXTS.pause, 'pause', params, 'pause')
      : actionButton(TEXTS.play, 'play', params, 'play'),
    actionButton(TEXTS.next, 'next', params, 'skip-forward'),
    muteButton(view),
  );
  return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.NOW_PLAYING], components };
}

/** Parse a shortcut target ("source:CD", "quick:2", "favorite:5"). */
export function parseShortcutTarget(target) {
  const match = /^(source|quick|favorite):(.+)$/.exec(String(target ?? ''));
  if (!match || !SHORTCUT_TARGETS.some((option) => option.value === target)) {
    return null;
  }
  return match[1] === 'source'
    ? { kind: 'source', code: match[2] }
    : { kind: match[1], number: Number(match[2]) };
}

function shortcutLabel(target, view, customLabel) {
  if (typeof customLabel === 'string' && customLabel.trim()) {
    return customLabel.trim();
  }
  if (target.kind === 'source') {
    return sourceLabel(target.code, view.sourceOverrides);
  }
  return target.kind === 'quick'
    ? { en: `Quick Select ${target.number}`, fr: `Quick Select ${target.number}` }
    : { en: `Favorite ${target.number}`, fr: `Favori ${target.number}` };
}

function isActiveShortcut(target, state) {
  if (target.kind === 'source') {
    return state[FEATURE.SOURCE] === target.code;
  }
  return target.kind === 'quick' && state[STATE.QUICK_SELECT] === target.number;
}

const SHORTCUT_ICONS = { source: 'log-in', quick: 'zap', favorite: 'star' };

/** B — "Shortcuts": 4 targets chosen in the settings, the active one ticked. */
export function shortcutsContent(view, settings = {}) {
  const { state } = view;
  const components = [heading(view.name)];
  const items = isReachable(view) ? [] : [powerStatus(view)];
  items.push(...sourceAndModeItems(view).slice(0, 1));
  const quick = state[STATE.QUICK_SELECT];
  if (quick !== undefined) {
    items.push({ label: TEXTS.quickSelect, value: quick > 0 ? quick : TEXTS.none });
  }
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  for (const { value, slot } of chosenSlots(
    settings,
    'slot',
    SHORTCUT_TARGETS,
    SHORTCUT_DEFAULTS,
  )) {
    const target = parseShortcutTarget(value);
    components.push(
      actionButton(
        shortcutLabel(target, view, settings[`label_${slot}`]),
        `slot_${slot}`,
        { ...paramsOf(view), target: value },
        isActiveShortcut(target, state) ? CURRENT_ICON : SHORTCUT_ICONS[target.kind],
      ),
    );
  }
  return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.SHORTCUTS], components };
}

/** C — "Amplifier": the daily remote and its state at a glance. */
export function amplifierContent(view) {
  const on = view.state[FEATURE.POWER] === 1;
  const items = [powerStatus(view), ...sourceAndModeItems(view)];
  if (view.state[FEATURE.MUTE] !== undefined) {
    items.push({
      label: TEXTS.mute,
      value: view.state[FEATURE.MUTE] === 1 ? TEXTS.yes : TEXTS.no,
    });
  }
  const params = paramsOf(view);
  return {
    version: 1,
    ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.AMPLIFIER],
    components: [
      heading(view.name),
      volumeTile(view),
      { type: 'status', items },
      on
        ? actionButton(TEXTS.turnOff, 'power_off', params, 'power')
        : actionButton(TEXTS.turnOn, 'power_on', params, 'power'),
      actionButton(TEXTS.volumeDown, 'volume_down', params, 'volume-1'),
      actionButton(TEXTS.volumeUp, 'volume_up', params, 'volume-2'),
      muteButton(view),
    ],
  };
}

/** D — "Remote": 4 keys chosen in the settings (the arrows by default). */
export function remoteContent(view, settings = {}) {
  const components = [heading(view.name)];
  if (!isReachable(view)) {
    components.push({ type: 'status', items: [powerStatus(view)] });
  } else if (view.state.menu === 1) {
    components.push({ type: 'text', variant: 'caption', text: fit(TEXTS.menuOpen, 80) });
  }
  for (const { value } of chosenSlots(settings, 'key', REMOTE_BUTTONS, REMOTE_DEFAULTS)) {
    const key = REMOTE_BUTTONS.find((button) => button.value === value);
    components.push(actionButton(key.label, key.value, paramsOf(view), key.icon));
  }
  return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.REMOTE], components };
}

/** E — "Radio": the analog tuner (frequency, preset, band, tuning mode). */
export function radioContent(view, settings = {}) {
  const { state } = view;
  const components = [heading(view.name)];
  const frequency = describeTunerFrequency(state[STATE.TUNER_FREQUENCY]);
  components.push(
    frequency
      ? { type: 'value', label: TEXTS.frequency, value: frequency.value, unit: frequency.unit }
      : { type: 'value', label: TEXTS.frequency, value: '—' },
  );
  const preset = state[STATE.TUNER_PRESET];
  components.push({
    type: 'value',
    label: TEXTS.preset,
    value: Number.isInteger(preset) && preset > 0 ? preset : '—',
  });

  const items = isReachable(view) ? [] : [powerStatus(view)];
  const band = state[STATE.TUNER_BAND] ?? frequency?.band;
  if (band) {
    items.push({ label: TEXTS.band, value: band });
  }
  const mode = state[STATE.TUNER_MODE];
  if (mode) {
    items.push({ label: TEXTS.tuningMode, value: mode === 'AUTO' ? TEXTS.auto : TEXTS.manual });
  }
  items.push(
    state[FEATURE.SOURCE] === TUNER_SOURCE_CODE && state[FEATURE.POWER] === 1
      ? { label: TEXTS.source, value: TEXTS.tunerSelected, color: WIDGET_COLORS.SUCCESS }
      : { label: TEXTS.source, value: TEXTS.tunerNotSelected, color: WIDGET_COLORS.WARNING },
  );
  components.push({ type: 'status', items });

  for (const { value } of chosenSlots(settings, 'button', RADIO_BUTTONS, RADIO_DEFAULTS)) {
    const button = RADIO_BUTTONS.find((entry) => entry.value === value);
    components.push(actionButton(button.label, button.value, paramsOf(view), button.icon));
  }
  return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.RADIO], components };
}
