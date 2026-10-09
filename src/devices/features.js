// -----------------------------------------------------------------------------
// What a Denon/Marantz AVR device IS for Gladys: its feature keys, the
// widget-only state keys, and the discovery payload (buildFeatures()).
//
// Pure declarations — no socket, no shared state. The sessions live in
// ./session.js, the shared state in ./registry.js, the command dispatch in
// ./commands.js (see ./avr.js for the map of the whole folder).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  buildCursorUpCommand,
  buildCursorDownCommand,
  buildCursorLeftCommand,
  buildCursorRightCommand,
  buildEnterCommand,
  buildReturnCommand,
  buildInfoCommand,
  buildVolumeUpCommand,
  buildVolumeDownCommand,
  SOURCE_CODES,
  SOUND_MODE_CODES,
} from '../denon/protocol.js';

export const DEVICE_TYPE = 'avr';

export const FEATURE = {
  POWER: 'power',
  VOLUME: 'volume',
  MUTE: 'mute',
  SOURCE: 'source',
  SOURCE_INDEX: 'source_index',
  SOUND_MODE: 'sound_mode',
  CURSOR_UP: 'cursor_up',
  CURSOR_DOWN: 'cursor_down',
  CURSOR_LEFT: 'cursor_left',
  CURSOR_RIGHT: 'cursor_right',
  ENTER: 'enter',
  RETURN: 'return',
  INFO: 'info',
  MENU: 'menu',
  VOLUME_UP: 'volume_up',
  VOLUME_DOWN: 'volume_down',
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  PLAYBACK_STATE: 'playback_state',
  NOW_PLAYING: 'now_playing',
  PLAY_NOTIFICATION: 'play_notification',
  AD_BREAK: 'ad_break',
  // The former "Mark ad break" push button (dev builds only), still
  // honored until the device is updated: the AD_BREAK switch replaces it.
  AD_BREAK_MARK: 'ad_break_mark',
};

// Own state keys (never published directly, only combined into
// FEATURE.NOW_PLAYING — see connectDevice()'s onLine below), kept out of
// FEATURE so featureExternalId()/onSetValue never treat them as a feature.
const NOW_PLAYING_TITLE = 'now_playing_title';
const NOW_PLAYING_ARTIST = 'now_playing_artist';

// Read by the dashboard widgets only (src/widgets/, through
// getDeviceSnapshot()), never published as device features: the album and
// cover art of the HEOS track, and the receiver's Quick Select and analog
// tuner status (parseLine() in ../denon/protocol.js). Declaring them as
// features would make every existing device need a Discovery "Update" for
// data no generic Gladys control can use anyway.
export const STATE = {
  NOW_PLAYING_TITLE,
  NOW_PLAYING_ARTIST,
  NOW_PLAYING_ALBUM: 'now_playing_album',
  NOW_PLAYING_IMAGE_URL: 'now_playing_image_url',
  QUICK_SELECT: 'quick_select',
  TUNER_FREQUENCY: 'tuner_frequency',
  TUNER_PRESET: 'tuner_preset',
  TUNER_BAND: 'tuner_band',
  TUNER_MODE: 'tuner_mode',
};
export const STATE_ONLY_KEYS = new Set([
  STATE.QUICK_SELECT,
  STATE.TUNER_FREQUENCY,
  STATE.TUNER_PRESET,
  STATE.TUNER_BAND,
  STATE.TUNER_MODE,
]);

// The receiver's input for the analog tuner: TF/TP/TM commands only act
// while it is selected (Denon's protocol), see sendTunerCommand().
export const TUNER_SOURCE_CODE = 'TUNER';

// The receiver's own input that routes HEOS playback (HEOS Music) — the one a
// "Speak on a speaker" announcement needs selected on the configured zone.
export const HEOS_SOURCE_CODE = 'NET';

export function featureExternalId(deviceExternalId, key) {
  return `${deviceExternalId}:${key}`;
}

export function ipAddressOf(device) {
  return (device.params ?? []).find((p) => p.name === 'IP_ADDRESS')?.value;
}

/**
 * SOURCE_CODES filtered down to the entries `source_overrides` doesn't hide,
 * in the same order the Source dropdown (and FEATURE.SOURCE_INDEX below)
 * present them — the single source of truth both features are built from,
 * so they can never disagree on what index N means.
 */
export function visibleSourceCodes(sourceOverrides = {}) {
  return SOURCE_CODES.filter((code) => sourceOverrides[code.value] !== '');
}

/**
 * The label a user sees for one input: their `source_overrides` rename, else
 * the protocol's own bilingual name, else the raw SI code.
 * @returns {string | { en: string, fr: string }}
 */
export function sourceLabel(code, sourceOverrides = {}) {
  if (sourceOverrides[code]) {
    return sourceOverrides[code];
  }
  return SOURCE_CODES.find((source) => source.value === code)?.label ?? code;
}

/** The bilingual name of one sound mode, else its raw MS code. */
export function soundModeLabel(mode) {
  return SOUND_MODE_CODES.find((entry) => entry.value === mode)?.label ?? mode;
}

/**
 * Setup-menu remote-control keys: one-shot buttons (no target value to set,
 * same as the NS9x transport buttons below), declared under DEVICE_FEATURE_
 * CATEGORIES.TELEVISION with one of the SDK's TELEVISION "push button"
 * types (front/src/utils/consts.js#isPushButtonFeature in Gladys core) —
 * unlike MUSIC, that category renders its buttons directly in the plain
 * device list, no dashboard box required. Menu is deliberately NOT in this
 * table: unlike these, it is a real ON/OFF toggle (see FEATURE.MENU in
 * buildFeatures()/onSetValue() below), not a fire-and-forget key press.
 */
export const REMOTE_KEYS = [
  {
    feature: FEATURE.CURSOR_UP,
    name: 'Cursor up',
    type: DEVICE_FEATURE_TYPES.TELEVISION.UP,
    command: buildCursorUpCommand,
  },
  {
    feature: FEATURE.CURSOR_DOWN,
    name: 'Cursor down',
    type: DEVICE_FEATURE_TYPES.TELEVISION.DOWN,
    command: buildCursorDownCommand,
  },
  {
    feature: FEATURE.CURSOR_LEFT,
    name: 'Cursor left',
    type: DEVICE_FEATURE_TYPES.TELEVISION.LEFT,
    command: buildCursorLeftCommand,
  },
  {
    feature: FEATURE.CURSOR_RIGHT,
    name: 'Cursor right',
    type: DEVICE_FEATURE_TYPES.TELEVISION.RIGHT,
    command: buildCursorRightCommand,
  },
  {
    feature: FEATURE.ENTER,
    name: 'Enter',
    type: DEVICE_FEATURE_TYPES.TELEVISION.ENTER,
    command: buildEnterCommand,
  },
  {
    feature: FEATURE.RETURN,
    name: 'Return',
    type: DEVICE_FEATURE_TYPES.TELEVISION.RETURN,
    command: buildReturnCommand,
  },
  {
    feature: FEATURE.INFO,
    name: 'Info',
    type: DEVICE_FEATURE_TYPES.TELEVISION.INFO,
    command: buildInfoCommand,
  },
  {
    feature: FEATURE.VOLUME_UP,
    name: 'Volume up',
    type: DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_UP,
    command: buildVolumeUpCommand,
  },
  {
    feature: FEATURE.VOLUME_DOWN,
    name: 'Volume down',
    type: DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_DOWN,
    command: buildVolumeDownCommand,
  },
];

// O(1) command lookup for onSetValue(), keyed the same way REMOTE_KEYS.feature is.
export const REMOTE_KEY_COMMAND_BY_FEATURE = Object.fromEntries(
  REMOTE_KEYS.map((remoteKey) => [remoteKey.feature, remoteKey.command]),
);

export function buildFeatures(deviceExternalId, sourceOverrides = {}) {
  const visibleSources = visibleSourceCodes(sourceOverrides);
  return [
    {
      name: 'Power',
      external_id: featureExternalId(deviceExternalId, FEATURE.POWER),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type: DEVICE_FEATURE_TYPES.TELEVISION.BINARY,
      // min/max are NOT NULL in Gladys' database for every feature, binary
      // ones included — omitting them passes the store validator and CI
      // fine, then fails with a 422 ("max cannot be null") the moment a user
      // clicks "add" on a real Gladys instance. 0/1 is the binary range.
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Volume',
      external_id: featureExternalId(deviceExternalId, FEATURE.VOLUME),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type: DEVICE_FEATURE_TYPES.TELEVISION.VOLUME,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Mute',
      external_id: featureExternalId(deviceExternalId, FEATURE.MUTE),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type: DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_MUTE,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      // A dropdown of the receiver's own input codes (TEXT.SELECT), NOT the
      // generic TELEVISION.SOURCE type: that one is a one-shot remote-control
      // button in Gladys' front-end (same family as VOLUME_MUTE, no
      // meaningful value), so it could never represent a specific input —
      // only TEXT.SELECT actually renders a real select with our
      // supported_options. The value published/set is the verbatim SI code,
      // so it stays correct for inputs the static SOURCE_CODES list did not
      // anticipate. The `select_source` manifest action (see
      // gladys-assistant-integration.json) is kept as a second, equivalent
      // path — this dashboard control needs a fairly recent Gladys core
      // (TEXT.SELECT/supported_options); on an older one this feature type
      // may be rejected outright, so both routes existing matters, not just
      // redundancy.
      //
      // Also settable from a scene's generic "Control a device" action since
      // Gladys >=4.86.1 (see gladys_version in the manifest — 4.86.0 shipped
      // TEXT.SELECT but had a bug specific to externally-declared
      // supported_options, fixed the next day): the scene editor reads this
      // feature's own supported_options to show the same labeled dropdown,
      // and the server-side action explicitly exempts TEXT.SELECT from its
      // otherwise numbers-only value check. FEATURE.SOURCE_INDEX below is a
      // numeric alias of the same control for anyone on an older core, or
      // who just prefers a stable number in their scene.
      name: 'Source',
      external_id: featureExternalId(deviceExternalId, FEATURE.SOURCE),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      // sourceOverrides (config `source_overrides`, see src/config.js) lets
      // the user rename an entry (e.g. SAT/CBL is actually a Chromecast) or
      // hide one entirely — an empty-string override. `value` never
      // changes: it's still the real SI code the receiver understands,
      // only the dropdown's `label` is user-facing.
      supported_options: visibleSources.map((code) => ({
        value: code.value,
        label: sourceOverrides[code.value] || code.value,
      })),
      // Placeholder range: min/max are NOT NULL for every feature even when
      // they carry no real meaning for a select value (see the Power
      // feature above for why this must never be omitted).
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
    },
    {
      // Numeric alias of Source: a scene's generic "Control a device"
      // action can already set Source directly as of Gladys >=4.86.1 (see
      // the comment above it), but this gives a plain integer for an older
      // core, or for anyone who'd rather not depend on that. Index N is the
      // Nth entry of the *visible* dropdown above (source_overrides-hidden
      // entries excluded, same order) — 0 is the first one. Hiding/showing
      // an entry renumbers everything after it, exactly like the dropdown
      // itself; the current index for the active source is also reported by
      // the "Test connection" action so it can be read off without guessing.
      name: 'Source index',
      external_id: featureExternalId(deviceExternalId, FEATURE.SOURCE_INDEX),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      min: 0,
      max: Math.max(0, visibleSources.length - 1),
      read_only: false,
      has_feedback: true,
    },
    {
      // Same TEXT.SELECT mechanism as Source, own supported_options list.
      // Confidence note: the mode list itself (SOUND_MODE_CODES) is the
      // least certain part of this integration — see the comment above it
      // in src/denon/protocol.js.
      name: 'Sound mode',
      external_id: featureExternalId(deviceExternalId, FEATURE.SOUND_MODE),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      supported_options: SOUND_MODE_CODES.map((mode) => ({ value: mode.value, label: mode.value })),
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
    },
    ...REMOTE_KEYS.map(({ feature, name, type }) => ({
      name,
      external_id: featureExternalId(deviceExternalId, feature),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
    })),
    {
      // The only remote-control key that's a real toggle rather than a
      // fire-and-forget press: connectDevice()'s onLine handler publishes
      // its actual state from the receiver's own MNMEN push (protocol.js),
      // and onSetValue() reads that back to decide open vs close — same
      // toggle pattern as Mute above, for the same reason (a single button
      // press is not itself a target state).
      name: 'Menu',
      external_id: featureExternalId(deviceExternalId, FEATURE.MENU),
      category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
      type: DEVICE_FEATURE_TYPES.TELEVISION.MENU,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: false,
    },
    {
      // Network/USB transport buttons (NS9x, see protocol.js) — one-shot
      // presses, meaningful only while playing a NET/USB/streaming source
      // (Qobuz, Spotify Connect via HEOS...): pressing them on a source
      // that isn't playing is a harmless no-op on the receiver's end.
      name: 'Play',
      external_id: featureExternalId(deviceExternalId, FEATURE.PLAY),
      category: DEVICE_FEATURE_CATEGORIES.MUSIC,
      type: DEVICE_FEATURE_TYPES.MUSIC.PLAY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
    },
    {
      name: 'Pause',
      external_id: featureExternalId(deviceExternalId, FEATURE.PAUSE),
      category: DEVICE_FEATURE_CATEGORIES.MUSIC,
      type: DEVICE_FEATURE_TYPES.MUSIC.PAUSE,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
    },
    {
      name: 'Previous',
      external_id: featureExternalId(deviceExternalId, FEATURE.PREVIOUS),
      category: DEVICE_FEATURE_CATEGORIES.MUSIC,
      type: DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
    },
    {
      name: 'Next',
      external_id: featureExternalId(deviceExternalId, FEATURE.NEXT),
      category: DEVICE_FEATURE_CATEGORIES.MUSIC,
      type: DEVICE_FEATURE_TYPES.MUSIC.NEXT,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
    },
    {
      // Required, not optional: Gladys' "Music" dashboard box (the one with
      // the actual play/pause/skip button row, as opposed to the plain
      // device list — MUSIC isn't a generically-rendered category there)
      // reads this feature unconditionally when it loads the device. With
      // no PLAYBACK_STATE feature at all, that lookup is undefined and the
      // box's own state ends up never populated: Play renders but silently
      // does nothing when clicked, Previous/Next don't render at all. No
      // separate Telnet "paused" signal exists, so anything other than the
      // receiver's own "Now Playing ..." banner (see NSE0 in protocol.js)
      // maps to PAUSED — matches MUSIC_PLAYBACK_STATE's two values.
      name: 'Playback state',
      external_id: featureExternalId(deviceExternalId, FEATURE.PLAYBACK_STATE),
      category: DEVICE_FEATURE_CATEGORIES.MUSIC,
      type: DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
    },
    {
      // Read-only, composed as "Artist - Title" from the NSE1/NSE2 lines
      // the receiver pushes while playing a NET/USB/streaming source. Empty
      // (never published) until playback actually starts, and there is no
      // query for it — like the transport buttons above, this only ever
      // updates from the receiver's own pushes.
      name: 'Now playing',
      external_id: featureExternalId(deviceExternalId, FEATURE.NOW_PLAYING),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
    },
    {
      // Backs Gladys' generic "Speak on a speaker" scene action
      // (device_feature_category MUSIC + device_feature_type
      // PLAY_NOTIFICATION is exactly what that action's device picker
      // filters on — see PlayNotification.jsx in Gladys core's front-end).
      // The value Gladys sends is a ready-made TTS audio file URL (it calls
      // its own gateway to render the text first); onSetValue() below plays
      // it via HEOS's browse/play_stream, the same mechanism TuneIn/direct
      // URL playback uses, so this only works once a HEOS pid is matched
      // (see the HEOS-routing comment on FEATURE.PLAY/PAUSE/NEXT/PREVIOUS
      // in onSetValue()) — a non-HEOS model, or one with the HEOS CLI
      // unreachable, cannot be made to speak an arbitrary URL at all: there
      // is no legacy Telnet equivalent to fall back to, unlike the
      // transport buttons.
      //
      // No volume control here even though the scene action's UI always
      // asks for one: external (Docker-based) integrations never receive
      // it at all — Gladys core's proxy service for external integrations
      // (server/lib/external-integration/externalIntegration.registerProxyService.js)
      // forwards device.setValue's `value` only, dropping `options`
      // entirely, unlike the volume argument built-in services (Sonos,
      // Google Cast, AirPlay) get from being called in-process. The
      // announcement plays at the receiver's current volume.
      name: 'Play notification',
      external_id: featureExternalId(deviceExternalId, FEATURE.PLAY_NOTIFICATION),
      category: DEVICE_FEATURE_CATEGORIES.MUSIC,
      type: DEVICE_FEATURE_TYPES.MUSIC.PLAY_NOTIFICATION,
      min: 1,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
    },
    {
      // Radio ad-break detection, see src/adbreak/. On while the station
      // currently playing is (very likely) airing ads — learned per
      // station, see src/adbreak/stats.js — so a scene can react to it;
      // the integration itself lowers the volume meanwhile unless
      // ad_break_auto_duck is switched off in the configuration.
      //
      // Also a control: switching it on says "it's an ad" (teaches the ad
      // schedule of a station with no song metadata at all, the host talk
      // before the ads, and the jingles), switching it off ends the break.
      // A switch rather than a separate push button: Gladys names a feature
      // by its own name only when the device has another of the same type
      // (Power is binary too), a lone button showed as the bare "Push
      // button".
      name: 'Radio ad break',
      external_id: featureExternalId(deviceExternalId, FEATURE.AD_BREAK),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
    },
  ];
}

/** Build the discovery payload for one SSDP-discovered receiver. */
export function buildDiscoveredDevice(gladys, discovered, sourceOverrides = {}) {
  const ids = gladys.externalIds(DEVICE_TYPE, discovered.udn);
  const name = discovered.modelName
    ? `${discovered.friendlyName} (${discovered.modelName})`
    : discovered.friendlyName;
  return {
    name,
    external_id: ids.device,
    params: [{ name: 'IP_ADDRESS', value: discovered.host }],
    features: buildFeatures(ids.device, sourceOverrides),
  };
}

/** Build the discovery payload for a manually-configured host (SSDP fallback). */
export function buildManualDevice(gladys, host, sourceOverrides = {}) {
  const ids = gladys.externalIds(DEVICE_TYPE, `manual:${host}`);
  return {
    name: `Denon/Marantz AVR (${host})`,
    external_id: ids.device,
    params: [{ name: 'IP_ADDRESS', value: host }],
    features: buildFeatures(ids.device, sourceOverrides),
  };
}
