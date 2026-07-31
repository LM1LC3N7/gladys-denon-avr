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
  // (VLANs...). Leave empty to rely entirely on discovery.
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
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // Force the types: config may arrive as strings from a form.
    host: typeof raw.host === 'string' ? raw.host.trim() : DEFAULT_CONFIG.host,
    port: Number(raw.port ?? DEFAULT_CONFIG.port) || DEFAULT_CONFIG.port,
    reconnect_interval_seconds:
      Number(raw.reconnect_interval_seconds ?? DEFAULT_CONFIG.reconnect_interval_seconds) ||
      DEFAULT_CONFIG.reconnect_interval_seconds,
  };
}
