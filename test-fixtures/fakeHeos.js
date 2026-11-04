// -----------------------------------------------------------------------------
// A fake HEOS CLI (TCP, one JSON line per reply) and a matched HEOS session
// of one AVR against it, registered like a real one — for the Qobuz and
// music player tests. `respond(command, params)` returns the list of partial
// replies to a command: `{ payload?, message?, result?, options?, delayMs? }`; the
// message defaults to the echoed pid/sid/cid/scid/aid, as HEOS does.
// -----------------------------------------------------------------------------

import net from 'node:net';
import assert from 'node:assert/strict';
import { openHeosSession } from '../src/devices/heos-session.js';
import { __setHeosConnectionForTesting } from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './fakeGladys.js';

export const FAKE_PID = 42;

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake HEOS CLI answering `respond(command, params)`. */
export async function startFakeHeos(respond) {
  const received = [];
  let client = null;
  const server = net.createServer((socket) => {
    client = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        received.push(line);
        const path = line.replace(/^heos:\/\//, '');
        const [command, query = ''] = path.split('?');
        const params = Object.fromEntries(
          query
            .split('&')
            .filter(Boolean)
            .map((pair) => [
              pair.slice(0, pair.indexOf('=')),
              decodeURIComponent(pair.slice(pair.indexOf('=') + 1)),
            ]),
        );
        const replies =
          command === 'player/get_players'
            ? [{ payload: [{ pid: FAKE_PID, ip: '127.0.0.1', name: 'Salon' }] }]
            : respond(command, params);
        let delay = 0;
        for (const reply of replies ?? []) {
          const echoed = Object.entries(params)
            .filter(([key]) => ['pid', 'sid', 'cid', 'scid', 'aid'].includes(key))
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join('&');
          // `delayMs`: a slow receiver (or a slow cloud service behind it).
          delay += reply.delayMs ?? 0;
          const send = (text) => !socket.destroyed && socket.write(text);
          const write = (text) => (delay > 0 ? setTimeout(() => send(text), delay) : send(text));
          write(
            `${JSON.stringify({
              heos: {
                command,
                result: reply.result ?? 'success',
                message: reply.message ?? echoed,
              },
              ...(reply.payload ? { payload: reply.payload } : {}),
              ...(reply.options ? { options: reply.options } : {}),
            })}\r\n`,
          );
        }
      }
    });
  });
  const port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
  return {
    port,
    received,
    close() {
      client?.destroy();
      server.close();
    },
  };
}

/** A matched HEOS session of `id` against a fake answering `respond`; closed after the test. */
export async function connectFakeHeos(t, id, respond) {
  const fake = await startFakeHeos(respond);
  const session = openHeosSession(
    createFakeGladys(),
    { external_id: id, name: 'Salon' },
    {
      host: '127.0.0.1',
      zone: 'main',
      config: normalizeConfig(),
      isTelnetConnected: () => false,
      port: fake.port,
    },
  );
  __setHeosConnectionForTesting(id, session);
  t.after(() => {
    session.stop();
    fake.close();
  });
  for (let i = 0; i < 50 && session.pid == null; i += 1) {
    await tick(10);
  }
  assert.equal(session.pid, FAKE_PID);
  return fake;
}

/** The commands of a kind the fake received (`browse/search`…). */
export const sentOf = (fake, prefix) =>
  fake.received.filter((line) => line.startsWith(`heos://${prefix}`));
