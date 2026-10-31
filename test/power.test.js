// Main-zone power on receivers with and without zones (forum topic 10722,
// post 35: On/Off did nothing on a Marantz PM7000N, whose protocol only has
// PWON/PWSTANDBY/PW?). Fake receivers on real local sockets:
//   - an AV receiver with a main zone and a Zone 2 (PWSTANDBY cuts every
//     zone, PWON wakes the zones that were on, ZM* only touches the main
//     zone), with lost or late ZM? answers on demand;
//   - a stereo receiver that only knows PW (optionally answering ZM? while
//     ignoring ZMON/ZMOFF);
//   - a silent receiver;
// and a fake Deviceinfo.xml HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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
  __flushPowerStoreForTesting,
  describePowerMode,
  fetchDeviceZones,
  getPowerMode,
  notePowerReport,
  parseDeviceZones,
  sendPower,
  setPowerMode,
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

const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'denon-power-'));
const STORE = path.join(DIR, 'power-modes.json');
process.env.DENON_POWER_FILE = STORE;
process.env.DENON_DEVICEINFO_PORTS = ''; // No Deviceinfo.xml unless a test serves one.

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const POWER_COMMAND = /^(PW|ZM|Z2)(ON|OFF|STANDBY)$/;

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
 * A fake receiver over Telnet. `zones: true`: AV receiver with a main zone
 * and a Zone 2. `zones: false`: stereo model, PW only (ZM? answered when
 * `answerZmQuery`, ZMON/ZMOFF always ignored). `dropZm`: the first N ZM?
 * are lost; `zmDelayMs`: ZM? answered late; `answerZ2: false`: Z2? ignored;
 * `silent`: no power line at all; `echoNoop: false`: a power command that
 * changes nothing is not echoed.
 */
async function startReceiver({
  zones = false,
  main = true,
  zone2 = false,
  silent = false,
  answerZmQuery = false,
  answerZ2 = true,
  dropZm = 0,
  zmDelayMs = 0,
  echoNoop = true,
} = {}) {
  const r = {
    zones,
    main,
    zone2,
    last: { main: true, zone2: false },
    received: [],
    dropZm,
    answerZ2,
  };
  const sockets = new Set();
  const timers = new Set();
  let connections = 0;
  const on = () => r.main || r.zone2;
  const write = (line) => {
    for (const socket of sockets) {
      socket.write(`${line}\r`);
    }
  };
  const later = (ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  const handle = (command) => {
    r.received.push(command);
    if (command === 'MV?') {
      write('MV40');
    }
    if (silent) {
      return;
    }
    if (command === 'PW?') {
      write(on() ? 'PWON' : 'PWSTANDBY');
    } else if (command === 'PWON') {
      if (!on()) {
        r.main = zones ? r.last.main || !r.last.zone2 : true;
        r.zone2 = zones && r.last.zone2;
        write('PWON');
        if (zones) {
          write(r.main ? 'ZMON' : 'ZMOFF');
        }
      } else if (echoNoop) {
        write('PWON');
      }
    } else if (command === 'PWSTANDBY') {
      if (on()) {
        r.last = { main: r.main, zone2: r.zone2 };
        r.main = false;
        r.zone2 = false;
        if (zones) {
          write('ZMOFF');
          write('Z2OFF');
        }
        write('PWSTANDBY');
      } else if (echoNoop) {
        write('PWSTANDBY');
      }
    } else if (!zones) {
      if (command === 'ZM?' && answerZmQuery) {
        write(r.main ? 'ZMON' : 'ZMOFF');
      }
    } else if (command === 'ZM?') {
      if (r.dropZm > 0) {
        r.dropZm -= 1;
        return;
      }
      const answer = () => write(r.main ? 'ZMON' : 'ZMOFF');
      if (zmDelayMs > 0) {
        later(zmDelayMs, answer);
      } else {
        answer();
      }
    } else if (command === 'ZMON') {
      const wasOff = !on();
      if (!r.main || echoNoop) {
        r.main = true;
        if (wasOff) {
          write('PWON');
        }
        write('ZMON');
      }
    } else if (command === 'ZMOFF') {
      if (r.main || echoNoop) {
        r.main = false;
        write('ZMOFF');
        if (!r.zone2) {
          write('PWSTANDBY');
        }
      }
    } else if (command === 'Z2?' && r.answerZ2) {
      write(r.zone2 ? 'Z2ON' : 'Z2OFF');
      write('Z250');
    }
  };
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r');
      buffer = lines.pop();
      for (const command of lines) {
        handle(command);
      }
    });
  });
  r.port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
  r.connections = () => connections;
  r.push = write;
  r.dropConnection = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  };
  r.powerCommands = () => r.received.filter((c) => POWER_COMMAND.test(c));
  r.close = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    r.dropConnection();
    return new Promise((resolve) => server.close(resolve));
  };
  return r;
}

/** A fake Deviceinfo.xml server on 127.0.0.1; `body` null answers 404. */
async function startDeviceInfo(body, delayMs = 0) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/goform/Deviceinfo.xml' || body === null) {
      res.writeHead(404).end();
      return;
    }
    setTimeout(() => res.writeHead(200, { 'content-type': 'text/xml' }).end(body), delayMs);
  });
  const port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
  process.env.DENON_DEVICEINFO_PORTS = String(port);
  return {
    port,
    close: () => {
      process.env.DENON_DEVICEINFO_PORTS = '';
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const deviceInfoXml = (zones) =>
  `<?xml version="1.0" encoding="utf-8"?><Device_Info><ModelName>X</ModelName><DeviceZones>${zones}</DeviceZones></Device_Info>`;

function connect(gladys, receiver, extraConfig = {}) {
  const device = buildDiscoveredDevice(gladys, {
    udn: `udn-${receiver.port}`,
    host: '127.0.0.1',
    friendlyName: 'Receiver',
    modelName: receiver.zones ? 'AVR-X2700H' : 'PM7000N',
  });
  const config = normalizeConfig({
    port: receiver.port,
    reconnect_interval_seconds: 1,
    ...extraConfig,
  });
  connectDevice(gladys, device, config);
  // The HEOS session to 127.0.0.1:1255 has nothing to talk to: stop it now.
  getSession(device.external_id).heos?.stop?.();
  return { device, config, id: device.external_id };
}

const powerFeature = (id) => ({ external_id: featureExternalId(id, FEATURE.POWER) });
const setPower = (gladys, c, value) =>
  onSetValue(gladys, { device: c.device, feature: powerFeature(c.id), value, config: c.config });

function powerStates(gladys, id) {
  const feature = featureExternalId(id, FEATURE.POWER);
  return gladys.published.filter((p) => p.featureExternalId === feature).map((p) => p.state);
}

const badges = (gladys, id) => gladys.transports.filter((t) => t.external_id === id);

// Probe 150 ms + 100 ms: a verdict "no zones" takes 250 ms.
const PROBE_DONE_MS = 400;

test.beforeEach(async () => {
  await fs.rm(STORE, { force: true });
  process.env.DENON_DEVICEINFO_PORTS = '';
  __setTimingForTesting({
    zoneSwitchDelayMs: 0,
    powerProbeMs: 150,
    powerProbeRetryMs: 100,
    powerReadBackMs: 100,
    powerConfirmMs: 250,
    announcementPollMs: 10,
    announcementStartTimeoutMs: 500,
    announcementMaxMs: 2_000,
  });
});

test.afterEach(async () => {
  __clearConnectionsForTesting();
  await __flushPowerStoreForTesting();
});

test.after(() => fs.rm(DIR, { recursive: true, force: true }));

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

test('initialQueries: the main zone asks both ZM? and PW?, a secondary zone not PW?', () => {
  const main = initialQueries(ZONE.MAIN);
  assert.ok(main.includes('ZM?'));
  assert.ok(main.includes('PW?'));
  assert.ok(!initialQueries(ZONE.ZONE2).includes('PW?'));
  assert.ok(initialQueries(ZONE.ZONE2).includes('Z2?'));
});

test('parseDeviceZones: 1-9 only', () => {
  assert.equal(parseDeviceZones(deviceInfoXml(1)), 1);
  assert.equal(parseDeviceZones(deviceInfoXml(2)), 2);
  assert.equal(parseDeviceZones('<DeviceZones> 3 </DeviceZones>'), 3);
  for (const bad of ['', null, deviceInfoXml(0), deviceInfoXml(''), deviceInfoXml('x'), 'a']) {
    assert.equal(parseDeviceZones(bad), null);
  }
});

test('fetchDeviceZones: 404, oversized, refused host and timeout-free abort all give null', async () => {
  const signal = new AbortController().signal;
  const missing = await startDeviceInfo(null);
  try {
    assert.equal(await fetchDeviceZones('127.0.0.1', signal), null);
  } finally {
    await missing.close();
  }

  const huge = await startDeviceInfo(`${' '.repeat(70 * 1024)}${deviceInfoXml(1)}`);
  try {
    assert.equal(await fetchDeviceZones('127.0.0.1', signal), null, 'past 64 KB: ignored');
    assert.equal(await fetchDeviceZones('127.0.0.1/x?', signal), null, 'not a host');
  } finally {
    await huge.close();
  }

  const ok = await startDeviceInfo(deviceInfoXml(2));
  try {
    assert.equal(await fetchDeviceZones('127.0.0.1', signal), 2);
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await fetchDeviceZones('127.0.0.1', aborted.signal), null);
  } finally {
    await ok.close();
  }
});

test('setPowerMode: logged change only once, a weaker source never overrides a stronger one', () => {
  const ID = 'avr:modes';
  assert.equal(setPowerMode(ID, POWER_MODE.SYSTEM, 'test', 3), true);
  assert.equal(setPowerMode(ID, POWER_MODE.SYSTEM, 'test', 3), false, 'same mode: no change');
  assert.equal(setPowerMode(ID, POWER_MODE.ZONE, 'test', 2), false, 'weaker source');
  assert.equal(getPowerMode(ID), POWER_MODE.SYSTEM);
});

// --- Deviceinfo.xml first ------------------------------------------------------

test('DeviceZones=2: ZMON/ZMOFF even with every ZM? lost and Z2? unanswered', async () => {
  const info = await startDeviceInfo(deviceInfoXml(2));
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, zone2: true, dropZm: 99, answerZ2: false });
  const c = connect(gladys, rx);
  try {
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.ZONE, 'ZONE mode');
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.ZONE);
    await setPower(gladys, c, 0);
    await tick(100);
    assert.deepEqual(rx.powerCommands(), ['ZMOFF']);
    assert.equal(rx.zone2, true, 'Zone 2 still on');
  } finally {
    disconnectDevice(c.id);
    await rx.close();
    await info.close();
  }
});

test('DeviceZones=1: PWSTANDBY even on a stereo receiver that answers ZM?', async () => {
  // Answered after the first PW? answer: that one must be asked again.
  const info = await startDeviceInfo(deviceInfoXml(1), 100);
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false, answerZmQuery: true });
  const c = connect(gladys, rx);
  try {
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    await waitFor(() => getState(c.id).power === 1, 'PWON read once in SYSTEM mode');
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.SYSTEM, 'ZMON answers do not override it');
    await setPower(gladys, c, 0);
    await waitFor(() => getState(c.id).power === 0, 'power off read back');
    assert.equal(rx.main, false);
    assert.deepEqual(rx.powerCommands(), ['PWSTANDBY']);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
    await info.close();
  }
});

test('while Deviceinfo.xml is still being read, the probe gives no "no zones" verdict', async () => {
  const info = await startDeviceInfo(deviceInfoXml(2), 600);
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, zone2: true, dropZm: 99, answerZ2: false });
  const c = connect(gladys, rx);
  try {
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.UNKNOWN, 'not SYSTEM before DeviceZones');
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.ZONE, 'ZONE from DeviceZones');
  } finally {
    disconnectDevice(c.id);
    await rx.close();
    await info.close();
  }
});

test('DeviceZones=1 read after the first PW? answer: the power is asked again', async () => {
  const info = await startDeviceInfo(deviceInfoXml(1), 100);
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false, main: true });
  const c = connect(gladys, rx);
  try {
    await waitFor(() => rx.received.includes('PW?'), 'the first PW?');
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    await waitFor(() => getState(c.id).power === 1, 'PWON read in SYSTEM mode', 140);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
    await info.close();
  }
});

test('a device closed while Deviceinfo.xml is read gets no verdict from it', async () => {
  const info = await startDeviceInfo(deviceInfoXml(1), 200);
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false });
  const c = connect(gladys, rx);
  try {
    await tick(50);
    disconnectDevice(c.id);
    await tick(350);
    assert.equal(getPowerMode(c.id), POWER_MODE.UNKNOWN);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
    await info.close();
  }
});

test('a saved DeviceZones applies at once after a restart, Deviceinfo.xml unreachable', async () => {
  const info = await startDeviceInfo(deviceInfoXml(1));
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false });
  let c = connect(gladys, rx);
  try {
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    await __flushPowerStoreForTesting();
    assert.deepEqual(JSON.parse(await fs.readFile(STORE, 'utf8'))[c.id], {
      host: '127.0.0.1',
      deviceZones: 1,
    });
    disconnectDevice(c.id);
    await info.close();
    __clearConnectionsForTesting(); // A restart: nothing left in memory.
    c = connect(gladys, rx);
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.SYSTEM, 'SYSTEM from /data', 100);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

// --- Telnet probe (no Deviceinfo.xml) ------------------------------------------

test('stereo receiver, no Deviceinfo.xml: PW? answered, ZM? twice and Z2? not -> PWON/PWSTANDBY', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false, main: true });
  const c = connect(gladys, rx);
  try {
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    assert.match(describePowerMode(c.id), /PWON\/PWSTANDBY/);
    assert.equal(rx.received.filter((x) => x === 'ZM?').length, 2, 'ZM? asked twice');
    assert.ok(rx.received.includes('Z2?'));
    await waitFor(() => powerStates(gladys, c.id).includes(1), 'power on read back');

    await setPower(gladys, c, 0);
    await waitFor(() => getState(c.id).power === 0, 'power off read back');
    await setPower(gladys, c, 1);
    await waitFor(() => getState(c.id).power === 1, 'power on read back');
    assert.deepEqual(rx.powerCommands(), ['PWSTANDBY', 'PWON']);
    await tick(400);
    assert.ok(badges(gladys, c.id).every((b) => !b.degraded));

    // Closing the session forgets the in-memory mode.
    disconnectDevice(c.id);
    assert.equal(getPowerMode(c.id), POWER_MODE.UNKNOWN);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('AVR, first ZM? lost: the Z2? answer keeps ZMOFF, Zone 2 stays on (S2)', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, main: true, zone2: true, dropZm: 1 });
  const c = connect(gladys, rx);
  try {
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.ZONE);
    await setPower(gladys, c, 0);
    await waitFor(() => getState(c.id).power === 0, 'main off read back');
    assert.deepEqual(rx.powerCommands(), ['ZMOFF']);
    assert.equal(rx.zone2, true);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('AVR whose every ZM? is lost: the Z2? answer alone keeps ZMON/ZMOFF', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, main: true, zone2: true, dropZm: 99 });
  const c = connect(gladys, rx);
  try {
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.ZONE);
    await setPower(gladys, c, 0);
    await tick(100);
    assert.deepEqual(rx.powerCommands(), ['ZMOFF']);
    assert.equal(rx.zone2, true);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('AVR, main off and Zone 2 on, first ZM? lost: On sends ZMON, PWON never read as main on (S2b)', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, main: false, zone2: true, dropZm: 1 });
  const c = connect(gladys, rx);
  try {
    await tick(PROBE_DONE_MS);
    assert.notEqual(getState(c.id).power, 1, 'the main zone is not shown on');
    await setPower(gladys, c, 1);
    await waitFor(() => rx.main, 'main zone on');
    assert.deepEqual(rx.powerCommands(), ['ZMON']);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('AVR without Zone 2 answers: the second ZM?, sent alone, keeps ZMON/ZMOFF', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, dropZm: 1, answerZ2: false });
  const c = connect(gladys, rx);
  try {
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.ZONE);
    assert.equal(rx.received.filter((x) => x === 'ZM?').length, 2);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('AVR, ZM? late, Off during the probe: ZMOFF, never PWSTANDBY (S1)', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, zone2: true, zmDelayMs: 200, answerZ2: false });
  const c = connect(gladys, rx);
  try {
    await tick(170); // Past the first probe window, before the late answer.
    await setPower(gladys, c, 0);
    await tick(PROBE_DONE_MS);
    assert.deepEqual(rx.powerCommands(), ['ZMOFF']);
    assert.equal(rx.zone2, true);
    assert.equal(getPowerMode(c.id), POWER_MODE.ZONE);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('a "with zones" verdict survives a restart in /data, even if ZM? and Z2? go unanswered (S3)', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, zone2: true });
  let c = connect(gladys, rx);
  try {
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.ZONE, 'ZONE mode');
    await __flushPowerStoreForTesting();
    disconnectDevice(c.id);
    __clearConnectionsForTesting(); // A restart.
    rx.dropZm = 99;
    rx.answerZ2 = false;
    c = connect(gladys, rx);
    // This connection: ZM? lost, and nobody answers Z2? either.
    rx.received.length = 0;
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.ZONE);
    await setPower(gladys, c, 0);
    await tick(100);
    assert.deepEqual(rx.powerCommands(), ['ZMOFF']);
    assert.equal(rx.zone2, true);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('a saved verdict for another IP address is not used', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false });
  const id = `avr:udn-${rx.port}`;
  await fs.writeFile(STORE, JSON.stringify({ [id]: { host: '10.0.0.9', zone: true } }));
  const c = connect(gladys, rx);
  try {
    assert.equal(c.id, id);
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('an unreadable /data file turns the probe off: ZMON/ZMOFF, file left as is', async () => {
  await fs.writeFile(STORE, '{not json');
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false });
  const c = connect(gladys, rx);
  try {
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.UNKNOWN);
    rx.push('ZMOFF'); // Would be saved if the file were writable.
    await tick(50);
    await __flushPowerStoreForTesting();
    assert.equal(await fs.readFile(STORE, 'utf8'), '{not json');
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('a ZM line turns a receiver taken for one without zones back to ZMON/ZMOFF', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false, main: true });
  const c = connect(gladys, rx);
  try {
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    rx.push('ZMOFF');
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.ZONE, 'ZONE mode');
    assert.equal(getState(c.id).power, 0);
    await setPower(gladys, c, 1);
    await waitFor(() => rx.received.includes('ZMON'), 'ZMON sent');
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('a probe cut by a disconnect gives no verdict', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false });
  const c = connect(gladys, rx);
  try {
    await waitFor(() => rx.received.includes('PW?'), 'the first queries');
    rx.dropConnection(); // Reconnects after 1 s.
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.UNKNOWN);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('a device closed during the probe gets no verdict either', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false });
  const c = connect(gladys, rx);
  try {
    await waitFor(() => rx.received.includes('PW?'), 'the first queries');
    disconnectDevice(c.id);
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.UNKNOWN);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('Zone 2 on a stereo receiver: no probe, Z2ON/Z2OFF as before', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false, main: true });
  const c = connect(gladys, rx, { zone: 'zone2' });
  try {
    await waitFor(() => rx.received.includes('Z2?'), 'the zone 2 queries');
    rx.push('PWON');
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.UNKNOWN);
    assert.ok(!rx.received.includes('PW?'));
    await setPower(gladys, c, 1);
    await waitFor(() => rx.received.includes('Z2ON'), 'Z2ON sent');
    assert.ok(!rx.received.includes('PWON'));
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

// --- Confirmation and badge -----------------------------------------------------

test('silent receiver: ZMON, then the badge says "not confirmed", cleared by a report and by a reconnect', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ silent: true });
  const c = connect(gladys, rx);
  try {
    await tick(PROBE_DONE_MS);
    assert.equal(getPowerMode(c.id), POWER_MODE.UNKNOWN);

    await setPower(gladys, c, 1);
    await waitFor(() => badges(gladys, c.id).at(-1)?.degraded === true, 'degraded badge');
    const badge = badges(gladys, c.id).at(-1);
    assert.equal(badge.transport, 'local');
    assert.match(badge.message.en, /ZMON.*not confirmed/);
    assert.match(badge.message.fr, /ZMON.*non confirmé/);
    assert.equal(
      rx.received.filter((x) => x === 'ZM?').length,
      3,
      'asked again alone, read back once',
    );

    rx.push('PWSTANDBY');
    await waitFor(() => !badges(gladys, c.id).at(-1).degraded, 'nominal after a report');

    await setPower(gladys, c, 1);
    await waitFor(() => badges(gladys, c.id).at(-1)?.degraded === true, 'degraded again');
    const before = rx.connections();
    rx.dropConnection();
    await waitFor(() => rx.connections() > before, 'reconnected', 3_000);
    await waitFor(() => !badges(gladys, c.id).at(-1).degraded, 'nominal after a reconnect');
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('a power command that changes nothing and is not echoed is confirmed by the read-back', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, main: true, echoNoop: false });
  const c = connect(gladys, rx);
  try {
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.ZONE, 'ZONE mode');
    await setPower(gladys, c, 1);
    await tick(400);
    assert.ok(badges(gladys, c.id).every((b) => !b.degraded));
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('sendPower: confirmed by the same value only, read back, reported unconfirmed after the delay', async () => {
  const ID = 'avr:power';
  const reports = [];
  const telnet = createFakeTelnetClient();
  setSession(ID, { telnet, reportPower: (value) => reports.push(value) });

  assert.equal(sendPower(telnet, ID, true, ZONE.MAIN, 'test'), true);
  notePowerReport(ID, 0); // An older state on its way: not a confirmation.
  assert.deepEqual(reports, []);
  await tick(350);
  assert.deepEqual(reports, ['ZMON']);
  assert.deepEqual(telnet.sent, ['ZMON', 'ZM?']);

  reports.length = 0;
  setPowerMode(ID, POWER_MODE.SYSTEM, 'test');
  telnet.sent.length = 0;
  assert.equal(sendPower(telnet, ID, false, ZONE.MAIN, 'test'), true);
  notePowerReport(ID, 0);
  assert.deepEqual(reports, [null]);
  await tick(350);
  assert.deepEqual(reports, [null], 'no late "unconfirmed" after a confirmation');
  assert.deepEqual(telnet.sent, ['PWSTANDBY'], 'no read-back once confirmed');

  // A newer command replaces the older one's follow-up.
  reports.length = 0;
  sendPower(telnet, ID, true, ZONE.MAIN, 'test');
  await tick(150);
  sendPower(telnet, ID, false, ZONE.MAIN, 'test');
  await tick(180);
  assert.deepEqual(reports, [], 'the first follow-up was cancelled');
  await tick(150);
  assert.deepEqual(reports, ['PWSTANDBY']);

  // Not written: no follow-up at all.
  reports.length = 0;
  telnet.setConnected(false);
  assert.equal(sendPower(telnet, ID, true, ZONE.MAIN, 'test'), false);
  await tick(350);
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

async function announce(gladys, c) {
  __setHeosConnectionForTesting(c.id, createFakeHeosSession(9));
  const feature = { external_id: featureExternalId(c.id, FEATURE.PLAY_NOTIFICATION) };
  await onSetValue(gladys, {
    device: c.device,
    feature,
    value: 'https://tts.example/a.mp3',
    config: c.config,
  });
  await waitFor(() => isAnnouncing(c.id) && getState(c.id).power === 1, 'on for the announcement');
  updateState(c.id, { playback_state: 1 });
  updateState(c.id, { playback_state: 0 });
}

test('announcement on a stereo receiver: PWON before, PWSTANDBY after', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false, main: false });
  const c = connect(gladys, rx, { announcement_volume: 0 });
  try {
    await waitFor(() => getPowerMode(c.id) === POWER_MODE.SYSTEM, 'SYSTEM mode');
    await waitFor(() => getState(c.id).power === 0, 'standby read');
    await announce(gladys, c);
    await waitFor(() => getState(c.id).power === 0, 'back to standby');
    assert.deepEqual(rx.powerCommands(), ['PWON', 'PWSTANDBY']);
    assert.equal(rx.main, false);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

test('announcement on an AVR whose first ZM? was lost: ZMON before, ZMOFF after, Zone 2 kept (A3)', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: true, main: false, zone2: true, dropZm: 1 });
  const c = connect(gladys, rx, { announcement_volume: 0 });
  try {
    await tick(PROBE_DONE_MS);
    await announce(gladys, c);
    await waitFor(() => !rx.main, 'main zone back off');
    assert.deepEqual(rx.powerCommands(), ['ZMON', 'ZMOFF']);
    assert.equal(rx.zone2, true);
  } finally {
    disconnectDevice(c.id);
    await rx.close();
  }
});

// --- Test hygiene and "Test connection" --------------------------------------------

test('__clearConnectionsForTesting stops the Telnet clients (a failed test cannot hang the file)', async () => {
  const gladys = createFakeGladys();
  const rx = await startReceiver({ zones: false });
  const c = connect(gladys, rx);
  const { telnet } = getSession(c.id);
  try {
    await waitFor(() => rx.connections() === 1, 'connected');
    __clearConnectionsForTesting();
    rx.dropConnection();
    await tick(1_300); // Past the 1 s reconnect delay.
    assert.equal(rx.connections(), 1, 'no reconnection');
  } finally {
    telnet.stop();
    await rx.close();
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
