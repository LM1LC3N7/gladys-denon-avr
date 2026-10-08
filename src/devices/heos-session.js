// -----------------------------------------------------------------------------
// The best-effort HEOS CLI session of one AVR (port 1255), entirely separate
// from (and never allowed to affect the reachability of) its legacy Telnet
// session in ./session.js: a non-HEOS model, or one with the HEOS CLI port
// firewalled, simply never confirms a `pid` and every HEOS-routed command
// transparently falls back to the legacy Telnet one (see ./commands.js).
//
// Once a `pid` is matched, HEOS is the authoritative source for the playback
// state and "Now playing" (the legacy NSE0/NSE1/NSE2 lines generally don't
// fire for HEOS-managed playback, per real-hardware feedback), and for
// volume/mute only while Telnet is down — a HEOS-only speaker (Denon Home,
// HEOS 1/3/5...) that has no "AVR Control" service at all.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createHeosClient } from '../heos/client.js';
import {
  buildGetPlayersCommand,
  buildGetPlayStateCommand,
  buildGetNowPlayingMediaCommand,
  buildRegisterForChangeEventsCommand,
  buildGetVolumeCommand,
  buildGetMuteCommand,
  findPlayerIdByIp,
  heosPlayStateToPlaybackState,
  heosMuteStateToBoolean,
  parseNowPlayingMedia,
  parseNowPlayingArtwork,
  HEOS_EVENT,
} from '../heos/protocol.js';
import { FEATURE, STATE, featureExternalId } from './features.js';
import { notifyStateChange, timing, updateState } from './registry.js';

const logger = createLogger({ name: 'avr' });

// Pseudo state key notified (never cached) with the outcome of a
// browse/play_stream: 'ok' | 'fail'. ./announcements.js listens to it to
// restore the previous state at once when HEOS refuses a stream.
export const STREAM_RESULT_KEY = 'heos_stream_result';

// What the HEOS side knows of this receiver, for the transport badge
// (./transport.js): not connected yet, connected and matched to our IP, or
// connected but listing no player at our IP (multi-NIC / IP mismatch).
export const HEOS_MATCH = {
  NONE: 'none',
  MATCHED: 'matched',
  UNMATCHED: 'unmatched',
};

/**
 * Open the HEOS session of one AVR.
 *
 * @param {object} gladys the SDK instance (publishState)
 * @param {object} device the Gladys device
 * @param {object} opts
 * @param {string} opts.host the receiver's IP, matched against HEOS players
 * @param {string} opts.zone the configured zone (HEOS player pick)
 * @param {number} [opts.port] the HEOS CLI port (tests only, against a local fake server)
 * @param {object} opts.config the normalized config (reconnect backoff)
 * @param {() => boolean} opts.isTelnetConnected whether Telnet is up (volume/mute precedence)
 * @param {(match: string) => void} [opts.onMatchChange] called when HEOS_MATCH moves
 * @returns {{ client: object, pid: number|null, match: string, forget(id: string): void, stop(): void }}
 */
export function openHeosSession(
  gladys,
  device,
  { host, zone, config, isTelnetConnected, onMatchChange, port },
) {
  const externalId = device.external_id;
  const session = {
    client: null,
    pid: null,
    match: HEOS_MATCH.NONE,
    pollTimer: null,
    // feature external_id -> last value Gladys acknowledged from the HEOS
    // side. The poll re-fetches every HEOS value whether or not it moved,
    // and Gladys core keeps NO dedup of its own: every numeric publishState
    // of a keep_history feature is one more history row (playback state
    // alone was ~2,900 rows a day per receiver), and Gladys >=5.1.2 flags
    // features past 8,640 states a day as "verbose". publishHeosState() only
    // publishes what changed — the poll still self-heals a missed event, it
    // just no longer re-writes the same value. Recorded on success only (a
    // publish that failed while the Gladys WebSocket was down is retried on
    // the next tick), dropped whenever the legacy Telnet side publishes the
    // same feature (forget()) or HEOS disconnects, so Gladys is never left on
    // a value HEOS didn't send last.
    lastPublished: new Map(),
    forget(id) {
      session.lastPublished.delete(id);
    },
    stop() {
      clearInterval(session.pollTimer);
      session.client?.stop();
    },
  };

  function setMatch(match) {
    if (session.match !== match) {
      session.match = match;
      onMatchChange?.(match);
    }
  }

  function publishHeosState(id, value) {
    const key = JSON.stringify(value);
    if (session.lastPublished.get(id) === key) {
      return;
    }
    gladys
      .publishState(id, value)
      .then(() => session.lastPublished.set(id, key))
      .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));
  }

  function publishNowPlayingMedia(parsedPayload) {
    const media = parseNowPlayingMedia(parsedPayload);
    const artwork = parseNowPlayingArtwork(parsedPayload);
    updateState(externalId, {
      [STATE.NOW_PLAYING_TITLE]: media?.title ?? '',
      [STATE.NOW_PLAYING_ARTIST]: media?.artist ?? '',
      [STATE.NOW_PLAYING_ALBUM]: media ? artwork.album : '',
      [STATE.NOW_PLAYING_IMAGE_URL]: media ? artwork.imageUrl : '',
    });
    const id = featureExternalId(externalId, FEATURE.NOW_PLAYING);
    const nowPlaying = media ? [media.artist, media.title].filter(Boolean).join(' - ') : '';
    publishHeosState(id, { text: nowPlaying });
  }

  // Telnet's own MV/MU pushes stay authoritative for volume/mute whenever
  // that session is actually up — confirmed correct on real AVR hardware
  // regardless of source, unlike the legacy NS9x transport commands. These
  // two only ever publish while Telnet is down, which in practice means a
  // HEOS-only speaker that has no "AVR Control" service at all (port 23
  // actively refused) — see the volume/mute routing in ./commands.js.
  function publishVolume(level) {
    if (isTelnetConnected() || level === undefined) {
      return;
    }
    const value = Math.round(Number(level));
    updateState(externalId, { [FEATURE.VOLUME]: value });
    publishHeosState(featureExternalId(externalId, FEATURE.VOLUME), value);
  }

  function publishMute(muted) {
    if (isTelnetConnected()) {
      return;
    }
    updateState(externalId, { [FEATURE.MUTE]: muted });
    publishHeosState(featureExternalId(externalId, FEATURE.MUTE), muted);
  }

  function publishPlaybackState(state) {
    const value = heosPlayStateToPlaybackState(state);
    updateState(externalId, { [FEATURE.PLAYBACK_STATE]: value });
    publishHeosState(featureExternalId(externalId, FEATURE.PLAYBACK_STATE), value);
  }

  function refreshAll(pid) {
    session.client.sendCommand(buildGetPlayStateCommand(pid));
    session.client.sendCommand(buildGetNowPlayingMediaCommand(pid));
    session.client.sendCommand(buildGetVolumeCommand(pid));
    session.client.sendCommand(buildGetMuteCommand(pid));
  }

  session.client = createHeosClient({
    host,
    port,
    reconnectIntervalSeconds: config.reconnect_interval_seconds,
    onConnect: () => {
      logger.debug(`${externalId}: HEOS CLI connected, looking up this receiver's player id`);
      session.client.sendCommand(buildGetPlayersCommand());
      session.client.sendCommand(buildRegisterForChangeEventsCommand());
    },
    onMessage: (parsed) => {
      if (parsed.command === 'player/get_players' && parsed.result !== 'fail') {
        const pid = findPlayerIdByIp(parsed.payload, host, zone);
        if (pid != null) {
          session.pid = pid;
          logger.info(`${externalId}: HEOS player id ${pid} matched to ${host} (${zone} zone)`);
          setMatch(HEOS_MATCH.MATCHED);
          refreshAll(pid);
        } else {
          // Not an error (this device may simply not run HEOS), but worth a
          // log line — and a degraded transport badge: this is the single
          // most common reason "Speak on a speaker"/the playback buttons
          // silently do nothing. The reported IPs help spot a multi-NIC/IP
          // mismatch (the receiver advertising a different address over
          // HEOS than the one SSDP/the config gave this integration).
          const reportedIps = (parsed.payload ?? []).map((p) => p?.ip).filter(Boolean);
          logger.warn(
            `${externalId}: HEOS CLI reachable but no player matches ${host} (HEOS reports: ${
              reportedIps.length > 0 ? reportedIps.join(', ') : 'no players at all'
            })`,
          );
          setMatch(HEOS_MATCH.UNMATCHED);
        }
        return;
      }

      const isOurPlayer = session.pid != null && Number(parsed.message?.pid) === session.pid;
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

      if (parsed.command === 'player/get_volume') {
        publishVolume(parsed.message?.level);
        return;
      }

      if (parsed.command === 'player/get_mute') {
        publishMute(heosMuteStateToBoolean(parsed.message?.state));
        return;
      }

      if (parsed.command === HEOS_EVENT.PLAYER_VOLUME_CHANGED) {
        publishVolume(parsed.message?.level);
        if (parsed.message?.mute !== undefined) {
          publishMute(heosMuteStateToBoolean(parsed.message.mute));
        }
        return;
      }

      // "Speak on a speaker" fires this and never checks the reply itself —
      // sendCommand() only confirms the socket accepted the bytes, not that
      // the receiver could actually play the URL. Logging the outcome here
      // is the only way to tell "HEOS rejected the stream" (bad/unreachable
      // URL, wrong format, player busy...) apart from "played fine" — both
      // look identical from Gladys' side, since a scene logs a failed action
      // server-side and reports the scene as run regardless.
      //
      // Both branches log at `info`, not `debug`: Gladys never sets
      // LOG_LEVEL for an external integration's container (checked against
      // core's externalIntegration.buildContainerDescriptor.js), so `debug`
      // is effectively unreachable for anyone running this from the Gladys
      // UI. This line is the only confirmation a user has that HEOS actually
      // accepted the stream at all.
      if (parsed.command === 'browse/play_stream' || parsed.command === 'browse/play_preset') {
        const what =
          parsed.command === 'browse/play_stream' ? '"Speak on a speaker" stream' : 'HEOS favorite';
        if (parsed.result === 'fail') {
          logger.error(
            `${externalId}: HEOS rejected the ${what} (eid=${parsed.message?.eid}): ${parsed.message?.text}`,
          );
        } else {
          logger.info(`${externalId}: HEOS accepted the ${what}`);
        }
        if (parsed.command === 'browse/play_stream') {
          notifyStateChange(
            externalId,
            STREAM_RESULT_KEY,
            parsed.result === 'fail' ? 'fail' : 'ok',
          );
        }
        return;
      }

      // The event itself carries no track data (just the pid) — it's a
      // "something changed, go re-fetch" signal, not the data itself.
      if (parsed.command === HEOS_EVENT.PLAYER_NOW_PLAYING_CHANGED) {
        session.client.sendCommand(buildGetNowPlayingMediaCommand(session.pid));
      }
    },
    onDisconnect: () => {
      // Losing the pid just resumes the legacy-command fallback in
      // ./commands.js (and the legacy NSE0/NSE1/NSE2 precedence in
      // ./session.js) until (if ever) HEOS reconnects and re-matches.
      session.pid = null;
      session.lastPublished.clear();
      setMatch(HEOS_MATCH.NONE);
    },
  });

  // Actively refresh playback state + now-playing on a timer, on top of
  // reacting to HEOS's pushed events — see timing.heosPollIntervalMs for why
  // the pushed events alone weren't enough in practice. A no-op tick (pid not
  // known yet, or the HEOS socket currently down) is harmless: sendCommand()
  // just returns false.
  session.pollTimer = setInterval(() => {
    if (session.pid != null) {
      refreshAll(session.pid);
    }
  }, timing.heosPollIntervalMs);

  return session;
}
