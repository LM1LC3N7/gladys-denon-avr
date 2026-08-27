// -----------------------------------------------------------------------------
// HEOS CLI socket client — thin wrapper around the generic Telnet-style
// client in src/denon/telnet.js (same line-in/line-out/reconnect-with-backoff
// shape, HEOS just uses port 1255, a "\r\n" line terminator and `heos://`
// command URIs instead of Denon's bare-word commands).
//
// Kept deliberately separate from the AVR's legacy Telnet connection: HEOS is
// a distinct service that some models don't run at all, so a HEOS connection
// failing (refused, timing out, or just never confirming a `pid`) must never
// be treated as this AVR being unreachable — see src/devices/avr.js, which
// only ever logs HEOS-side problems and keeps every core feature working off
// the legacy Telnet session regardless of HEOS's state.
// -----------------------------------------------------------------------------

import { createTelnetClient } from '../denon/telnet.js';
import { HEOS_PORT, parseMessage } from './protocol.js';

/**
 * Open a resilient HEOS CLI session.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port] defaults to the well-known HEOS_PORT (1255);
 *   only ever overridden by tests, against a local fake server.
 * @param {number} [opts.reconnectIntervalSeconds]
 * @param {(parsed: {command: string, result: string, message: object, payload: unknown}) => void} [opts.onMessage]
 *   called for every line that parses as a HEOS response/event; malformed or
 *   unrecognized lines are silently dropped (never crash the caller).
 * @param {() => void} [opts.onConnect]
 * @param {(consecutiveFailures: number) => void} [opts.onDisconnect]
 * @returns {{ sendCommand(commandPath: string): boolean, isConnected(): boolean, stop(): void }}
 */
export function createHeosClient({
  host,
  port = HEOS_PORT,
  reconnectIntervalSeconds = 10,
  onMessage,
  onConnect,
  onDisconnect,
}) {
  const telnet = createTelnetClient({
    host,
    port,
    reconnectIntervalSeconds,
    lineTerminator: '\r\n',
    loggerName: 'heos-cli',
    onLine: (line) => {
      const parsed = parseMessage(line);
      if (parsed) {
        onMessage?.(parsed);
      }
    },
    onConnect,
    onDisconnect,
  });

  return {
    /** Send one `heos://<commandPath>` command. Returns false if not connected. */
    sendCommand(commandPath) {
      return telnet.send(`heos://${commandPath}`);
    },
    isConnected() {
      return telnet.isConnected();
    },
    stop() {
      telnet.stop();
    },
  };
}
