import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverFeed,
  followIndesRadiosFeed,
  identifyStation,
  lookupDurationById,
  lookupDurationSeconds,
} from '../src/adbreak/sources.js';
import { loadStatsStore, saveStatsStore } from '../src/adbreak/stats.js';

const encoder = new TextEncoder();

/** A streamed response body: `parts` of text, one chunk each. */
function bodyOf(parts) {
  return new ReadableStream({
    start(stream) {
      for (const part of parts) {
        stream.enqueue(encoder.encode(part));
      }
      stream.close();
    },
  });
}

const tuneinProfile = {
  ok: true,
  json: async () => ({ Link: { WebUrl: 'https://radio.example' } }),
};

test('discoverFeed reads at most 2 MB of the station page', async () => {
  const filler = 'x'.repeat(1024 * 1024);
  const page = (parts) => async (url) =>
    String(url).includes('tunein') ? tuneinProfile : { ok: true, url, body: bodyOf(parts) };
  const near = await discoverFeed('s1', page(['"zones":[{"idMds":"42"}]', filler, filler, filler]));
  assert.deepEqual(near, { type: 'indesradios', site: 'https://radio.example', mdsId: '42' });
  assert.equal(
    await discoverFeed('s1', page([filler, filler, filler, '"zones":[{"idMds":"42"}]'])),
    null,
  );
  const noSite = async () => ({ ok: true, json: async () => ({}) });
  assert.equal(await discoverFeed('s1', noSite), null);
  await assert.rejects(
    discoverFeed('s1', async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
});

test('a feed sending an endless line is dropped and reconnected', async () => {
  let calls = 0;
  const tracks = [];
  const fetchImpl = async (url) => {
    if (String(url).includes('TitleDiffusions')) {
      return { ok: true, json: async () => [] };
    }
    calls += 1;
    return calls === 1
      ? { ok: true, body: bodyOf(['data: ', 'y'.repeat(70 * 1024)]) }
      : {
          ok: true,
          body: bodyOf(['data: {"title":"SONG","artist":"A","durationInSeconds":"99"}\n']),
        };
  };
  const feed = followIndesRadiosFeed({
    site: 'https://radio.example',
    mdsId: '1',
    onTrack: (t) => tracks.push(t),
    fetchImpl,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.ok(calls >= 2, 'reconnected');
    assert.equal(tracks[0].title, 'SONG');
    assert.equal(tracks[0].durationSeconds, 99);
  } finally {
    feed.stop();
  }
});

test('song durations are cached, the oldest forgotten first', async () => {
  let fetches = 0;
  const byId = async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ duration: 180 }) };
  };
  assert.equal(await lookupDurationById('7', byId), 180);
  assert.equal(await lookupDurationById('7', byId), 180);
  assert.equal(fetches, 1);
  const failing = async () => ({ ok: false, status: 404 });
  assert.equal(await lookupDurationById('8', failing), null);

  const search = async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ data: [] }) };
  };
  fetches = 0;
  await lookupDurationSeconds('first', 'song', search);
  for (let i = 0; i < 5000; i++) {
    await lookupDurationSeconds('artist', `song ${i}`, search);
  }
  assert.equal(fetches, 5001);
  await lookupDurationSeconds('artist', 'song 4999', search);
  assert.equal(fetches, 5001, 'a recent one is still cached');
  await lookupDurationSeconds('first', 'song', search);
  assert.equal(fetches, 5002, 'the oldest was forgotten');
});

test('a direct URL station is keyed without its per-play token', () => {
  const a = identifyStation({ mid: 'https://radio.example/live.mp3?token=1#x' });
  const b = identifyStation({ mid: 'https://radio.example/live.mp3?token=2' });
  assert.equal(a.key, 'url:https://radio.example/live.mp3');
  assert.equal(a.key, b.key);
  assert.equal(a.streamUrl, 'https://radio.example/live.mp3?token=1#x', 'played as given');
});

test('the statistics store: a corrupt file is kept aside, saves never clash', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adbreak-stats-'));
  const file = path.join(dir, 'ad-breaks.json');
  try {
    assert.deepEqual(await loadStatsStore(file), {}, 'no file yet');
    await fs.writeFile(file, '{"tunein:s1": {"breaks": [');
    assert.deepEqual(await loadStatsStore(file), {});
    assert.equal(await fs.readFile(`${file}.corrupt`, 'utf8'), '{"tunein:s1": {"breaks": [');
    await fs.writeFile(file, '[1, 2]');
    assert.deepEqual(await loadStatsStore(file), {}, 'not a store either');

    await Promise.all([saveStatsStore(file, { a: 1 }), saveStatsStore(file, { b: 2 })]);
    const saved = await loadStatsStore(file);
    assert.ok(saved.a === 1 || saved.b === 2);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
