// -----------------------------------------------------------------------------
// The Gladys device commands (`gladys.onSetValue`): one feature of one AVR,
// dispatched to its legacy Telnet session or to HEOS, whichever is
// authoritative for that feature (see the routing comments below).
// -----------------------------------------------------------------------------

import {
  buildPowerCommand,
  buildVolumeCommand,
  buildMuteCommand,
  buildSourceCommand,
  buildSoundModeCommand,
  buildPlayCommand,
  buildPauseCommand,
  buildNextCommand,
  buildPreviousCommand,
  buildMenuCommand,
  normalizeZone,
} from '../denon/protocol.js';
import {
  buildPlayCommand as buildHeosPlayCommand,
  buildPauseCommand as buildHeosPauseCommand,
  buildPlayNextCommand as buildHeosPlayNextCommand,
  buildPlayPreviousCommand as buildHeosPlayPreviousCommand,
  buildSetVolumeCommand as buildHeosSetVolumeCommand,
  buildVolumeUpCommand as buildHeosVolumeUpCommand,
  buildVolumeDownCommand as buildHeosVolumeDownCommand,
  buildSetMuteCommand as buildHeosSetMuteCommand,
} from '../heos/protocol.js';
import { normalizeConfig } from '../config.js';
import {
  FEATURE,
  REMOTE_KEY_COMMAND_BY_FEATURE,
  featureExternalId,
  visibleSourceCodes,
} from './features.js';
import { getHeos, getState, getTelnet } from './registry.js';
import { playAnnouncement } from './announcements.js';

/**
 * Dispatch a user command (`onSetValue`) to the right device's Telnet
 * session. `config` is optional (defaults to no source overrides) so
 * existing callers/tests that don't need FEATURE.SOURCE_INDEX keep working
 * unchanged; index.js passes its live, hot-reloaded config through.
 */
export async function onSetValue(gladys, { device, feature, value, config }) {
  const key = feature.external_id.slice(device.external_id.length + 1);
  const zone = normalizeZone(config?.zone);

  // FEATURE.PLAY_NOTIFICATION is purely HEOS — there is no legacy Telnet
  // fallback for it at all (see its own branch below) — so it must be
  // dispatched before the Telnet connectivity gate, not after. Real-hardware
  // feedback: a HEOS-only speaker (Denon Home, no "AVR Control" service at
  // all — Telnet on port 23 is actively refused, `ECONNREFUSED`, which is
  // simply what that product category is) added via the manual IP fallback
  // could never speak, even though its HEOS CLI was perfectly reachable,
  // purely because this function used to require Telnet for every feature
  // indiscriminately. Every other feature below is still Telnet-based (or,
  // for the transport buttons, HEOS-with-a-Telnet-fallback) and keeps the
  // gate right where it was.
  // Pure integration-side logic, no receiver command: no transport gate.
  if (key === FEATURE.AD_BREAK || key === FEATURE.AD_BREAK_MARK) {
    const adBreak = getHeos(device.external_id)?.adBreak;
    if (!adBreak) {
      throw new Error(`${device.external_id} is not connected`);
    }
    adBreak.setAdBreak(key === FEATURE.AD_BREAK_MARK || Number(value) === 1);
    return;
  }

  if (key === FEATURE.PLAY_NOTIFICATION) {
    // `value` is the TTS audio file URL Gladys core already rendered — see
    // the feature comment in buildFeatures() and ./announcements.js for the
    // announcement volume and the return to the previous state.
    await playAnnouncement(device.external_id, value, config ?? normalizeConfig());
    return;
  }

  const telnet = getTelnet(device.external_id);
  const telnetConnected = telnet?.isConnected() ?? false;
  const heos = getHeos(device.external_id);
  const heosConnected = heos?.pid != null && (heos.client?.isConnected() ?? false);

  // Volume/mute and the transport buttons are the only features with a HEOS
  // route at all — everything else below (power, source, sound mode, the
  // Setup-menu remote keys...) has no HEOS equivalent and stays strictly
  // Telnet-only. A real AVR receiver's legacy Telnet session normally covers
  // all of these fine, but a HEOS-only speaker (Denon Home, HEOS 1/3/5...)
  // never has one at all — no "AVR Control" service exists on that product
  // category, port 23 is actively refused (real-hardware feedback, see the
  // FEATURE.PLAY_NOTIFICATION comment above) — so without this branch every
  // one of these commands failed outright on that hardware, volume/mute
  // included, exactly like FEATURE.PLAY_NOTIFICATION used to before it got
  // its own HEOS-only path.
  if (
    key === FEATURE.VOLUME ||
    key === FEATURE.VOLUME_UP ||
    key === FEATURE.VOLUME_DOWN ||
    key === FEATURE.MUTE
  ) {
    // Telnet's MV/MU commands stay authoritative whenever that session is
    // actually up (confirmed correct on real hardware, main-zone volume
    // regardless of source) — HEOS is only the fallback for when it isn't,
    // so fall through to the Telnet branches below in that case.
    if (!telnetConnected) {
      if (!heosConnected) {
        throw new Error(`${device.external_id} is not connected`);
      }
      let heosCommand;
      if (key === FEATURE.VOLUME) {
        heosCommand = buildHeosSetVolumeCommand(heos.pid, value);
      } else if (key === FEATURE.VOLUME_UP) {
        heosCommand = buildHeosVolumeUpCommand(heos.pid);
      } else if (key === FEATURE.VOLUME_DOWN) {
        heosCommand = buildHeosVolumeDownCommand(heos.pid);
      } else {
        // Same "button, not a target state" reasoning as the Telnet MUTE
        // branch below — toggle off the last state HEOS itself reported.
        const currentlyMuted = getState(device.external_id).mute === 1;
        heosCommand = buildHeosSetMuteCommand(heos.pid, !currentlyMuted);
      }
      if (!heos.client.sendCommand(heosCommand)) {
        throw new Error(`Failed to send HEOS command to ${device.external_id}`);
      }
      return;
    }
  } else if (
    (key === FEATURE.PLAY ||
      key === FEATURE.PAUSE ||
      key === FEATURE.NEXT ||
      key === FEATURE.PREVIOUS) &&
    heosConnected
  ) {
    // Unlike volume/mute, HEOS is preferred here even when Telnet is up —
    // see the routing comment further down, kept in place for the
    // Telnet-connected fallback case (HEOS reachable but pid not yet
    // matched, or momentarily disconnected).
    const heosCommand =
      key === FEATURE.PLAY
        ? buildHeosPlayCommand(heos.pid)
        : key === FEATURE.PAUSE
          ? buildHeosPauseCommand(heos.pid)
          : key === FEATURE.NEXT
            ? buildHeosPlayNextCommand(heos.pid)
            : buildHeosPlayPreviousCommand(heos.pid);
    if (!heos.client.sendCommand(heosCommand)) {
      throw new Error(`Failed to send HEOS command to ${device.external_id}`);
    }
    return;
  }

  if (!telnet || !telnetConnected) {
    throw new Error(`${device.external_id} is not connected`);
  }

  let command;
  if (key === FEATURE.POWER) {
    command = buildPowerCommand(value === 1, zone);
  } else if (key === FEATURE.VOLUME) {
    command = buildVolumeCommand(value, zone);
  } else if (key === FEATURE.MUTE) {
    // DEVICE_FEATURE_TYPES.TELEVISION.VOLUME_MUTE is a remote-control button
    // (same family as VOLUME_UP/VOLUME_DOWN), not a stateful switch like
    // POWER's BINARY type — `value` is not a target state to set, it's just
    // a "button pressed" signal (observed constant across presses on a real
    // instance: trusting it as a target made every press send the same
    // command, so the second press never undid the first). Toggle off the
    // receiver's own last-reported mute state instead.
    const currentlyMuted = getState(device.external_id).mute === 1;
    command = buildMuteCommand(!currentlyMuted, zone);
  } else if (key === FEATURE.SOURCE) {
    // TEXT.SELECT features carry their state as the selected option's own
    // string value (not the `number` the SDK types suggest — checked
    // against the Gladys core: device.setValue forwards it as-is, string or
    // number, to the integration), so `value` is already the SI code.
    command = buildSourceCommand(value, zone);
  } else if (key === FEATURE.SOURCE_INDEX) {
    // Numeric alias of SOURCE — see the feature comment in buildFeatures().
    // Same visible-list computation as the dropdown and as onLine()'s
    // publish, so index N always means the same input both ways.
    const codes = visibleSourceCodes(config?.sourceOverrides);
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= codes.length) {
      throw new Error(
        `${device.external_id}: source index ${value} is out of range (0-${codes.length - 1})`,
      );
    }
    command = buildSourceCommand(codes[index].value, zone);
  } else if (key === FEATURE.SOUND_MODE) {
    // Same TEXT.SELECT string-value case as SOURCE.
    command = buildSoundModeCommand(value);
  } else if (REMOTE_KEY_COMMAND_BY_FEATURE[key]) {
    // Setup-menu remote keys — fire-and-forget, `value` carries nothing
    // meaningful (see the comment on REMOTE_KEYS above).
    // Only the volume +/- keys actually use `zone` (MVUP vs Z2UP); the
    // Setup-menu keys drive the on-screen menu, which only exists on the
    // main zone's display, and ignore it.
    command = REMOTE_KEY_COMMAND_BY_FEATURE[key](zone);
  } else if (key === FEATURE.MENU) {
    // Toggle off the receiver's last-reported Setup-menu state, exactly
    // like Mute above — value is just a "pressed" signal, not a target.
    const menuCurrentlyOpen = getState(device.external_id).menu === 1;
    command = buildMenuCommand(!menuCurrentlyOpen);
  } else if (
    key === FEATURE.PLAY ||
    key === FEATURE.PAUSE ||
    key === FEATURE.NEXT ||
    key === FEATURE.PREVIOUS
  ) {
    // Only reached when HEOS wasn't connected (the branch above already
    // returned otherwise) — non-HEOS model, HEOS CLI unreachable, or
    // discovery hasn't matched a player id yet. These legacy commands remain
    // correct for the receiver's own non-HEOS Net/USB playback; they're
    // confirmed to have no effect on HEOS-managed sources (Qobuz/Spotify
    // Connect/TIDAL/TuneIn...), which is exactly why HEOS is preferred above
    // whenever it's actually reachable.
    command =
      key === FEATURE.PLAY
        ? buildPlayCommand()
        : key === FEATURE.PAUSE
          ? buildPauseCommand()
          : key === FEATURE.NEXT
            ? buildNextCommand()
            : buildPreviousCommand();
  } else {
    throw new Error(`Feature "${key}" is not controllable`);
  }

  if (!telnet.send(command)) {
    throw new Error(`Failed to send command to ${device.external_id}`);
  }
}

/**
 * Run one feature command on one AVR by its feature key (FEATURE.*), the
 * way a Gladys device control would — for the dashboard widget buttons and
 * the scene actions, so they share every routing rule of onSetValue().
 */
export function runFeatureCommand(gladys, externalId, key, value, config) {
  return onSetValue(gladys, {
    device: { external_id: externalId },
    feature: { external_id: featureExternalId(externalId, key) },
    value,
    config,
  });
}
