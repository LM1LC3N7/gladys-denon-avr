import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
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

test('normalizeConfig falls back to the default for a missing/invalid numeric field', () => {
  assert.equal(normalizeConfig({ host: '192.168.1.50' }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ port: 'not-a-number' }).port, DEFAULT_CONFIG.port);
});
