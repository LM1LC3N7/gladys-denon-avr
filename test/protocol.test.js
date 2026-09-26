import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine,
  buildPowerQuery,
  buildPowerCommand,
  buildVolumeQuery,
  buildVolumeCommand,
  buildMuteQuery,
  buildMuteCommand,
  buildSourceQuery,
  buildSourceCommand,
  buildSoundModeQuery,
  buildSoundModeCommand,
  buildPlayCommand,
  buildPauseCommand,
  buildNextCommand,
  buildPreviousCommand,
  buildCursorUpCommand,
  buildCursorDownCommand,
  buildCursorLeftCommand,
  buildCursorRightCommand,
  buildEnterCommand,
  buildReturnCommand,
  buildInfoCommand,
  buildMenuQuery,
  buildMenuCommand,
  buildVolumeUpCommand,
  buildVolumeDownCommand,
  percentToDenonVolume,
  denonVolumeToPercent,
  normalizeZone,
  ZONE,
  SOURCE_CODES,
  SOUND_MODE_CODES,
} from '../src/denon/protocol.js';

test('parseLine: main zone power is ZMON/ZMOFF, PWSTANDBY means off, a bare PWON is ignored', () => {
  assert.deepEqual(parseLine('ZMON'), { feature: 'power', value: 1 });
  assert.deepEqual(parseLine('ZMOFF'), { feature: 'power', value: 0 });
  assert.deepEqual(parseLine('PWSTANDBY'), { feature: 'power', value: 0 });
  // PWON is also pushed when only Zone 2 wakes the unit up: not "main zone on".
  assert.equal(parseLine('PWON'), null);
});

test('parseLine: other zones never leak into the main zone (the default)', () => {
  assert.equal(parseLine('Z2ON'), null);
  assert.equal(parseLine('Z250'), null);
  assert.equal(parseLine('Z2MUON'), null);
  assert.equal(parseLine('Z2CD'), null);
  assert.equal(parseLine('Z3OFF'), null);
  assert.equal(parseLine('Z2ON', ZONE.MAIN), null);
  assert.equal(parseLine('Z2ON', 'nonsense'), null, 'an unknown zone falls back to main');
});

test('parseLine: zone 2 power/volume/mute/source, main zone lines ignored', () => {
  assert.deepEqual(parseLine('Z2ON', ZONE.ZONE2), { feature: 'power', value: 1 });
  assert.deepEqual(parseLine('Z2OFF', ZONE.ZONE2), { feature: 'power', value: 0 });
  assert.deepEqual(parseLine('PWSTANDBY', ZONE.ZONE2), { feature: 'power', value: 0 });
  assert.deepEqual(parseLine('Z250', ZONE.ZONE2), {
    feature: 'volume',
    value: denonVolumeToPercent(50),
  });
  assert.deepEqual(parseLine('Z2MUON', ZONE.ZONE2), { feature: 'mute', value: 1 });
  assert.deepEqual(parseLine('Z2MUOFF', ZONE.ZONE2), { feature: 'mute', value: 0 });
  assert.deepEqual(parseLine('Z2TUNER', ZONE.ZONE2), { feature: 'source', value: 'TUNER' });
  assert.deepEqual(parseLine('Z2SAT/CBL', ZONE.ZONE2), { feature: 'source', value: 'SAT/CBL' });
  assert.deepEqual(parseLine('Z2SOURCE', ZONE.ZONE2), { feature: 'source', value: 'SOURCE' });
  // Other Z2 status lines are not sources.
  assert.equal(parseLine('Z2CSST', ZONE.ZONE2), null);
  assert.equal(parseLine('Z2SLPOFF', ZONE.ZONE2), null);
  // The main zone's own lines, and zone 3's, are not zone 2's.
  assert.equal(parseLine('ZMON', ZONE.ZONE2), null);
  assert.equal(parseLine('MV50', ZONE.ZONE2), null);
  assert.equal(parseLine('MUON', ZONE.ZONE2), null);
  assert.equal(parseLine('SITUNER', ZONE.ZONE2), null);
  assert.equal(parseLine('Z3ON', ZONE.ZONE2), null);
  // Zone-independent lines are still reported.
  assert.deepEqual(parseLine('MSMOVIE', ZONE.ZONE2), { feature: 'sound_mode', value: 'MOVIE' });
  assert.deepEqual(parseLine('MNMEN ON', ZONE.ZONE2), { feature: 'menu', value: 1 });
});

test('parseLine: zone 3 uses the Z3 prefix', () => {
  assert.deepEqual(parseLine('Z3ON', ZONE.ZONE3), { feature: 'power', value: 1 });
  assert.deepEqual(parseLine('Z340', ZONE.ZONE3), {
    feature: 'volume',
    value: denonVolumeToPercent(40),
  });
  assert.equal(parseLine('Z2ON', ZONE.ZONE3), null);
});

test('normalizeZone defaults anything unknown to the main zone', () => {
  assert.equal(normalizeZone(undefined), ZONE.MAIN);
  assert.equal(normalizeZone(''), ZONE.MAIN);
  assert.equal(normalizeZone('zone4'), ZONE.MAIN);
  assert.equal(normalizeZone('zone2'), ZONE.ZONE2);
  assert.equal(normalizeZone('zone3'), ZONE.ZONE3);
});

test('parseLine: mute', () => {
  assert.deepEqual(parseLine('MUON'), { feature: 'mute', value: 1 });
  assert.deepEqual(parseLine('MUOFF'), { feature: 'mute', value: 0 });
});

test('parseLine: volume, two-digit whole steps', () => {
  assert.deepEqual(parseLine('MV50'), { feature: 'volume', value: denonVolumeToPercent(50) });
  assert.deepEqual(parseLine('MV00'), { feature: 'volume', value: 0 });
  assert.deepEqual(parseLine('MV98'), { feature: 'volume', value: 100 });
});

test('parseLine: volume, three-digit half steps', () => {
  assert.deepEqual(parseLine('MV805'), { feature: 'volume', value: denonVolumeToPercent(80.5) });
  assert.deepEqual(parseLine('MV800'), { feature: 'volume', value: denonVolumeToPercent(80) });
});

test('parseLine: MVMAX is ignored (volume ceiling, not current volume)', () => {
  assert.equal(parseLine('MVMAX 98'), null);
});

test('parseLine: source, verbatim SI code, including ones with a slash', () => {
  assert.deepEqual(parseLine('SITUNER'), { feature: 'source', value: 'TUNER' });
  assert.deepEqual(parseLine('SISAT/CBL'), { feature: 'source', value: 'SAT/CBL' });
});

test('parseLine: sound mode, verbatim MS code, including ones with a space', () => {
  assert.deepEqual(parseLine('MSMOVIE'), { feature: 'sound_mode', value: 'MOVIE' });
  assert.deepEqual(parseLine('MSPURE DIRECT'), { feature: 'sound_mode', value: 'PURE DIRECT' });
});

test('parseLine: now-playing title/artist (NSE1/NSE2), trailing padding stripped', () => {
  assert.deepEqual(parseLine('NSE1Come Away With Me___'), {
    feature: 'now_playing_title',
    value: 'Come Away With Me',
  });
  assert.deepEqual(parseLine('NSE2Norah Jones'), {
    feature: 'now_playing_artist',
    value: 'Norah Jones',
  });
});

test('parseLine: playback state (NSE0) is derived from the "Now Playing ..." banner text, not a dedicated flag', () => {
  assert.deepEqual(parseLine('NSE0Now Playing USB'), { feature: 'playback_state', value: 1 });
  // No separate Telnet "paused" signal exists: anything that isn't the
  // "Now Playing ..." banner maps to 0 (see the comment above this check
  // in protocol.js for why that's the correct call for a binary feature).
  assert.deepEqual(parseLine('NSE0Bluetooth Standby'), { feature: 'playback_state', value: 0 });
});

test('parseLine: an empty MS/NSE1/NSE2 payload is ignored, not published as a blank value', () => {
  assert.equal(parseLine('MS'), null);
  assert.equal(parseLine('NSE1'), null);
  assert.equal(parseLine('NSE1____'), null);
});

test('parseLine: other NSE rows (position, station name...) are ignored, only 0/1/2 are handled', () => {
  assert.equal(parseLine('NSE500:11 100%'), null);
  assert.equal(parseLine('NSE3Some Album'), null);
});

test('parseLine: Setup menu open/closed (MNMEN), with and without the space', () => {
  assert.deepEqual(parseLine('MNMEN ON'), { feature: 'menu', value: 1 });
  assert.deepEqual(parseLine('MNMEN OFF'), { feature: 'menu', value: 0 });
  assert.deepEqual(parseLine('MNMENON'), { feature: 'menu', value: 1 });
  assert.deepEqual(parseLine('MNMENOFF'), { feature: 'menu', value: 0 });
});

test('parseLine: an MNMEN reply that is neither ON nor OFF (e.g. an echoed query) is ignored', () => {
  assert.equal(parseLine('MNMEN?'), null);
});

test('parseLine: unrecognized or empty lines are ignored', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('   '), null);
  assert.equal(parseLine('PWON'), null);
});

test('parseLine trims incoming whitespace/CR', () => {
  assert.deepEqual(parseLine('  ZMON\r'), { feature: 'power', value: 1 });
});

test('volume percent <-> Denon raw scale round-trips at the boundaries', () => {
  assert.equal(percentToDenonVolume(0), 0);
  assert.equal(percentToDenonVolume(100), 98);
  assert.equal(denonVolumeToPercent(0), 0);
  assert.equal(denonVolumeToPercent(98), 100);
});

test('volume percent is clamped to 0-100 and the raw scale to 0-98', () => {
  assert.equal(percentToDenonVolume(-10), 0);
  assert.equal(percentToDenonVolume(150), 98);
  assert.equal(denonVolumeToPercent(-5), 0);
  assert.equal(denonVolumeToPercent(200), 100);
});

test('command builders produce the exact protocol strings, no trailing CR', () => {
  assert.equal(buildPowerQuery(), 'ZM?');
  assert.equal(buildPowerCommand(true), 'ZMON');
  assert.equal(buildPowerCommand(false), 'ZMOFF');
  assert.equal(buildVolumeQuery(), 'MV?');
  assert.equal(buildVolumeCommand(50), 'MV49');
  assert.equal(buildMuteQuery(), 'MU?');
  assert.equal(buildMuteCommand(true), 'MUON');
  assert.equal(buildMuteCommand(false), 'MUOFF');
  assert.equal(buildSourceQuery(), 'SI?');
  assert.equal(buildSourceCommand('TUNER'), 'SITUNER');
  assert.equal(buildSoundModeQuery(), 'MS?');
  assert.equal(buildSoundModeCommand('MOVIE'), 'MSMOVIE');
  assert.equal(buildPlayCommand(), 'NS9A');
  assert.equal(buildPauseCommand(), 'NS9B');
  assert.equal(buildNextCommand(), 'NS9D');
  assert.equal(buildPreviousCommand(), 'NS9E');
  assert.equal(buildCursorUpCommand(), 'MNCUP');
  assert.equal(buildCursorDownCommand(), 'MNCDN');
  assert.equal(buildCursorLeftCommand(), 'MNCLT');
  assert.equal(buildCursorRightCommand(), 'MNCRT');
  assert.equal(buildEnterCommand(), 'MNENT');
  assert.equal(buildReturnCommand(), 'MNRTN');
  assert.equal(buildInfoCommand(), 'MNINF');
  assert.equal(buildMenuQuery(), 'MNMEN?');
  assert.equal(buildMenuCommand(true), 'MNMEN ON');
  assert.equal(buildMenuCommand(false), 'MNMEN OFF');
  assert.equal(buildVolumeUpCommand(), 'MVUP');
  assert.equal(buildVolumeDownCommand(), 'MVDOWN');
});

test('zone-aware builders target the requested zone, never the whole-unit PW commands', () => {
  assert.equal(buildPowerQuery(ZONE.ZONE2), 'Z2?');
  assert.equal(buildPowerCommand(true, ZONE.ZONE2), 'Z2ON');
  assert.equal(buildPowerCommand(false, ZONE.ZONE2), 'Z2OFF');
  assert.equal(buildVolumeQuery(ZONE.ZONE2), 'Z2?');
  assert.equal(buildVolumeCommand(50, ZONE.ZONE2), 'Z249');
  assert.equal(buildVolumeCommand(0, ZONE.ZONE2), 'Z200');
  assert.equal(buildMuteQuery(ZONE.ZONE2), 'Z2MU?');
  assert.equal(buildMuteCommand(true, ZONE.ZONE2), 'Z2MUON');
  assert.equal(buildMuteCommand(false, ZONE.ZONE2), 'Z2MUOFF');
  assert.equal(buildSourceQuery(ZONE.ZONE2), 'Z2?');
  assert.equal(buildSourceCommand('NET', ZONE.ZONE2), 'Z2NET');
  assert.equal(buildVolumeUpCommand(ZONE.ZONE2), 'Z2UP');
  assert.equal(buildVolumeDownCommand(ZONE.ZONE2), 'Z2DOWN');
  assert.equal(buildPowerCommand(true, ZONE.ZONE3), 'Z3ON');
  assert.equal(buildSourceCommand('CD', ZONE.ZONE3), 'Z3CD');
  // Explicit main zone, and an unknown zone, behave like the default.
  assert.equal(buildPowerCommand(true, ZONE.MAIN), 'ZMON');
  assert.equal(buildSourceCommand('CD', 'bogus'), 'SICD');
});

test('buildVolumeCommand always pads to two digits', () => {
  assert.equal(buildVolumeCommand(0), 'MV00');
  assert.equal(buildVolumeCommand(100), 'MV98');
});

test('SOURCE_CODES: every entry has a unique value and a bilingual label', () => {
  const values = SOURCE_CODES.map((s) => s.value);
  assert.equal(new Set(values).size, values.length, 'no duplicate source codes');
  for (const source of SOURCE_CODES) {
    assert.ok(source.label?.en, `${source.value} needs an English label`);
    assert.ok(source.label?.fr, `${source.value} needs a French label`);
  }
});

test('SOUND_MODE_CODES: every entry has a unique value and a bilingual label', () => {
  const values = SOUND_MODE_CODES.map((m) => m.value);
  assert.equal(new Set(values).size, values.length, 'no duplicate sound mode codes');
  for (const mode of SOUND_MODE_CODES) {
    assert.ok(mode.label?.en, `${mode.value} needs an English label`);
    assert.ok(mode.label?.fr, `${mode.value} needs a French label`);
  }
});
