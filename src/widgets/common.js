// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys >= 5.1.0) — shared vocabulary of the content
// builders: widget keys, bilingual texts, setting options, bounded texts.
//
// What Gladys renders (SDK lib/widget-content.js, spec
// docs/specs/external-integrations/capabilities/dashboard-widgets.md): at
// most 8 components per card, 1 focal (image), 6 tiles, 2 texts, 1 status
// list, 4 buttons in one row — no slider, no dropdown. Hence one widget per
// job, several instances side by side when a user wants more keys, and the
// standard controls (the volume slider, the input dropdown) left to the core
// widgets that already render the device features.
//
// A current choice is marked by its icon (`check-circle`), never by the
// `primary` style: in dark mode Gladys paints a primary button like the
// others (field feedback from the Android TV Remote integration).
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { SOURCE_CODES } from '../denon/protocol.js';
import { FEATURE, sourceLabel, soundModeLabel } from '../devices/avr.js';

/** Widget keys, declared in the manifest `widgets` (forever: never rename). */
export const WIDGET = Object.freeze({
  NOW_PLAYING: 'now_playing',
  SHORTCUTS: 'shortcuts',
  AMPLIFIER: 'amplifier',
  REMOTE: 'remote',
  RADIO: 'radio',
});

/** Freshness of each content, in seconds (10-3600 for the core). */
export const WIDGET_TTL_SECONDS = Object.freeze({
  [WIDGET.NOW_PLAYING]: 30,
  [WIDGET.SHORTCUTS]: 60,
  [WIDGET.AMPLIFIER]: 60,
  [WIDGET.REMOTE]: 300,
  [WIDGET.RADIO]: 60,
  // Nothing to show yet: re-pull soon, a device may be added meanwhile.
  empty: 60,
});

export const CURRENT_ICON = 'check-circle';

// --- Setting options (also declared in the manifest, test/manifest.test.js) --

/** Shortcut targets: every input, the 5 Quick Selects, 8 HEOS favorites. */
export const SHORTCUT_TARGETS = Object.freeze([
  ...[1, 2, 3, 4, 5].map((n) => ({
    value: `quick:${n}`,
    label: { en: `Quick Select ${n}`, fr: `Quick Select ${n}` },
  })),
  ...SOURCE_CODES.map((source) => ({
    value: `source:${source.value}`,
    label: { en: `Input: ${source.label.en}`, fr: `Entrée : ${source.label.fr}` },
  })),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    value: `favorite:${n}`,
    label: { en: `HEOS favorite ${n}`, fr: `Favori HEOS ${n}` },
  })),
]);
export const SHORTCUT_DEFAULTS = Object.freeze(['quick:1', 'quick:2', 'quick:3', 'quick:4']);

/** Remote keys a "Remote" widget button may send, with their Feather icon. */
export const REMOTE_BUTTONS = Object.freeze([
  { value: 'up', label: { en: 'Up', fr: 'Haut' }, icon: 'chevron-up', feature: FEATURE.CURSOR_UP },
  {
    value: 'down',
    label: { en: 'Down', fr: 'Bas' },
    icon: 'chevron-down',
    feature: FEATURE.CURSOR_DOWN,
  },
  {
    value: 'left',
    label: { en: 'Left', fr: 'Gauche' },
    icon: 'chevron-left',
    feature: FEATURE.CURSOR_LEFT,
  },
  {
    value: 'right',
    label: { en: 'Right', fr: 'Droite' },
    icon: 'chevron-right',
    feature: FEATURE.CURSOR_RIGHT,
  },
  { value: 'enter', label: { en: 'OK', fr: 'OK' }, icon: 'check', feature: FEATURE.ENTER },
  {
    value: 'return',
    label: { en: 'Back', fr: 'Retour' },
    icon: 'corner-up-left',
    feature: FEATURE.RETURN,
  },
  { value: 'menu', label: { en: 'Menu', fr: 'Menu' }, icon: 'menu', feature: FEATURE.MENU },
  { value: 'info', label: { en: 'Info', fr: 'Info' }, icon: 'info', feature: FEATURE.INFO },
  {
    value: 'volume_down',
    label: { en: 'Vol −', fr: 'Vol −' },
    icon: 'volume-1',
    feature: FEATURE.VOLUME_DOWN,
  },
  {
    value: 'volume_up',
    label: { en: 'Vol +', fr: 'Vol +' },
    icon: 'volume-2',
    feature: FEATURE.VOLUME_UP,
  },
  { value: 'mute', label: { en: 'Mute', fr: 'Sourdine' }, icon: 'volume-x', feature: FEATURE.MUTE },
  {
    value: 'power_on',
    label: { en: 'Turn on', fr: 'Allumer' },
    icon: 'power',
    feature: FEATURE.POWER,
    featureValue: 1,
  },
  {
    value: 'power_off',
    label: { en: 'Standby', fr: 'Veille' },
    icon: 'moon',
    feature: FEATURE.POWER,
    featureValue: 0,
  },
]);
export const REMOTE_DEFAULTS = Object.freeze(['up', 'down', 'left', 'right']);

/** Radio widget buttons (TUNER_COMMANDS keys, the two toggles, the input). */
export const RADIO_BUTTONS = Object.freeze([
  { value: 'frequency_down', label: { en: 'Freq −', fr: 'Fréq −' }, icon: 'chevrons-left' },
  { value: 'frequency_up', label: { en: 'Freq +', fr: 'Fréq +' }, icon: 'chevrons-right' },
  { value: 'preset_down', label: { en: 'Preset −', fr: 'Présél. −' }, icon: 'skip-back' },
  { value: 'preset_up', label: { en: 'Preset +', fr: 'Présél. +' }, icon: 'skip-forward' },
  { value: 'band_toggle', label: { en: 'AM / FM', fr: 'AM / FM' }, icon: 'repeat' },
  { value: 'mode_toggle', label: { en: 'Auto / Manual', fr: 'Auto / Manuel' }, icon: 'sliders' },
  { value: 'tuner', label: { en: 'Tuner input', fr: 'Entrée Tuner' }, icon: 'radio' },
]);
export const RADIO_DEFAULTS = Object.freeze([
  'frequency_down',
  'frequency_up',
  'preset_up',
  'band_toggle',
]);

/** Settings of the 4 buttons of a widget: `<prefix>_1` … `<prefix>_4`. */
export function slotKeys(prefix) {
  return [1, 2, 3, 4].map((n) => `${prefix}_${n}`);
}

/**
 * The 4 button values a widget instance asks for: each slot setting when it
 * names a known option, the default otherwise; duplicates dropped (Gladys
 * drops a button whose action key another one already uses).
 */
export function chosenSlots(settings, prefix, options, defaults) {
  const known = new Set(options.map((option) => option.value));
  const chosen = slotKeys(prefix).map((key, index) =>
    known.has(settings?.[key]) ? settings[key] : defaults[index],
  );
  return chosen
    .map((value, index) => ({ value, slot: index + 1 }))
    .filter((entry, index) => chosen.indexOf(entry.value) === index);
}

// --- Texts ------------------------------------------------------------------

export const TEXTS = {
  noAvr: {
    en: 'No receiver yet: add a Denon/Marantz AVR from the Discovery tab of the integration, then pick it here.',
    fr: "Aucun ampli pour l'instant : ajoutez un ampli Denon/Marantz depuis l'onglet Découverte de l'intégration, puis choisissez-le ici.",
  },
  unknownAvr: {
    en: 'The receiver picked in the settings of this widget is no longer added. Pick another one, or leave the field empty.',
    fr: "L'ampli choisi dans les réglages de ce widget n'est plus ajouté. Choisissez-en un autre, ou laissez le champ vide.",
  },
  power: { en: 'Power', fr: 'Alimentation' },
  on: { en: 'On', fr: 'Allumé' },
  standby: { en: 'Standby', fr: 'Veille' },
  unreachable: { en: 'Unreachable', fr: 'Injoignable' },
  unknown: { en: 'Unknown', fr: 'Inconnu' },
  volume: { en: 'Volume', fr: 'Volume' },
  mute: { en: 'Mute', fr: 'Sourdine' },
  yes: { en: 'Yes', fr: 'Oui' },
  no: { en: 'No', fr: 'Non' },
  source: { en: 'Input', fr: 'Entrée' },
  soundMode: { en: 'Sound mode', fr: 'Mode son' },
  quickSelect: { en: 'Quick Select', fr: 'Quick Select' },
  none: { en: 'None', fr: 'Aucun' },
  artist: { en: 'Artist', fr: 'Artiste' },
  album: { en: 'Album', fr: 'Album' },
  playback: { en: 'Playback', fr: 'Lecture' },
  playing: { en: 'Playing', fr: 'En lecture' },
  paused: { en: 'Paused or stopped', fr: 'En pause ou arrêtée' },
  nothingPlaying: { en: 'Nothing playing', fr: 'Rien en lecture' },
  turnOn: { en: 'Turn on', fr: 'Allumer' },
  turnOff: { en: 'Standby', fr: 'Veille' },
  volumeDown: { en: 'Vol −', fr: 'Vol −' },
  volumeUp: { en: 'Vol +', fr: 'Vol +' },
  previous: { en: 'Previous', fr: 'Précédent' },
  next: { en: 'Next', fr: 'Suivant' },
  play: { en: 'Play', fr: 'Lecture' },
  pause: { en: 'Pause', fr: 'Pause' },
  frequency: { en: 'Frequency', fr: 'Fréquence' },
  preset: { en: 'Preset', fr: 'Présélection' },
  band: { en: 'Band', fr: 'Bande' },
  tuningMode: { en: 'Tuning', fr: 'Accord' },
  auto: { en: 'Auto', fr: 'Auto' },
  manual: { en: 'Manual', fr: 'Manuel' },
  tunerSelected: { en: 'Tuner', fr: 'Tuner' },
  tunerNotSelected: {
    en: 'Other — a button selects the tuner',
    fr: 'Autre : un bouton choisit le tuner',
  },
  menuOpen: {
    en: 'The Setup menu is open on the TV screen',
    fr: "Le menu de configuration est ouvert sur l'écran de la TV",
  },
};

/** A text cut to a bound (the core would cut it too, and log it). */
export function fit(text, max) {
  if (text && typeof text === 'object') {
    return Object.fromEntries(Object.entries(text).map(([lang, value]) => [lang, fit(value, max)]));
  }
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

export function heading(text) {
  return { type: 'text', variant: 'heading', text: fit(text, 40) };
}

export function actionButton(label, key, params, icon) {
  return { type: 'button', label: fit(label, 24), icon, action: { key, params } };
}

/** A live volume tile, bound to the device's own Volume feature. */
export function volumeTile(view) {
  return {
    type: 'value',
    label: TEXTS.volume,
    device_feature: `${view.externalId}:${FEATURE.VOLUME}`,
  };
}

/** A widget with nothing to show but a sentence — never an error. */
export function emptyContent(reason) {
  return {
    version: 1,
    ttl_seconds: WIDGET_TTL_SECONDS.empty,
    components: [
      {
        type: 'text',
        variant: 'body',
        text: reason === 'unknown' ? TEXTS.unknownAvr : TEXTS.noAvr,
      },
    ],
  };
}

export function isReachable(view) {
  return view.telnetConnected || view.heosConnected;
}

/** The power row of a status list: on / standby / unreachable, colored. */
export function powerStatus(view) {
  if (!isReachable(view)) {
    return { label: TEXTS.power, value: TEXTS.unreachable, color: WIDGET_COLORS.WARNING };
  }
  if (view.state.power === 1) {
    return { label: TEXTS.power, value: TEXTS.on, color: WIDGET_COLORS.SUCCESS };
  }
  if (view.state.power === 0) {
    return { label: TEXTS.power, value: TEXTS.standby, color: WIDGET_COLORS.NEUTRAL };
  }
  return { label: TEXTS.power, value: TEXTS.unknown };
}

/** The current input of a view, as its user label (bounded), or null. */
export function sourceText(view) {
  const code = view.state[FEATURE.SOURCE];
  return code ? fit(sourceLabel(code, view.sourceOverrides), 40) : null;
}

/** The current sound mode of a view, as its label (bounded), or null. */
export function soundModeText(view) {
  const mode = view.state[FEATURE.SOUND_MODE];
  return mode ? fit(soundModeLabel(mode), 40) : null;
}

/** The status rows of the input and sound mode, when known. */
export function sourceAndModeItems(view) {
  const items = [];
  const source = sourceText(view);
  if (source) {
    items.push({ label: TEXTS.source, value: source });
  }
  const mode = soundModeText(view);
  if (mode) {
    items.push({ label: TEXTS.soundMode, value: mode });
  }
  return items;
}
