// Main-zone power on receivers without zones (forum topic 10722, post 35:
// On/Off did nothing on a Marantz PM7000N, which ignores ZM? and ZMON/ZMOFF
// and only knows PWON/PWSTANDBY/PW?). Fake receivers on real local sockets:
// a stereo one that ignores every ZM command, an AV receiver with zones, a
// silent one that never reports its power.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  FEATURE,
  buildDiscoveredDevice,
  connectDevice,
  disconnectDevice,
  featureExternalId,
  onSetValue,
  runTestConnectionAction,
} from '../src/devices/avr.js';
import { initialQueries } from '../src/devices/session.js';
import {
  getPowerMode,
  notePowerReport,
  sendPower,
  setPowerMode,
  describePowerMode,
} from '../src/devices/power.js';
import { computeTransport } from '../src/devices/transport.js';
import {
  __clearConnectionsForTesting,
  __setHeosConnectionForTesting,
  __setTimingForTesting,
  getSession,
  getState,
  setSession,
  updateState,
} from '../src/devices/registry.js';
import { isAnnouncing } from '../src/devices/announcements.js';
import {
  POWER_MODE,
  ZONE,
  buildPowerCommand,
  buildPowerQuery,
  parseLine,
} from '../src/denon/protocol.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeHeosSession, createFakeTelnetClient } from '../test-fixtures/fakeClients.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 3_000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await tick(10);
  }
}

/**
 * A fake receiver over Telnet. `zones: false` is a stereo model: it answers
 * PW?/PWON/PWSTANDBY and ignores every ZM command. `zones: true` is an AV
 * receiver answering both. `silent: true` never reports its power.
 */
async function startReceiver({ zones = false, silent = false, on = true } = {}) {
  const received = [];
  const sockets = new Set();
  let power = on;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    const write = (line) => socket.write(`${line}\r`);
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r');
      buffer = lines.pop();
      for (const command of lines) {
        received.push(command);
        if (command === 'MV?') {
          write('MV40');
        }
        if (silent) {
          continue;
        }
        if (command === 'PW?') {
          write(power ? 'PWON' : 'PWSTANDBY');
        } else if (command === 'PWON' || command === 'PWSTANDBY') {
          power = command === 'PWON';
          write(command);
        } else if (zones && command === 'ZM?') {
          write(power ? 'ZMON' : 'ZMOFF');
        } else if (zones && (command === 'ZMON' || command === 'ZMOFF')) {
          power = command === 'ZMON';
          write(command);
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
    push(line) {
      for (const socket of sockets) {
        socket.write(`${line}\r`);
      }
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function connect(gladys, receiver, extraConfig = {}) {
  const device = buildDiscoveredDevice(gladys, {
    udn: `udn-${receiver.port}`,
    host: '127.0.0.1',
    friendlyName: 'Marantz PM7000N',
    modelName: 'PM7000N',
  });
  const config = normalizeConfig({ port: receiver.port, ...extraConfig });
  connectDevice(gladys, device, config);
  // The HEOS session to 127.0.0.1:1255 has nothing to talk to: stop it now.
  getSession(device.external_id).heos?.stop?.();
  return { device, config };
}

function powerStates(gladys, device) {
  const id = featureExternalId(device.external_id, FEATURE.POWER);
  return gladys.published.filter((p) => p.featureExternalId === id).map((p) => p.state);
}

function powerFeature(device) {
  return { external_id: featureExternalId(device.external_id, FEATURE.POWER) };
}

function badges(gladys, device) {
  return gladys.transports.filter((t) => t.external_id === device.external_id);
}

test.beforeEach(() => {
  __setTimingForTesting({
    zoneSwitchDelayMs: 0,
    powerProbeMs: 150,
    powerConfirmMs: 200,
    announcementPollMs: 10,
    announcementStartTimeoutMs: 500,
    announcementMaxMs: 2_000,
  });
});

test.afterEach(() => {
  __clearConnectionsForTesting();
});

// --- Protocol ----------------------------------------------------------------

test('protocol: PW commands only for the main zone of a receiver without zones', () => {
  assert.equal(buildPowerCommand(true, ZONE.MAIN, POWER_MODE.SYSTEM), 'PWON');
  assert.equal(buildPowerCommand(false, ZONE.MAIN, POWER_MODE.SYSTEM), 'PWSTANDBY');
  assert.equal(buildPowerQuery(ZONE.MAIN, POWER_MODE.SYSTEM), 'PW?');
  for (const mode of [POWER_MODE.UNKNOWN, POWER_MODE.ZONE, undefined]) {
    assert.equal(buildPowerCommand(true, ZONE.MAIN, mode), 'ZMON');
    assert.equal(buildPowerCommand(false, ZONE.MAIN, mode), 'ZMOFF');
    assert.equal(buildPowerQuery(ZONE.MAIN, mode), 'ZM?');
  }
  // A secondary zone never turns into the whole-unit PW commands.
  assert.equal(buildPowerCommand(true, ZONE.ZONE2, POWER_MODE.SYSTEM), 'Z2ON');
  assert.equal(buildPowerCommand(false, ZONE.ZONE3, POWER_MODE.SYSTEM), 'Z3OFF');
  assert.equal(buildPowerQuery(ZONE.ZONE2, POWER_MODE.SYSTEM), 'Z2?');
});

test('protocol: PWON means "on" only for the main zone of a receiver without zones', () => {
  assert.deepEqual(parseLine('PWON', ZONE.MAIN, POWER_MODE.SYSTEM), { feature: 'power', value: 1 });
  assert.deepEqual(parseLine(' PWON\r', ZONE.MAIN, POWER_MODE.SYSTEM), {
    feature: 'power',
    value: 1,
  });
  assert.deepEqual(parseLine('PWSTANDBY', ZONE.MAIN, POWER_MODE.SYSTEM), {
    feature: 'power',
    value: 0,
  });
  assert.equal(parseLine('PWON', ZONE.MAIN, POWER_MODE.ZONE), null);
  assert.equal(parseLine('PWON', ZONE.MAIN, POWER_MODE.UNKNOWN), null);
  assert.equal(parseLine('PWON', ZONE.ZONE2, POWER_MODE.SYSTEM), null);
  assert.equal(parseLine('PWONX', ZONE.MAIN, POWER_MODE.SYSTEM), null);
});

test('initialQueries: the main zone asks both ZM? and PW?, a secondary zone neither PW?', () => {
  const main = initialQueries(ZONE.MAIN);
  assert.ok(main.includes('ZM?'));
  assert.ok(main.includes('PW?'));
  assert.ok(!initialQueries(ZONE.ZONE2).includes('PW?'));
  assert.ok(initialQueries(ZONE.ZONE2).includes('Z2?'));
});

// --- Detection, command, read-back -------------------------------------------

test('stereo receiver (no zones): detected, power read back from PW, PWON/PWSTANDBY sent', async () => {
  const gladys = createFakeGladys();
  const receiver = await startReceiver({ zones: false, on: true });
  const { device, config } = connect(gladys, receiver);
  try {
    await waitFor(() => getPowerMode(device.external_id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    assert.match(describePowerMode(device.external_id), /PWON\/PWSTANDBY/);
    // The PWON answer to the first PW? came before detection; the PW? sent
    // once detected is read as "on".
    await waitFor(() => powerStates(gladys, device).includes(1), 'power on published');
    assert.equal(receiver.received.filter((c) => c === 'PW?').length, 2);

    await onSetValue(gladys, { device, feature: powerFeature(device), value: 0, config });
    await waitFor(() => getState(device.external_id).power === 0, 'power off read back');
    assert.equal(powerStates(gladys, device).at(-1), 0);

    await onSetValue(gladys, { device, feature: powerFeature(device), value: 1, config });
    await waitFor(() => getState(device.external_id).power === 1, 'power on read back');

    const sentPower = receiver.received.filter((c) => /^(PW|ZM)(ON|OFF|STANDBY)$/.test(c));
    assert.deepEqual(sentPower, ['PWSTANDBY', 'PWON']);

    // Confirmed: the badge never turned degraded.
    await tick(300);
    assert.ok(badges(gladys, device).every((b) => !b.degraded));

    // Closing the session forgets the mode (a new IP may be another receiver).
    disconnectDevice(device.external_id);
    assert.equal(getPowerMode(device.external_id), POWER_MODE.UNKNOWN);
  } finally {
    disconnectDevice(device.external_id);
    await receiver.close();
  }
});

test('AV receiver with zones: ZMON/ZMOFF, never the whole-unit PW commands', async () => {
  const gladys = createFakeGladys();
  const receiver = await startReceiver({ zones: true, on: false });
  const { device, config } = connect(gladys, receiver);
  try {
    await waitFor(() => getPowerMode(device.external_id) === POWER_MODE.ZONE, 'ZONE mode');
    await tick(250); // Past the probe: still ZONE.
    assert.equal(getPowerMode(device.external_id), POWER_MODE.ZONE);

    await onSetValue(gladys, { device, feature: powerFeature(device), value: 1, config });
    await waitFor(() => getState(device.external_id).power === 1, 'power on read back');
    await onSetValue(gladys, { device, feature: powerFeature(device), value: 0, config });
    await waitFor(() => getState(device.external_id).power === 0, 'power off read back');

    const sentPower = receiver.received.filter((c) => /^(PW|ZM)(ON|OFF|STANDBY)$/.test(c));
    assert.deepEqual(sentPower, ['ZMON', 'ZMOFF']);
  } finally {
    disconnectDevice(device.external_id);
    await receiver.close();
  }
});

test('a receiver once seen answering ZM never switches to PW on a later unanswered ZM?', async () => {
  const gladys = createFakeGladys();
  const receiver = await startReceiver({ zones: false, on: true });
  const device = buildDiscoveredDevice(gladys, {
    udn: `udn-${receiver.port}`,
    host: '127.0.0.1',
    friendlyName: 'AVR',
  });
  // What an earlier connection of this session learnt (survives a reconnect).
  setPowerMode(device.external_id, POWER_MODE.ZONE, 'answered ZMON');
  const config = normalizeConfig({ port: receiver.port });
  connectDevice(gladys, device, config);
  getSession(device.external_id).heos?.stop?.();
  try {
    await waitFor(() => receiver.received.includes('PW?'), 'the probe queries');
    await tick(300);
    assert.equal(getPowerMode(device.external_id), POWER_MODE.ZONE);
    await onSetValue(gladys, { device, feature: powerFeature(device), value: 0, config });
    await waitFor(() => receiver.received.includes('ZMOFF'), 'ZMOFF sent');
    assert.ok(!receiver.received.includes('PWSTANDBY'));
  } finally {
    disconnectDevice(device.external_id);
    await receiver.close();
  }
});

test('a ZM answer turns a receiver taken for one without zones back to ZMON/ZMOFF', async () => {
  const gladys = createFakeGladys();
  const receiver = await startReceiver({ zones: false, on: true });
  const { device, config } = connect(gladys, receiver);
  try {
    await waitFor(() => getPowerMode(device.external_id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    receiver.push('ZMOFF');
    await waitFor(() => getPowerMode(device.external_id) === POWER_MODE.ZONE, 'ZONE mode');
    assert.equal(getState(device.external_id).power, 0);
    await onSetValue(gladys, { device, feature: powerFeature(device), value: 1, config });
    await waitFor(() => receiver.received.includes('ZMON'), 'ZMON sent');
  } finally {
    disconnectDevice(device.external_id);
    await receiver.close();
  }
});

test('a receiver answering neither ZM? nor PW? keeps ZMON, and the badge says "not confirmed"', async () => {
  const gladys = createFakeGladys();
  const receiver = await startReceiver({ silent: true });
  const { device, config } = connect(gladys, receiver);
  try {
    await waitFor(() => receiver.received.includes('PW?'), 'the probe queries');
    await tick(300);
    assert.equal(getPowerMode(device.external_id), POWER_MODE.UNKNOWN);

    await onSetValue(gladys, { device, feature: powerFeature(device), value: 1, config });
    await waitFor(() => receiver.received.includes('ZMON'), 'ZMON sent');
    await waitFor(() => badges(gladys, device).some((b) => b.degraded), 'degraded badge');
    const badge = badges(gladys, device).at(-1);
    assert.equal(badge.transport, 'local');
    assert.match(badge.message.en, /ZMON.*not confirmed/);
    assert.match(badge.message.fr, /ZMON.*non confirmé/);

    // The receiver reports its power after all: the badge is nominal again.
    receiver.push('PWSTANDBY');
    await waitFor(() => !badges(gladys, device).at(-1).degraded, 'nominal badge');
  } finally {
    disconnectDevice(device.external_id);
    await receiver.close();
  }
});

test('Zone 2 on a stereo receiver: no probe, Z2ON/Z2OFF as before', async () => {
  const gladys = createFakeGladys();
  const receiver = await startReceiver({ zones: false, on: true });
  const { device, config } = connect(gladys, receiver, { zone: 'zone2' });
  try {
    await waitFor(() => receiver.received.includes('Z2?'), 'the zone 2 queries');
    receiver.push('PWON'); // Within what would be the probe window.
    await tick(300);
    assert.equal(getPowerMode(device.external_id), POWER_MODE.UNKNOWN);
    assert.ok(!receiver.received.includes('PW?'));
    await onSetValue(gladys, { device, feature: powerFeature(device), value: 1, config });
    await waitFor(() => receiver.received.includes('Z2ON'), 'Z2ON sent');
    assert.ok(!receiver.received.includes('PWON'));
  } finally {
    disconnectDevice(device.external_id);
    await receiver.close();
  }
});

// --- Confirmation bookkeeping (no socket) --------------------------------------

test('sendPower: confirmed by the same value only, reported unconfirmed after the delay', async () => {
  const ID = 'avr:power';
  const reports = [];
  const telnet = createFakeTelnetClient();
  setSession(ID, { telnet, reportPower: (value) => reports.push(value) });

  assert.equal(sendPower(telnet, ID, true, ZONE.MAIN, 'test'), true);
  notePowerReport(ID, 0); // An older state on its way: not a confirmation.
  assert.deepEqual(reports, []);
  await tick(300);
  assert.deepEqual(reports, ['ZMON']);

  reports.length = 0;
  setPowerMode(ID, POWER_MODE.SYSTEM, 'test');
  assert.equal(sendPower(telnet, ID, false, ZONE.MAIN, 'test'), true);
  notePowerReport(ID, 0);
  assert.deepEqual(reports, [null]);
  await tick(300);
  assert.deepEqual(reports, [null], 'no late "unconfirmed" after a confirmation');
  assert.deepEqual(telnet.sent, ['ZMON', 'PWSTANDBY']);

  // A newer command replaces the older one's follow-up.
  reports.length = 0;
  sendPower(telnet, ID, true, ZONE.MAIN, 'test');
  await tick(100);
  sendPower(telnet, ID, false, ZONE.MAIN, 'test');
  await tick(150);
  assert.deepEqual(reports, [], 'the first follow-up was cancelled');
  await tick(150);
  assert.deepEqual(reports, ['PWSTANDBY']);

  // Not written: no follow-up at all.
  reports.length = 0;
  telnet.setConnected(false);
  assert.equal(sendPower(telnet, ID, true, ZONE.MAIN, 'test'), false);
  await tick(300);
  assert.deepEqual(reports, []);
});

test('computeTransport: an unconfirmed power command degrades a working Telnet badge only', () => {
  const base = { telnetUp: true, telnetFailures: 0, host: 'h', port: 23 };
  assert.equal(computeTransport('x', base).degraded, undefined);
  const entry = computeTransport('x', { ...base, powerUnconfirmed: 'PWON' });
  assert.equal(entry.degraded, true);
  assert.match(entry.message.en, /PWON/);
  assert.match(entry.message.fr, /PWON/);
  const down = computeTransport('x', {
    ...base,
    telnetUp: false,
    telnetFailures: 5,
    powerUnconfirmed: 'PWON',
  });
  assert.equal(down.transport, 'unreachable');
});

// --- "Speak on a speaker" -------------------------------------------------------

test('announcement on a stereo receiver: PWON before, PWSTANDBY after', async () => {
  const gladys = createFakeGladys();
  const receiver = await startReceiver({ zones: false, on: false });
  const { device, config } = connect(gladys, receiver, { announcement_volume: 0 });
  try {
    await waitFor(() => getPowerMode(device.external_id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    assert.equal(getState(device.external_id).power, 0);
    __setHeosConnectionForTesting(device.external_id, createFakeHeosSession(9));

    const feature = {
      external_id: featureExternalId(device.external_id, FEATURE.PLAY_NOTIFICATION),
    };
    await onSetValue(gladys, { device, feature, value: 'https://tts.example/a.mp3', config });
    await waitFor(() => getState(device.external_id).power === 1, 'on for the announcement');
    assert.ok(isAnnouncing(device.external_id));

    updateState(device.external_id, { playback_state: 1 });
    updateState(device.external_id, { playback_state: 0 });
    await waitFor(() => getState(device.external_id).power === 0, 'back to standby');

    const sentPower = receiver.received.filter((c) => /^(PW|ZM)(ON|OFF|STANDBY)$/.test(c));
    assert.deepEqual(sentPower, ['PWON', 'PWSTANDBY']);
  } finally {
    disconnectDevice(device.external_id);
    await receiver.close();
  }
});

test('"Test connection" names the power commands of the main zone only', async () => {
  const ID = 'avr:test-connection';
  setSession(ID, { telnet: createFakeTelnetClient() });
  setPowerMode(ID, POWER_MODE.SYSTEM, 'test');
  const fields = { device: ID };
  const [main, zone2] = await Promise.all([
    runTestConnectionAction(createFakeGladys(), { fields, config: normalizeConfig({}) }),
    runTestConnectionAction(createFakeGladys(), {
      fields,
      config: normalizeConfig({ zone: 'zone2' }),
    }),
  ]);
  assert.match(main.en, /Power: \? \(receiver without zones: PWON\/PWSTANDBY\)/);
  assert.match(main.fr, /Alimentation : \? \(ampli sans zones : PWON\/PWSTANDBY\)/);
  assert.doesNotMatch(zone2.en, /PWON/);
  assert.doesNotMatch(zone2.fr, /PWON/);
});
