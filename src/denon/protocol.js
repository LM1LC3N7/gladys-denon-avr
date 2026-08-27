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
//   MS?   / MS<MODE>                   -> surround/sound mode
//   NS9A / NS9B / NS9D / NS9E          -> network/USB transport: play/pause/next/previous
//   NSE0<text> / NSE1<text> / NSE2<text> -> pushed while playing: playback state / title / artist
//
// The last three groups are NOT in the same official reference PDF the first
// four come from (network/HEOS control was added to the protocol later, and
// Denon never published as clean a spec for it) — cross-checked against two
// independent, actively-maintained community implementations instead
// (python denonavr, used by Home Assistant; the node denon-remote CLI) that
// agree on the NS9x codes. Genuinely lower confidence than the rest of this
// file: verify with `node scripts/debug-telnet.js <host>` (send `MS?` and
// start playback on a NET/USB source to see the real NSE lines) before
// relying on this against your own receiver.
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

// Generic MS (surround/sound mode) codes. Varies far more across
// generations than SOURCE_CODES (naming changed repeatedly as Dolby/DTS
// added formats over the years) — this is a reasonable starting set, not a
// promise of completeness for every model. Same tolerance as source codes:
// a receiver ignores a mode it doesn't have, so sending an unsupported one
// is harmless. Note the literal spaces in some values (e.g. "PURE DIRECT")
// — that space is part of the command Denon expects, not a typo.
export const SOUND_MODE_CODES = [
  { value: 'MOVIE', label: { en: 'Movie', fr: 'Film' } },
  { value: 'MUSIC', label: { en: 'Music', fr: 'Musique' } },
  { value: 'GAME', label: { en: 'Game', fr: 'Jeu' } },
  { value: 'DIRECT', label: { en: 'Direct', fr: 'Direct' } },
  { value: 'PURE DIRECT', label: { en: 'Pure Direct', fr: 'Pure Direct' } },
  { value: 'STEREO', label: { en: 'Stereo', fr: 'Stéréo' } },
  { value: 'STANDARD', label: { en: 'Standard', fr: 'Standard' } },
  { value: 'DOLBY DIGITAL', label: { en: 'Dolby Digital', fr: 'Dolby Digital' } },
  { value: 'DTS SURROUND', label: { en: 'DTS Surround', fr: 'DTS Surround' } },
  { value: 'MCH STEREO', label: { en: 'Multi-Channel Stereo', fr: 'Stéréo multicanal' } },
  { value: 'VIRTUAL', label: { en: 'Virtual', fr: 'Virtuel' } },
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

  // Must come before the SI/generic checks would ever be extended to a
  // bare "S" prefix — not currently a risk, but MS itself is unambiguous.
  if (line.startsWith('MS')) {
    const mode = line.slice(2).trim();
    if (mode.length === 0) {
      return null;
    }
    return { feature: 'sound_mode', value: mode };
  }

  // NSE<n><text>: pushed while a NET/USB/streaming source is playing. Only
  // the rows every source we've seen documented shares are handled; other
  // rows (album, playback position/percentage, station name...) are
  // silently ignored like any other status line this integration doesn't
  // react to. Trailing "_" is fixed-width padding, not part of the text.
  //
  // NSE0 is the receiver's own "Now Playing <source>" banner — not a
  // second copy of the source (that's SI), the one line confirmed (in the
  // denonavr project, used by Home Assistant) to double as the playback
  // state: it reads exactly "Now Playing ..." while playing, anything else
  // otherwise. There is no separate "paused" signal over Telnet — the
  // MUSIC.PLAYBACK_STATE feature Gladys' Music dashboard box requires only
  // has PLAYING/PAUSED anyway (see src/devices/avr.js), so "not playing"
  // maps to PAUSED here, whether the receiver actually considers itself
  // paused or fully stopped.
  if (line.startsWith('NSE0')) {
    const text = line.slice(4).replace(/_+$/, '').trim();
    return { feature: 'playback_state', value: text.startsWith('Now Playing') ? 1 : 0 };
  }
  if (line.startsWith('NSE1')) {
    const title = line.slice(4).replace(/_+$/, '').trim();
    return title.length === 0 ? null : { feature: 'now_playing_title', value: title };
  }
  if (line.startsWith('NSE2')) {
    const artist = line.slice(4).replace(/_+$/, '').trim();
    return artist.length === 0 ? null : { feature: 'now_playing_artist', value: artist };
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

/** Build the command that queries the current surround/sound mode (no trailing CR). */
export function buildSoundModeQuery() {
  return 'MS?';
}

/** Build the command that sets the surround/sound mode by its MS code (no trailing CR). */
export function buildSoundModeCommand(mode) {
  return `MS${mode}`;
}

/**
 * Build the network/USB transport commands (no trailing CR). One-shot
 * remote-control buttons (see DEVICE_FEATURE_TYPES.MUSIC in avr.js) — no
 * query exists for "current playback state" the way PW?/MV?/MU?/SI? do.
 */
export function buildPlayCommand() {
  return 'NS9A';
}
export function buildPauseCommand() {
  return 'NS9B';
}
export function buildNextCommand() {
  return 'NS9D';
}
export function buildPreviousCommand() {
  return 'NS9E';
}
