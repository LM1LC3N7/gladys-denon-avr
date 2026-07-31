import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceDescription, discoverDenonAvrs } from '../src/denon/discovery.js';

const DENON_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Denon AVR-S970H</friendlyName>
    <manufacturer>Denon</manufacturer>
    <modelName>AVR-S970H</modelName>
    <UDN>uuid:12345678-dead-beef-0000-abcdef012345</UDN>
  </device>
</root>`;

const MARANTZ_XML = DENON_XML.replaceAll('Denon', 'Marantz').replaceAll('AVR-S970H', 'SR6015');

const UNRELATED_XML = `<?xml version="1.0"?>
<root><device><friendlyName>Some Printer</friendlyName><manufacturer>HP</manufacturer><UDN>uuid:not-an-avr</UDN></device></root>`;

test('parseDeviceDescription accepts Denon and Marantz, case-insensitively', () => {
  const denon = parseDeviceDescription(DENON_XML);
  assert.equal(denon.udn, '12345678-dead-beef-0000-abcdef012345');
  assert.equal(denon.friendlyName, 'Denon AVR-S970H');
  assert.equal(denon.modelName, 'AVR-S970H');

  const marantz = parseDeviceDescription(MARANTZ_XML);
  assert.equal(marantz.manufacturer, 'Marantz');
});

test('parseDeviceDescription rejects other manufacturers', () => {
  assert.equal(parseDeviceDescription(UNRELATED_XML), undefined);
});

test('parseDeviceDescription rejects a Denon-branded body without a UDN', () => {
  const noUdn = DENON_XML.replace(/<UDN>.*<\/UDN>/, '');
  assert.equal(parseDeviceDescription(noUdn), undefined);
});

function fakeGladysWithSsdp(responders) {
  return { scanNetwork: async () => responders };
}

test('discoverDenonAvrs filters, fetches, dedupes and extracts the host', async () => {
  const fetchCalls = [];
  const fetchFn = async (url) => {
    fetchCalls.push(url);
    if (url === 'http://192.168.1.50:8080/description.xml') {
      return { ok: true, text: async () => DENON_XML };
    }
    return { ok: true, text: async () => UNRELATED_XML };
  };

  const gladys = fakeGladysWithSsdp([
    // The same device announces several services -> repeated LOCATION, must be deduped.
    {
      LOCATION: 'http://192.168.1.50:8080/description.xml',
      ST: 'urn:schemas-upnp-org:device:MediaRenderer:1',
    },
    { LOCATION: 'http://192.168.1.50:8080/description.xml', ST: 'upnp:rootdevice' },
    { LOCATION: 'http://192.168.1.60:80/description.xml', ST: 'upnp:rootdevice' },
  ]);

  const found = await discoverDenonAvrs(gladys, { fetchFn });

  assert.equal(found.length, 1);
  assert.equal(found[0].host, '192.168.1.50');
  assert.equal(found[0].udn, '12345678-dead-beef-0000-abcdef012345');
  // Deduped: only 2 distinct LOCATIONs were fetched, not 3 responders.
  assert.equal(fetchCalls.length, 2);
});

test('discoverDenonAvrs skips responders without a LOCATION header and tolerates fetch failures', async () => {
  const gladys = fakeGladysWithSsdp([
    { ST: 'upnp:rootdevice' }, // no LOCATION
    { LOCATION: 'http://192.168.1.99:8080/description.xml' },
  ]);
  const fetchFn = async () => {
    throw new Error('network unreachable');
  };

  const found = await discoverDenonAvrs(gladys, { fetchFn });
  assert.deepEqual(found, []);
});

test('discoverDenonAvrs is case-insensitive on the LOCATION header name', async () => {
  const gladys = fakeGladysWithSsdp([{ location: 'http://192.168.1.50:8080/description.xml' }]);
  const fetchFn = async () => ({ ok: true, text: async () => DENON_XML });

  const found = await discoverDenonAvrs(gladys, { fetchFn });
  assert.equal(found.length, 1);
  assert.equal(found[0].host, '192.168.1.50');
});
