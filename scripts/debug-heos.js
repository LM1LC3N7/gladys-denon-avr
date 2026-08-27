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
// If nothing connects at all, either this receiver has no HEOS module, or
// the HEOS CLI port (1255) is firewalled on its network interface — this
// integration falls back to the legacy Telnet transport commands in that
// case (see scripts/debug-telnet.js), it never treats this as a fatal error.
// -----------------------------------------------------------------------------

import readline from 'node:readline';
import { createHeosClient } from '../src/heos/client.js';

const [, , host] = process.argv;
if (!host) {
  console.error('Usage: node scripts/debug-heos.js <host>');
  process.exit(1);
}

console.log(`Connecting to ${host}:1255 (HEOS CLI)...`);

const heos = createHeosClient({
  host,
  onConnect: () => {
    console.log('Connected. Type a command path and press Enter (Ctrl+C to quit).');
    console.log('Examples: player/get_players  system/register_for_change_events?enable=on');
    console.log('          player/set_play_state?pid=<pid>&state=play');
  },
  onMessage: (parsed) => console.log('<-', JSON.stringify(parsed)),
  onDisconnect: (consecutiveFailures) =>
    console.log(`Disconnected (attempt ${consecutiveFailures})`),
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
  heos.stop();
  rl.close();
  process.exit(0);
});
