import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHeosClient } from '../src/heos/client.js';
import { HEOS_PORT } from '../src/heos/protocol.js';

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}

test('createHeosClient defaults to the well-known HEOS_PORT', () => {
  assert.equal(HEOS_PORT, 1255);
});

test('createHeosClient connects, sends heos:// commands terminated by CRLF, and parses JSON replies', async () => {
  const received = [];
  const server = net.createServer((socket) => {
    socket.write(
      JSON.stringify({
        heos: { command: 'player/get_players', result: 'success', message: '' },
        payload: [{ pid: 1, ip: '127.0.0.1' }],
      }) + '\r\n',
    );
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
  });
  const port = await listen(server);

  const messages = [];
  let connected = false;
  const client = createHeosClient({
    host: '127.0.0.1',
    port,
    reconnectIntervalSeconds: 1,
    onConnect: () => {
      connected = true;
    },
    onMessage: (parsed) => messages.push(parsed),
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(connected, true);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], {
      command: 'player/get_players',
      result: 'success',
      message: {},
      payload: [{ pid: 1, ip: '127.0.0.1' }],
    });

    assert.equal(client.sendCommand('player/get_players'), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received.join(''), 'heos://player/get_players\r\n');
  } finally {
    client.stop();
    server.close();
  }
});

test('createHeosClient silently drops malformed/non-HEOS lines instead of calling onMessage', async () => {
  const server = net.createServer((socket) => {
    socket.write('not json\r\n');
    socket.write(JSON.stringify({ foo: 'bar' }) + '\r\n');
  });
  const port = await listen(server);

  const messages = [];
  const client = createHeosClient({
    host: '127.0.0.1',
    port,
    onMessage: (parsed) => messages.push(parsed),
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(messages, []);
  } finally {
    client.stop();
    server.close();
  }
});

test('sendCommand() returns false and does not throw when not connected', () => {
  const client = createHeosClient({ host: '127.0.0.1', port: 1 });
  try {
    assert.equal(client.sendCommand('player/get_players'), false);
  } finally {
    client.stop();
  }
});
