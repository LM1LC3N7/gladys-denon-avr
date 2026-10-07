// -----------------------------------------------------------------------------
// Ad-break jingles: learned automatically, then recognized live.
//
// Song metadata only says when music stops and restarts; between the two, a
// station airs host talk, then its "ads" jingle, the ads, often an "end of
// ads" jingle, maybe more host talk. Those jingles are the exact same
// recording every time, so once known they give the real start and end of
// the ads — no delay to wait out, nothing ducked but the ads.
//
// How it learns, with no user input:
//   1. while a station plays, its stream is decoded (ffmpeg) and fingerprinted
//      (fingerprint.js) into a rolling ~12 min buffer of hashes;
//   2. after each break found from the metadata (songEndedAt -> next song),
//      the audio fingerprints right after the song end ("start" side) and
//      right before the next song ("end" side) are kept as a sample;
//   3. a sound present in most of the last samples, on a given side, is a
//      jingle candidate — but a station also plays its imaging jingles
//      between ordinary songs, so a candidate is first only *observed*: each
//      live hit is checked against what the metadata does next (a break
//      that follows a start-jingle hit, a song that follows an end-jingle
//      hit). It becomes active after CONFIRMATIONS_TO_ACTIVATE confirmed hits
//      with a good precision, and is dropped if its precision degrades.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  SAMPLE_RATE,
  FRAME_SECONDS,
  fingerprint,
  indexHashes,
  sharedRegions,
} from './fingerprint.js';

const logger = createLogger({ name: 'ad-break' });

const HOP_SAMPLES = Math.round(FRAME_SECONDS * SAMPLE_RATE);
const FRAMES_PER_SECOND = 1 / FRAME_SECONDS;
const RING_SECONDS = 12 * 60;
// Fingerprint the stream every STEP_SECONDS, with enough context around the
// new audio for peaks (neighborhood) and pairs (look-ahead) to be complete.
const STEP_SECONDS = 2;
const CONTEXT_SECONDS = 3;

// Sample windows around a break: [song end - 10 s, + 150 s] and
// [next song - 150 s, + 10 s].
const SIDE_BEFORE = 10;
const SIDE_AFTER = 150;
const MAX_SAMPLES = 6;
const MIN_SAMPLES = 3;
// A region shared by two samples needs this many agreeing hashes (~1-2 s of
// identical audio); unrelated audio scores < 10 (measured on OUI FM).
const MIN_SHARED_SCORE = 25;
const MIN_JINGLE_SECONDS = 1.5;
const MAX_JINGLE_SECONDS = 20;

// Live recognition: the last WINDOW_SECONDS of hashes against each jingle.
const WINDOW_SECONDS = 8;
const MIN_HIT_SCORE = 20;
const HIT_COOLDOWN_MS = 90_000;

export const CONFIRMATIONS_TO_ACTIVATE = 2;
const MIN_PRECISION = 0.8;

const STORE_DIR = process.env.AD_BREAK_JINGLES_DIR || '/data/ad-jingles';

const toPairs = (hashes) => hashes.map(({ hash, t }) => [hash, t]);
const fromPairs = (pairs) => pairs.map(([hash, t]) => ({ hash, t }));

/**
 * Group the query frames of a shared region into contiguous runs (gaps
 * under 1.5 s) and return the densest run as [startFrame, endFrame].
 */
function densestRun(frames) {
  const sorted = [...frames].sort((a, b) => a - b);
  let best = null;
  let run = [sorted[0], sorted[0], 1];
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] - run[1] <= 1.5 * FRAMES_PER_SECOND) {
      run = [run[0], sorted[i], run[2] + 1];
      continue;
    }
    if (!best || run[2] > best[2]) {
      best = run;
    }
    if (i < sorted.length) {
      run = [sorted[i], sorted[i], 1];
    }
  }
  return best;
}

/**
 * The sound most of `samples` share, as a jingle template, or null.
 * Each sample is a list of {hash, t} (t: frames relative to the anchor).
 * @returns {null | {hashes: Array<{hash, t}>, frames: number, support: number,
 *   offsetSeconds: number}} offsetSeconds: median position relative to the anchor
 */
export function findSharedJingle(samples) {
  if (samples.length < MIN_SAMPLES) {
    return null;
  }
  const indexes = samples.map(indexHashes);
  let best = null;
  // Regions of the newest sample, checked against every other sample.
  const query = samples.at(-1);
  const regions = [];
  for (let j = 0; j < samples.length - 1; j++) {
    for (const region of sharedRegions(query, indexes[j], MIN_SHARED_SCORE)) {
      const run = densestRun(region.queryFrames);
      if (!run) {
        continue;
      }
      const seconds = (run[1] - run[0]) * FRAME_SECONDS;
      if (seconds >= MIN_JINGLE_SECONDS && seconds <= MAX_JINGLE_SECONDS) {
        regions.push({ from: run[0], to: run[1], other: j, otherOffset: region.offset });
      }
    }
  }
  // A candidate: one region of the newest sample, supported by every other
  // sample that has an overlapping region.
  for (const candidate of regions) {
    const supporters = new Set(
      regions.filter((r) => r.from <= candidate.to && r.to >= candidate.from).map((r) => r.other),
    );
    const support = supporters.size + 1; // + the newest sample itself
    if (support / samples.length < 0.6) {
      continue;
    }
    if (
      !best ||
      support > best.support ||
      (support === best.support && candidate.from < best.from)
    ) {
      const positions = regions
        .filter((r) => r.from <= candidate.to && r.to >= candidate.from)
        .map((r) => (candidate.from + r.otherOffset) * FRAME_SECONDS);
      positions.push(candidate.from * FRAME_SECONDS);
      positions.sort((a, b) => a - b);
      best = { ...candidate, support, offsetSeconds: positions[Math.floor(positions.length / 2)] };
    }
  }
  if (!best) {
    return null;
  }
  const hashes = query
    .filter(({ t }) => t >= best.from && t <= best.to)
    .map(({ hash, t }) => ({ hash, t: t - best.from }));
  return {
    hashes,
    frames: best.to - best.from,
    support: best.support,
    offsetSeconds: best.offsetSeconds,
  };
}

/** Empty learned state of one station. */
function emptyState() {
  return { samples: { start: [], end: [] }, jingles: { start: null, end: null } };
}

/**
 * Follow one station's stream: decode it, fingerprint it, learn its jingles
 * from the breaks the metadata reveals, and report jingle hits.
 *
 * @param {object} opts
 * @param {string} opts.stationKey
 * @param {string} opts.streamUrl
 * @param {(hit: {side: 'start'|'end', active: boolean, at: number, score: number}) => void} opts.onHit
 * @param {() => void} [opts.onChange] a jingle became active or was dropped
 * @param {string} [opts.ffmpegPath]
 */
export function createJingleListener({
  stationKey,
  streamUrl,
  onHit,
  onChange,
  ffmpegPath = 'ffmpeg',
}) {
  const file = path.join(STORE_DIR, `${stationKey.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  let state = emptyState();
  let stopped = false;
  let child = null;
  let restartTimer = null;

  // Rolling buffers. Frames are numbered from the start of the current
  // ffmpeg session; wall time of frame f = wallAtSample(f * HOP_SAMPLES).
  let pcm = new Int16Array(0); // last CONTEXT + STEP seconds of audio
  let pcmStartSample = 0; // absolute sample index of pcm[0]
  let totalSamples = 0;
  let lastReceiveAt = 0;
  let finalizedFrame = 0;
  let ring = []; // [{hash, t (absolute frame), at (epoch ms)}]
  const lastHitAt = { start: 0, end: 0 };
  const pending = []; // shadow-mode hits waiting for the metadata verdict

  const wallAtSample = (sample) => lastReceiveAt - ((totalSamples - sample) / SAMPLE_RATE) * 1000;

  const loaded = fs
    .readFile(file, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text);
      state = { ...emptyState(), ...parsed };
    })
    .catch(() => {});

  async function save() {
    try {
      await fs.mkdir(STORE_DIR, { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(state));
      await fs.rename(`${file}.tmp`, file);
    } catch (err) {
      logger.warn(`Cannot save ad-break jingles to ${file}: ${err.message}`);
    }
  }

  function onPcm(chunk) {
    lastReceiveAt = Date.now();
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.length / 2));
    const merged = new Int16Array(pcm.length + samples.length);
    merged.set(pcm);
    merged.set(samples, pcm.length);
    pcm = merged;
    totalSamples += samples.length;
    if (pcm.length < (CONTEXT_SECONDS + STEP_SECONDS) * SAMPLE_RATE) {
      return;
    }
    // Fingerprint the buffer; keep the landmarks whose anchor is old enough
    // for its peaks and pairs to be final, and not kept already.
    const firstFrame = pcmStartSample / HOP_SAMPLES;
    const safeFrame = firstFrame + Math.floor((pcm.length / SAMPLE_RATE - 2) * FRAMES_PER_SECOND);
    for (const { hash, t } of fingerprint(pcm)) {
      const frame = firstFrame + t;
      if (frame >= finalizedFrame && frame < safeFrame) {
        ring.push({ hash, t: frame, at: wallAtSample(frame * HOP_SAMPLES) });
      }
    }
    finalizedFrame = safeFrame;
    // Keep CONTEXT_SECONDS of audio, cut on a frame boundary.
    const keep = Math.floor((CONTEXT_SECONDS * SAMPLE_RATE) / HOP_SAMPLES) * HOP_SAMPLES;
    pcmStartSample += pcm.length - keep;
    pcm = pcm.slice(pcm.length - keep);
    const horizon = Date.now() - RING_SECONDS * 1000;
    if (ring.length && ring[0].at < horizon) {
      ring = ring.filter((h) => h.at >= horizon);
    }
    recognize();
  }

  function recognize() {
    const now = Date.now();
    const recent = ring.filter((h) => h.at >= now - WINDOW_SECONDS * 1000 - 2000);
    if (recent.length === 0) {
      return;
    }
    for (const side of ['start', 'end']) {
      const jingle = state.jingles[side];
      if (!jingle || now - lastHitAt[side] < HIT_COOLDOWN_MS) {
        continue;
      }
      jingle.index ??= indexHashes(fromPairs(jingle.hashes));
      const match = bestMatch(recent, jingle.index);
      if (match.score >= Math.max(MIN_HIT_SCORE, jingle.hashes.length * 0.08)) {
        lastHitAt[side] = now;
        const at = recent.find((h) => h.t === match.firstFrame)?.at ?? now;
        logger.info(
          `${stationKey}: ${side} jingle heard (score ${match.score}, ${jingle.active ? 'active' : 'observing'})`,
        );
        if (!jingle.active) {
          pending.push({ side, at });
        }
        onHit({ side, active: Boolean(jingle.active), at, score: match.score });
      }
    }
  }

  function bestMatch(recent, index) {
    const regions = sharedRegions(
      recent.map(({ hash, t }) => ({ hash, t })),
      index,
      1,
    );
    const best = regions[0] ?? { score: 0, queryFrames: [] };
    return { score: best.score, firstFrame: Math.min(...best.queryFrames) };
  }

  function start() {
    if (stopped) {
      return;
    }
    pcm = new Int16Array(0);
    pcmStartSample = 0;
    totalSamples = 0;
    finalizedFrame = 0;
    ring = [];
    child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-i',
        streamUrl,
        '-vn',
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', onPcm);
    child.stderr.on('data', (d) => logger.debug(`ffmpeg ${stationKey}: ${String(d).trim()}`));
    child.on('error', (err) => {
      logger.warn(`${stationKey}: cannot run ffmpeg (${err.message}), jingle learning disabled`);
      stopped = true;
    });
    child.on('exit', () => {
      child = null;
      if (!stopped) {
        restartTimer = setTimeout(start, 10_000);
      }
    });
  }

  function sideSample(anchorAt) {
    const from = anchorAt - SIDE_BEFORE * 1000;
    const to = anchorAt + SIDE_AFTER * 1000;
    const inWindow = ring.filter((h) => h.at >= from && h.at <= to);
    if (inWindow.length === 0 || inWindow[0].at > from + 5000 || inWindow.at(-1).at < to - 5000) {
      return null; // not fully heard (listener started late / gap)
    }
    const anchorFrame = inWindow.reduce((best, h) =>
      Math.abs(h.at - anchorAt) < Math.abs(best.at - anchorAt) ? h : best,
    ).t;
    return inWindow.map(({ hash, t }) => ({ hash, t: t - anchorFrame }));
  }

  function endSample(anchorAt) {
    const from = anchorAt - SIDE_AFTER * 1000;
    const to = anchorAt + SIDE_BEFORE * 1000;
    const inWindow = ring.filter((h) => h.at >= from && h.at <= to);
    if (inWindow.length === 0 || inWindow[0].at > from + 5000 || inWindow.at(-1).at < to - 5000) {
      return null;
    }
    const anchorFrame = inWindow.reduce((best, h) =>
      Math.abs(h.at - anchorAt) < Math.abs(best.at - anchorAt) ? h : best,
    ).t;
    return inWindow.map(({ hash, t }) => ({ hash, t: t - anchorFrame }));
  }

  function relearn(side) {
    const found = findSharedJingle(state.samples[side].map(fromPairs));
    const current = state.jingles[side];
    if (!found) {
      return;
    }
    // Same sound as the current jingle (or its observation)? Keep its record.
    if (current) {
      current.index ??= indexHashes(fromPairs(current.hashes));
      const overlap = sharedRegions(found.hashes, current.index, MIN_SHARED_SCORE)[0];
      if (overlap) {
        return;
      }
      if (current.active) {
        return; // An active jingle is only replaced once it has been dropped.
      }
    }
    state.jingles[side] = {
      hashes: toPairs(found.hashes),
      seconds: Math.round(found.frames * FRAME_SECONDS * 10) / 10,
      offsetSeconds: Math.round(found.offsetSeconds),
      support: found.support,
      hits: 0,
      confirmed: 0,
      active: false,
      learnedAt: Date.now(),
    };
    logger.info(
      `${stationKey}: ${side} jingle candidate found (${state.jingles[side].seconds} s, in ${found.support}/${state.samples[side].length} breaks, ~${state.jingles[side].offsetSeconds} s ${side === 'start' ? 'after the song end' : 'before the next song'}), observing it`,
    );
  }

  function verdict(hit, confirmed) {
    const jingle = state.jingles[hit.side];
    if (!jingle) {
      return;
    }
    jingle.hits += 1;
    jingle.confirmed += confirmed ? 1 : 0;
    const precision = jingle.confirmed / jingle.hits;
    if (
      !jingle.active &&
      jingle.confirmed >= CONFIRMATIONS_TO_ACTIVATE &&
      precision >= MIN_PRECISION
    ) {
      jingle.active = true;
      onChange?.();
      logger.info(
        `${stationKey}: ${hit.side} jingle confirmed ${jingle.confirmed}/${jingle.hits}: now active`,
      );
    } else if (jingle.hits >= 3 && precision < MIN_PRECISION) {
      logger.info(
        `${stationKey}: ${hit.side} jingle candidate dropped (${jingle.confirmed}/${jingle.hits} hits were real breaks)`,
      );
      const wasActive = jingle.active;
      state.jingles[hit.side] = null;
      if (wasActive) {
        onChange?.();
      }
    }
    save();
  }

  start();

  return {
    /** A break was measured from the metadata: learn from its audio. */
    async learnFromBreak({ songEndedAt, nextSongAt }) {
      await loaded;
      const startSide = sideSample(songEndedAt);
      const endSide = endSample(nextSongAt);
      for (const [side, sample] of [
        ['start', startSide],
        ['end', endSide],
      ]) {
        if (sample) {
          state.samples[side] = [...state.samples[side], toPairs(sample)].slice(-MAX_SAMPLES);
          relearn(side);
        }
      }
      await save();
    },

    /**
     * Metadata news for the observed (shadow) hits: a song started at `at`.
     * A start-jingle hit followed by a song within 60 s was not a break; one
     * still unanswered after 150 s was. An end-jingle hit followed by a song
     * within 150 s was a real end of break.
     */
    onSongStarted(at) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const hit = pending[i];
        if (at <= hit.at) {
          continue;
        }
        const after = (at - hit.at) / 1000;
        if (hit.side === 'start' && after < 60) {
          verdict(hit, false);
          pending.splice(i, 1);
        } else if (hit.side === 'end' && after <= 150) {
          verdict(hit, true);
          pending.splice(i, 1);
        }
      }
    },

    /** Called every few seconds: settle the hits whose verdict is due. */
    tick(now = Date.now()) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const hit = pending[i];
        const age = (now - hit.at) / 1000;
        if (hit.side === 'start' && age > 150) {
          verdict(hit, true);
          pending.splice(i, 1);
        } else if (hit.side === 'end' && age > 150) {
          verdict(hit, false);
          pending.splice(i, 1);
        }
      }
    },

    /** Is the `side` ('start'/'end') jingle learned and confirmed? */
    hasActive(side) {
      return Boolean(state.jingles[side]?.active);
    },

    /** Resolves once the learned state is loaded from disk. */
    ready: loaded,

    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      child?.kill('SIGTERM');
    },
  };
}
