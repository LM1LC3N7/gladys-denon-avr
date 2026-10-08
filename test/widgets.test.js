import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  WIDGET,
  SHORTCUT_TARGETS,
  REMOTE_BUTTONS,
  RADIO_BUTTONS,
  chosenSlots,
  fit,
} from '../src/widgets/common.js';
import {
  nowPlayingContent,
  shortcutsContent,
  amplifierContent,
  remoteContent,
  radioContent,
  parseShortcutTarget,
} from '../src/widgets/content.js';
import { runWidgetAction } from '../src/widgets/actions.js';
import { artworkKey, createArtworkCache } from '../src/widgets/artwork.js';
import { createRefresher } from '../src/widgets/refresh.js';
import {
  buildWidgetContent,
  registerWidgets,
  resolveView,
  WIDGETS_BY_STATE_KEY,
} from '../src/widgets/index.js';
import {
  __clearConnectionsForTesting,
  __setConnectionForTesting,
  __setHeosConnectionForTesting,
  __setLastKnownStateForTesting,
  __setZoneSwitchDelayMsForTesting,
  setSession,
  updateState,
} from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeHeosSession, createFakeTelnetClient } from '../test-fixtures/fakeClients.js';

const ID = 'avr:abc';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

function view(state = {}, overrides = {}) {
  return {
    externalId: ID,
    known: true,
    name: 'Living room AVR',
    telnetConnected: true,
    heosConnected: true,
    state,
    sourceOverrides: {},
    ...overrides,
  };
}

const PLAYING = {
  power: 1,
  volume: 40,
  mute: 0,
  source: 'NET',
  sound_mode: 'STEREO',
  playback_state: 1,
  now_playing_title: 'A very long song title that goes far beyond forty characters',
  now_playing_artist: 'Band',
  now_playing_album: 'LP',
  quick_select: 2,
  tuner_frequency: 8750,
  tuner_preset: 6,
  tuner_band: 'FM',
  tuner_mode: 'AUTO',
};

function connect(state = {}) {
  const telnet = createFakeTelnetClient();
  const heos = createFakeHeosSession(5);
  __setConnectionForTesting(ID, telnet);
  __setHeosConnectionForTesting(ID, heos);
  setSession(ID, { device: { external_id: ID, name: 'Living room AVR' } });
  __setLastKnownStateForTesting(ID, state);
  return { telnet, heos };
}

test.beforeEach(() => {
  __setZoneSwitchDelayMsForTesting(0);
});

test.afterEach(() => {
  __clearConnectionsForTesting();
});

function assertRenderedAsSent(content) {
  assert.deepEqual(validateWidgetContent(content), []);
}

test('every widget content fits the Gladys vocabulary and budget, in every state', () => {
  const states = [
    view(PLAYING),
    view({}),
    view({ power: 0, menu: 1, tuner_frequency: 105000, tuner_band: 'AM', tuner_mode: 'MANUAL' }),
    view(PLAYING, { telnetConnected: false, heosConnected: false }),
    view(PLAYING, {
      sourceOverrides: { NET: 'A user label longer than forty characters for sure' },
    }),
  ];
  const settings = {
    slot_1: 'source:NET',
    slot_2: 'quick:2',
    slot_3: 'favorite:3',
    slot_4: 'source:NET',
    label_3: 'Oui FM',
    key_1: 'menu',
    key_2: 'enter',
    button_1: 'tuner',
  };
  for (const v of states) {
    assertRenderedAsSent(nowPlayingContent(v));
    assertRenderedAsSent(nowPlayingContent(v, 'cover-abc123'));
    assertRenderedAsSent(shortcutsContent(v));
    assertRenderedAsSent(shortcutsContent(v, settings));
    assertRenderedAsSent(amplifierContent(v));
    assertRenderedAsSent(remoteContent(v));
    assertRenderedAsSent(remoteContent(v, settings));
    assertRenderedAsSent(radioContent(v));
    assertRenderedAsSent(radioContent(v, settings));
  }
});

test('now playing: title as heading, artwork, play/pause follows the playback state, mute ticked', () => {
  const content = nowPlayingContent(view({ ...PLAYING, mute: 1 }), 'cover-1');
  const types = content.components.map((c) => c.type);
  assert.deepEqual(types, [
    'text',
    'value',
    'image',
    'status',
    'button',
    'button',
    'button',
    'button',
  ]);
  assert.equal(content.components[0].text.length, 40);
  assert.equal(content.components[1].device_feature, `${ID}:volume`);
  const buttons = content.components.filter((c) => c.type === 'button');
  assert.deepEqual(
    buttons.map((b) => b.action.key),
    ['previous', 'pause', 'next', 'mute'],
  );
  assert.equal(buttons[3].icon, 'check-circle');
  assert.deepEqual(buttons[0].action.params, { avr: ID });

  const paused = nowPlayingContent(view({ ...PLAYING, playback_state: 0, now_playing_title: '' }));
  assert.equal(paused.components[0].text, 'Living room AVR');
  assert.ok(paused.components.some((c) => c.type === 'button' && c.action.key === 'play'));
  assert.ok(!paused.components.some((c) => c.type === 'image'));
});

test('shortcuts: defaults to Quick Select 1-4, ticks the active one, dedupes, custom labels', () => {
  const defaults = shortcutsContent(view(PLAYING)).components.filter((c) => c.type === 'button');
  assert.deepEqual(
    defaults.map((b) => [b.action.key, b.action.params.target, b.icon]),
    [
      ['slot_1', 'quick:1', 'zap'],
      ['slot_2', 'quick:2', 'check-circle'],
      ['slot_3', 'quick:3', 'zap'],
      ['slot_4', 'quick:4', 'zap'],
    ],
  );
  const custom = shortcutsContent(view(PLAYING, { sourceOverrides: { 'SAT/CBL': 'Chromecast' } }), {
    slot_1: 'source:IRADIO',
    slot_2: 'source:SAT/CBL',
    slot_3: 'source:BT',
    slot_4: 'source:SAT/CBL',
    label_1: 'Radio internet',
    slot_x: 'source:CD',
  }).components.filter((c) => c.type === 'button');
  assert.deepEqual(
    custom.map((b) => [b.action.key, b.label]),
    [
      ['slot_1', 'Radio internet'],
      ['slot_2', 'Chromecast'],
      ['slot_3', { en: 'Bluetooth', fr: 'Bluetooth' }],
    ],
  );
});

test('amplifier: power button follows the state; remote: arrows by default, chosen keys otherwise', () => {
  const on = amplifierContent(view(PLAYING)).components.filter((c) => c.type === 'button');
  assert.deepEqual(
    on.map((b) => b.action.key),
    ['power_off', 'volume_down', 'volume_up', 'mute'],
  );
  const off = amplifierContent(view({ power: 0 })).components.find((c) => c.type === 'button');
  assert.equal(off.action.key, 'power_on');

  const keys = (settings) =>
    remoteContent(view({}), settings)
      .components.filter((c) => c.type === 'button')
      .map((b) => b.action.key);
  assert.deepEqual(keys(), ['up', 'down', 'left', 'right']);
  assert.deepEqual(keys({ key_1: 'menu', key_2: 'enter', key_3: 'return', key_4: 'info' }), [
    'menu',
    'enter',
    'return',
    'info',
  ]);
  assert.deepEqual(keys({ key_1: 'bogus' }), ['up', 'down', 'left', 'right']);
});

test('radio: frequency and preset tiles, band/mode/input status', () => {
  const content = radioContent(view(PLAYING));
  const tiles = content.components.filter((c) => c.type === 'value');
  assert.deepEqual(
    tiles.map((t) => [t.value, t.unit]),
    [
      [87.5, 'MHz'],
      [6, undefined],
    ],
  );
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items.at(-1).color, 'warning', 'the input is NET, not the tuner');
  const tuned = radioContent(view({ ...PLAYING, source: 'TUNER' }));
  assert.equal(tuned.components.find((c) => c.type === 'status').items.at(-1).color, 'success');
  assert.deepEqual(
    tuned.components.filter((c) => c.type === 'button').map((b) => b.action.key),
    ['frequency_down', 'frequency_up', 'preset_up', 'band_toggle'],
  );
});

test('setting options: every value parses back, slots dedupe', () => {
  for (const option of SHORTCUT_TARGETS) {
    assert.ok(parseShortcutTarget(option.value), option.value);
  }
  assert.equal(parseShortcutTarget('source:NOPE'), null);
  assert.equal(parseShortcutTarget('quick:9'), null);
  assert.ok(REMOTE_BUTTONS.every((b) => b.feature));
  assert.equal(RADIO_BUTTONS.length, 7);
  assert.deepEqual(
    chosenSlots({ key_1: 'up', key_2: 'up' }, 'key', REMOTE_BUTTONS, ['a', 'b', 'c', 'd']),
    [
      { value: 'up', slot: 1 },
      { value: 'c', slot: 3 },
      { value: 'd', slot: 4 },
    ],
  );
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.deepEqual(fit({ en: 'abcdef', fr: 'ab' }, 4), { en: 'abc…', fr: 'ab' });
});

test('widget actions: feature buttons route like device commands', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig();
  const { telnet, heos } = connect({ power: 1, mute: 0, source: 'NET' });
  for (const key of ['power_off', 'power_on', 'volume_up', 'volume_down', 'mute', 'up', 'enter']) {
    await runWidgetAction(gladys, key, { avr: ID }, config);
  }
  assert.deepEqual(telnet.sent, ['ZMOFF', 'ZMON', 'MVUP', 'MVDOWN', 'MUON', 'MNCUP', 'MNENT']);
  await runWidgetAction(gladys, 'pause', { avr: ID }, config);
  assert.deepEqual(heos.sent, ['player/set_play_state?pid=5&state=pause']);
});

test('widget actions: shortcuts, tuner buttons and toggles', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig();
  const { telnet, heos } = connect({
    power: 1,
    source: 'TUNER',
    tuner_band: 'FM',
    tuner_mode: 'AUTO',
  });
  await runWidgetAction(gladys, 'slot_1', { avr: ID, target: 'source:BT' }, config);
  await runWidgetAction(gladys, 'slot_2', { avr: ID, target: 'quick:3' }, config);
  await runWidgetAction(gladys, 'frequency_up', { avr: ID }, config);
  await runWidgetAction(gladys, 'band_toggle', { avr: ID }, config);
  await runWidgetAction(gladys, 'mode_toggle', { avr: ID }, config);
  await runWidgetAction(gladys, 'tuner', { avr: ID }, config);
  assert.deepEqual(telnet.sent, ['SIBT', 'MSQUICK3', 'TFANUP', 'TMANAM', 'TMANMANUAL']);

  updateState(ID, { source: 'NET' });
  await runWidgetAction(gladys, 'slot_3', { avr: ID, target: 'favorite:2' }, config);
  assert.deepEqual(heos.sent, ['browse/play_preset?pid=5&preset=2']);
});

test('widget actions refuse an unknown receiver, button or shortcut target', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig();
  await assert.rejects(
    () => runWidgetAction(gladys, 'mute', { avr: 'avr:x' }, config),
    /no longer/,
  );
  connect({});
  await assert.rejects(
    () => runWidgetAction(gladys, 'self_destruct', { avr: ID }, config),
    /Unknown widget button/,
  );
  await assert.rejects(
    () => runWidgetAction(gladys, 'slot_1', { avr: ID, target: 'source:NOPE' }, config),
    /Unknown shortcut/,
  );
});

test('resolveView: the picked receiver, else the first one; empty states otherwise', () => {
  const config = normalizeConfig();
  assert.deepEqual(resolveView({}, config), { reason: 'none' });
  connect(PLAYING);
  assert.equal(resolveView({}, config).view.name, 'Living room AVR');
  assert.equal(resolveView({ avr: ID }, config).view.externalId, ID);
  assert.deepEqual(resolveView({ avr: 'avr:gone' }, config), { reason: 'unknown' });
});

test('buildWidgetContent: empty state, and the now playing artwork once downloaded', async () => {
  const config = normalizeConfig();
  const artwork = createArtworkCache({
    fetchFn: async () => new Response(PNG, { headers: { 'content-length': String(PNG.length) } }),
  });
  const empty = await buildWidgetContent(WIDGET.NOW_PLAYING, {}, config, { artwork });
  assert.equal(empty.components[0].variant, 'body');

  connect({ ...PLAYING, now_playing_image_url: 'https://cdn.example.com/cover.png' });
  const content = await buildWidgetContent(WIDGET.NOW_PLAYING, {}, config, { artwork });
  const image = content.components.find((c) => c.type === 'image');
  assert.equal(image.key, artworkKey('https://cdn.example.com/cover.png'));
  assert.equal(artwork.get(image.key), PNG.toString('base64'));
  for (const key of Object.values(WIDGET)) {
    assertRenderedAsSent(await buildWidgetContent(key, {}, config, { artwork }));
  }
  await assert.rejects(() => buildWidgetContent('nope', {}, config, { artwork }), /Unknown widget/);
});

test('artwork: too large, not an image or a failed download is left out, and remembered', async () => {
  let calls = 0;
  const big = createArtworkCache({
    fetchFn: async () => {
      calls += 1;
      return new Response('x', { headers: { 'content-length': String(400 * 1024) } });
    },
  });
  assert.equal(await big.prepare('https://cdn.example.com/big.jpg'), null);
  assert.equal(await big.prepare('https://cdn.example.com/big.jpg'), null);
  assert.equal(calls, 1, 'a refused image is not downloaded again');

  const text = createArtworkCache({ fetchFn: async () => new Response('<html>') });
  assert.equal(await text.prepare('https://cdn.example.com/page'), null);
  const down = createArtworkCache({ fetchFn: async () => new Response('', { status: 404 }) });
  assert.equal(await down.prepare('https://cdn.example.com/404'), null);
  assert.equal(await down.prepare(''), null);

  const lru = createArtworkCache({ fetchFn: async () => new Response(PNG), maxEntries: 1 });
  const first = await lru.prepare('https://a.example.com/1.png');
  await lru.prepare('https://a.example.com/2.png');
  assert.equal(lru.get(first), undefined, 'the oldest entry is evicted');
});

test('refresher: first nudge at once, the rest collapsed into one trailing nudge', async () => {
  const sent = [];
  const refresher = createRefresher((key) => sent.push(key), { minIntervalMs: 40 });
  refresher.request('a');
  refresher.request('a');
  refresher.request('a');
  refresher.request('b');
  assert.deepEqual(sent, ['a', 'b']);
  await tick(60);
  assert.deepEqual(sent, ['a', 'b', 'a']);
  refresher.request('a');
  refresher.stop();
  await tick(60);
  assert.deepEqual(sent, ['a', 'b', 'a'], 'stop() drops the pending trailing nudge');
});

test('registerWidgets: handlers for every widget, nudges on the state each one shows', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig();
  const stop = registerWidgets(gladys, () => config, {
    artwork: createArtworkCache({ fetchFn: async () => new Response(PNG) }),
  });
  assert.deepEqual(Object.keys(gladys.handlers.widgetGet).sort(), Object.values(WIDGET).sort());
  assert.deepEqual(Object.keys(gladys.handlers.widgetAction).sort(), Object.values(WIDGET).sort());

  connect({ power: 1 });
  updateState(ID, { tuner_frequency: 9000 });
  assert.deepEqual(gladys.widgetRefreshes, ['radio']);
  updateState(ID, { volume: 12 });
  assert.deepEqual(gladys.widgetRefreshes, ['radio'], 'the volume tile is live, no nudge');
  assert.deepEqual(WIDGETS_BY_STATE_KEY.source.sort(), [
    'amplifier',
    'now_playing',
    'radio',
    'shortcuts',
  ]);

  const content = await gladys.handlers.widgetGet.amplifier({ settings: {} });
  assertRenderedAsSent(content);
  await gladys.handlers.widgetAction.amplifier('mute', { avr: ID }, { settings: {} });
  updateState(ID, { now_playing_image_url: 'https://cdn.example.com/c.png' });
  await tick();
  const image = await gladys.handlers.widgetGetImage(artworkKey('https://cdn.example.com/c.png'));
  assert.equal(image, PNG.toString('base64'));
  await assert.rejects(() => gladys.handlers.widgetGetImage('cover-unknown'), /Unknown image/);
  stop();
});
