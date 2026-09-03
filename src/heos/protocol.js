// -----------------------------------------------------------------------------
// HEOS CLI protocol — pure functions only.
//
// HEOS is Denon/Marantz's separate network-audio control plane (also used by
// their standalone HEOS speakers): a plain-text, line-based TCP service on
// port 1255, entirely independent from the legacy "AVR Control" Telnet
// service on port 23 (src/denon/protocol.js). On a HEOS-equipped AVR, a
// network/streaming source that goes through HEOS (Qobuz, TIDAL, Spotify
// Connect, TuneIn...) is actually driven by HEOS under the hood — the legacy
// NS9x transport commands only ever reach the older, non-HEOS Net/USB
// subsystem, which is why they were confirmed (real hardware, this
// integration's own changelog) to have no effect on HEOS-managed playback.
//
// Commands are `heos://` URIs terminated by "\r\n" (see src/heos/client.js);
// responses are JSON, one object per line, shaped:
//   { "heos": { "command": "...", "result": "success"|"fail", "message": "k=v&k=v" }, "payload": [...] }
// `message` is itself a URL-query-string of extra key/value pairs — never a
// bare string — including on event pushes.
//
// No official Denon-published spec exists the way the AVR Control PDF does;
// this is cross-checked against `pyheos` (github.com/andrewsayre/pyheos),
// the library behind Home Assistant's own official HEOS integration, plus
// the field names in the (unofficial, widely mirrored) HEOS CLI Protocol
// Specification. Confidence is "should work, matches a library used in
// production by Home Assistant" — NOT verified against this project's own
// real hardware (the S970H this integration is developed against has never
// had its HEOS features exercised by this codebase before). If it
// misbehaves on a real receiver, `node scripts/debug-heos.js <host>` is the
// tool to compare actual JSON traffic against what's expected here.
// -----------------------------------------------------------------------------

export const HEOS_PORT = 1255;

// HEOS' own values for a player's transport state (get_play_state /
// player_state_changed), distinct from Gladys' own MUSIC_PLAYBACK_STATE
// enum (PLAYING=1/PAUSED=0) that avr.js publishes — mapped in
// heosPlayStateToPlaybackState() below.
export const HEOS_PLAY_STATE = {
  PLAY: 'play',
  PAUSE: 'pause',
  STOP: 'stop',
};

// HEOS pushes these unprompted once `register_for_change_events` is on (see
// buildRegisterForChangeEventsCommand below). PLAYER_NOW_PLAYING_CHANGED
// carries no payload of its own (just the pid in `message`) — it's a
// "go re-fetch" signal, not the data itself; see buildGetNowPlayingMediaCommand.
export const HEOS_EVENT = {
  PLAYER_STATE_CHANGED: 'event/player_state_changed',
  PLAYER_NOW_PLAYING_CHANGED: 'event/player_now_playing_changed',
};

/** `heos://player/get_players` — list every HEOS player known to this system. */
export function buildGetPlayersCommand() {
  return 'player/get_players';
}

/** `heos://player/get_play_state?pid=<pid>` — query one player's transport state. */
export function buildGetPlayStateCommand(pid) {
  return `player/get_play_state?pid=${pid}`;
}

/** `heos://player/set_play_state?pid=<pid>&state=play|pause|stop`. */
export function buildSetPlayStateCommand(pid, state) {
  return `player/set_play_state?pid=${pid}&state=${state}`;
}

/** Convenience wrapper: play. */
export function buildPlayCommand(pid) {
  return buildSetPlayStateCommand(pid, HEOS_PLAY_STATE.PLAY);
}

/** Convenience wrapper: pause. */
export function buildPauseCommand(pid) {
  return buildSetPlayStateCommand(pid, HEOS_PLAY_STATE.PAUSE);
}

/** `heos://player/play_next?pid=<pid>`. */
export function buildPlayNextCommand(pid) {
  return `player/play_next?pid=${pid}`;
}

/** `heos://player/play_previous?pid=<pid>`. */
export function buildPlayPreviousCommand(pid) {
  return `player/play_previous?pid=${pid}`;
}

/**
 * `heos://player/get_now_playing_media?pid=<pid>` — the current track's
 * metadata (title/artist/album/art...) for one player. No equivalent
 * "set" — this is display-only, fed into FEATURE.NOW_PLAYING (see avr.js).
 */
export function buildGetNowPlayingMediaCommand(pid) {
  return `player/get_now_playing_media?pid=${pid}`;
}

/**
 * `heos://browse/play_stream?pid=<pid>&url=<url>` — play an arbitrary HTTP(S)
 * audio URL directly on one player, bypassing any music source/browse tree.
 * This is what backs Gladys' generic "Speak on a speaker" scene action
 * (`ACTIONS.MUSIC.PLAY_NOTIFICATION`): the core hands the integration a
 * ready-made TTS file URL (`self.gateway.getTTSApiUrl()`) and expects it
 * played immediately — see FEATURE.PLAY_NOTIFICATION in ../devices/avr.js.
 *
 * `url` is sent RAW, never percent-encoded — confirmed on real hardware
 * (an encoded URL was silently accepted by the receiver, registered a
 * generic "Url Stream" placeholder in its queue, and then never actually
 * played: `get_play_state` stayed `stop` forever) and against `pyheos`'s own
 * `HeosCommand` query encoder (`message.py`): every other parameter gets a
 * minimal `&`/`=`/`%` escape, but `url` is explicitly exempted and MUST be
 * the last parameter in the command instead — that positional rule, not
 * percent-encoding, is what lets an `&`/`?` inside the URL coexist with the
 * `pid=` parameter before it, since nothing follows `url=` for a receiver
 * parsing left-to-right to misinterpret. `pid` therefore must stay first.
 */
export function buildPlayStreamCommand(pid, url) {
  return `browse/play_stream?pid=${pid}&url=${url}`;
}

/**
 * `heos://system/register_for_change_events?enable=on` — ask the HEOS
 * system to push `event/player_state_changed` (and other `event/*` lines)
 * unprompted, the same "push, don't poll" model as the legacy Telnet
 * service. Without this, HEOS only ever answers direct queries.
 */
export function buildRegisterForChangeEventsCommand(enable = true) {
  return `system/register_for_change_events?enable=${enable ? 'on' : 'off'}`;
}

/** Parse a HEOS `key=value&key=value` message/query string into a plain object. */
function parseHeosQueryString(raw) {
  const result = {};
  if (!raw) {
    return result;
  }
  for (const pair of String(raw).split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const [key, value] = pair.split('=');
    if (key) {
      result[decodeURIComponent(key)] = value === undefined ? '' : decodeURIComponent(value);
    }
  }
  return result;
}

/**
 * Parse ONE line received from the HEOS CLI socket into
 * `{ command, result, message, payload }`, or `null` if it isn't a
 * recognizable HEOS response/event (e.g. a stray empty line).
 *
 * `message` is already parsed from its raw `k=v&k=v` form into a plain
 * object — every caller in this codebase wants the fields, never the raw
 * string.
 */
export function parseMessage(rawLine) {
  const line = String(rawLine).trim();
  if (line.length === 0) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const heos = parsed?.heos;
  if (!heos || typeof heos.command !== 'string') {
    return null;
  }
  return {
    command: heos.command,
    result: heos.result,
    message: parseHeosQueryString(heos.message),
    payload: parsed.payload,
  };
}

/**
 * Given a `player/get_players` response's `payload` array, find the `pid`
 * of the player whose `ip` matches the receiver's known IP address (the
 * same IP this integration already uses for the legacy Telnet connection).
 * Returns `null` if no match is found (non-HEOS model, HEOS not reachable
 * yet, IP mismatch...).
 */
export function findPlayerIdByIp(payload, ip) {
  if (!Array.isArray(payload) || !ip) {
    return null;
  }
  const player = payload.find((p) => p?.ip === ip);
  return player ? player.pid : null;
}

/**
 * Map a HEOS play-state string (from `get_play_state`'s message or a
 * `event/player_state_changed` push) to Gladys' MUSIC_PLAYBACK_STATE value
 * (1 = playing, 0 = paused/stopped/unknown).
 */
export function heosPlayStateToPlaybackState(state) {
  return state === HEOS_PLAY_STATE.PLAY ? 1 : 0;
}

/**
 * Extract `{ title, artist }` from a `get_now_playing_media` response's
 * `payload` (the object itself, already parsed from the outer JSON line by
 * parseMessage() above — HEOS names the fields `song`/`artist`, not
 * `title`, hence the rename here so callers deal in one vocabulary).
 * Returns `null` when there's nothing playing (a station with no song
 * metadata yet, an empty payload...), so callers can tell "know it's
 * blank" apart from "haven't asked yet".
 *
 * `artist` falls back to HEOS's own separate `station` field (confirmed on
 * real hardware) when the receiver doesn't report one: many internet radio
 * streams carry no ICY/ID3 metadata, so `song` ends up holding a generic
 * stream description ("63 kbps aac") instead of an actual track, and
 * `artist` is empty — leaving Gladys' "Now playing" showing just
 * "63 kbps aac" with no indication of which station that even is, while the
 * receiver's own front display shows the station name it has separately
 * (e.g. "Oui FM"). Only used as a fallback, never overwriting a real artist
 * HEOS did report (a station playing an actual tagged track).
 */
export function parseNowPlayingMedia(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const title = typeof payload.song === 'string' ? payload.song.trim() : '';
  const artist = typeof payload.artist === 'string' ? payload.artist.trim() : '';
  const station = typeof payload.station === 'string' ? payload.station.trim() : '';
  if (!title && !artist && !station) {
    return null;
  }
  return { title, artist: artist || station };
}
