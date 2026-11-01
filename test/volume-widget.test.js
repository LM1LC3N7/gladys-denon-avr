// Forum topic 10722, post 37: several quick Vol+/Vol- taps in the Amplifier
// widget end on "L'action a échoué", then every button of the integration's
// widgets stays dead for a while.
//
// Cause (Gladys core, server/lib/external-integration/): every widget tap is
// one action, and each successful action drops the widget content, so at
// least one content pull follows it. Both are capped per integration: 30
// actions and 30 pulls per fixed minute window (countPerMinute), refused
// calls counted too. Past either cap, every action of every widget of the
// integration answers 429 until the window ends (up to 60 s). With one tap
// = one remote step (MVUP = 0.5 dB), raising the volume by 10 dB needed 20
// taps, 40 core calls: over the cap within seconds.
//
// The module cannot lift the core cap: a tap now moves the volume by a
// real step from the last wanted level (rapid taps add up even before the
// receiver reports), so the same change costs a quarter of the taps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWidgetAction } from '../src/widgets/actions.js';
import {
  __clearConnectionsForTesting,
  __setConnectionForTesting,
  __setHeosConnectionForTesting,
  __setLastKnownStateForTesting,
  __setTimingForTesting,
  setSession,
  updateState,
  getState,
} from '../src/devices/registry.js';
import { denonVolumeToPercent, percentToDenonVolume } from '../src/denon/protocol.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeHeosSession } from '../test-fixtures/fakeClients.js';

const ID = 'avr:vol';
const config = normalizeConfig();
const gladys = createFakeGladys();
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The core's caps, Gladys server/lib/external-integration/constants.js.
const MAX_WIDGET_ACTIONS_PER_MINUTE = 30;
const MAX_WIDGET_GET_MISSES_PER_MINUTE = 30;

/**
 * A receiver on Telnet that applies MVUP/MVDOWN (0.5 dB steps, like most
 * Denon/Marantz models) and MVnn, and reports its volume back like the real
 * one (MV line -> state), unless `echo` is off.
 */
function fakeReceiver({ raw = 30, echo = true } = {}) {
  const sent = [];
  let connected = true;
  const client = {
    sent,
    send(command) {
      if (!connected) {
        return false;
      }
      sent.push(command);
      if (command === 'MVUP') {
        raw = Math.min(98, raw + 0.5);
      } else if (command === 'MVDOWN') {
        raw = Math.max(0, raw - 0.5);
      } else if (/^MV\d+$/.test(command)) {
        raw = Number(command.slice(2));
      } else {
        return true;
      }
      if (echo) {
        updateState(ID, { volume: denonVolumeToPercent(raw) });
      }
      return true;
    },
    isConnected: () => connected,
    stop: () => {
      connected = false;
    },
    setConnected(value) {
      connected = value;
    },
    raw: () => raw,
  };
  __setConnectionForTesting(ID, client);
  setSession(ID, { device: { external_id: ID, name: 'Living room' } });
  __setLastKnownStateForTesting(ID, { power: 1, mute: 0, volume: denonVolumeToPercent(raw) });
  return client;
}

/** The core's per-integration budget of one minute: a tap = an action + its re-pull. */
function coreBudget() {
  let actions = 0;
  let pulls = 0;
  return {
    tap() {
      actions += 1;
      pulls += 1;
      return actions <= MAX_WIDGET_ACTIONS_PER_MINUTE && pulls <= MAX_WIDGET_GET_MISSES_PER_MINUTE;
    },
    get actions() {
      return actions;
    },
  };
}

test.afterEach(() => __clearConnectionsForTesting());

test('Vol+ taps raise an AVR by 20 % within the core widget budget of one minute', async () => {
  const receiver = fakeReceiver({ raw: percentToDenonVolume(30) });
  const budget = coreBudget();
  while (getState(ID).volume < 50) {
    assert.ok(
      budget.tap(),
      `tap ${budget.actions} is past the core cap (30 actions + 30 pulls a minute): ` +
        'every widget button would answer "L\'action a échoué" until the minute ends',
    );
    await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
    await tick(70);
  }
  assert.ok(budget.actions <= 10, `${budget.actions} taps for +20 %`);
  assert.equal(receiver.sent.at(-1), `MV${String(percentToDenonVolume(50)).padStart(2, '0')}`);
});

test('rapid taps add up from the last wanted volume, never from a late report', async () => {
  // The receiver does not report back in time: 5 taps must still give +10 %.
  const receiver = fakeReceiver({ raw: percentToDenonVolume(40), echo: false });
  for (let i = 0; i < 5; i += 1) {
    await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  }
  await tick(150);
  assert.equal(receiver.raw(), percentToDenonVolume(50));
  // Coalesced: never two volume commands within the receiver's ~50 ms.
  assert.ok(receiver.sent.length <= 5);
  // Vol- right after goes down from the wanted 50, not from the stale 40.
  await runWidgetAction(gladys, 'volume_down', { avr: ID }, config);
  await tick(150);
  assert.equal(receiver.raw(), percentToDenonVolume(48));
});

test('a failed tap leaves nothing stuck: the next tap and the other buttons work at once', async () => {
  const receiver = fakeReceiver({ raw: percentToDenonVolume(40) });
  receiver.setConnected(false);
  await assert.rejects(runWidgetAction(gladys, 'volume_up', { avr: ID }, config), /not connected/);
  receiver.setConnected(true);
  await runWidgetAction(gladys, 'mute', { avr: ID }, config);
  await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  await tick(100);
  assert.deepEqual(receiver.sent, ['MUON', `MV${percentToDenonVolume(42)}`]);
});

test('without a known volume, a tap stays one remote step (MVUP)', async () => {
  const receiver = fakeReceiver();
  __setLastKnownStateForTesting(ID, { power: 1 });
  await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  assert.deepEqual(receiver.sent, ['MVUP']);
});

test('the wanted volume expires: a later tap starts from what the receiver reports', async () => {
  __setTimingForTesting({ volumeWantedMs: 100 });
  const receiver = fakeReceiver({ raw: percentToDenonVolume(40), echo: false });
  await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  await tick(150);
  // Someone turned the knob meanwhile.
  updateState(ID, { volume: 20 });
  await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  await tick(100);
  assert.equal(receiver.raw(), percentToDenonVolume(22));
});

test('a HEOS-only speaker: Vol+ sets the HEOS level from the wanted one, 5 % a tap', async () => {
  const heos = createFakeHeosSession(7);
  __setHeosConnectionForTesting(ID, heos);
  setSession(ID, { device: { external_id: ID, name: 'Denon Home' } });
  __setLastKnownStateForTesting(ID, { volume: 20 });
  await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  await tick(150);
  assert.deepEqual(heos.sent, [
    'player/set_volume?pid=7&level=25',
    'player/set_volume?pid=7&level=30',
  ]);
});

test('no volume command after the device is disconnected', async () => {
  const receiver = fakeReceiver({ raw: percentToDenonVolume(40), echo: false });
  await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  await runWidgetAction(gladys, 'volume_up', { avr: ID }, config);
  const sentBefore = receiver.sent.length;
  receiver.stop = () => {}; // Still "connected": only the module may hold the send back.
  __clearConnectionsForTesting();
  // Reconnected at once: a send left over from the old session must not reach the new one.
  __setConnectionForTesting(ID, receiver);
  await tick(150);
  assert.equal(receiver.sent.length, sentBefore);
});
