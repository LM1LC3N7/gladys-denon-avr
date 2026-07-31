// -----------------------------------------------------------------------------
// Raw Telnet client for the Denon/Marantz AVR Control protocol.
//
// The receiver keeps ONE line-based session open on TCP port 23: we write
// plain-ASCII commands terminated by "\r", and it pushes a line back for
// every reply AND for every asynchronous state change (physical remote, app,
// another controller...) — there is nothing to poll, see src/devices/avr.js.
//
// This module owns the socket lifecycle only (connect, line framing,
// reconnect with a capped backoff); protocol.js owns parsing/building the
// command lines themselves.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'denon-telnet' });

const DEFAULT_PORT = 23;
const MAX_RECONNECT_DELAY_SECONDS = 120;

/**
 * Delay before reconnect attempt number `attempt` (1-based), linear and
 * capped — pure function so the backoff curve is unit-testable without real
 * timers.
 */
export function computeReconnectDelayMs(attempt, baseIntervalSeconds) {
  const base = Math.max(1, Number(baseIntervalSeconds) || 10);
  const seconds = Math.min(base * Math.max(1, attempt), MAX_RECONNECT_DELAY_SECONDS);
  return seconds * 1000;
}

/**
 * Open a resilient Telnet session.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port]
 * @param {number} [opts.reconnectIntervalSeconds]
 * @param {(line: string) => void} [opts.onLine] one parsed line (no CR/LF)
 * @param {() => void} [opts.onConnect]
 * @param {(consecutiveFailures: number) => void} [opts.onDisconnect] called
 *   on every socket close, whether it was ever connected or not, with the
 *   number of consecutive failed/dropped attempts so far (reset to 0 on a
 *   successful connect).
 * @returns {{ send(command: string): boolean, isConnected(): boolean, stop(): void }}
 */
export function createTelnetClient({
  host,
  port = DEFAULT_PORT,
  reconnectIntervalSeconds = 10,
  onLine,
  onConnect,
  onDisconnect,
}) {
  let socket = null;
  let buffer = '';
  let stopped = false;
  let reconnectTimer = null;
  let consecutiveFailures = 0;
  // Tracks the 'connect' event specifically — `socket` exists (and is not
  // yet `destroyed`) for the whole connecting phase too, so relying on the
  // socket object alone would make send()/isConnected() falsely report
  // "connected" for a socket still in the middle of the TCP handshake.
  let connected = false;

  function connect() {
    if (stopped) {
      return;
    }
    logger.debug(`Connecting to ${host}:${port}...`);
    socket = net.createConnection({ host, port });
    socket.setEncoding('utf8');
    socket.setNoDelay(true);

    socket.on('connect', () => {
      connected = true;
      consecutiveFailures = 0;
      logger.info(`Connected to ${host}:${port}`);
      onConnect?.();
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r\n?/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) {
          onLine?.(line);
        }
      }
    });

    socket.on('error', (err) => {
      logger.warn(`Telnet socket error on ${host}:${port}: ${err.message}`);
    });

    socket.on('close', () => {
      socket = null;
      connected = false;
      buffer = '';
      consecutiveFailures += 1;
      onDisconnect?.(consecutiveFailures);
      if (!stopped) {
        const delayMs = computeReconnectDelayMs(consecutiveFailures, reconnectIntervalSeconds);
        logger.debug(
          `Reconnecting to ${host}:${port} in ${delayMs / 1000}s (attempt ${consecutiveFailures + 1})`,
        );
        reconnectTimer = setTimeout(connect, delayMs);
      }
    });
  }

  connect();

  return {
    /** Write one command line (the trailing "\r" is added here). Returns false if not connected. */
    send(command) {
      if (!connected || !socket) {
        logger.debug(`Cannot send "${command}": not connected`);
        return false;
      }
      socket.write(`${command}\r`);
      return true;
    },
    isConnected() {
      return connected;
    },
    /** Stop reconnecting and close the current socket. */
    stop() {
      stopped = true;
      connected = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.destroy();
        socket = null;
      }
    },
  };
}
