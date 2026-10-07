#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Quick manual test against a real HEOS-equipped Denon/Marantz AVR, without
// running Gladys at all: open the same HEOS CLI client this integration uses
// in production (src/heos/client.js), log every JSON reply/event the
// receiver sends, and let you type command paths (see src/heos/protocol.js;
// the `heos://` scheme is added automatically — type e.g. `player/get_players`,
// then `player/set_play_state?pid=<pid>&state=play` once you have a pid from
// the first reply) at a prompt.
//
// Usage: node scripts/debug-heos.js <host>
//
// Every line is timestamped and every reply/event is auto-logged.
// `player/get_now_playing_media` is fetched three ways, deliberately
// redundant: once as soon as this player's pid is matched, again whenever
// a `player_now_playing_changed` event fires (the same re-fetch
// src/devices/avr.js does in production), AND on a fixed poll
// (NOW_PLAYING_POLL_MS) regardless of events — some stations/receivers were
// found in practice to never push `player_now_playing_changed` at all across
// an ad transition, which would otherwise leave this script showing nothing.
// This is deliberately geared at the ad-break metadata validation protocol
// (see the project brief): run this while a radio stream plays through a
// few real ad breaks, and the `song`/`artist`/`station` fields logged at
// each NOW PLAYING line are what any future ad-detection ruleset would have
// to key off. Compare timestamps against the stream's own ICY metadata
// (e.g. `curl -H "Icy-MetaData: 1" <stream-url>` or `ffprobe -i <stream-url>`)
// to check whether the two are in sync or the ad is inserted server-side
// only (in which case HEOS is the only reliable source — see the brief).
//
// If nothing connects at all, either this receiver has no HEOS module, or
// the HEOS CLI port (1255) is firewalled on its network interface — this
// integration falls back to the legacy Telnet transport commands in that
// case (see scripts/debug-telnet.js), it never treats this as a fatal error.
// -----------------------------------------------------------------------------

import readline from 'node:readline';
import { createHeosClient } from '../src/heos/client.js';
import {
  buildGetNowPlayingMediaCommand,
  buildGetPlayStateCommand,
  buildRegisterForChangeEventsCommand,
} from '../src/heos/protocol.js';

const [, , host] = process.argv;
if (!host) {
  console.error('Usage: node scripts/debug-heos.js <host>');
  process.exit(1);
}

// Poll instead of relying solely on `player_now_playing_changed`: see the
// file header comment on why relying only on the push event can leave this
// script silent across a real ad transition.
const NOW_PLAYING_POLL_MS = 5000;

function timestamp() {
  return new Date().toISOString();
}

let pid = null;
let pollTimer = null;

console.log(`Connecting to ${host}:1255 (HEOS CLI)...`);

const heos = createHeosClient({
  host,
  onConnect: () => {
    console.log('Connected. Type a command path and press Enter (Ctrl+C to quit).');
    console.log('Examples: player/get_players  system/register_for_change_events?enable=on');
    console.log('          player/set_play_state?pid=<pid>&state=play');
    heos.sendCommand('player/get_players');
    heos.sendCommand(buildRegisterForChangeEventsCommand());
  },
  onMessage: (parsed) => {
    console.log(`[${timestamp()}] <-`, JSON.stringify(parsed));

    if (parsed.command === 'player/get_players' && parsed.result !== 'fail') {
      const player = (parsed.payload ?? []).find((p) => p?.ip === host);
      if (player) {
        pid = player.pid;
        console.log(`[${timestamp()}] Matched pid=${pid} for ${host}`);
        heos.sendCommand(buildGetNowPlayingMediaCommand(pid));
        heos.sendCommand(buildGetPlayStateCommand(pid));
        clearInterval(pollTimer);
        pollTimer = setInterval(() => {
          heos.sendCommand(buildGetNowPlayingMediaCommand(pid));
          heos.sendCommand(buildGetPlayStateCommand(pid));
        }, NOW_PLAYING_POLL_MS);
      }
      return;
    }

    if (parsed.command === 'player/get_now_playing_media') {
      console.log(
        `[${timestamp()}] NOW PLAYING song=${JSON.stringify(parsed.payload?.song)} artist=${JSON.stringify(
          parsed.payload?.artist,
        )} station=${JSON.stringify(parsed.payload?.station)} image_url=${JSON.stringify(
          parsed.payload?.image_url,
        )} mid=${JSON.stringify(parsed.payload?.mid)}`,
      );
      return;
    }

    if (parsed.command === 'player/get_play_state') {
      console.log(`[${timestamp()}] PLAY STATE ${parsed.message?.state}`);
      return;
    }

    if (parsed.command === 'event/player_now_playing_changed' && pid != null) {
      console.log(`[${timestamp()}] (pushed now-playing-changed event)`);
      heos.sendCommand(buildGetNowPlayingMediaCommand(pid));
    }
  },
  onDisconnect: (consecutiveFailures) =>
    console.log(`[${timestamp()}] Disconnected (attempt ${consecutiveFailures})`),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const commandPath = line.trim();
  if (!commandPath) {
    return;
  }
  if (!heos.sendCommand(commandPath)) {
    console.log('(not connected, command dropped)');
  }
});

process.on('SIGINT', () => {
  clearInterval(pollTimer);
  heos.stop();
  rl.close();
  process.exit(0);
});
