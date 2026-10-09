import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTransport,
  reportHealth,
  forgetHealth,
  CONNECTION_FAILURE_THRESHOLD,
} from '../src/devices/transport.js';
import { HEOS_MATCH } from '../src/devices/heos-session.js';
import { __clearConnectionsForTesting } from '../src/devices/registry.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

const ID = 'avr:abc';
const BASE = { host: '192.168.1.50', port: 23, telnetFailures: 0, heosMatch: HEOS_MATCH.NONE };

test.afterEach(() => {
  __clearConnectionsForTesting();
});

test('computeTransport: Telnet up is local and nominal', () => {
  assert.deepEqual(computeTransport(ID, { ...BASE, telnetUp: true }), {
    external_id: ID,
    transport: 'local',
  });
  assert.deepEqual(
    computeTransport(ID, { ...BASE, telnetUp: true, heosMatch: HEOS_MATCH.MATCHED }),
    { external_id: ID, transport: 'local' },
  );
});

test('computeTransport: HEOS answering with no player at our IP is a degraded local badge', () => {
  const entry = computeTransport(ID, { ...BASE, telnetUp: true, heosMatch: HEOS_MATCH.UNMATCHED });
  assert.equal(entry.transport, 'local');
  assert.equal(entry.degraded, true);
  assert.match(entry.message.en, /192\.168\.1\.50/);
  assert.ok(entry.message.fr);
});

test('computeTransport: Telnet down but HEOS matched (HEOS-only speaker) is degraded, not unreachable', () => {
  const entry = computeTransport(ID, {
    ...BASE,
    telnetUp: false,
    telnetFailures: 10,
    heosMatch: HEOS_MATCH.MATCHED,
  });
  assert.equal(entry.transport, 'local');
  assert.equal(entry.degraded, true);
  assert.match(entry.message.fr, /HEOS/);
});

test('computeTransport: both down is unreachable only past the failure threshold', () => {
  assert.equal(
    computeTransport(ID, {
      ...BASE,
      telnetUp: false,
      telnetFailures: CONNECTION_FAILURE_THRESHOLD - 1,
    }),
    null,
    'a receiver still waking up is not reported yet',
  );
  const entry = computeTransport(ID, {
    ...BASE,
    telnetUp: false,
    telnetFailures: CONNECTION_FAILURE_THRESHOLD,
  });
  assert.equal(entry.transport, 'unreachable');
  assert.equal(entry.degraded, undefined);
});

test('reportHealth publishes each badge change once, per device', async () => {
  const gladys = createFakeGladys();
  reportHealth(gladys, ID, { telnetUp: true, telnetFailures: 0, host: '10.0.0.2', port: 23 });
  reportHealth(gladys, ID, { telnetUp: true, telnetFailures: 0 });
  reportHealth(gladys, 'avr:other', { telnetUp: true, host: '10.0.0.3', port: 23 });
  reportHealth(gladys, ID, { telnetUp: false, telnetFailures: 1 });
  reportHealth(gladys, ID, { telnetUp: false, telnetFailures: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    gladys.transports.map((t) => [t.external_id, t.transport]),
    [
      [ID, 'local'],
      ['avr:other', 'local'],
      [ID, 'unreachable'],
    ],
  );
});

test('reportHealth republishes after forgetHealth (a reopened session) and after a failed publish', async () => {
  const gladys = createFakeGladys();
  let fail = true;
  gladys.publishTransports = async (entries) => {
    if (fail) {
      throw new Error('Gladys down');
    }
    gladys.transports.push(...entries);
  };
  reportHealth(gladys, ID, { telnetUp: true, host: '10.0.0.2', port: 23 });
  await new Promise((resolve) => setImmediate(resolve));
  fail = false;
  reportHealth(gladys, ID, { telnetUp: true });
  forgetHealth(ID);
  reportHealth(gladys, ID, { telnetUp: true, host: '10.0.0.2', port: 23 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gladys.transports.length, 2);
});
