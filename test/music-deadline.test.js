// The music commands against a slow HEOS: Gladys waits 10 s, the module
// stops by its own deadline (timing.musicDeadlineMs, 8 s; shortened here),
// says why, never starts the music late, and leaves nothing queued behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMusicHandlers } from '../src/devices/music.js';
import { encodeMediaId } from '../src/heos/media.js';
import { createSceneActionHandlers } from '../src/scenes/actions.js';
import { playFromService } from '../src/devices/qobuz.js';
import { DeadlineError, runWithDeadline, timeLeft } from '../src/devices/deadline.js';
import {
  __clearConnectionsForTesting,
  __setTimingForTesting,
  getHeos,
} from '../src/devices/registry.js';
import { buildGetMusicSourcesCommand } from '../src/heos/protocol.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { connectFakeHeos, sentOf } from '../test-fixtures/fakeHeos.js';
import { QOBUZ, qobuzReceiver } from '../test-fixtures/qobuzReceiver.js';

const ID = 'avr:slow';
const DEVICE = { external_id: ID, selector: 'salon', params: [] };
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.afterEach(() => {
  __clearConnectionsForTesting();
});

const handlers = (config = {}) =>
  createMusicHandlers(createFakeGladys(), () => normalizeConfig(config));

/** The receiver of qobuzReceiver(), each answer to `command` delayed by `ms`. */
function slow(command, ms, options = {}) {
  const base = qobuzReceiver(options);
  return qobuzReceiver({
    ...options,
    overrides: {
      [command]: (params) => base(command, params).map((reply) => ({ ...reply, delayMs: ms })),
    },
  });
}

test('the deadline: nested ones never extend the outer one; none outside a music command', async () => {
  assert.equal(timeLeft(), Infinity);
  await runWithDeadline(100, async () => {
    assert.ok(timeLeft() <= 100);
    await runWithDeadline(10_000, async () => {
      assert.ok(timeLeft() <= 100, 'the outer deadline wins');
    });
    await runWithDeadline(10, async () => assert.ok(timeLeft() <= 10));
  });
});

test('a slow HEOS: the latest album fails by the deadline, says so, and never plays late', async (t) => {
  __setTimingForTesting({ musicDeadlineMs: 400, musicActReserveMs: 100 });
  t.mock.method(console, 'log', () => {});
  const fake = await connectFakeHeos(t, ID, slow('browse/browse', 300, { artist: 'albums' }));
  const music = handlers();
  const id = encodeMediaId({ kind: 'latest', sid: QOBUZ, artist: 'Céline Dion', name: 'Qobuz' });
  const started = Date.now();
  await assert.rejects(music.play(DEVICE, { id, type: 'album' }, 'replace'), (err) => {
    assert.ok(err instanceof DeadlineError, err.message);
    assert.match(
      err.message,
      /did not answer browse\/browse in time: stopped there, nothing was started/,
    );
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 700, `failed by the deadline (${elapsed} ms)`);
  // The late answers arrive; nothing acts on them.
  await tick(800);
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
  // Nothing left in the request chain: the next command answers at once.
  const before = Date.now();
  const queue = await music.queueGet(DEVICE, { offset: 0, limit: 10 });
  assert.equal(queue.total, 3);
  assert.ok(Date.now() - before < 200, 'not blocked behind the abandoned command');
});

test('too little time left to act: nothing is started, the module says it', async (t) => {
  __setTimingForTesting({ musicDeadlineMs: 400, musicActReserveMs: 350 });
  const fake = await connectFakeHeos(t, ID, slow('browse/search', 100));
  const music = handlers();
  const id = encodeMediaId({ kind: 'latest', sid: QOBUZ, artist: 'Céline Dion', name: 'Qobuz' });
  await assert.rejects(
    music.play(DEVICE, { id, type: 'album' }),
    /did not answer in time \(before playing\): nothing was started\. Try again, or use the "AVR: play from …" scene action, which waits up to 60 s/,
  );
  await tick(200);
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
});

test('a slow queue: the jump is not sent after the deadline', async (t) => {
  __setTimingForTesting({ musicDeadlineMs: 300, musicActReserveMs: 100 });
  const fake = await connectFakeHeos(t, ID, slow('player/get_queue', 250));
  const music = handlers();
  await assert.rejects(music.queuePlay(DEVICE, 1), DeadlineError);
  await tick(300);
  assert.deepEqual(sentOf(fake, 'player/play_queue'), []);
});

test('a slow search: bounded by its budget on every service, what was found is kept', async (t) => {
  __setTimingForTesting({ musicSearchBudgetMs: 400 });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const base = qobuzReceiver({ qobuz: false });
  const fake = await connectFakeHeos(
    t,
    ID,
    qobuzReceiver({
      qobuz: false,
      overrides: {
        // TIDAL's album search hangs; its artist search answers.
        'browse/search': (params) =>
          params.sid === '10' && params.scid === '2'
            ? base('browse/search', params).map((reply) => ({ ...reply, delayMs: 2_000 }))
            : undefined,
      },
    }),
  );
  const music = handlers({ music_search_service: 'all' });
  const started = Date.now();
  const { items } = await music.search(DEVICE, { query: 'Céline Dion', limit: 20 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 700, `bounded by the budget (${elapsed} ms)`);
  assert.equal(items[0].title, 'Céline Dion', 'the artist found before is kept');
  assert.deepEqual(
    sentOf(fake, 'browse/search').map((line) =>
      /sid=(\d+)&search=.*&scid=(\d)/.exec(line).slice(1),
    ),
    [
      ['10', '1'],
      ['10', '2'],
    ],
    'no search started on Deezer past the budget',
  );
});

test('a search with nothing found because the service did not answer: an error, not "no result"', async (t) => {
  __setTimingForTesting({ musicSearchBudgetMs: 300 });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  await connectFakeHeos(t, ID, slow('browse/search', 1_000));
  const music = handlers();
  await assert.rejects(
    music.search(DEVICE, { query: 'Céline Dion', type: 'album', limit: 10 }),
    /Qobuz did not answer the search "Céline Dion" in time \(Gladys waits 10 s\): try again/,
  );
});

test('a search refused by every service: the refusal, not "no result"', async (t) => {
  t.mock.method(console, 'error', () => {});
  await connectFakeHeos(
    t,
    ID,
    qobuzReceiver({
      overrides: {
        'browse/search': () => [
          { result: 'fail', message: 'eid=12&text=System error&syserrno=-9' },
        ],
      },
    }),
  );
  const music = handlers();
  await assert.rejects(
    music.search(DEVICE, { query: 'Céline Dion', limit: 10 }),
    /Qobuz could not search "Céline Dion": HEOS refused browse\/search: System error/,
  );
});

test('a scene action has no deadline: a slow HEOS still plays', async (t) => {
  __setTimingForTesting({ musicDeadlineMs: 100, musicActReserveMs: 90 });
  const fake = await connectFakeHeos(t, ID, slow('browse/search', 150));
  const scenes = createSceneActionHandlers(() => normalizeConfig());
  const result = await scenes.play_qobuz({ avr: ID, kind: 'album', name: 'Kind of Blue' });
  assert.equal(result.played, 'Kind of Blue');
  assert.equal(sentOf(fake, 'browse/add_to_queue').length, 1);
});

test('a request reached after the deadline is never sent', async (t) => {
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  const heos = getHeos(ID);
  const before = sentOf(fake, 'browse/get_music_sources').length;
  await runWithDeadline(-1, async () => {
    await assert.rejects(heos.request(buildGetMusicSourcesCommand()), DeadlineError);
  });
  await tick(50);
  assert.equal(sentOf(fake, 'browse/get_music_sources').length, before);
});

test('playFromService under a deadline (as a music command would) checks the time left before acting', async (t) => {
  __setTimingForTesting({ musicActReserveMs: 10_000 });
  const fake = await connectFakeHeos(t, ID, qobuzReceiver());
  await runWithDeadline(5_000, async () => {
    await assert.rejects(
      playFromService(ID, { service: 'qobuz', kind: 'album', name: 'Kind of Blue' }, 'main'),
      /nothing was started/,
    );
  });
  assert.deepEqual(sentOf(fake, 'browse/add_to_queue'), []);
});

test('slow search criteria: "did not answer in time", never "no service can search"', async (t) => {
  __setTimingForTesting({ musicSearchBudgetMs: 300 });
  await connectFakeHeos(t, ID, slow('browse/get_search_criteria', 600));
  const music = handlers();
  await assert.rejects(
    music.search(DEVICE, { query: 'Céline Dion', limit: 10 }),
    /HEOS did not answer the search in time \(Gladys waits 10 s\)/,
  );
});
