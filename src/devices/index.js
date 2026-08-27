// -----------------------------------------------------------------------------
// Device discovery composition: SSDP-discovered AVRs + the optional manual
// host(s) fallback (config.hosts), combined into the payload
// gladys.publishDiscoveredDevices() expects.
//
// Connection management (Telnet sessions, command dispatch, manifest action
// handlers) lives in ./avr.js; the SSDP scan itself lives in
// ../denon/discovery.js. This module only composes the two into one
// discovery payload — kept separate so index.js (the entry point) stays pure
// wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { discoverDenonAvrs } from '../denon/discovery.js';
import { buildDiscoveredDevice, buildManualDevice } from './avr.js';

const logger = createLogger({ name: 'discovery' });

/**
 * Run an SSDP scan and build the full discovery payload: every Denon/Marantz
 * AVR found, plus one manual-fallback entry per host in `config.hosts` — for
 * networks that block multicast, or receivers SSDP simply doesn't reach —
 * skipping any host SSDP already found at that same address.
 */
export async function buildDiscoveredDevices(gladys, config) {
  let discovered = [];
  try {
    discovered = await discoverDenonAvrs(gladys);
  } catch (err) {
    logger.error(`SSDP scan failed: ${err.message}`);
  }

  const devices = discovered.map((d) => buildDiscoveredDevice(gladys, d, config.sourceOverrides));

  const discoveredHosts = new Set(discovered.map((d) => d.host));
  for (const host of config.hosts) {
    if (!discoveredHosts.has(host)) {
      devices.push(buildManualDevice(gladys, host, config.sourceOverrides));
    }
  }

  return devices;
}
