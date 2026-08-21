#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Quick manual test against a real Denon/Marantz AVR, without running Gladys
// at all: open the same Telnet client this integration uses in production
// (src/denon/telnet.js), log every line the receiver sends, and let you type
// raw protocol commands (see src/denon/protocol.js for the command syntax:
// PW?, PWON, MV50, MU?, SI?, SITUNER...) at a prompt.
//
// Usage: node scripts/debug-telnet.js <host> [port]
// -----------------------------------------------------------------------------

import readline from 'node:readline';
import { createTelnetClient } from '../src/denon/telnet.js';

const [, , host, portArg] = process.argv;
if (!host) {
  console.error('Usage: node scripts/debug-telnet.js <host> [port]');
  process.exit(1);
}
const port = portArg ? Number(portArg) : 23;

console.log(`Connecting to ${host}:${port}...`);

const telnet = createTelnetClient({
  host,
  port,
  onConnect: () => {
    console.log('Connected. Type a command and press Enter (Ctrl+C to quit).');
    console.log('Examples: PW?  PWON  PWSTANDBY  MV?  MV50  MU?  MUON  SI?  SITUNER');
  },
  onLine: (line) => console.log(`<- ${line}`),
  onDisconnect: (consecutiveFailures) =>
    console.log(`Disconnected (attempt ${consecutiveFailures})`),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const command = line.trim();
  if (!command) {
    return;
  }
  if (!telnet.send(command)) {
    console.log('(not connected, command dropped)');
  }
});

process.on('SIGINT', () => {
  telnet.stop();
  rl.close();
  process.exit(0);
});
