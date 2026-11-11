import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  DEFAULT_CONFIG,
  sessionConfigChanged,
  applyTimezone,
  wakeDelayMs,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), { ...DEFAULT_CONFIG, hosts: [], sourceOverrides: {} });
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({
    host: '192.168.1.50',
    port: 2323,
    reconnect_interval_seconds: 30,
  });
  assert.equal(config.host, '192.168.1.50');
  assert.equal(config.port, 2323);
  assert.equal(config.reconnect_interval_seconds, 30);
});

test('normalizeConfig coerces numeric strings coming from a form', () => {
  const config = normalizeConfig({ port: '23', reconnect_interval_seconds: '15' });
  assert.equal(config.port, 23);
  assert.equal(typeof config.port, 'number');
  assert.equal(config.reconnect_interval_seconds, 15);
  assert.equal(typeof config.reconnect_interval_seconds, 'number');
});

test('normalizeConfig trims a manual host and falls back to the default when absent', () => {
  assert.equal(normalizeConfig({ host: '  192.168.1.50  ' }).host, '192.168.1.50');
  assert.equal(normalizeConfig({}).host, DEFAULT_CONFIG.host);
});

test('normalizeConfig: a single host is a one-element hosts array (backward compatible)', () => {
  const config = normalizeConfig({ host: '192.168.1.50' });
  assert.equal(config.host, '192.168.1.50');
  assert.deepEqual(config.hosts, ['192.168.1.50']);
});

test('normalizeConfig: comma-separated hosts are trimmed, deduplicated, and empties dropped', () => {
  const config = normalizeConfig({ host: ' 192.168.1.50 ,192.168.2.50, ,192.168.1.50,' });
  assert.deepEqual(config.hosts, ['192.168.1.50', '192.168.2.50']);
  // `host` stays the first one, for callers that only expect a single value.
  assert.equal(config.host, '192.168.1.50');
});

test('normalizeConfig: an empty host yields an empty hosts array', () => {
  assert.deepEqual(normalizeConfig({ host: '' }).hosts, []);
  assert.deepEqual(normalizeConfig({ host: '   ' }).hosts, []);
});

test('normalizeConfig falls back to the default for a missing/invalid numeric field', () => {
  assert.equal(normalizeConfig({ host: '192.168.1.50' }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ port: 'not-a-number' }).port, DEFAULT_CONFIG.port);
});

test('normalizeConfig: source_overrides parses CODE=Label pairs, CODE= means hidden', () => {
  const config = normalizeConfig({ source_overrides: 'SAT/CBL=Chromecast, GAME=, aux1 = PS5' });
  assert.deepEqual(config.sourceOverrides, {
    'SAT/CBL': 'Chromecast',
    GAME: '',
    AUX1: 'PS5',
  });
});

test('normalizeConfig: source_overrides is empty by default and ignores malformed entries', () => {
  assert.deepEqual(normalizeConfig().sourceOverrides, {});
  assert.deepEqual(
    normalizeConfig({ source_overrides: 'not-an-override, =NoCode' }).sourceOverrides,
    {},
  );
});

test('normalizeConfig: zone defaults to the main zone, unknown values fall back to it', () => {
  assert.equal(normalizeConfig().zone, 'main');
  assert.equal(normalizeConfig({ zone: 'zone2' }).zone, 'zone2');
  assert.equal(normalizeConfig({ zone: 'zone3' }).zone, 'zone3');
  assert.equal(normalizeConfig({ zone: 'garage' }).zone, 'main');
  assert.equal(normalizeConfig({ zone: null }).zone, 'main');
});

test('sessionConfigChanged: zone, port, backoff or source overrides changing reopens the sessions', () => {
  const base = normalizeConfig({ source_overrides: 'GAME=' });
  assert.equal(sessionConfigChanged(base, normalizeConfig({ source_overrides: 'GAME=' })), false);
  for (const change of [
    { zone: 'zone2' },
    { port: 2323 },
    { reconnect_interval_seconds: 30 },
    { source_overrides: 'GAME=, SAT/CBL=Chromecast' },
  ]) {
    assert.equal(
      sessionConfigChanged(base, normalizeConfig({ source_overrides: 'GAME=', ...change })),
      true,
      `${JSON.stringify(change)} must reopen the sessions`,
    );
  }
});

test('sessionConfigChanged: a manual host list change alone keeps the sessions (devices carry their own IP)', () => {
  assert.equal(
    sessionConfigChanged(normalizeConfig(), normalizeConfig({ host: '192.168.1.60' })),
    false,
  );
});

test('the time zone: trimmed, defaulted, and applied only when known', () => {
  assert.equal(normalizeConfig({}).timezone, 'Europe/Paris');
  assert.equal(normalizeConfig({ timezone: '  America/Montreal ' }).timezone, 'America/Montreal');
  assert.equal(normalizeConfig({ timezone: '   ' }).timezone, 'Europe/Paris');
  const before = process.env.TZ;
  try {
    assert.equal(applyTimezone('America/Montreal'), true);
    assert.equal(process.env.TZ, 'America/Montreal');
    assert.equal(new Date(Date.UTC(2026, 0, 1, 12)).getHours(), 7, 'local time follows');
    assert.equal(applyTimezone('Mars/Olympus'), false);
    assert.equal(process.env.TZ, 'America/Montreal', 'unchanged');
  } finally {
    if (before === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = before;
    }
  }
});

test('ad-break levels: whole numbers within range, empty means default', () => {
  const config = normalizeConfig({ ad_break_volume_drop: '12.6', ad_break_min_volume: '' });
  assert.equal(config.ad_break_volume_drop, 13);
  assert.equal(config.ad_break_min_volume, 20);
  assert.equal(normalizeConfig({ ad_break_volume_drop: 0 }).ad_break_volume_drop, 1);
  assert.equal(normalizeConfig({ ad_break_min_volume: 'x' }).ad_break_min_volume, 20);
  assert.equal(normalizeConfig({ ad_break_detection: 'true' }).ad_break_detection, false);
});

test('wake_delay_seconds: 4 s by default, 0-15 kept, out of bounds or unreadable = the default', () => {
  assert.equal(normalizeConfig().wake_delay_seconds, 4);
  assert.equal(wakeDelayMs(normalizeConfig()), 4_000);
  for (const [raw, seconds] of [
    [0, 0],
    ['0', 0],
    [7, 7],
    ['7.5', 7.5],
    [15, 15],
    [-1, 4],
    [15.01, 4],
    [60, 4],
    ['abc', 4],
    ['', 4],
    [null, 4],
    [NaN, 4],
    [Infinity, 4],
    [true, 4],
    ['   ', 4],
    ['\t\n', 4],
    [[], 4],
    [[5], 4],
    [{}, 4],
  ]) {
    assert.equal(
      normalizeConfig({ wake_delay_seconds: raw }).wake_delay_seconds,
      seconds,
      `${raw}`,
    );
  }
  assert.equal(wakeDelayMs({ wake_delay_seconds: 2.5 }), 2_500);
  assert.equal(wakeDelayMs({}), 4_000);
  assert.equal(wakeDelayMs({ wake_delay_seconds: 99 }), 4_000);
});
