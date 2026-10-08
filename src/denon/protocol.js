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
//   ZM?   / ZMON / ZMOFF               -> main zone power (see ZONE below)
//   PWSTANDBY (push only)              -> whole unit in standby: every zone off
//   MV?   / MV<nn>                     -> master volume (raw scale, see below)
//   MU?   / MUON / MUOFF               -> mute
//   SI?   / SI<CODE>                   -> input source
//   Z2? / Z2ON / Z2OFF / Z2<nn> / Z2<CODE> / Z2MU? / Z2MUON / Z2MUOFF / Z2UP / Z2DOWN
//                                      -> the same for Zone 2 (Z3... for Zone 3)
//   MS?   / MS<MODE>                   -> surround/sound mode
//   NS9A / NS9B / NS9D / NS9E          -> network/USB transport: play/pause/next/previous
//   NSE0<text> / NSE1<text> / NSE2<text> -> pushed while playing: playback state / title / artist
//   MNCUP / MNCDN / MNCLT / MNCRT      -> Setup menu cursor: up/down/left/right
//   MNENT / MNRTN / MNINF              -> Setup menu: enter / return / info
//   MNMEN ON / MNMEN OFF               -> Setup menu open/close
//   MVUP / MVDOWN                      -> relative volume step (the remote's +/- keys)
//   MSQUICK1-5 / MSQUICK ? (Z2QUICK...) -> Quick Select presets (source + volume + mode)
//   TFANUP / TFANDOWN / TFAN?          -> analog tuner frequency step / status
//   TPANUP / TPANDOWN / TPAN?          -> analog tuner preset step / status
//   TMANAM / TMANFM / TMANAUTO / TMANMANUAL / TMAN? -> tuner band, tuning mode
//
// The Quick Select and tuner rows come from Denon's own published protocol
// (AVR-X2000/E400 "PROTOCOL 10.1.0", 2013), like the first four groups. The
// tuner commands only act while the input source is TUNER (spelled out in
// that document), and the AM/FM band commands are "North America model
// only" there.
//
// The last four groups are NOT in the same official reference PDF the first
// four come from (network/HEOS control and the Setup-menu remote keys were
// both added to the protocol later, and Denon never published as clean a
// spec for either) — cross-checked against two independent, actively-
// maintained community implementations instead (python denonavr, used by
// Home Assistant; the node denon-remote CLI) that agree on these codes.
// Genuinely lower confidence than the rest of this file: verify with
// `node scripts/debug-telnet.js <host>` (send `MS?` and start playback on a
// NET/USB source to see the real NSE lines; open the Setup menu on the
// receiver's own screen to see the real MNMEN line) before relying on this
// against your own receiver.
// -----------------------------------------------------------------------------

// Denon's raw master-volume scale: roughly 0-98, where each unit is 1 dB and
// 80 is the "reference" 0 dB mark (so the usable range is about -80 dB to
// +18 dB). Gladys wants a plain 0-100 percent, so we map linearly onto the
// raw scale. This is a reasonable generic default; the exact ceiling can
// differ per model/setup (Denon lets you cap "Maximum Volume"), so treat this
// as a starting point to calibrate against the real receiver, not a promise
// of pixel-perfect dB accuracy.
const DENON_VOLUME_MAX = 98;

// Zones a multi-zone receiver exposes over the same Telnet session. Every
// zone-aware builder/parser below defaults to ZONE.MAIN, and so does the
// `zone` config key (src/config.js): the main zone is the one this
// integration targets unless the user explicitly asks otherwise.
//
// Why power is ZM (not PW) for the main zone: PWON/PWSTANDBY are *system*
// commands. PWSTANDBY puts every zone in standby (it would also cut a Zone 2
// someone is listening to), and PWON wakes the unit up restoring whichever
// zones were on last — so PWON could, and on real hardware did, bring the
// receiver back on Zone 2 instead of the main zone depending on how it was
// last turned off. ZMON/ZMOFF only ever touch the main zone (ZMOFF with
// every other zone off puts the unit in standby all the same). For the same
// reason a bare PWON push is NOT read as "main zone on" (it's also sent when
// only Zone 2 wakes the unit up) — the ZMON/ZMOFF push that follows it is.
export const ZONE = {
  MAIN: 'main',
  ZONE2: 'zone2',
  ZONE3: 'zone3',
};

const ZONE_PREFIX = {
  [ZONE.ZONE2]: 'Z2',
  [ZONE.ZONE3]: 'Z3',
};

/** Normalize anything (config value, undefined...) to a known ZONE value — main by default. */
export function normalizeZone(zone) {
  return Object.values(ZONE).includes(zone) ? zone : ZONE.MAIN;
}

/** Telnet prefix of a secondary zone ("Z2"/"Z3"), or null for the main zone. */
function zonePrefix(zone) {
  return ZONE_PREFIX[normalizeZone(zone)] ?? null;
}

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
 *
 * `zone` selects which zone's power/volume/mute/source lines are reported
 * (see ZONE above); the other zones' lines are ignored, so a Zone 2 volume
 * change can never be mistaken for the main zone's and vice versa. Lines that
 * aren't per-zone (sound mode, Setup menu, NSE now-playing) are reported
 * whatever the zone.
 */
export function parseLine(rawLine, zone = ZONE.MAIN) {
  const line = String(rawLine).trim();
  if (line.length === 0) {
    return null;
  }

  // Whole unit in standby: every zone is off, whichever one we follow.
  if (line.startsWith('PWSTANDBY')) {
    return { feature: 'power', value: 0 };
  }
  // PWON is deliberately ignored — see the comment above ZONE.
  if (line.startsWith('PW')) {
    return null;
  }

  const prefix = zonePrefix(zone);
  if (prefix) {
    return parseSecondaryZoneLine(line, prefix);
  }
  // Another zone's line (Z2..., Z3...): never ours in main-zone mode.
  if (/^Z\d/.test(line)) {
    return null;
  }

  if (line.startsWith('ZMON')) {
    return { feature: 'power', value: 1 };
  }
  if (line.startsWith('ZMOFF')) {
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
    return parseVolumeDigits(line.slice(2));
  }

  if (line.startsWith('SI')) {
    const code = line.slice(2).trim();
    if (code.length === 0) {
      return null;
    }
    return { feature: 'source', value: code };
  }

  return parseZoneIndependentLine(line);
}

/**
 * Volume digits (whatever follows MV/Z2/Z3) -> `{ feature: 'volume', value }`,
 * or null when they aren't a volume. 2 digits: whole dB step (e.g. "50").
 * 3 digits: half-step, last digit is 5 for +0.5 (e.g. "805" -> 80.5), 0
 * otherwise (e.g. "800" -> 80.0).
 */
function parseVolumeDigits(digits) {
  if (!/^\d{2,3}$/.test(digits)) {
    return null;
  }
  const rawVolume =
    digits.length === 2
      ? Number(digits)
      : Number(digits.slice(0, 2)) + (digits.endsWith('5') ? 0.5 : 0);
  return { feature: 'volume', value: denonVolumeToPercent(rawVolume) };
}

// Everything a Z2/Z3 line can carry after its prefix that is a source: the
// known SI codes plus SOURCE ("follow the main zone's input"). Z2/Z3 lines
// have no separate "SI" marker the way the main zone does — Z2CD is the
// source, Z250 the volume, Z2ON the power, and other Z2 status lines exist
// too (Z2CS channel setting, Z2SLP sleep timer, Z2HPF...), so only an exact
// known code is accepted as a source rather than "anything else".
const SECONDARY_ZONE_SOURCES = new Set([...SOURCE_CODES.map((code) => code.value), 'SOURCE']);

function parseSecondaryZoneLine(line, prefix) {
  if (!line.startsWith(prefix)) {
    // The main zone's Quick Select (MSQUICK) is not this zone's (Z2QUICK).
    return line.startsWith('MSQUICK') ? null : parseZoneIndependentLine(line);
  }
  const rest = line.slice(prefix.length).trim();
  if (rest === 'ON') {
    return { feature: 'power', value: 1 };
  }
  if (rest === 'OFF') {
    return { feature: 'power', value: 0 };
  }
  if (rest === 'MUON') {
    return { feature: 'mute', value: 1 };
  }
  if (rest === 'MUOFF') {
    return { feature: 'mute', value: 0 };
  }
  if (/^\d/.test(rest)) {
    return parseVolumeDigits(rest);
  }
  if (rest.startsWith('QUICK')) {
    return parseQuickSelect(rest.slice(5));
  }
  if (SECONDARY_ZONE_SOURCES.has(rest)) {
    return { feature: 'source', value: rest };
  }
  return null;
}

/** Lines that aren't tied to one zone: Setup menu, sound mode, NSE now-playing. */
function parseZoneIndependentLine(line) {
  // MNMEN<space>ON / MNMEN<space>OFF: the on-screen Setup menu opened/closed
  // — by this integration, the physical remote, or the receiver itself.
  // Also tolerates the no-space form (MNMENON), matching how PWON/MUON never
  // carry the space their own send-command syntax doesn't require either.
  if (line.startsWith('MNMEN')) {
    const state = line.slice(5).replace(/\s+/g, '');
    if (state === 'ON') {
      return { feature: 'menu', value: 1 };
    }
    if (state === 'OFF') {
      return { feature: 'menu', value: 0 };
    }
    return null;
  }

  // MSQUICK<n> shares the MS prefix but is the main zone's Quick Select, not
  // a sound mode: without this check, MSQUICK1 used to be published as a
  // sound mode named "QUICK1". The secondary zones' own Z2QUICK/Z3QUICK are
  // read in parseSecondaryZoneLine(); in main-zone mode they never reach here.
  if (line.startsWith('MSQUICK')) {
    return parseQuickSelect(line.slice(7));
  }

  // MS is the main zone's surround mode (secondary zones have none); still
  // reported in every zone mode, like the Setup menu, see parseLine().
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

  // The tuner is shared by every zone, so its lines are reported whatever
  // the zone, like the sound mode above.
  if (line.startsWith('TFAN')) {
    const digits = line.slice(4).trim();
    return /^\d{6}$/.test(digits) ? { feature: 'tuner_frequency', value: Number(digits) } : null;
  }
  if (line.startsWith('TPAN')) {
    return parseTunerPreset(line.slice(4).trim());
  }
  if (line.startsWith('TMAN')) {
    const value = line.slice(4).trim();
    if (value === 'AM' || value === 'FM') {
      return { feature: 'tuner_band', value };
    }
    if (value === 'AUTO' || value === 'MANUAL') {
      return { feature: 'tuner_mode', value };
    }
    return null;
  }

  return null;
}

/** Whatever follows MSQUICK/Z2QUICK: "1"-"5" (selected) or "0" (none) -> quick_select. */
function parseQuickSelect(rest) {
  const value = rest.trim();
  return /^[0-5]$/.test(value) ? { feature: 'quick_select', value: Number(value) } : null;
}

// Preset banks of the TPAN status, A1-G8 = channels 1-56 ("A5=CH5, B2=CH10,
// C4=CH20" in Denon's protocol). Newer firmwares report the plain two-digit
// channel instead ("TPAN06"), so both forms are read.
const TUNER_PRESET_BANKS = 'ABCDEFG';

function parseTunerPreset(rest) {
  if (rest === 'OFF') {
    return { feature: 'tuner_preset', value: 0 };
  }
  // TPANMEM<n> is "preset stored", not the current preset.
  if (/^\d{2}$/.test(rest)) {
    const channel = Number(rest);
    return channel >= 1 && channel <= 56 ? { feature: 'tuner_preset', value: channel } : null;
  }
  const bank = /^([A-G])([1-8])$/.exec(rest);
  if (bank) {
    return {
      feature: 'tuner_preset',
      value: TUNER_PRESET_BANKS.indexOf(bank[1]) * 8 + Number(bank[2]),
    };
  }
  return null;
}

/**
 * Read a TFAN frequency (6 digits, "****.**") the way Denon's protocol
 * defines it: below 050000 it is FM in MHz (008750 = 87.50 MHz), from
 * 050000 up AM in kHz (105000 = 1050.00 kHz). Returns
 * `{ band: 'FM' | 'AM', value, unit: 'MHz' | 'kHz' }`, or null.
 */
export function describeTunerFrequency(raw) {
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0 || number > 999999) {
    return null;
  }
  return number < 50000
    ? { band: 'FM', value: number / 100, unit: 'MHz' }
    : { band: 'AM', value: number / 100, unit: 'kHz' };
}

/**
 * Build the command that queries a zone's power state (no trailing CR).
 * Main zone: ZM? (not PW? — see the comment above ZONE). A secondary zone's
 * bare Z2?/Z3? query answers with its power, volume and source all at once.
 */
export function buildPowerQuery(zone = ZONE.MAIN) {
  const prefix = zonePrefix(zone);
  return prefix ? `${prefix}?` : 'ZM?';
}

/** Build the command that turns a zone on/off (no trailing CR) — never the whole-unit PW commands. */
export function buildPowerCommand(on, zone = ZONE.MAIN) {
  const prefix = zonePrefix(zone) ?? 'ZM';
  return `${prefix}${on ? 'ON' : 'OFF'}`;
}

/** Build the command that queries a zone's current volume (no trailing CR). */
export function buildVolumeQuery(zone = ZONE.MAIN) {
  const prefix = zonePrefix(zone);
  return prefix ? `${prefix}?` : 'MV?';
}

/** Build the command that sets a zone's volume from a 0-100 percent (no trailing CR). */
export function buildVolumeCommand(percent, zone = ZONE.MAIN) {
  const prefix = zonePrefix(zone) ?? 'MV';
  return `${prefix}${String(percentToDenonVolume(percent)).padStart(2, '0')}`;
}

/** Build the command that queries a zone's current mute state (no trailing CR). */
export function buildMuteQuery(zone = ZONE.MAIN) {
  const prefix = zonePrefix(zone);
  return prefix ? `${prefix}MU?` : 'MU?';
}

/** Build the command that sets a zone's mute on/off (no trailing CR). */
export function buildMuteCommand(on, zone = ZONE.MAIN) {
  const prefix = zonePrefix(zone) ?? '';
  return `${prefix}${on ? 'MUON' : 'MUOFF'}`;
}

/** Build the command that queries a zone's current input source (no trailing CR). */
export function buildSourceQuery(zone = ZONE.MAIN) {
  const prefix = zonePrefix(zone);
  return prefix ? `${prefix}?` : 'SI?';
}

/** Build the command that selects a zone's input source by its SI code (no trailing CR). */
export function buildSourceCommand(code, zone = ZONE.MAIN) {
  const prefix = zonePrefix(zone) ?? 'SI';
  return `${prefix}${code}`;
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

/**
 * Setup-menu remote-control keys (no trailing CR): the cursor pad, Enter,
 * Return, Info and the Menu open/close toggle a physical Denon/Marantz
 * remote sends while navigating the on-screen Setup menu. Not in the same
 * official protocol PDF as PW/MV/MU/SI/MS (Denon never published as clean a
 * spec for these either) — cross-checked instead against the actively
 * maintained python-denonavr project (the library behind Home Assistant's
 * own Denon integration), same lower-confidence flag as the NS9x transport
 * commands above: verify with scripts/debug-telnet.js against your own
 * receiver before relying on it.
 */
export function buildCursorUpCommand() {
  return 'MNCUP';
}
export function buildCursorDownCommand() {
  return 'MNCDN';
}
export function buildCursorLeftCommand() {
  return 'MNCLT';
}
export function buildCursorRightCommand() {
  return 'MNCRT';
}
export function buildEnterCommand() {
  return 'MNENT';
}
export function buildReturnCommand() {
  return 'MNRTN';
}
export function buildInfoCommand() {
  return 'MNINF';
}

/** Build the command that queries the current Setup-menu open/closed state (no trailing CR). */
export function buildMenuQuery() {
  return 'MNMEN?';
}

/** Build the command that opens/closes the on-screen Setup menu (no trailing CR). */
export function buildMenuCommand(open) {
  return open ? 'MNMEN ON' : 'MNMEN OFF';
}

/** Build the relative volume step commands (no trailing CR) — mirrors the remote's +/- keys. */
export function buildVolumeUpCommand(zone = ZONE.MAIN) {
  return `${zonePrefix(zone) ?? 'MV'}UP`;
}
export function buildVolumeDownCommand(zone = ZONE.MAIN) {
  return `${zonePrefix(zone) ?? 'MV'}DOWN`;
}

/** Quick Select presets 1-5 (no trailing CR): MSQUICK<n>, Z2QUICK<n> for Zone 2. */
export function buildQuickSelectCommand(number, zone = ZONE.MAIN) {
  const preset = Number(number);
  if (!Number.isInteger(preset) || preset < 1 || preset > 5) {
    throw new Error(`Quick Select ${number} does not exist (1-5)`);
  }
  return `${zonePrefix(zone) ?? 'MS'}QUICK${preset}`;
}

/** Build the command that queries the current Quick Select (no trailing CR). */
export function buildQuickSelectQuery(zone = ZONE.MAIN) {
  return `${zonePrefix(zone) ?? 'MS'}QUICK ?`;
}

/** Analog tuner queries (no trailing CR): frequency, preset, band + tuning mode. */
export function buildTunerQueries() {
  return ['TFAN?', 'TPAN?', 'TMAN?'];
}

/**
 * Analog tuner commands (no trailing CR), keyed the way the Radio widget
 * names its buttons. Only effective while the input source is TUNER.
 */
export const TUNER_COMMANDS = Object.freeze({
  frequency_up: 'TFANUP',
  frequency_down: 'TFANDOWN',
  preset_up: 'TPANUP',
  preset_down: 'TPANDOWN',
  band_fm: 'TMANFM',
  band_am: 'TMANAM',
  mode_auto: 'TMANAUTO',
  mode_manual: 'TMANMANUAL',
});
