// -----------------------------------------------------------------------------
// SSDP (UPnP) discovery of Denon/Marantz AVRs on the LAN.
//
// Denon/Marantz receivers answer SSDP the same way they do for HEOS/AirPlay,
// whether powered on or in (network) standby — this is not a port scan or an
// ARP sweep, just parsing what the device already broadcasts. The actual
// multicast M-SEARCH is done by the Gladys core (`gladys.scanNetwork('ssdp')`,
// declared via the manifest `network_discovery` field); this module only
// interprets the raw responder headers and the UPnP description.xml they
// point to (fetched with the native `fetch`, no extra dependency).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'denon-discovery' });

const MANUFACTURER_PATTERN = /denon|marantz/i;

function extractXmlTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i'));
  return match ? match[1].trim() : undefined;
}

/**
 * Parse ONE UPnP device description.xml body. Returns `undefined` when it
 * does not look like a Denon/Marantz device (most LAN UPnP responders won't
 * be — TVs, routers, other brands...) or lacks a UDN to key on.
 */
export function parseDeviceDescription(xml) {
  const manufacturer = extractXmlTag(xml, 'manufacturer');
  if (!manufacturer || !MANUFACTURER_PATTERN.test(manufacturer)) {
    return undefined;
  }
  const udn = extractXmlTag(xml, 'UDN');
  if (!udn) {
    return undefined;
  }
  return {
    udn: udn.replace(/^uuid:/i, ''),
    manufacturer,
    friendlyName: extractXmlTag(xml, 'friendlyName') || 'Denon AVR',
    modelName: extractXmlTag(xml, 'modelName'),
  };
}

function findLocation(headers) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'location');
  return key ? headers[key] : undefined;
}

/**
 * Run one mediated SSDP scan and resolve the Denon/Marantz AVRs found on the
 * LAN, deduplicated by UDN, as `{ udn, host, friendlyName, modelName, manufacturer }`.
 *
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {{ timeoutSeconds?: number, fetchFn?: typeof fetch }} [options]
 */
export async function discoverDenonAvrs(gladys, { timeoutSeconds = 5, fetchFn = fetch } = {}) {
  const responders = await gladys.scanNetwork('ssdp', { timeoutSeconds });

  const found = [];
  const seenUdn = new Set();
  const seenLocations = new Set();

  for (const headers of responders) {
    const location = findLocation(headers);
    if (!location || seenLocations.has(location)) {
      continue;
    }
    seenLocations.add(location);

    let xml;
    try {
      const response = await fetchFn(location);
      if (!response.ok) {
        continue;
      }
      xml = await response.text();
    } catch (err) {
      logger.debug(`Could not fetch ${location}: ${err.message}`);
      continue;
    }

    const parsed = parseDeviceDescription(xml);
    if (!parsed || seenUdn.has(parsed.udn)) {
      continue;
    }

    let host;
    try {
      host = new URL(location).hostname;
    } catch (err) {
      logger.debug(`Invalid LOCATION URL "${location}": ${err.message}`);
      continue;
    }

    seenUdn.add(parsed.udn);
    found.push({ ...parsed, host });
  }

  logger.info(`SSDP scan: ${found.length} Denon/Marantz AVR(s) found`);
  return found;
}
