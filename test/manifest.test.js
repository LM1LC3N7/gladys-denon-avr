// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers, or that the static
// `select_source` options list matches the SI codes protocol.js knows about
// — these tests keep everything in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SOURCE_CODES, SOUND_MODE_CODES } from '../src/denon/protocol.js';
import {
  WIDGET,
  SHORTCUT_TARGETS,
  SHORTCUT_DEFAULTS,
  REMOTE_BUTTONS,
  REMOTE_DEFAULTS,
  RADIO_BUTTONS,
  RADIO_DEFAULTS,
} from '../src/widgets/common.js';
import { SCENE_ACTION, createSceneActionHandlers } from '../src/scenes/actions.js';
import { SCENE_TRIGGER } from '../src/scenes/triggers.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

// Registered directly in index.js (there is a single device type, so no
// per-blueprint action registry like the template's demo devices had).
const HANDLED_ACTIONS = ['test_connection', 'select_source'];

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      HANDLED_ACTIONS.includes(action.key),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the manifest carries the "Getting started" intro section');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const allFields = [
    ...manifest.config_schema,
    ...(manifest.actions ?? []).flatMap((a) => a.fields ?? []),
  ];
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0, 'the AVR/device fields use the dynamic "devices" select');
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices', 'the only core-defined source in V1 is "devices"');
    assert.equal(
      field.options,
      undefined,
      `field "${field.key}": declaring source and options together rejects the manifest`,
    );
  }
});

test('select_source action options exactly match protocol.js SOURCE_CODES', () => {
  const action = manifest.actions.find((a) => a.key === 'select_source');
  const sourceField = action.fields.find((f) => f.key === 'source');
  assert.deepEqual(
    sourceField.options.map((o) => o.value),
    SOURCE_CODES.map((s) => s.value),
    'the manifest select_source options must stay in sync with src/denon/protocol.js#SOURCE_CODES',
  );
  for (const option of sourceField.options) {
    const expected = SOURCE_CODES.find((s) => s.value === option.value);
    assert.deepEqual(option.label, expected.label, `label mismatch for source "${option.value}"`);
  }
});

const optionsOf = (list) => list.map(({ value, label }) => ({ value, label }));

test('widgets: the manifest declares exactly the widgets the code renders', () => {
  assert.deepEqual(
    manifest.widgets.map((w) => w.key),
    Object.values(WIDGET),
  );
  for (const widget of manifest.widgets) {
    for (const language of Object.keys(widget.label)) {
      const length = widget.label[language].length;
      assert.ok(
        length >= 3 && length <= 30,
        `${widget.key} label (${language}) is 3-30 characters`,
      );
    }
    const avr = widget.settings.find((s) => s.key === 'avr');
    assert.equal(avr?.source, 'devices', `${widget.key} lets the user pick the receiver`);
    assert.ok(widget.settings.length <= 10, `${widget.key}: 10 settings at most`);
  }
});

test('widgets: button settings offer exactly the code options, with the code defaults', () => {
  const cases = [
    [WIDGET.SHORTCUTS, 'slot', SHORTCUT_TARGETS, SHORTCUT_DEFAULTS],
    [WIDGET.REMOTE, 'key', REMOTE_BUTTONS, REMOTE_DEFAULTS],
    [WIDGET.RADIO, 'button', RADIO_BUTTONS, RADIO_DEFAULTS],
  ];
  for (const [key, prefix, options, defaults] of cases) {
    const widget = manifest.widgets.find((w) => w.key === key);
    const slots = widget.settings.filter((s) => s.key.startsWith(`${prefix}_`));
    assert.equal(slots.length, 4, `${key} has 4 button settings`);
    slots.forEach((slot, index) => {
      assert.deepEqual(slot.options, optionsOf(options), `${key}.${slot.key} options`);
      assert.equal(slot.default, defaults[index], `${key}.${slot.key} default`);
    });
  }
});

test('scene actions and triggers: declared keys match the handlers, options match the protocol', () => {
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    Object.values(SCENE_ACTION),
  );
  assert.deepEqual(Object.keys(createSceneActionHandlers(() => ({}))), Object.values(SCENE_ACTION));
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key),
    Object.values(SCENE_TRIGGER),
  );
  const setAmp = manifest.scene_actions.find((a) => a.key === SCENE_ACTION.SET_AMP);
  assert.deepEqual(setAmp.fields.find((f) => f.key === 'source').options, optionsOf(SOURCE_CODES));
  assert.deepEqual(
    setAmp.fields.find((f) => f.key === 'sound_mode').options,
    optionsOf(SOUND_MODE_CODES),
  );
  const sourceChanged = manifest.scene_triggers.find((t) => t.key === SCENE_TRIGGER.SOURCE_CHANGED);
  assert.deepEqual(
    sourceChanged.fields.find((f) => f.key === 'source').options,
    optionsOf(SOURCE_CODES),
  );
});

test('get_state declares exactly the outputs its handler returns', async () => {
  const getState = manifest.scene_actions.find((a) => a.key === SCENE_ACTION.GET_STATE);
  const { __setConnectionForTesting, __clearConnectionsForTesting } =
    await import('../src/devices/registry.js');
  __setConnectionForTesting('avr:x', { isConnected: () => true, send: () => true });
  try {
    const outputs = await createSceneActionHandlers(() => ({}))[SCENE_ACTION.GET_STATE]({
      avr: 'avr:x',
    });
    assert.deepEqual(getState.outputs.map((o) => o.key).sort(), Object.keys(outputs).sort());
  } finally {
    __clearConnectionsForTesting();
  }
});

test('widgets and scene declarations require Gladys 5.1.0', () => {
  assert.match(manifest.gladys_version, /^>=\s*5\.(1|[2-9])\.\d+$/);
});
