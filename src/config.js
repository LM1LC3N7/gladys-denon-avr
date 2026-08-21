// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// Discovery (SSDP) is the primary way an AVR's IP is known — see
// src/denon/discovery.js and src/devices/index.js — so every key here is
// optional: an empty config still works as long as SSDP finds the receiver.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  // Manual IP/hostname fallback, for networks that block SSDP multicast
  // (VLANs, several NICs on the Gladys host...) or with more receivers than
  // SSDP can reach. One value for the common case; a comma-separated list
  // (e.g. "192.168.1.50, 192.168.1.51") to add several receivers by hand at
  // once — see the `hosts` array below, which is what discovery actually
  // consumes. A single value here behaves exactly as before this field
  // supported a list. Leave empty to rely entirely on discovery.
  host: '',
  // Telnet port. Denon/Marantz AVRs use 23 on every model; exposed as an
  // advanced override rather than hardcoded, in case of a non-standard setup.
  port: 23,
  // Backoff base (seconds) between Telnet reconnect attempts, see
  // src/denon/telnet.js#computeReconnectDelayMs.
  reconnect_interval_seconds: 10,
};

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const rawHost = typeof raw.host === 'string' ? raw.host : DEFAULT_CONFIG.host;
  // Comma-separated list -> deduplicated, trimmed, non-empty hosts. A single
  // value with no comma is just a one-element list, so this is a superset of
  // the old single-host behavior, not a breaking change to it.
  const hosts = [
    ...new Set(
      rawHost
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    ),
  ];

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // Kept for backward compatibility with any code expecting a single
    // `host` string (e.g. the connectDevice() last-resort fallback in
    // src/devices/avr.js): the first configured host, or '' if none.
    host: hosts[0] ?? '',
    // What discovery (src/devices/index.js) actually iterates over.
    hosts,
    port: Number(raw.port ?? DEFAULT_CONFIG.port) || DEFAULT_CONFIG.port,
    reconnect_interval_seconds:
      Number(raw.reconnect_interval_seconds ?? DEFAULT_CONFIG.reconnect_interval_seconds) ||
      DEFAULT_CONFIG.reconnect_interval_seconds,
  };
}
