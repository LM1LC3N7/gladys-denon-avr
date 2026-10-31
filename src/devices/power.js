// -----------------------------------------------------------------------------
// Main-zone power on receivers with and without zones.
//
// An AV receiver drives its main zone with ZMON/ZMOFF (see ZONE in
// ../denon/protocol.js for why never PWON/PWSTANDBY there: PWSTANDBY would
// also cut Zone 2). A stereo network model (Marantz PM7000N, M-CR610/611,
// Denon DRA-100...) has no zones: its protocol only has PWON/PWSTANDBY/PW?
// (forum topic 10722, post 35: On/Off did nothing on a PM7000N).
//
// How a receiver is classified (POWER_MODE), per device, strongest first:
//   1. A Z2/Z3 line (this session, or saved): the receiver has a Zone 2 ->
//      ZONE, whatever any other source says.
//   2. DeviceZones in /goform/Deviceinfo.xml (HTTP, port 80 then 8080, read
//      once per session), the signal python denonavr (MIT) switches on:
//      2 or more -> ZONE, 1 -> SYSTEM. A ZM line does not override a 1 read
//      this session: some one-zone units answer ZM? yet ignore ZMON/ZMOFF.
//   3. A ZM line (this session or saved), or DeviceZones >= 2 saved -> ZONE.
//   4. Only when Deviceinfo.xml gave no DeviceZones and /data is readable,
//      the Telnet probe: PW? answered, and none of ZM?, Z2? (sent with the
//      first queries) and a second ZM? sent alone answered by any ZM/Z2/Z3
//      line -> SYSTEM. Known limit: an AV receiver without Deviceinfo.xml,
//      on its very first connection, losing all three zone answers.
//   In doubt (nothing answered, probe cut by a disconnect, Deviceinfo.xml
//   still being read): POWER_MODE.UNKNOWN, i.e. ZMON/ZMOFF as in 1.1.0.
//
// /data keeps only verdicts in the safe direction ("with zones": DeviceZones
// >= 2, a ZM line, a Z2/Z3 line), per device and IP address, never "without
// zones": that one must come from the current session. The entry is deleted
// with the device.
//
// Every power command sent is logged at info level with the exact command,
// re-queried after timing.powerReadBackMs and followed for
// timing.powerConfirmMs: without a power report back, the device badge turns
// "degraded" with the command that went unanswered.
// -----------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { POWER_MODE, ZONE, buildPowerCommand, buildPowerQuery } from '../denon/protocol.js';
import { getSession, registerResetHook, timing } from './registry.js';

const logger = createLogger({ name: 'avr' });

// How sure a mode is: a weaker source never replaces a stronger one.
const RANK = Object.freeze({ PROBE: 1, ZONE_LINE: 2, DEVICE_INFO: 3, ZONE2_LINE: 4 });

// Deviceinfo.xml: bounded in size and time, like every other answer.
const DEVICE_INFO_MAX_BYTES = 64 * 1024;
const DEVICE_INFO_TIMEOUT_MS = 3_000;

// external_id -> { mode, rank }.
const modes = new Map();
// external_id -> { timer, readBack, value, command }: a power command awaiting its report.
const pending = new Map();
// The /data store, loaded once: { ok, data: { [external_id]: { host, deviceZones?, zone?, zone2? } } }.
let storePromise = null;
let saving = Promise.resolve();

registerResetHook(() => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    clearTimeout(entry.readBack);
  }
  pending.clear();
  modes.clear();
  storePromise = null;
});

const MODE_TEXT = {
  [POWER_MODE.UNKNOWN]: 'zones not detected yet: ZMON/ZMOFF',
  [POWER_MODE.ZONE]: 'receiver with zones: ZMON/ZMOFF',
  [POWER_MODE.SYSTEM]: 'receiver without zones: PWON/PWSTANDBY',
};

/** The detected power mode of one receiver (POWER_MODE.UNKNOWN until known). */
export function getPowerMode(externalId) {
  return modes.get(externalId)?.mode ?? POWER_MODE.UNKNOWN;
}

/** One line describing the power mode, for the logs and "Test connection". */
export function describePowerMode(externalId) {
  return MODE_TEXT[getPowerMode(externalId)];
}

/**
 * Record the power mode of one receiver, unless a stronger source already
 * decided it. Logged when it changes; resolves whether it changed.
 */
export function setPowerMode(externalId, mode, reason, rank = RANK.PROBE) {
  const current = modes.get(externalId);
  if (current && current.rank > rank) {
    return false;
  }
  modes.set(externalId, { mode, rank }); // rank >= current.rank here
  if ((current?.mode ?? POWER_MODE.UNKNOWN) === mode) {
    return false;
  }
  logger.info(`${externalId}: ${reason}, power mode is now "${MODE_TEXT[mode]}"`);
  return true;
}

/** Forget the in-memory power state of one receiver (session closed); /data stays. */
export function forgetPower(externalId) {
  modes.delete(externalId);
  const entry = pending.get(externalId);
  clearTimeout(entry?.timer);
  clearTimeout(entry?.readBack);
  pending.delete(externalId);
}

/** The power command for one receiver, zone and wanted state, in its detected mode. */
export function powerCommandFor(externalId, on, zone) {
  return buildPowerCommand(on, zone, getPowerMode(externalId));
}

/** Ask the current session of one receiver to update its badge. */
function reportPower(externalId, powerUnconfirmed) {
  getSession(externalId)?.reportPower?.(powerUnconfirmed);
}

/**
 * Send the power command of one receiver over `telnet` (whatever its
 * connection state: the caller decides how a refusal surfaces), log it at
 * info level, re-query the power after timing.powerReadBackMs (a receiver
 * may not echo a command that changes nothing) and report it unconfirmed
 * after timing.powerConfirmMs without an answer. Resolves whether it was
 * written.
 */
export function sendPower(telnet, externalId, on, zone, origin) {
  const command = powerCommandFor(externalId, on, zone);
  if (!telnet.send(command)) {
    logger.warn(
      `${externalId}: power ${on ? 'on' : 'off'} (${origin}): ${command} NOT sent, not connected`,
    );
    return false;
  }
  logger.info(
    `${externalId}: power ${on ? 'on' : 'off'} (${origin}) -> sent ${command} (${describePowerMode(externalId)})`,
  );
  const previous = pending.get(externalId);
  clearTimeout(previous?.timer);
  clearTimeout(previous?.readBack);
  const query = buildPowerQuery(zone, getPowerMode(externalId));
  const readBack = setTimeout(() => telnet.send(query), timing.powerReadBackMs);
  readBack.unref?.();
  // Replaced (cleared) by a newer power command, a report or forgetPower().
  const timer = setTimeout(() => {
    pending.delete(externalId);
    logger.warn(
      `${externalId}: the receiver did not report its power after ${command} (${timing.powerConfirmMs} ms)`,
    );
    reportPower(externalId, command);
  }, timing.powerConfirmMs);
  timer.unref?.();
  pending.set(externalId, { timer, readBack, value: on ? 1 : 0, command });
  return true;
}

/**
 * A power state the receiver reported (parsed by ./session.js): confirms
 * the command awaiting this value, and clears a "not confirmed" badge — the
 * receiver does report its power after all.
 */
export function notePowerReport(externalId, value) {
  const entry = pending.get(externalId);
  if (entry && entry.value !== value) {
    return; // An older state still on its way: the command is not confirmed yet.
  }
  if (entry) {
    clearTimeout(entry.timer);
    clearTimeout(entry.readBack);
    pending.delete(externalId);
  }
  reportPower(externalId, null);
}

// --- /data -------------------------------------------------------------------

function storeFile() {
  return process.env.DENON_POWER_FILE || '/data/power-modes.json';
}

/** A stored entry as trusted data, or null: anything malformed is ignored. */
function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.host !== 'string') {
    return null;
  }
  // Only "with zones" verdicts: a stored 1 (older file) is dropped.
  const deviceZones = Number.isInteger(entry.deviceZones) ? entry.deviceZones : undefined;
  return {
    host: entry.host,
    ...(deviceZones >= 2 && deviceZones <= 9 ? { deviceZones } : {}),
    ...(entry.zone === true ? { zone: true } : {}),
    ...(entry.zone2 === true ? { zone2: true } : {}),
  };
}

/**
 * The /data store, read once. A missing file is an empty store; an
 * unreadable or corrupt one is NOT (`ok: false`): never written over, and
 * the Telnet probe stays off (a lost "with zones" verdict must not let a
 * silence turn an AVR into one without zones).
 */
function loadStore() {
  storePromise ??= (async () => {
    let text;
    try {
      text = await fs.readFile(storeFile(), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { ok: true, data: {} };
      }
      logger.warn(`Power modes file unreadable (${err.code ?? err.message}): probe disabled`);
      return { ok: false, data: {} };
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const data = Object.create(null);
        for (const [id, entry] of Object.entries(parsed)) {
          const valid = validEntry(entry);
          if (valid) {
            data[id] = valid;
          }
        }
        return { ok: true, data };
      }
    } catch {
      // Reported below.
    }
    logger.warn('Power modes file corrupt: kept as is, probe disabled');
    return { ok: false, data: {} };
  })();
  return storePromise;
}

/** Merge `fields` into the stored entry of one receiver at `host`; saved when it changed. */
async function remember(externalId, host, fields) {
  const store = await loadStore();
  if (!store.ok) {
    return;
  }
  const before = store.data[externalId];
  const base = before?.host === host ? before : { host };
  const next = JSON.parse(JSON.stringify({ ...base, ...fields }));
  if (JSON.stringify(next) === JSON.stringify(before ?? { host })) {
    return; // Unchanged, or nothing worth saving.
  }
  store.data[externalId] = next;
  await writeStore(store);
}

/** Delete the stored entry of one receiver (device deleted). */
export async function forgetSavedPower(externalId) {
  const store = await loadStore();
  if (!store.ok || !(externalId in store.data)) {
    return;
  }
  delete store.data[externalId];
  await writeStore(store);
}

async function writeStore(store) {
  const snapshot = JSON.stringify(store.data);
  saving = saving
    .then(async () => {
      const file = storeFile();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, snapshot);
      await fs.rename(`${file}.tmp`, file);
    })
    .catch((err) => logger.warn(`Saving the power modes failed: ${err.message}`));
  await saving;
}

// --- Deviceinfo.xml ------------------------------------------------------------

/** DeviceZones of a Deviceinfo.xml body (1-9), or null. */
export function parseDeviceZones(xml) {
  const match = /<DeviceZones>\s*(\d{1,2})\s*<\/DeviceZones>/.exec(String(xml));
  const zones = match ? Number(match[1]) : NaN;
  return zones >= 1 && zones <= 9 ? zones : null;
}

function deviceInfoPorts() {
  return (process.env.DENON_DEVICEINFO_PORTS ?? '80,8080')
    .split(',')
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

/** The body of a response, or null past `maxBytes` (stopped before reading it all). */
async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * DeviceZones of the receiver at `host` (port 80, then 8080), or null when
 * no Deviceinfo.xml gives one. Never throws.
 */
export async function fetchDeviceZones(host, signal, fetchFn = fetch) {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    return null;
  }
  for (const port of deviceInfoPorts()) {
    try {
      const response = await fetchFn(`http://${host}:${port}/goform/Deviceinfo.xml`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(DEVICE_INFO_TIMEOUT_MS)]),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const zones = parseDeviceZones(await readBounded(response, DEVICE_INFO_MAX_BYTES));
      if (zones !== null) {
        return zones;
      }
    } catch (err) {
      if (signal.aborted) {
        return null;
      }
      logger.debug(`Deviceinfo.xml on ${host}:${port}: ${err.message}`);
    }
  }
  return null;
}

// --- Per-session detection -------------------------------------------------------

const ZONE_LINE = /^(ZM|Z2|Z3)/;

/**
 * The power-mode detection of one Telnet session (./session.js): created
 * with the session, told every connect, line and disconnect, stopped with
 * the session. `send` writes one Telnet command. Only the main zone is
 * classified: Zone 2/3 always use their own Z2/Z3 commands.
 */
export function createPowerDetector({ externalId, host, zone, send, fetchFn = fetch }) {
  const isMain = zone === ZONE.MAIN;
  const abort = new AbortController();
  let stopped = false;
  let storeOk = false;
  // undefined: still reading; null: none; 1-9: DeviceZones.
  let deviceZones;
  let probe = null;
  // The last finished probe said "no zones" (only acted on once
  // Deviceinfo.xml gave nothing and /data is readable).
  let probeSaysSystem = false;

  const applyDeviceZones = (zones) => {
    const mode = zones >= 2 ? POWER_MODE.ZONE : POWER_MODE.SYSTEM;
    if (
      setPowerMode(
        externalId,
        mode,
        `Deviceinfo.xml says DeviceZones=${zones}`,
        RANK.DEVICE_INFO,
      ) &&
      mode === POWER_MODE.SYSTEM
    ) {
      // A PW answer already received was not read in the old mode.
      send(buildPowerQuery(ZONE.MAIN, POWER_MODE.SYSTEM));
    }
  };

  const decide = () => {
    if (stopped || !probeSaysSystem || deviceZones !== null || !storeOk) {
      return;
    }
    if (
      setPowerMode(
        externalId,
        POWER_MODE.SYSTEM,
        'no DeviceZones, PW? answered, ZM? (twice) and Z2? not',
      )
    ) {
      // The PW answer that came before was not read (PWON means nothing in
      // zone mode): ask again, now read in this mode.
      send(buildPowerQuery(ZONE.MAIN, POWER_MODE.SYSTEM));
    }
  };

  const stopProbe = () => {
    clearTimeout(probe?.timer);
    probe = null;
  };

  if (isMain) {
    loadStore().then((store) => {
      if (stopped) {
        return;
      }
      storeOk = store.ok;
      const saved = store.data[externalId];
      if (saved?.host === host) {
        if (saved.zone2) {
          setPowerMode(
            externalId,
            POWER_MODE.ZONE,
            'saved: answered Z2/Z3 before',
            RANK.ZONE2_LINE,
          );
        } else if (saved.deviceZones || saved.zone) {
          // Below a DeviceZones read this session (a box swapped at that IP).
          setPowerMode(
            externalId,
            POWER_MODE.ZONE,
            saved.deviceZones
              ? `saved: DeviceZones=${saved.deviceZones} before`
              : 'saved: answered ZM before',
            RANK.ZONE_LINE,
          );
        }
      }
      decide();
    });
    fetchDeviceZones(host, abort.signal, fetchFn).then((zones) => {
      if (stopped) {
        return;
      }
      deviceZones = zones;
      if (zones === null) {
        logger.info(
          `${externalId}: no DeviceZones in Deviceinfo.xml, power mode stays "${describePowerMode(externalId)}" until the Telnet answers or saved data decide`,
        );
        decide();
        return;
      }
      applyDeviceZones(zones);
      // Only "with zones" is saved; a 1 also drops an older saved count.
      remember(externalId, host, { deviceZones: zones >= 2 ? zones : undefined });
    });
  }

  return {
    /** A Telnet connect: probe what the receiver answers (the queries are sent by the caller). */
    onConnect() {
      stopProbe();
      if (!isMain) {
        return;
      }
      probeSaysSystem = false;
      const current = { sawPw: false, sawZm: false, sawZone: false };
      send('Z2?');
      // Cleared by the next connect, a disconnect and stop().
      current.timer = setTimeout(() => {
        // Second chance, ZM? alone: a busy receiver may have dropped it,
        // and the main zone's power is unknown without its answer.
        if (!current.sawZm) {
          send('ZM?');
        }
        if (current.sawZone || !current.sawPw) {
          probe = null;
          if (!current.sawZone) {
            logger.info(`${externalId}: no answer to ZM? nor PW? on this connection`);
          }
          return;
        }
        current.timer = setTimeout(() => {
          probe = null;
          if (!current.sawZone) {
            probeSaysSystem = true;
            decide();
          }
        }, timing.powerProbeRetryMs);
        current.timer.unref?.();
      }, timing.powerProbeMs);
      current.timer.unref?.();
      probe = current;
    },
    /** One trimmed Telnet line, before parsing. */
    onLine(line) {
      if (!isMain) {
        return;
      }
      if (ZONE_LINE.test(line)) {
        const isZm = line.startsWith('ZM');
        if (probe) {
          probe.sawZone = true;
          probe.sawZm ||= isZm;
        }
        probeSaysSystem = false;
        // A Zone 2/3 line proves zones over anything; a ZM line over all
        // but a DeviceZones=1 read this session (see the header).
        setPowerMode(
          externalId,
          POWER_MODE.ZONE,
          `answered ${line}`,
          isZm ? RANK.ZONE_LINE : RANK.ZONE2_LINE,
        );
        remember(externalId, host, isZm ? { zone: true } : { zone2: true });
      } else if ((line === 'PWON' || line === 'PWSTANDBY') && probe) {
        probe.sawPw = true;
      }
    },
    /** The Telnet connection dropped: a cut probe gives no verdict. */
    onDisconnect: stopProbe,
    /** The session is closed: stop everything, Deviceinfo.xml included. */
    stop() {
      stopped = true;
      stopProbe();
      abort.abort();
    },
  };
}

/** Wait for pending /data writes (tests). */
export function __flushPowerStoreForTesting() {
  return saving;
}
