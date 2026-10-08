// -----------------------------------------------------------------------------
// Ad-break jingles: learned automatically, then recognized live.
//
// Song metadata only says when music stops and restarts; between the two, a
// station airs host talk, then its "ads" jingle, the ads, often an "end of
// ads" jingle, maybe more host talk. Those jingles are the exact same
// recording every time, so once known they give the real start and end of
// the ads — no delay to wait out, nothing ducked but the ads.
//
// How it learns (no user input needed):
//   1. while a station plays, its stream is decoded (ffmpeg) into band-energy
//      patterns (bands.js), kept in a rolling ~16 min buffer;
//   2. after each break found from the metadata (songEndedAt -> next song),
//      the patterns right after the song end ("start" side) and right before
//      the next song ("end" side) are kept as a sample — and so are the
//      ~30 s before each "it's an ad" press, the most precise sample;
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
  createBandStream,
  normalizedWindow,
  dot,
  coarse,
  encodeFrames,
  decodeFrames,
} from './bands.js';

const logger = createLogger({ name: 'ad-break' });

const FRAMES_PER_SECOND = 1 / FRAME_SECONDS;
// Long enough to sample the start side of the longest break (900 s) when
// the next song finally comes.
const RING_SECONDS = 16 * 60;

// Sample windows around a break: [song end - 10 s, + 150 s] and
// [next song - 150 s, + 10 s]; around a "it's an ad" press: [-30 s, +5 s].
const SIDE_BEFORE = 10;
const SIDE_AFTER = 150;
const MARK_BEFORE = 30;
const MARK_AFTER = 5;
// A jingle marks the transition: the start one within MAX_START_OFFSET s
// of the song end, the end one within MAX_END_OFFSET s of the next song.
// A sound shared deeper in the break is an ad aired often (on OUI FM, one
// came back at ~141 s after the song end in 4 breaks of 6): taken for the
// end jingle, it would restore the volume minutes before the music.
const MAX_START_OFFSET = 90;
const MAX_END_OFFSET = 60;
const MAX_SAMPLES = 6;
const MIN_SAMPLES = 3;

// A jingle is matched on TEMPLATE_SECONDS of band patterns (bands.js).
const TEMPLATE_FRAMES = Math.round(1.6 * FRAMES_PER_SECOND);
const COARSE_FRAMES = Math.floor(TEMPLATE_FRAMES / 2);
const CANDIDATE_STEP = 4; // coarse frames (~0.37 s) between candidates
// Correlations (see bands.js): OUI FM's learned jingle scores 0.74-0.90 on
// its airings, nothing else of 2.5 h of its radio reached 0.4.
const COARSE_MIN_SCORE = 0.4;
const COARSE_TRIES = 4;
const MIN_HIT_SCORE = 0.5;
const HIT_COOLDOWN_MS = 90_000;

export const CONFIRMATIONS_TO_ACTIVATE = 2;
const MIN_PRECISION = 0.8;

const STORE_DIR = process.env.AD_BREAK_JINGLES_DIR || '/data/ad-jingles';
const STORE_VERSION = 2;

/**
 * The sound most of `samples` share, as a jingle template, or null.
 * @param {Array<{frames: Float32Array[], anchor: number}>} samples band
 *   frames (bands.js) around breaks; anchor: frame of the song end / next
 *   song / press the sample was taken around
 * @returns {null | {frames: Float32Array[], support: number, score: number,
 *   offsetSeconds: number}} frames: the template (the shared sound, averaged
 *   over its airings); offsetSeconds: its median position from the anchor
 */
export function findSharedJingle(samples) {
  if (samples.length < MIN_SAMPLES) {
    return null;
  }
  // 1. Coarse search: windows of the newest sample against every position
  //    of the other samples.
  const coarseSamples = samples.map((s) => coarse(s.frames));
  const newest = coarseSamples.at(-1);
  const others = coarseSamples.slice(0, -1).map((frames) => {
    const windows = [];
    for (let p = 0; p + COARSE_FRAMES <= frames.length; p++) {
      windows.push(normalizedWindow(frames, p, COARSE_FRAMES));
    }
    return windows;
  });
  // 2. Each coarse match is checked at full resolution (coarse patterns
  //    match by chance too often): a supporter scores MIN_HIT_SCORE there.
  const last = samples.at(-1);
  const refine = (sample, coarseAt, reference) => {
    let aligned = { at: -1, score: -1 };
    for (let at = coarseAt * 2 - 4; at <= coarseAt * 2 + 4; at++) {
      if (at < 0 || at + TEMPLATE_FRAMES > sample.frames.length) {
        continue;
      }
      const w = normalizedWindow(sample.frames, at, TEMPLATE_FRAMES);
      const score = w ? dot(w, reference) : -1;
      if (score > aligned.score) {
        aligned = { at, score };
      }
    }
    return aligned;
  };
  const candidates = [];
  for (let c = 0; c + COARSE_FRAMES <= newest.length; c += CANDIDATE_STEP) {
    const template = normalizedWindow(newest, c, COARSE_FRAMES);
    const from = c * 2;
    const reference =
      from + TEMPLATE_FRAMES <= last.frames.length &&
      normalizedWindow(last.frames, from, TEMPLATE_FRAMES);
    if (!template || !reference) {
      continue;
    }
    const supporters = [];
    others.forEach((windows, j) => {
      // The few best coarse positions (the right one is not always first).
      const coarseMatches = [];
      windows.forEach((w, p) => {
        const score = w ? dot(w, template) : -1;
        if (score >= COARSE_MIN_SCORE) {
          coarseMatches.push({ p, score });
        }
      });
      coarseMatches.sort((a, b) => b.score - a.score);
      const tried = [];
      let bestAligned = { at: -1, score: -1 };
      for (const m of coarseMatches) {
        if (tried.length === COARSE_TRIES) {
          break;
        }
        if (tried.some((p) => Math.abs(p - m.p) <= 4)) {
          continue;
        }
        tried.push(m.p);
        const aligned = refine(samples[j], m.p, reference);
        if (aligned.score > bestAligned.score) {
          bestAligned = aligned;
        }
      }
      if (bestAligned.score >= MIN_HIT_SCORE) {
        supporters.push({ j, ...bestAligned });
      }
    });
    const support = supporters.length + 1;
    if (support / samples.length >= 0.6) {
      const score = supporters.reduce((sum, m) => sum + m.score, 0) / supporters.length;
      candidates.push({ from, supporters, support, score });
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  // 3. The earliest sound of the best support (a station's break opens with
  //    its jingle; other fixed sounds — a sponsor tag, a recurring ad —
  //    come later), at its best-matching position within 2 s.
  const maxSupport = Math.max(...candidates.map((c) => c.support));
  const first = candidates.find((c) => c.support === maxSupport);
  const best = candidates
    .filter((c) => c.support === maxSupport && c.from - first.from <= 2 * FRAMES_PER_SECOND)
    .reduce((a, b) => (b.score > a.score ? b : a));
  // 4. Average the airings of the sound into the template.
  const airings = [
    { sample: last, at: best.from },
    ...best.supporters.map((m) => ({ sample: samples[m.j], at: m.at })),
  ];
  const frames = Array.from({ length: TEMPLATE_FRAMES }, (_, i) => {
    const f = new Float32Array(last.frames[0].length);
    for (const { sample, at } of airings) {
      sample.frames[at + i].forEach((v, k) => {
        f[k] += v / airings.length;
      });
    }
    return f;
  });
  const positions = airings
    .map(({ sample, at }) => (at - sample.anchor) * FRAME_SECONDS)
    .sort((a, b) => a - b);
  return {
    frames,
    support: best.support,
    score: best.score,
    offsetSeconds: positions[Math.floor(positions.length / 2)],
  };
}

/** Empty learned state of one station. */
function emptyState() {
  return {
    version: STORE_VERSION,
    samples: { start: [], end: [] },
    jingles: { start: null, end: null },
  };
}

/**
 * Follow one station's stream: decode it, compute its band patterns, learn
 * its jingles from the breaks the metadata reveals, and report jingle hits.
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

  // Rolling buffer of the stream's band frames with their wall time.
  let ring = []; // [{frame: Float32Array, at: epoch ms}]
  let stream = null;
  let receivedAt = 0; // wall time the last chunk of PCM arrived
  let receivedSamples = 0; // samples received in this ffmpeg session
  const lastHitAt = { start: 0, end: 0 };
  const templates = { start: null, end: null }; // normalized, from state.jingles
  const pending = []; // shadow-mode hits waiting for the metadata verdict

  function nearTransition(side, offsetSeconds) {
    if (offsetSeconds == null) {
      return true;
    }
    return side === 'start'
      ? offsetSeconds <= MAX_START_OFFSET
      : offsetSeconds >= -MAX_END_OFFSET;
  }

  function prepare(side) {
    const jingle = state.jingles[side];
    templates[side] = jingle
      ? normalizedWindow(decodeFrames(jingle.template), 0, jingle.template.frames)
      : null;
  }

  const loaded = fs
    .readFile(file, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text);
      // Version 1 (landmark hashes) cannot be converted: start over.
      if (parsed.version === STORE_VERSION) {
        state = { ...emptyState(), ...parsed };
        for (const side of ['start', 'end']) {
          if (!nearTransition(side, state.jingles[side]?.offsetSeconds)) {
            state.jingles[side] = null;
          }
        }
      }
    })
    .catch(() => {})
    .then(() => {
      prepare('start');
      prepare('end');
    });

  async function save() {
    try {
      await fs.mkdir(STORE_DIR, { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(state));
      await fs.rename(`${file}.tmp`, file);
    } catch (err) {
      logger.warn(`Cannot save ad-break jingles to ${file}: ${err.message}`);
    }
  }

  function onFrame(frame, endSample) {
    // The stream arrives at its real-time pace: the last sample received is
    // "now", earlier ones are dated back from it.
    const at = receivedAt - ((receivedSamples - endSample) / SAMPLE_RATE) * 1000;
    ring.push({ frame, at });
    if (ring[0].at < at - RING_SECONDS * 1000) {
      ring = ring.filter((h) => h.at >= at - RING_SECONDS * 1000);
    }
    recognize(at);
  }

  function recognize(now) {
    if (ring.length < TEMPLATE_FRAMES) {
      return;
    }
    let window = null;
    for (const side of ['start', 'end']) {
      const template = templates[side];
      if (!template || now - lastHitAt[side] < HIT_COOLDOWN_MS) {
        continue;
      }
      window ??= normalizedWindow(
        ring.slice(-TEMPLATE_FRAMES).map((h) => h.frame),
        0,
        TEMPLATE_FRAMES,
      );
      const score = window ? dot(window, template) : 0;
      if (score >= MIN_HIT_SCORE) {
        lastHitAt[side] = now;
        const jingle = state.jingles[side];
        const at = ring.at(-TEMPLATE_FRAMES).at;
        logger.info(
          `${stationKey}: ${side} jingle heard (score ${score.toFixed(2)}, ${jingle.active ? 'active' : 'observing'})`,
        );
        if (!jingle.active) {
          pending.push({ side, at });
        }
        onHit({ side, active: Boolean(jingle.active), at, score });
      }
    }
  }

  function start() {
    if (stopped) {
      return;
    }
    stream = createBandStream(onFrame);
    receivedSamples = 0;
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
    let carry = null; // odd byte left from the previous chunk
    child.stdout.on('data', (chunk) => {
      const bytes = carry ? Buffer.concat([carry, chunk]) : chunk;
      const even = bytes.length & ~1;
      carry = even < bytes.length ? bytes.subarray(even) : null;
      const aligned = Buffer.from(bytes.subarray(0, even)); // own, aligned memory
      receivedAt = Date.now();
      receivedSamples += even / 2;
      stream.push(new Int16Array(aligned.buffer, aligned.byteOffset, even / 2));
    });
    child.stderr.on('data', (d) => logger.debug(`ffmpeg ${stationKey}: ${String(d).trim()}`));
    child.on('error', (err) => {
      logger.warn(`${stationKey}: cannot run ffmpeg (${err.message}), jingle learning disabled`);
      stopped = true;
    });
    child.on('exit', () => {
      child = null;
      ring = [];
      if (!stopped) {
        restartTimer = setTimeout(start, 10_000);
      }
    });
  }

  /** Band frames heard between two wall times, or null if not fully heard. */
  function heard(from, to, anchorAt) {
    const inWindow = ring.filter((h) => h.at >= from && h.at <= to);
    if (inWindow.length === 0 || inWindow[0].at > from + 5000 || inWindow.at(-1).at < to - 5000) {
      return null; // listener started late / stream gap
    }
    let anchor = 0;
    inWindow.forEach((h, i) => {
      if (Math.abs(h.at - anchorAt) < Math.abs(inWindow[anchor].at - anchorAt)) {
        anchor = i;
      }
    });
    return { frames: inWindow.map((h) => h.frame), anchor };
  }

  function addSample(side, sample) {
    state.samples[side] = [
      ...state.samples[side],
      { anchor: sample.anchor, ...encodeFrames(sample.frames) },
    ].slice(-MAX_SAMPLES);
    relearn(side);
  }

  function relearn(side) {
    const samples = state.samples[side].map((s) => ({ frames: decodeFrames(s), anchor: s.anchor }));
    const found = findSharedJingle(samples);
    const current = state.jingles[side];
    if (!found || !nearTransition(side, found.offsetSeconds)) {
      return;
    }
    const template = normalizedWindow(found.frames, 0, found.frames.length);
    // Same sound as the current jingle (or its observation)? Keep its record.
    if (current && templates[side] && template && dot(template, templates[side]) >= MIN_HIT_SCORE) {
      return;
    }
    if (current?.active) {
      return; // An active jingle is only replaced once it has been dropped.
    }
    state.jingles[side] = {
      template: encodeFrames(found.frames),
      offsetSeconds: Math.round(found.offsetSeconds),
      support: found.support,
      score: Math.round(found.score * 100) / 100,
      hits: 0,
      confirmed: 0,
      active: false,
      learnedAt: Date.now(),
    };
    state.jingles[side].template.frames = found.frames.length;
    prepare(side);
    logger.info(
      `${stationKey}: ${side} jingle candidate found (in ${found.support}/${samples.length} samples, ~${state.jingles[side].offsetSeconds} s ${side === 'start' ? 'after the song end' : 'before the next song'}), observing it`,
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
      templates[hit.side] = null;
      if (wasActive) {
        onChange?.();
      }
    }
    save();
  }

  const waitUntilHeard = async (at) => {
    const wait = at + 3000 - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };

  start();

  return {
    /** A break was measured from the metadata: learn from its audio. */
    async learnFromBreak({ songEndedAt, nextSongAt }) {
      await loaded;
      // Called when the next song starts: the end-side sample also needs the
      // SIDE_BEFORE seconds after it, not heard yet.
      await waitUntilHeard(nextSongAt + SIDE_BEFORE * 1000);
      if (stopped) {
        return;
      }
      const startSide = heard(
        songEndedAt - SIDE_BEFORE * 1000,
        Math.min(songEndedAt + SIDE_AFTER * 1000, nextSongAt),
        songEndedAt,
      );
      const endSide = heard(
        Math.max(nextSongAt - SIDE_AFTER * 1000, songEndedAt),
        nextSongAt + SIDE_BEFORE * 1000,
        nextSongAt,
      );
      if (startSide) {
        addSample('start', startSide);
      }
      if (endSide) {
        addSample('end', endSide);
      }
      await save();
    },

    /**
     * The user pressed "it's an ad", usually right after the station's ad
     * jingle: the most precise sample there is.
     */
    async learnFromMark(at) {
      await loaded;
      await waitUntilHeard(at + MARK_AFTER * 1000);
      const sample = !stopped && heard(at - MARK_BEFORE * 1000, at + MARK_AFTER * 1000, at);
      if (sample) {
        addSample('start', sample);
        await save();
      }
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
