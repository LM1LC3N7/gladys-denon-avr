// -----------------------------------------------------------------------------
// Denon/Marantz "AVR Control" protocol — pure functions only.
//
// This is the plain-ASCII, line-based protocol every networked Denon/Marantz
// AVR speaks over Telnet (TCP port 23), documented in Denon's own "AVR
// control protocol" PDFs and unchanged for well over a decade. Nothing here
// talks to a socket: parseLine()/build*Command() are pure so they can be unit
// tested without a real (or fake) receiver.
//
// Reference commands used by this integration:
//   PW?   / PWON / PWSTANDBY           -> main zone power
//   MV?   / MV<nn>                     -> master volume (raw scale, see below)
//   MU?   / MUON / MUOFF               -> mute
//   SI?   / SI<CODE>                   -> input source
// -----------------------------------------------------------------------------

// Denon's raw master-volume scale: roughly 0-98, where each unit is 1 dB and
// 80 is the "reference" 0 dB mark (so the usable range is about -80 dB to
// +18 dB). Gladys wants a plain 0-100 percent, so we map linearly onto the
// raw scale. This is a reasonable generic default; the exact ceiling can
// differ per model/setup (Denon lets you cap "Maximum Volume"), so treat this
// as a starting point to calibrate against the real receiver, not a promise
// of pixel-perfect dB accuracy.
const DENON_VOLUME_MAX = 98;

// Generic SI (input source) codes from Denon's published AVR Control
// protocol spec. Not every receiver has every input (a model just ignores a
// code it doesn't have), so this list is protocol-level, not model-specific.
export const SOURCE_CODES = [
  { value: 'PHONO', label: { en: 'Phono', fr: 'Phono' } },
  { value: 'CD', label: { en: 'CD', fr: 'CD' } },
  { value: 'TUNER', label: { en: 'Tuner', fr: 'Tuner' } },
  { value: 'DVD', label: { en: 'DVD', fr: 'DVD' } },
  { value: 'BD', label: { en: 'Blu-ray', fr: 'Blu-ray' } },
  { value: 'SAT/CBL', label: { en: 'Sat/Cable', fr: 'Satellite/Câble' } },
  { value: 'MPLAY', label: { en: 'Media Player', fr: 'Lecteur multimédia' } },
  { value: 'GAME', label: { en: 'Game', fr: 'Jeu' } },
  { value: 'TV', label: { en: 'TV', fr: 'TV' } },
  { value: 'HDRADIO', label: { en: 'HD Radio', fr: 'HD Radio' } },
  { value: 'NET', label: { en: 'Network', fr: 'Réseau' } },
  { value: 'IRADIO', label: { en: 'Internet Radio', fr: 'Radio internet' } },
  { value: 'SERVER', label: { en: 'Media Server', fr: 'Serveur média' } },
  { value: 'FAVORITES', label: { en: 'Favorites', fr: 'Favoris' } },
  { value: 'USB/IPOD', label: { en: 'USB/iPod', fr: 'USB/iPod' } },
  { value: 'BT', label: { en: 'Bluetooth', fr: 'Bluetooth' } },
  { value: 'AUX1', label: { en: 'Aux 1', fr: 'Aux 1' } },
  { value: 'AUX2', label: { en: 'Aux 2', fr: 'Aux 2' } },
  { value: 'AUX3', label: { en: 'Aux 3', fr: 'Aux 3' } },
  { value: 'AUX4', label: { en: 'Aux 4', fr: 'Aux 4' } },
  { value: 'AUX5', label: { en: 'Aux 5', fr: 'Aux 5' } },
  { value: 'AUX6', label: { en: 'Aux 6', fr: 'Aux 6' } },
  { value: 'AUX7', label: { en: 'Aux 7', fr: 'Aux 7' } },
];

/**
 * Convert a Gladys volume percent (0-100) to a Denon raw volume integer
 * (0-DENON_VOLUME_MAX).
 */
export function percentToDenonVolume(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent)));
  return Math.round((clamped / 100) * DENON_VOLUME_MAX);
}

/**
 * Convert a Denon raw volume value (integer, or integer + 0.5 for the
 * half-step 3-digit form, e.g. 80.5) to a Gladys volume percent (0-100).
 */
export function denonVolumeToPercent(rawVolume) {
  const clamped = Math.max(0, Math.min(DENON_VOLUME_MAX, Number(rawVolume)));
  return Math.round((clamped / DENON_VOLUME_MAX) * 100);
}

/**
 * Parse ONE line received from the receiver's Telnet session into a
 * `{ feature: 'power' | 'volume' | 'mute' | 'source', value }` update, or
 * `null` when the line is not one this integration reacts to (there are many
 * other status lines: tone controls, surround mode, zone 2/3...).
 *
 * `value` is already in Gladys terms: booleans for power/mute (as 0|1), a
 * 0-100 percent number for volume, the raw SI code string for source.
 */
export function parseLine(rawLine) {
  const line = String(rawLine).trim();
  if (line.length === 0) {
    return null;
  }

  if (line.startsWith('PWON')) {
    return { feature: 'power', value: 1 };
  }
  if (line.startsWith('PWSTANDBY')) {
    return { feature: 'power', value: 0 };
  }

  if (line.startsWith('MUON')) {
    return { feature: 'mute', value: 1 };
  }
  if (line.startsWith('MUOFF')) {
    return { feature: 'mute', value: 0 };
  }

  // MVMAX<space><nn> reports the volume ceiling, not the current volume —
  // must be excluded before the generic MV<digits> match below.
  if (line.startsWith('MVMAX')) {
    return null;
  }
  if (line.startsWith('MV')) {
    const digits = line.slice(2);
    if (!/^\d{2,3}$/.test(digits)) {
      return null;
    }
    // 2 digits: whole dB step (e.g. "50"). 3 digits: half-step, last digit
    // is 5 for +0.5 (e.g. "805" -> 80.5), 0 otherwise (e.g. "800" -> 80.0).
    const rawVolume =
      digits.length === 2
        ? Number(digits)
        : Number(digits.slice(0, 2)) + (digits.endsWith('5') ? 0.5 : 0);
    return { feature: 'volume', value: denonVolumeToPercent(rawVolume) };
  }

  if (line.startsWith('SI')) {
    const code = line.slice(2).trim();
    if (code.length === 0) {
      return null;
    }
    return { feature: 'source', value: code };
  }

  return null;
}

/** Build the command that queries the current power state (no trailing CR). */
export function buildPowerQuery() {
  return 'PW?';
}

/** Build the command that sets power on/off (no trailing CR). */
export function buildPowerCommand(on) {
  return on ? 'PWON' : 'PWSTANDBY';
}

/** Build the command that queries the current volume (no trailing CR). */
export function buildVolumeQuery() {
  return 'MV?';
}

/** Build the command that sets the volume from a 0-100 percent (no trailing CR). */
export function buildVolumeCommand(percent) {
  return `MV${String(percentToDenonVolume(percent)).padStart(2, '0')}`;
}

/** Build the command that queries the current mute state (no trailing CR). */
export function buildMuteQuery() {
  return 'MU?';
}

/** Build the command that sets mute on/off (no trailing CR). */
export function buildMuteCommand(on) {
  return on ? 'MUON' : 'MUOFF';
}

/** Build the command that queries the current input source (no trailing CR). */
export function buildSourceQuery() {
  return 'SI?';
}

/** Build the command that selects an input source by its SI code (no trailing CR). */
export function buildSourceCommand(code) {
  return `SI${code}`;
}
