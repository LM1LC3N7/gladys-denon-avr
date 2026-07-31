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
  percentToDenonVolume,
  denonVolumeToPercent,
  SOURCE_CODES,
} from '../src/denon/protocol.js';

test('parseLine: power', () => {
  assert.deepEqual(parseLine('PWON'), { feature: 'power', value: 1 });
  assert.deepEqual(parseLine('PWSTANDBY'), { feature: 'power', value: 0 });
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

test('parseLine: unrecognized or empty lines are ignored', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('   '), null);
  assert.equal(parseLine('ZMON'), null); // zone 2 power, out of scope for v1
});

test('parseLine trims incoming whitespace/CR', () => {
  assert.deepEqual(parseLine('  PWON\r'), { feature: 'power', value: 1 });
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
  assert.equal(buildPowerQuery(), 'PW?');
  assert.equal(buildPowerCommand(true), 'PWON');
  assert.equal(buildPowerCommand(false), 'PWSTANDBY');
  assert.equal(buildVolumeQuery(), 'MV?');
  assert.equal(buildVolumeCommand(50), 'MV49');
  assert.equal(buildMuteQuery(), 'MU?');
  assert.equal(buildMuteCommand(true), 'MUON');
  assert.equal(buildMuteCommand(false), 'MUOFF');
  assert.equal(buildSourceQuery(), 'SI?');
  assert.equal(buildSourceCommand('TUNER'), 'SITUNER');
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
