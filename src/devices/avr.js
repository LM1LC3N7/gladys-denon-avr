// -----------------------------------------------------------------------------
// Device type: Denon/Marantz AVR (receiver)
//
// Unlike the template's fixed demo devices, an AVR is discovered dynamically
// (SSDP, see src/denon/discovery.js) and there can be zero, one or several of
// them on the LAN. So instead of ONE static blueprint object, this module
// exposes:
//   - buildDiscoveredDevice() / buildManualDevice() to build discovery payloads
//   - a small connection registry (external_id -> Telnet client) driven by the
//     device lifecycle: connectDevice() on gladys.onDeviceCreated / at startup
//     (for devices the user already created), disconnectDevice() on
//     gladys.onDeviceDeleted
//   - onSetValue() / runTestConnectionAction() / runSelectSourceAction() that
//     look up the right connection from that registry
//
// The Telnet session is push-driven: the receiver sends a line for every
// state change, from ANY controller (this integration, the physical remote,
// the Denon app...). connectDevice() seeds the initial state with one round
// of queries, then every line is parsed and republished as it arrives.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createTelnetClient } from '../denon/telnet.js';
import {
  parseLine,
  buildPowerQuery,
  buildPowerCommand,
  buildVolumeQuery,
  buildVolumeCommand,
  buildMuteQuery,
  buildMuteCommand,
  buildSourceQuery,
  buildSourceCommand,
  buildSoundModeQuery,
  buildSoundModeCommand,
  buildPlayCommand,
  buildPauseCommand,
  buildNextCommand,
  buildPreviousCommand,
  buildCursorUpCommand,
  buildCursorDownCommand,
  buildCursorLeftCommand,
  buildCursorRightCommand,
  buildEnterCommand,
  buildReturnCommand,
  buildInfoCommand,
  buildMenuQuery,
  buildMenuCommand,
  buildVolumeUpCommand,
  buildVolumeDownCommand,
  SOURCE_CODES,
  SOUND_MODE_CODES,
} from '../denon/protocol.js';
import { createHeosClient } from '../heos/client.js';
import {
  buildGetPlayersCommand,
  buildGetPlayStateCommand,
  buildGetNowPlayingMediaCommand,
  buildPlayCommand as buildHeosPlayCommand,
  buildPauseCommand as buildHeosPauseCommand,
  buildPlayNextCommand as buildHeosPlayNextCommand,
  buildPlayPreviousCommand as buildHeosPlayPreviousCommand,
  buildPlayStreamCommand,
  buildRegisterForChangeEventsCommand,
  findPlayerIdByIp,
  heosPlayStateToPlaybackState,
  parseNowPlayingMedia,
  HEOS_EVENT,
} from '../heos/protocol.js';

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
};

// Own state keys (never published directly, only combined into
// FEATURE.NOW_PLAYING — see connectDevice()'s onLine below), kept out of
// FEATURE so featureExternalId()/onSetValue never treat them as a feature.
const NOW_PLAYING_TITLE = 'now_playing_title';
const NOW_PLAYING_ARTIST = 'now_playing_artist';

const CONNECTION_FAILURE_THRESHOLD = 3;

// How often to actively re-query HEOS for playback state + now-playing
// metadata while a player id is known, on top of reacting to its pushed
// events. HEOS CLI connections are known to drop silently when idle (the
// protocol has its own recommended heart_beat command for exactly this),
// and even when the socket itself survives, there's no guarantee every
// `event/player_*_changed` push actually reaches us — so treat the pushed
// events as the fast path and this poll as the self-healing fallback that
// guarantees eventual consistency either way, rather than trying to prove
// which failure mode is real. Real-hardware feedback: without this, the
// dashboard was observed stuck on "paused" indefinitely after playback
// actually started elsewhere (the Qobuz app), even though HEOS commands
// sent *from* Gladys (play/pause/next) worked fine.
const DEFAULT_HEOS_POLL_INTERVAL_MS = 30_000;
// `let`, not `const`: overridable by __setHeosPollIntervalMsForTesting() so
// tests can exercise the periodic-refresh behavior without a real 30s wait.
let HEOS_POLL_INTERVAL_MS = DEFAULT_HEOS_POLL_INTERVAL_MS;

const logger = createLogger({ name: DEVICE_TYPE });

// external_id -> Telnet client (one persistent session per AVR the user created).
const connections = new Map();
// external_id -> last known state, used by the "Test connection" action.
const lastKnownState = new Map();
// external_id -> { client, pid }. `pid` is null until a `get_players` reply
// matches our IP (or forever, on a non-HEOS model / unreachable HEOS CLI) —
// every caller must treat a missing/null pid as "fall back to legacy
// Telnet", never as an error. See connectDevice()/onSetValue() below.
const heosConnections = new Map();

export function featureExternalId(deviceExternalId, key) {
  return `${deviceExternalId}:${key}`;
}

function ipAddressOf(device) {
  return (device.params ?? []).find((p) => p.name === 'IP_ADDRESS')?.value;
}

/**
 * SOURCE_CODES filtered down to the entries `source_overrides` doesn't hide,
 * in the same order the Source dropdown (and FEATURE.SOURCE_INDEX below)
 * present them — the single source of truth both features are built from,
 * so they can never disagree on what index N means.
 */
function visibleSourceCodes(sourceOverrides = {}) {
  return SOURCE_CODES.filter((code) => sourceOverrides[code.value] !== '');
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
const REMOTE_KEYS = [
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
const REMOTE_KEY_COMMAND_BY_FEATURE = Object.fromEntries(
  REMOTE_KEYS.map((remoteKey) => [remoteKey.feature, remoteKey.command]),
);

function buildFeatures(deviceExternalId, sourceOverrides = {}) {
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

/**
 * Open the persistent Telnet session for one Gladys-created AVR device.
 * Idempotent: does nothing if a session is already open for this device.
 */
export function connectDevice(gladys, device, config) {
  if (connections.has(device.external_id)) {
    return;
  }
  const host = ipAddressOf(device) || config.host;
  if (!host) {
    logger.warn(`No IP address known for ${device.external_id}, cannot connect`);
    return;
  }

  // Declared before the legacy Telnet client below (not just the HEOS one
  // further down) so that client's onLine handler can also read
  // `heosState.pid` — once HEOS has matched this receiver's player id, it
  // becomes the authoritative source for PLAYBACK_STATE/NOW_PLAYING and the
  // legacy NSE0/NSE1/NSE2 lines (which generally don't fire for HEOS-managed
  // playback anyway, per real-hardware feedback) must not overwrite it with
  // a stale or unrelated Net/USB-subsystem guess.
  const heosState = { client: null, pid: null, pollTimer: null };

  const telnet = createTelnetClient({
    host,
    port: config.port,
    reconnectIntervalSeconds: config.reconnect_interval_seconds,
    onConnect: () => {
      logger.info(`${device.external_id}: connected, seeding initial state`);
      telnet.send(buildPowerQuery());
      telnet.send(buildVolumeQuery());
      telnet.send(buildMuteQuery());
      telnet.send(buildSourceQuery());
      telnet.send(buildSoundModeQuery());
      telnet.send(buildMenuQuery());
      gladys.setConnectionStatus(true).catch(() => {});
    },
    onLine: (line) => {
      const update = parseLine(line);
      if (!update) {
        return;
      }
      const state = { ...lastKnownState.get(device.external_id) };
      state[update.feature] = update.value;
      lastKnownState.set(device.external_id, state);

      // now_playing_title/artist are cached above like any other state, but
      // never published under their own name: NOW_PLAYING is the single
      // "Artist - Title" feature actually declared in buildFeatures().
      if (update.feature === NOW_PLAYING_TITLE || update.feature === NOW_PLAYING_ARTIST) {
        if (heosState.pid != null) {
          return; // HEOS is authoritative once matched — see the comment above heosState.
        }
        const id = featureExternalId(device.external_id, FEATURE.NOW_PLAYING);
        const nowPlaying = [state[NOW_PLAYING_ARTIST], state[NOW_PLAYING_TITLE]]
          .filter(Boolean)
          .join(' - ');
        gladys
          .publishState(id, { text: nowPlaying })
          .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));
        return;
      }

      if (update.feature === FEATURE.PLAYBACK_STATE && heosState.pid != null) {
        return; // Same precedence rule — see the comment above heosState.
      }

      const id = featureExternalId(device.external_id, update.feature);
      const isTextFeature =
        update.feature === FEATURE.SOURCE || update.feature === FEATURE.SOUND_MODE;
      const value = isTextFeature ? { text: update.value } : update.value;
      gladys
        .publishState(id, value)
        .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));

      // Keep FEATURE.SOURCE_INDEX in lockstep with FEATURE.SOURCE — same
      // visible-list computation buildFeatures() used to build the dropdown
      // (see visibleSourceCodes()). A code that isn't in that list (hidden by
      // source_overrides, or one the static SOURCE_CODES table doesn't know)
      // has no index to report: skip the publish rather than send a bogus
      // one, leaving the last known good index in place.
      if (update.feature === FEATURE.SOURCE) {
        const indexId = featureExternalId(device.external_id, FEATURE.SOURCE_INDEX);
        const index = visibleSourceCodes(config.sourceOverrides).findIndex(
          (code) => code.value === update.value,
        );
        if (index !== -1) {
          gladys
            .publishState(indexId, index)
            .catch((err) => logger.error(`publishState failed for ${indexId}: ${err.message}`));
        }
      }
    },
    onDisconnect: (consecutiveFailures) => {
      if (consecutiveFailures >= CONNECTION_FAILURE_THRESHOLD) {
        gladys
          .setConnectionStatus(false, {
            en: `Cannot reach ${host}:${config.port} (${device.external_id}).`,
            fr: `Impossible de joindre ${host}:${config.port} (${device.external_id}).`,
          })
          .catch(() => {});
      }
    },
  });

  connections.set(device.external_id, telnet);

  // Best-effort HEOS CLI connection, entirely separate from (and never
  // allowed to affect the status of) the legacy Telnet session above: a
  // non-HEOS model, or one with the HEOS CLI port firewalled, simply never
  // confirms a `pid` and every HEOS-routed feature below transparently
  // falls back to the legacy NS9x transport commands (see onSetValue()).
  heosConnections.set(device.external_id, heosState);

  function publishNowPlayingMedia(parsedPayload) {
    const media = parseNowPlayingMedia(parsedPayload);
    const id = featureExternalId(device.external_id, FEATURE.NOW_PLAYING);
    const nowPlaying = media ? [media.artist, media.title].filter(Boolean).join(' - ') : '';
    gladys
      .publishState(id, { text: nowPlaying })
      .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));
  }

  function publishPlaybackState(state) {
    const id = featureExternalId(device.external_id, FEATURE.PLAYBACK_STATE);
    const value = heosPlayStateToPlaybackState(state);
    const cached = { ...lastKnownState.get(device.external_id) };
    cached[FEATURE.PLAYBACK_STATE] = value;
    lastKnownState.set(device.external_id, cached);
    gladys
      .publishState(id, value)
      .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));
  }

  heosState.client = createHeosClient({
    host,
    reconnectIntervalSeconds: config.reconnect_interval_seconds,
    onConnect: () => {
      logger.debug(
        `${device.external_id}: HEOS CLI connected, looking up this receiver's player id`,
      );
      heosState.client.sendCommand(buildGetPlayersCommand());
      heosState.client.sendCommand(buildRegisterForChangeEventsCommand());
    },
    onMessage: (parsed) => {
      if (parsed.command === 'player/get_players' && parsed.result !== 'fail') {
        const pid = findPlayerIdByIp(parsed.payload, host);
        if (pid != null) {
          heosState.pid = pid;
          logger.info(`${device.external_id}: HEOS player id ${pid} matched to ${host}`);
          heosState.client.sendCommand(buildGetPlayStateCommand(pid));
          heosState.client.sendCommand(buildGetNowPlayingMediaCommand(pid));
        } else {
          // Not an error (this device may simply not run HEOS), but worth a
          // log line: this is the single most common reason "Speak on a
          // speaker"/the playback buttons silently do nothing — no pid ever
          // means every HEOS-routed feature falls back to the legacy
          // commands (or, for FEATURE.PLAY_NOTIFICATION, has nothing to fall
          // back to at all) with zero feedback in the Gladys UI, since a
          // scene logs a failed action and moves on rather than surfacing
          // it. The reported IPs help spot a multi-NIC/IP mismatch (the
          // receiver advertising a different address over HEOS than the one
          // SSDP/the config gave this integration).
          const reportedIps = (parsed.payload ?? []).map((p) => p?.ip).filter(Boolean);
          logger.warn(
            `${device.external_id}: HEOS CLI reachable but no player matches ${host} (HEOS reports: ${
              reportedIps.length > 0 ? reportedIps.join(', ') : 'no players at all'
            })`,
          );
        }
        return;
      }

      const isOurPlayer = heosState.pid != null && Number(parsed.message?.pid) === heosState.pid;
      if (!isOurPlayer) {
        return;
      }

      // Prefer HEOS's own real transport-state event/query over the NSE0
      // "Now Playing ..." banner heuristic (protocol.js) whenever we have
      // it: it is an actual play/pause/stop signal, not a text-banner guess.
      if (
        parsed.command === HEOS_EVENT.PLAYER_STATE_CHANGED ||
        parsed.command === 'player/get_play_state'
      ) {
        publishPlaybackState(parsed.message?.state);
        return;
      }

      if (parsed.command === 'player/get_now_playing_media') {
        publishNowPlayingMedia(parsed.payload);
        return;
      }

      // "Speak on a speaker" (FEATURE.PLAY_NOTIFICATION, see onSetValue())
      // fires this and never checks the reply itself — sendCommand() only
      // confirms the socket accepted the bytes, not that the receiver could
      // actually play the URL. Logging the outcome here is the only way to
      // tell "HEOS rejected the stream" (bad/unreachable URL, wrong format,
      // player busy...) apart from "played fine, nothing else went wrong" —
      // both look identical from Gladys' side, since a scene logs a failed
      // action server-side and reports the scene as run regardless.
      if (parsed.command === 'browse/play_stream') {
        if (parsed.result === 'fail') {
          logger.error(
            `${device.external_id}: HEOS rejected the "Speak on a speaker" stream (eid=${parsed.message?.eid}): ${parsed.message?.text}`,
          );
        } else {
          logger.debug(`${device.external_id}: HEOS accepted the "Speak on a speaker" stream`);
        }
        return;
      }

      // The event itself carries no track data (just the pid) — it's a
      // "something changed, go re-fetch" signal, not the data itself.
      if (parsed.command === HEOS_EVENT.PLAYER_NOW_PLAYING_CHANGED) {
        heosState.client.sendCommand(buildGetNowPlayingMediaCommand(heosState.pid));
      }
    },
    onDisconnect: () => {
      // Deliberately no gladys.setConnectionStatus() call here: HEOS is an
      // optional bonus channel, its absence must never be surfaced as this
      // AVR being unreachable (that is entirely the legacy Telnet session's
      // job, above). Losing the pid just resumes the legacy-command
      // fallback in onSetValue() (and the legacy NSE0/NSE1/NSE2 precedence
      // above) until (if ever) HEOS reconnects and re-matches.
      heosState.pid = null;
    },
  });

  // Actively refresh playback state + now-playing on a timer, on top of
  // reacting to HEOS's pushed events — see the comment on
  // HEOS_POLL_INTERVAL_MS for why the pushed events alone weren't enough in
  // practice. A no-op tick (pid not known yet, or the HEOS socket currently
  // down) is harmless: sendCommand() just returns false.
  heosState.pollTimer = setInterval(() => {
    if (heosState.pid == null) {
      return;
    }
    heosState.client.sendCommand(buildGetPlayStateCommand(heosState.pid));
    heosState.client.sendCommand(buildGetNowPlayingMediaCommand(heosState.pid));
  }, HEOS_POLL_INTERVAL_MS);
}

/**
 * Test-only hook: inject a fake `{ send, isConnected }` client for a given
 * external_id, so onSetValue()/the manifest actions can be unit tested
 * without a real socket (mirrors the template's `simulateLanSession` hook
 * in src/devices/plug.js). Not used by production code.
 */
export function __setConnectionForTesting(externalId, telnetClient) {
  connections.set(externalId, telnetClient);
}

/**
 * Test-only hook: seed the last-known-state cache for a given external_id,
 * so the MUTE toggle logic in onSetValue() can be tested without a real
 * receiver pushing state back over Telnet. Not used by production code.
 */
export function __setLastKnownStateForTesting(externalId, state) {
  lastKnownState.set(externalId, state);
}

/**
 * Test-only hook: inject a fake `{ pid, client: { sendCommand, isConnected } }`
 * HEOS connection for a given external_id, so the HEOS-routing branch of
 * onSetValue() can be unit tested without a real HEOS socket.
 * Not used by production code.
 */
export function __setHeosConnectionForTesting(externalId, heosState) {
  heosConnections.set(externalId, heosState);
}

/**
 * Test-only hook: override HEOS_POLL_INTERVAL_MS so a test can exercise the
 * periodic playback-state/now-playing refresh without a real 30s wait.
 * Reset to the default by __clearConnectionsForTesting(). Not used by
 * production code.
 */
export function __setHeosPollIntervalMsForTesting(ms) {
  HEOS_POLL_INTERVAL_MS = ms;
}

/** Test-only hook: drop every registered connection between tests. */
export function __clearConnectionsForTesting() {
  connections.clear();
  lastKnownState.clear();
  for (const heosState of heosConnections.values()) {
    clearInterval(heosState?.pollTimer);
  }
  heosConnections.clear();
  HEOS_POLL_INTERVAL_MS = DEFAULT_HEOS_POLL_INTERVAL_MS;
}

/** Close and forget the persistent session of one device, if any. */
export function disconnectDevice(externalId) {
  connections.get(externalId)?.stop();
  connections.delete(externalId);
  lastKnownState.delete(externalId);
  const heosState = heosConnections.get(externalId);
  clearInterval(heosState?.pollTimer);
  heosState?.client?.stop();
  heosConnections.delete(externalId);
}

/** Close every open session (graceful shutdown). */
export function disconnectAllDevices() {
  for (const externalId of connections.keys()) {
    disconnectDevice(externalId);
  }
}

/**
 * Dispatch a user command (`onSetValue`) to the right device's Telnet
 * session. `config` is optional (defaults to no source overrides) so
 * existing callers/tests that don't need FEATURE.SOURCE_INDEX keep working
 * unchanged; index.js passes its live, hot-reloaded config through.
 */
export async function onSetValue(gladys, { device, feature, value, config }) {
  const telnet = connections.get(device.external_id);
  if (!telnet || !telnet.isConnected()) {
    throw new Error(`${device.external_id} is not connected`);
  }

  const key = feature.external_id.slice(device.external_id.length + 1);
  let command;
  if (key === FEATURE.POWER) {
    command = buildPowerCommand(value === 1);
  } else if (key === FEATURE.VOLUME) {
    command = buildVolumeCommand(value);
  } else if (key === FEATURE.MUTE) {
    // DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_MUTE is a remote-control button
    // (same family as VOLUME_UP/VOLUME_DOWN), not a stateful switch like
    // POWER's BINARY type — `value` is not a target state to set, it's just
    // a "button pressed" signal (observed constant across presses on a real
    // instance: trusting it as a target made every press send the same
    // command, so the second press never undid the first). Toggle off the
    // receiver's own last-reported mute state instead.
    const currentlyMuted = lastKnownState.get(device.external_id)?.mute === 1;
    command = buildMuteCommand(!currentlyMuted);
  } else if (key === FEATURE.SOURCE) {
    // TEXT.SELECT features carry their state as the selected option's own
    // string value (not the `number` the SDK types suggest — checked
    // against the Gladys core: device.setValue forwards it as-is, string or
    // number, to the integration), so `value` is already the SI code.
    command = buildSourceCommand(value);
  } else if (key === FEATURE.SOURCE_INDEX) {
    // Numeric alias of SOURCE — see the feature comment in buildFeatures().
    // Same visible-list computation as the dropdown and as onLine()'s
    // publish, so index N always means the same input both ways.
    const codes = visibleSourceCodes(config?.sourceOverrides);
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= codes.length) {
      throw new Error(
        `${device.external_id}: source index ${value} is out of range (0-${codes.length - 1})`,
      );
    }
    command = buildSourceCommand(codes[index].value);
  } else if (key === FEATURE.SOUND_MODE) {
    // Same TEXT.SELECT string-value case as SOURCE.
    command = buildSoundModeCommand(value);
  } else if (REMOTE_KEY_COMMAND_BY_FEATURE[key]) {
    // Setup-menu remote keys — fire-and-forget, `value` carries nothing
    // meaningful (see the comment on REMOTE_KEYS above).
    command = REMOTE_KEY_COMMAND_BY_FEATURE[key]();
  } else if (key === FEATURE.MENU) {
    // Toggle off the receiver's last-reported Setup-menu state, exactly
    // like Mute above — value is just a "pressed" signal, not a target.
    const menuCurrentlyOpen = lastKnownState.get(device.external_id)?.menu === 1;
    command = buildMenuCommand(!menuCurrentlyOpen);
  } else if (
    key === FEATURE.PLAY ||
    key === FEATURE.PAUSE ||
    key === FEATURE.NEXT ||
    key === FEATURE.PREVIOUS
  ) {
    // Qobuz/Spotify Connect/TIDAL/TuneIn... on a HEOS-equipped AVR are
    // actually driven by the separate HEOS CLI service (see src/heos/), not
    // by these legacy Telnet transport commands — confirmed on real
    // hardware to have no effect on that kind of playback. Route through
    // HEOS whenever we've matched a player id for this receiver; otherwise
    // (non-HEOS model, HEOS CLI unreachable, or discovery hasn't completed
    // yet) fall back to the legacy commands, which remain correct for the
    // receiver's own non-HEOS Net/USB playback.
    const heos = heosConnections.get(device.external_id);
    if (heos?.pid != null && heos.client?.isConnected()) {
      const heosCommand =
        key === FEATURE.PLAY
          ? buildHeosPlayCommand(heos.pid)
          : key === FEATURE.PAUSE
            ? buildHeosPauseCommand(heos.pid)
            : key === FEATURE.NEXT
              ? buildHeosPlayNextCommand(heos.pid)
              : buildHeosPlayPreviousCommand(heos.pid);
      if (!heos.client.sendCommand(heosCommand)) {
        throw new Error(`Failed to send HEOS command to ${device.external_id}`);
      }
      return;
    }
    command =
      key === FEATURE.PLAY
        ? buildPlayCommand()
        : key === FEATURE.PAUSE
          ? buildPauseCommand()
          : key === FEATURE.NEXT
            ? buildNextCommand()
            : buildPreviousCommand();
  } else if (key === FEATURE.PLAY_NOTIFICATION) {
    // Unlike the transport buttons above, there is no legacy Telnet
    // fallback: playing an arbitrary TTS URL only exists as a HEOS concept
    // (browse/play_stream). `value` is the TTS audio file URL Gladys core
    // already rendered — see the feature comment in buildFeatures().
    const heos = heosConnections.get(device.external_id);
    if (!heos?.pid || !heos.client?.isConnected()) {
      throw new Error(
        `${device.external_id}: cannot speak, HEOS is not connected or this receiver has no matched player id`,
      );
    }
    if (!heos.client.sendCommand(buildPlayStreamCommand(heos.pid, value))) {
      throw new Error(`Failed to send HEOS play_stream command to ${device.external_id}`);
    }
    return;
  } else {
    throw new Error(`Feature "${key}" is not controllable`);
  }

  if (!telnet.send(command)) {
    throw new Error(`Failed to send command to ${device.external_id}`);
  }
}

/**
 * `test_connection` manifest action: query the device and report its last
 * known state. `config` is optional (same rationale as onSetValue() above)
 * so the source index line is simply omitted for a caller that doesn't pass
 * it.
 */
export async function runTestConnectionAction(gladys, { fields, config }) {
  const externalId = fields.device;
  const telnet = connections.get(externalId);
  if (!telnet || !telnet.isConnected()) {
    return {
      en: 'Not connected to this AVR. Check the host/network and the integration logs.',
      fr: "Pas de connexion à cet ampli. Vérifiez l'hôte/le réseau et les logs de l'intégration.",
    };
  }

  telnet.send(buildPowerQuery());
  telnet.send(buildVolumeQuery());
  telnet.send(buildMuteQuery());
  telnet.send(buildSourceQuery());
  telnet.send(buildSoundModeQuery());
  // Bounded pause: the replies are asynchronous pushed lines, not a
  // request/response pair — give them a moment to land before reading the
  // (fresh-by-then) cache back.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const state = lastKnownState.get(externalId) ?? {};
  const power = state.power === 1 ? 'ON' : state.power === 0 ? 'STANDBY' : '?';
  const mute = state.mute === 1 ? 'ON' : state.mute === 0 ? 'OFF' : '?';
  // Same visible-list computation as buildFeatures()/onSetValue() — reports
  // "?" rather than a wrong number when the current source isn't in it
  // (hidden by source_overrides, or not yet known).
  const sourceIndex = visibleSourceCodes(config?.sourceOverrides).findIndex(
    (code) => code.value === state.source,
  );
  const sourceIndexText = sourceIndex === -1 ? '?' : sourceIndex;

  // Surfaced here specifically so a user whose "Speak on a speaker"/playback
  // buttons silently do nothing has one place to check without digging
  // through debug logs: those features require a matched HEOS player id
  // (see FEATURE.PLAY_NOTIFICATION/onSetValue()), and a scene swallows a
  // failed action without showing an error, so this line is often the only
  // visible confirmation of whether HEOS actually works for this receiver.
  const heos = heosConnections.get(externalId);
  const heosStatusEn =
    heos?.pid != null
      ? `player id ${heos.pid} matched${heos.client?.isConnected() ? '' : ', but currently disconnected'}`
      : heos?.client?.isConnected()
        ? 'connected, but no player id matched — Speak on a speaker will not work on this receiver'
        : 'not connected (no HEOS module, unreachable, or not confirmed yet)';
  const heosStatusFr =
    heos?.pid != null
      ? `identifiant lecteur ${heos.pid} trouvé${heos.client?.isConnected() ? '' : ', mais actuellement déconnecté'}`
      : heos?.client?.isConnected()
        ? 'connecté, mais aucun identifiant lecteur trouvé — Parler sur une enceinte ne fonctionnera pas sur cet ampli'
        : 'non connecté (pas de module HEOS, injoignable, ou pas encore confirmé)';

  return {
    en: `Power: ${power}, Volume: ${state.volume ?? '?'}%, Mute: ${mute}, Source: ${state.source ?? '?'} (index ${sourceIndexText}), Sound mode: ${state.sound_mode ?? '?'}. HEOS: ${heosStatusEn}.`,
    fr: `Alimentation : ${power}, Volume : ${state.volume ?? '?'}%, Muet : ${mute}, Source : ${state.source ?? '?'} (index ${sourceIndexText}), Mode sonore : ${state.sound_mode ?? '?'}. HEOS : ${heosStatusFr}.`,
  };
}

/** `select_source` manifest action: switch the receiver's input. */
export async function runSelectSourceAction(gladys, { fields }) {
  const telnet = connections.get(fields.device);
  if (!telnet || !telnet.isConnected()) {
    throw new Error('This AVR is not connected');
  }
  if (!telnet.send(buildSourceCommand(fields.source))) {
    throw new Error('Failed to send the source command');
  }
  return {
    en: `Source command sent: ${fields.source}.`,
    fr: `Commande source envoyée : ${fields.source}.`,
  };
}
