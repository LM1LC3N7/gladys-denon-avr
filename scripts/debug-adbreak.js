#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Run the radio ad-break detection (src/adbreak/) against a real receiver,
// without Gladys: same controller as in production, wired to a HEOS CLI
// session, logging every station change, song, detected break and volume
// change. Useful to tune it by ear while a station plays.
//
// Usage: node scripts/debug-adbreak.js <host> [--no-duck] [--drop=<levels>]
//
// Learned statistics go to AD_BREAK_STATS_FILE (default ./ad-breaks.json
// here, /data/ad-breaks.json in the container). Type `m` + Enter to press
// "it's an ad" (FEATURE.AD_BREAK_MARK).
// -----------------------------------------------------------------------------

import readline from 'node:readline';
import { createHeosClient } from '../src/heos/client.js';
import {
  buildGetPlayersCommand,
  buildGetPlayStateCommand,
  buildGetNowPlayingMediaCommand,
  buildRegisterForChangeEventsCommand,
  buildGetVolumeCommand,
  buildSetVolumeCommand,
  findPlayerIdByIp,
} from '../src/heos/protocol.js';

process.env.AD_BREAK_STATS_FILE ??= './ad-breaks.json';
const { createAdBreakController } = await import('../src/adbreak/index.js');
const { normalizeConfig } = await import('../src/config.js');

const [, , host, ...flags] = process.argv;
if (!host) {
  console.error('Usage: node scripts/debug-adbreak.js <host> [--no-duck] [--drop=<levels>]');
  process.exit(1);
}
const drop = flags.find((f) => f.startsWith('--drop='))?.split('=')[1];
const config = normalizeConfig({
  ad_break_auto_duck: !flags.includes('--no-duck'),
  ...(drop ? { ad_break_volume_drop: Number(drop) } : {}),
});

const log = (...args) => console.log(new Date().toISOString(), ...args);
let pid = null;
let volume = null;

const controller = createAdBreakController({
  name: host,
  getConfig: () => config,
  getVolume: () => volume,
  setVolume: (level) => {
    log(`SET VOLUME ${volume} -> ${level}`);
    volume = level;
    return client.sendCommand(buildSetVolumeCommand(pid, level));
  },
  publishAdBreak: (inBreak) => log(`AD BREAK = ${inBreak}`),
  publishNowPlaying: (text) => log(`NOW PLAYING = ${text}`),
});

const client = createHeosClient({
  host,
  onConnect: () => {
    client.sendCommand(buildGetPlayersCommand());
    client.sendCommand(buildRegisterForChangeEventsCommand());
  },
  onMessage: (parsed) => {
    if (parsed.command === 'player/get_players') {
      pid = findPlayerIdByIp(parsed.payload, host, 'main');
      log(`player id ${pid}`);
      refresh();
      return;
    }
    if (pid == null || Number(parsed.message?.pid) !== pid) {
      return;
    }
    if (
      parsed.command === 'player/get_play_state' ||
      parsed.command === 'event/player_state_changed'
    ) {
      controller.onPlayState(parsed.message?.state === 'play');
    } else if (parsed.command === 'player/get_now_playing_media') {
      controller.onNowPlayingMedia(parsed.payload);
    } else if (
      parsed.command === 'player/get_volume' ||
      parsed.command === 'event/player_volume_changed'
    ) {
      volume = Math.round(Number(parsed.message?.level));
    } else if (parsed.command === 'event/player_now_playing_changed') {
      client.sendCommand(buildGetNowPlayingMediaCommand(pid));
    }
  },
});

function refresh() {
  if (pid == null) {
    return;
  }
  client.sendCommand(buildGetPlayStateCommand(pid));
  client.sendCommand(buildGetNowPlayingMediaCommand(pid));
  client.sendCommand(buildGetVolumeCommand(pid));
}
setInterval(refresh, 30_000);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'm') {
    log('MARK (it is an ad)');
    controller.mark();
  }
});
