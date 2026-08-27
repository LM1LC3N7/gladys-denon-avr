// -----------------------------------------------------------------------------
// Raw line-based TCP client, originally for the Denon/Marantz AVR Control
// protocol (Telnet, port 23): plain-ASCII commands terminated by "\r", one
// line pushed back for every reply AND every asynchronous state change
// (physical remote, app, another controller...) — nothing to poll, see
// src/devices/avr.js.
//
// Also reused as-is for the HEOS CLI connection (src/heos/client.js,
// port 1255): same shape (line in, line out, reconnect with backoff), only
// the outgoing line terminator differs ("\r\n" instead of "\r" — see
// `lineTerminator` below); the receive side already splits on `\r\n?` so it
// needs no change either way.
//
// This module owns the socket lifecycle only (connect, line framing,
// reconnect with a capped backoff); protocol.js/heos/protocol.js own
// parsing/building the command lines themselves.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';

const DEFAULT_PORT = 23;
const DEFAULT_LINE_TERMINATOR = '\r';
const DEFAULT_LOGGER_NAME = 'denon-telnet';
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
 * @param {string} [opts.lineTerminator] appended to every outgoing command;
 *   "\r" for Denon Telnet (default), "\r\n" for HEOS CLI.
 * @param {string} [opts.loggerName] log line prefix, so a HEOS client can be
 *   told apart from the Denon Telnet client in the logs.
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
  lineTerminator = DEFAULT_LINE_TERMINATOR,
  loggerName = DEFAULT_LOGGER_NAME,
  onLine,
  onConnect,
  onDisconnect,
}) {
  const logger = createLogger({ name: loggerName });
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
      socket.write(`${command}${lineTerminator}`);
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
