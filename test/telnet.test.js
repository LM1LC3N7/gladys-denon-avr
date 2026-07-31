import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTelnetClient, computeReconnectDelayMs } from '../src/denon/telnet.js';

test('computeReconnectDelayMs grows linearly with the attempt count, capped at 120s', () => {
  assert.equal(computeReconnectDelayMs(1, 10), 10_000);
  assert.equal(computeReconnectDelayMs(2, 10), 20_000);
  assert.equal(computeReconnectDelayMs(50, 10), 120_000);
});

test('computeReconnectDelayMs falls back to a 10s base for an invalid interval', () => {
  assert.equal(computeReconnectDelayMs(1, 0), 10_000);
  assert.equal(computeReconnectDelayMs(1, undefined), 10_000);
});

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}

test('createTelnetClient connects, frames lines, and sends commands with a trailing CR', async () => {
  const receivedCommands = [];
  const server = net.createServer((socket) => {
    socket.write('PWON\r');
    // Two lines in one chunk, must still be framed separately.
    socket.write('MV50\rMUOFF\r');
    socket.on('data', (chunk) => receivedCommands.push(chunk.toString('utf8')));
  });
  const port = await listen(server);

  const lines = [];
  let connected = false;
  const client = createTelnetClient({
    host: '127.0.0.1',
    port,
    onConnect: () => {
      connected = true;
    },
    onLine: (line) => lines.push(line),
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(connected, true);
    assert.deepEqual(lines, ['PWON', 'MV50', 'MUOFF']);

    assert.equal(client.send('MV50'), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receivedCommands.join(''), 'MV50\r');
  } finally {
    client.stop();
    server.close();
  }
});

test('createTelnetClient reports isConnected() and reconnects after the server drops it', async () => {
  let socketCount = 0;
  const server = net.createServer((socket) => {
    socketCount += 1;
    if (socketCount === 1) {
      // Drop the first connection right away to force a reconnect.
      socket.destroy();
    }
  });
  const port = await listen(server);

  let disconnectCalls = 0;
  const client = createTelnetClient({
    host: '127.0.0.1',
    port,
    reconnectIntervalSeconds: 1,
    onDisconnect: () => {
      disconnectCalls += 1;
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(disconnectCalls >= 1, 'the first drop is reported');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(socketCount, 2, 'a second connection attempt was made');
    assert.equal(client.isConnected(), true);
  } finally {
    client.stop();
    server.close();
  }
});

test('send() returns false and does not throw when not connected', () => {
  const client = createTelnetClient({ host: '127.0.0.1', port: 1 });
  try {
    assert.equal(client.send('PW?'), false);
  } finally {
    client.stop();
  }
});
