import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_ACTION,
  createSceneActionHandlers,
  registerSceneActions,
} from '../src/scenes/actions.js';
import { SCENE_TRIGGER, startSceneTriggers } from '../src/scenes/triggers.js';
import {
  __clearConnectionsForTesting,
  __setConnectionForTesting,
  __setHeosConnectionForTesting,
  __setLastKnownStateForTesting,
  __setZoneSwitchDelayMsForTesting,
  updateState,
} from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeHeosSession, createFakeTelnetClient } from '../test-fixtures/fakeClients.js';

const ID = 'avr:abc';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

let config = normalizeConfig();
const getConfig = () => config;
const handlers = createSceneActionHandlers(getConfig);

test.beforeEach(() => {
  config = normalizeConfig();
  __setZoneSwitchDelayMsForTesting(0);
});

test.afterEach(() => {
  __clearConnectionsForTesting();
});

test('registerSceneActions registers one handler per declared key', () => {
  const gladys = createFakeGladys();
  registerSceneActions(gladys, getConfig);
  assert.deepEqual(
    Object.keys(gladys.handlers.sceneActions).sort(),
    Object.values(SCENE_ACTION).sort(),
  );
});

test('scene actions refuse an AVR that is not added/connected', async () => {
  await assert.rejects(
    () => handlers[SCENE_ACTION.QUICK_SELECT]({ avr: 'avr:nope', preset: '1' }),
    /Unknown AVR/,
  );
});

test('quick_select recalls the preset on the configured zone', async () => {
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(ID, telnet);
  await handlers[SCENE_ACTION.QUICK_SELECT]({ avr: ID, preset: '4' });
  config = normalizeConfig({ zone: 'zone2' });
  await handlers[SCENE_ACTION.QUICK_SELECT]({ avr: ID, preset: '1' });
  assert.deepEqual(telnet.sent, ['MSQUICK4', 'Z2QUICK1']);
});

test('play_heos_favorite plays the HEOS preset', async () => {
  const telnet = createFakeTelnetClient();
  const heos = createFakeHeosSession(3);
  __setConnectionForTesting(ID, telnet);
  __setHeosConnectionForTesting(ID, heos);
  __setLastKnownStateForTesting(ID, { power: 1, source: 'NET' });
  await handlers[SCENE_ACTION.PLAY_HEOS_FAVORITE]({ avr: ID, favorite: 5 });
  assert.deepEqual(heos.sent, ['browse/play_preset?pid=3&preset=5']);
});

test('set_amp: power on first, then input, sound mode and volume; each optional', async () => {
  const telnet = createFakeTelnetClient();
  __setConnectionForTesting(ID, telnet);
  __setLastKnownStateForTesting(ID, { power: 0 });
  await handlers[SCENE_ACTION.SET_AMP]({
    avr: ID,
    power: 'on',
    source: 'BD',
    sound_mode: 'MOVIE',
    volume: 45,
  });
  assert.deepEqual(telnet.sent, ['ZMON', 'SIBD', 'MSMOVIE', 'MV44']);

  telnet.sent.length = 0;
  await handlers[SCENE_ACTION.SET_AMP]({ avr: ID, volume: 0 });
  assert.deepEqual(telnet.sent, ['MV00'], 'volume 0 is a value, not "unchanged"');

  telnet.sent.length = 0;
  await handlers[SCENE_ACTION.SET_AMP]({ avr: ID, power: 'off', source: 'BD' });
  assert.deepEqual(telnet.sent, ['ZMOFF'], 'standby alone');

  await assert.rejects(() => handlers[SCENE_ACTION.SET_AMP]({ avr: ID, source: 'NOPE' }));
});

test('get_state returns the declared outputs, with the user source label', async () => {
  __setConnectionForTesting(ID, createFakeTelnetClient());
  __setLastKnownStateForTesting(ID, {
    power: 1,
    volume: 42,
    mute: 0,
    source: 'SAT/CBL',
    sound_mode: 'MOVIE',
    quick_select: 2,
    playback_state: 1,
    now_playing_title: 'Song',
    now_playing_artist: 'Band',
  });
  config = normalizeConfig({ source_overrides: 'SAT/CBL=Chromecast' });
  assert.deepEqual(await handlers[SCENE_ACTION.GET_STATE]({ avr: ID }), {
    reachable: true,
    power: true,
    volume: 42,
    muted: false,
    source: 'SAT/CBL',
    source_label: 'Chromecast',
    sound_mode: 'MOVIE',
    quick_select: 2,
    playing: true,
    title: 'Song',
    artist: 'Band',
  });
});

test('source_changed fires on a real input change only, not on the first value after connect', async () => {
  const gladys = createFakeGladys();
  config = normalizeConfig({ source_overrides: 'SAT/CBL=Chromecast' });
  const stop = startSceneTriggers(gladys, getConfig);
  updateState(ID, { source: 'TV' });
  updateState(ID, { source: 'TV' });
  updateState(ID, { source: 'SAT/CBL' });
  stop();
  updateState(ID, { source: 'CD' });
  await tick();
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: SCENE_TRIGGER.SOURCE_CHANGED,
      data: {
        avr: ID,
        source: 'SAT/CBL',
        source_label: 'Chromecast',
        previous_source: 'TV',
        previous_source_label: 'TV',
      },
    },
  ]);
});

test('track_changed fires once per new track, after title and artist settle', async () => {
  const gladys = createFakeGladys();
  __setConnectionForTesting(ID, createFakeTelnetClient());
  const stop = startSceneTriggers(gladys, getConfig, { trackDebounceMs: 20 });
  updateState(ID, { source: 'NET', now_playing_title: 'First', now_playing_artist: 'A' });
  await tick(40);
  assert.equal(gladys.sceneEvents.length, 0, 'the first track seen is the baseline');

  updateState(ID, { now_playing_title: 'Second' });
  updateState(ID, { now_playing_artist: 'B', now_playing_album: 'LP' });
  await tick(40);
  updateState(ID, { now_playing_title: '' });
  await tick(40);
  stop();
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: SCENE_TRIGGER.TRACK_CHANGED,
      data: { avr: ID, title: 'Second', artist: 'B', album: 'LP', source: 'NET' },
    },
  ]);
});
