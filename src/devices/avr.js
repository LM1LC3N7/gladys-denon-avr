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
  buildRegisterForChangeEventsCommand,
  findPlayerIdByIp,
  heosPlayStateToPlaybackState,
  parseNowPlayingMedia,
  HEOS_EVENT,
} from '../heos/protocol.js';

// DEVICE_FEATURE_TYPES.TEXT.SELECT ('select'): a dynamic dropdown among
// string values the integration itself declares via `supported_options`
// (Gladys core #2567 — installed TV apps, HDMI sources...), exactly our
// case. Not in this SDK's constants yet (^0.9.0 predates it; the string is
// stable and mirrors server/utils/constants.js), so it's spelled out here
// rather than imported. Requires a Gladys core recent enough to know the
// 'select' feature type — see the Source feature below.
const TEXT_SELECT_TYPE = 'select';

export const DEVICE_TYPE = 'avr';

export const FEATURE = {
  POWER: 'power',
  VOLUME: 'volume',
  MUTE: 'mute',
  SOURCE: 'source',
  SOUND_MODE: 'sound_mode',
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  PLAYBACK_STATE: 'playback_state',
  NOW_PLAYING: 'now_playing',
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

function buildFeatures(deviceExternalId, sourceOverrides = {}) {
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
      // A dropdown of the receiver's own input codes (TEXT.SELECT — see the
      // TEXT_SELECT_TYPE note above), NOT the generic TELEVISION.SOURCE type:
      // that one is a one-shot remote-control button in Gladys' front-end
      // (same family as VOLUME_MUTE, no meaningful value), so it could never
      // represent a specific input — only TEXT.SELECT actually renders a
      // real select with our supported_options. The value published/set is
      // the verbatim SI code, so it stays correct for inputs the static
      // SOURCE_CODES list did not anticipate. The `select_source` manifest
      // action (see gladys-assistant-integration.json) is kept as a second,
      // equivalent path — this dashboard control needs a fairly recent
      // Gladys core (TEXT.SELECT/supported_options); on an older one this
      // feature type may be rejected outright, so both routes existing
      // matters, not just redundancy.
      name: 'Source',
      external_id: featureExternalId(deviceExternalId, FEATURE.SOURCE),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: TEXT_SELECT_TYPE,
      // sourceOverrides (config `source_overrides`, see src/config.js) lets
      // the user rename an entry (e.g. SAT/CBL is actually a Chromecast) or
      // hide one entirely — an empty-string override. `value` never
      // changes: it's still the real SI code the receiver understands,
      // only the dropdown's `label` is user-facing.
      supported_options: SOURCE_CODES.filter((code) => sourceOverrides[code.value] !== '').map(
        (code) => ({ value: code.value, label: sourceOverrides[code.value] || code.value }),
      ),
      // Placeholder range: min/max are NOT NULL for every feature even when
      // they carry no real meaning for a select value (see the Power
      // feature above for why this must never be omitted).
      min: 0,
      max: 1,
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
      type: TEXT_SELECT_TYPE,
      supported_options: SOUND_MODE_CODES.map((mode) => ({ value: mode.value, label: mode.value })),
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
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

/** Dispatch a user command (`onSetValue`) to the right device's Telnet session. */
export async function onSetValue(gladys, { device, feature, value }) {
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
  } else if (key === FEATURE.SOUND_MODE) {
    // Same TEXT.SELECT string-value case as SOURCE.
    command = buildSoundModeCommand(value);
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
  } else {
    throw new Error(`Feature "${key}" is not controllable`);
  }

  if (!telnet.send(command)) {
    throw new Error(`Failed to send command to ${device.external_id}`);
  }
}

/** `test_connection` manifest action: query the device and report its last known state. */
export async function runTestConnectionAction(gladys, { fields }) {
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
  return {
    en: `Power: ${power}, Volume: ${state.volume ?? '?'}%, Mute: ${mute}, Source: ${state.source ?? '?'}, Sound mode: ${state.sound_mode ?? '?'}.`,
    fr: `Alimentation : ${power}, Volume : ${state.volume ?? '?'}%, Muet : ${mute}, Source : ${state.source ?? '?'}, Mode sonore : ${state.sound_mode ?? '?'}.`,
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
