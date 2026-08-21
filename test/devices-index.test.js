import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

const DENON_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>Denon AVR-S970H</friendlyName>
    <manufacturer>Denon</manufacturer>
    <modelName>AVR-S970H</modelName>
    <UDN>uuid:12345678-dead-beef-0000-abcdef012345</UDN>
  </device>
</root>`;

function fakeGladysWithSsdp(responders) {
  return { ...createFakeGladys(), scanNetwork: async () => responders };
}

// discoverDenonAvrs() (called internally by buildDiscoveredDevices) defaults
// to the global `fetch` — stub it for the duration of each test rather than
// threading a fetchFn through buildDiscoveredDevices just for testability.
async function withFetch(responseXml, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => responseXml });
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('buildDiscoveredDevices: SSDP-only, no manual hosts configured', async () => {
  const gladys = fakeGladysWithSsdp([{ LOCATION: 'http://192.168.1.50:8080/description.xml' }]);
  await withFetch(DENON_XML, async () => {
    const devices = await buildDiscoveredDevices(gladys, normalizeConfig());
    assert.equal(devices.length, 1);
    assert.match(devices[0].name, /AVR-S970H/);
  });
});

test('buildDiscoveredDevices: multiple manual hosts (comma-separated) each become their own fallback entry', async () => {
  const gladys = fakeGladysWithSsdp([]); // SSDP finds nothing
  const config = normalizeConfig({ host: '192.168.1.50, 192.168.2.50' });
  assert.deepEqual(config.hosts, ['192.168.1.50', '192.168.2.50']);

  const devices = await buildDiscoveredDevices(gladys, config);
  assert.equal(devices.length, 2);
  const ips = devices.map((d) => d.params.find((p) => p.name === 'IP_ADDRESS').value);
  assert.deepEqual(ips.sort(), ['192.168.1.50', '192.168.2.50']);
});

test('buildDiscoveredDevices: a manual host already found by SSDP is not duplicated', async () => {
  const gladys = fakeGladysWithSsdp([{ LOCATION: 'http://192.168.1.50:8080/description.xml' }]);
  const config = normalizeConfig({ host: '192.168.1.50, 192.168.2.50' });

  await withFetch(DENON_XML, async () => {
    const devices = await buildDiscoveredDevices(gladys, config);
    // The SSDP-discovered 192.168.1.50 + the manual-only 192.168.2.50, not 3.
    assert.equal(devices.length, 2);
    const ips = devices.map((d) => d.params.find((p) => p.name === 'IP_ADDRESS').value);
    assert.deepEqual(ips.sort(), ['192.168.1.50', '192.168.2.50']);
  });
});

test('buildDiscoveredDevices: a failed SSDP scan still returns the manual hosts', async () => {
  const gladys = {
    ...createFakeGladys(),
    scanNetwork: async () => {
      throw new Error('boom');
    },
  };
  const config = normalizeConfig({ host: '192.168.1.50' });

  const devices = await buildDiscoveredDevices(gladys, config);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].params.find((p) => p.name === 'IP_ADDRESS').value, '192.168.1.50');
});
