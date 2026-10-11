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
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
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

// ffmpeg restarts after it exits (stream cut, dead URL): first after
// RESTART_MIN_MS, doubling up to RESTART_MAX_MS while it keeps failing.
const RESTART_MIN_MS = 10_000;
const RESTART_MAX_MS = 10 * 60_000;
// Decoded this long, a stream counts as working again (backoff reset).
const HEALTHY_SECONDS = 60;
// The ring is trimmed in batches of this many seconds (not on every frame).
const RING_TRIM_SECONDS = 60;

/** Learned-state file of a station: a readable name, unique and short. */
export function stationFile(dir, stationKey) {
  const readable = stationKey.replace(/[^a-z0-9_-]/gi, '_');
  if (readable.length <= 80) {
    return path.join(dir, `${readable}.json`);
  }
  const hash = createHash('sha1').update(stationKey).digest('hex').slice(0, 12);
  return path.join(dir, `${readable.slice(0, 60)}_${hash}.json`);
}

// Two templates of the same jingle may cover slightly different parts of
// it (each search picks its best 1.6 s within ~2 s): compared at every
// relative shift up to this, on the overlapping part.
const SAME_SOUND_MAX_SHIFT = Math.round(2 * FRAMES_PER_SECOND);

/** Whether two templates (band frames) are the same sound, at some shift. */
export function sameSound(a, b) {
  const minOverlap = Math.ceil(Math.min(a.length, b.length) / 2);
  for (let shift = -SAME_SOUND_MAX_SHIFT; shift <= SAME_SOUND_MAX_SHIFT; shift++) {
    const fromA = Math.max(0, shift);
    const fromB = Math.max(0, -shift);
    const length = Math.min(a.length - fromA, b.length - fromB);
    if (length < minOverlap) {
      continue;
    }
    const wa = normalizedWindow(a, fromA, length);
    const wb = normalizedWindow(b, fromB, length);
    if (wa && wb && dot(wa, wb) >= MIN_HIT_SCORE) {
      return true;
    }
  }
  return false;
}

/** The learned jingle state of a station, as saved (null if none yet). */
export async function readJingleState(stationKey, dir = STORE_DIR) {
  try {
    const parsed = JSON.parse(await fs.readFile(stationFile(dir, stationKey), 'utf8'));
    return parsed?.version === STORE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** findSharedJingle() in a worker thread (see jingle-worker.js). */
export function findSharedJingleInWorker(encodedSamples) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./jingle-worker.js', import.meta.url), {
      workerData: { samples: encodedSamples },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`jingle worker exited with code ${code}`));
      }
    });
  });
}

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
// How long a hit in observation waits for its verdict.
const VERDICT_SECONDS = 150;

/**
 * Verdict of a jingle hit in observation, or null while it is not due.
 * With song changes, a start hit followed by a song within 60 s was not a
 * break, and an end hit followed by one within VERDICT_SECONDS was a real
 * end. Without any (a station with no titles), nothing would ever contradict
 * a hit: it is checked against what is known of the station instead — a
 * start hit counts when it falls in one of its ad windows (that day, that
 * hour) or when "it's an ad" is pressed right after it; an end hit when a
 * break was in progress, or when the end of the break is pressed right
 * after it.
 * @param {{side: 'start'|'end', at: number, inAdWindow?: boolean, inBreak?: boolean,
 *   marked?: boolean}} hit
 * @param {{now: number, songAt?: number|null, hasSongs: boolean}} news
 * @returns {boolean|null}
 */
export function hitVerdict(hit, { now, songAt = null, hasSongs }) {
  if (hit.marked) {
    return true;
  }
  const age = (now - hit.at) / 1000;
  if (hasSongs) {
    if (songAt !== null && songAt > hit.at) {
      const after = (songAt - hit.at) / 1000;
      if (hit.side === 'start' && after < 60) {
        return false;
      }
      if (hit.side === 'end' && after <= VERDICT_SECONDS) {
        return true;
      }
    }
    return age > VERDICT_SECONDS ? hit.side === 'start' : null;
  }
  if (age <= VERDICT_SECONDS) {
    return null;
  }
  return hit.side === 'start' ? Boolean(hit.inAdWindow) : Boolean(hit.inBreak);
}

export function createJingleListener({
  stationKey,
  streamUrl,
  onHit,
  onChange,
  // What is known of the station when a hit is heard (for hitVerdict).
  context = () => ({ hasSongs: true, inAdWindow: () => false, inBreak: false }),
  ffmpegPath = 'ffmpeg',
  // Injectable for tests.
  spawnImpl = spawn,
  findJingle = findSharedJingleInWorker,
  storeDir = STORE_DIR,
}) {
  const file = stationFile(storeDir, stationKey);
  let state = emptyState();
  let stopped = false;
  let child = null;
  let restartTimer = null;
  let failures = 0; // ffmpeg runs in a row that ended before HEALTHY_SECONDS
  let saving = Promise.resolve(); // one save at a time
  let learning = Promise.resolve(); // one relearn at a time

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
    return side === 'start' ? offsetSeconds <= MAX_START_OFFSET : offsetSeconds >= -MAX_END_OFFSET;
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

  function save() {
    saving = saving
      .then(async () => {
        await fs.mkdir(storeDir, { recursive: true });
        await fs.writeFile(`${file}.tmp`, JSON.stringify(state));
        await fs.rename(`${file}.tmp`, file);
      })
      .catch((err) => logger.warn(`Cannot save ad-break jingles to ${file}: ${err.message}`));
    return saving;
  }

  function onFrame(frame, endSample) {
    // The stream arrives at its real-time pace: the last sample received is
    // "now", earlier ones are dated back from it.
    const at = receivedAt - ((receivedSamples - endSample) / SAMPLE_RATE) * 1000;
    ring.push({ frame, at });
    if (ring[0].at < at - (RING_SECONDS + RING_TRIM_SECONDS) * 1000) {
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
        // Every hit is judged, an active jingle's too: one that starts
        // giving false alarms is dropped (see verdict()).
        const { inAdWindow, inBreak } = context();
        pending.push({ side, at, inAdWindow: inAdWindow(at), inBreak });
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
    child = spawnImpl(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        // Network streams only (an HLS playlist could name other protocols).
        '-protocol_whitelist',
        'http,https,tcp,tls,crypto',
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
      const healthy = receivedSamples >= HEALTHY_SECONDS * SAMPLE_RATE;
      child = null;
      ring = [];
      if (stopped) {
        return;
      }
      failures = healthy ? 0 : failures + 1;
      const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.max(0, failures - 1));
      logger.debug(`${stationKey}: stream decoding ended, restarting in ${delay / 1000} s`);
      restartTimer = setTimeout(start, delay);
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
    learning = learning
      .then(() => relearn(side))
      .catch((err) => logger.warn(`${stationKey}: ${side} jingle search failed: ${err.message}`));
    return learning;
  }

  async function relearn(side) {
    const samples = state.samples[side];
    if (samples.length < MIN_SAMPLES) {
      return;
    }
    const found = await findJingle(samples);
    if (stopped) {
      return;
    }
    const current = state.jingles[side];
    if (!found || !nearTransition(side, found.offsetSeconds)) {
      return;
    }
    // Same sound as the current jingle (or its observation)? Keep its record.
    if (current && sameSound(found.frames, decodeFrames(current.template))) {
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

  function settle(news) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const confirmed = hitVerdict(pending[i], news);
      if (confirmed !== null) {
        verdict(pending[i], confirmed);
        pending.splice(i, 1);
      }
    }
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
      await learning;
      await save();
    },

    /**
     * "It's an ad" pressed at `at` (side 'start'), or the end of a manual
     * break pressed (side 'end'): learn from the sound just before, and
     * confirm a hit of that side heard just before.
     */
    async learnFromMark(at, side = 'start') {
      for (const hit of pending) {
        if (hit.side === side && hit.at <= at && at - hit.at <= VERDICT_SECONDS * 1000) {
          hit.marked = true;
        }
      }
      settle({ now: Date.now(), hasSongs: context().hasSongs });
      await loaded;
      await waitUntilHeard(at + MARK_AFTER * 1000);
      const sample = !stopped && heard(at - MARK_BEFORE * 1000, at + MARK_AFTER * 1000, at);
      if (sample) {
        await addSample(side, sample);
        await save();
      }
    },

    /** Metadata news for the observed (shadow) hits: a song started at `at`. */
    onSongStarted(at) {
      settle({ now: Date.now(), songAt: at, hasSongs: true });
    },

    /** Called every few seconds: settle the hits whose verdict is due. */
    tick(now = Date.now()) {
      settle({ now, hasSongs: context().hasSongs });
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

    /** The learned state, live (what readJingleState() reads once saved). */
    state() {
      return state;
    },

    /** Resolves once the learning and saving in progress are done (tests). */
    settled() {
      return learning.then(() => saving);
    },
  };
}
