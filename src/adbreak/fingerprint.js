// -----------------------------------------------------------------------------
// Minimal landmark audio fingerprinting (the Shazam idea), pure JS.
//
// A station's ad-break jingle is the same recording every time it airs, so
// it can be recognized in the live stream from a handful of fingerprints:
//   1. spectrogram of mono PCM (FFT_SIZE window, HOP hop);
//   2. keep the strongest local spectral peaks (time, frequency);
//   3. pair each peak with a few peaks just after it: (f1, f2, dt) is a hash
//      that survives volume changes, encoding and noise;
//   4. two recordings share a segment when many of their hashes match with
//      the same time offset between them.
// Robust and cheap: decoding the stream (ffmpeg) costs more than this.
// -----------------------------------------------------------------------------

export const SAMPLE_RATE = 11025;
const FFT_SIZE = 1024; // ~93 ms window
const HOP = 512; // ~46 ms per frame
export const FRAME_SECONDS = HOP / SAMPLE_RATE;
const MIN_BIN = 4; // skip < ~43 Hz
const MAX_BIN = 380; // skip > ~4 kHz (where low-bitrate encoders differ most)
const PEAK_NEIGHBORHOOD_BINS = 12;
const PEAK_NEIGHBORHOOD_FRAMES = 6;
const PEAKS_PER_SECOND = 30;
const FAN_OUT = 5;
const MAX_PAIR_FRAMES = 40; // pair peaks up to ~1.9 s apart

// Precomputed Hann window and bit-reversal for the radix-2 FFT.
const hann = Float64Array.from(
  { length: FFT_SIZE },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)),
);
const bits = Math.log2(FFT_SIZE);
const reversed = Uint32Array.from({ length: FFT_SIZE }, (_, i) => {
  let r = 0;
  for (let b = 0; b < bits; b++) {
    r = (r << 1) | ((i >> b) & 1);
  }
  return r;
});

function magnitudes(frame) {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    re[reversed[i]] = frame[i] * hann[i];
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const cos = Math.cos(step * k);
        const sin = Math.sin(step * k);
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cos - im[b] * sin;
        const ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  const mag = new Float32Array(MAX_BIN);
  for (let k = MIN_BIN; k < MAX_BIN; k++) {
    mag[k] = Math.log1p(Math.hypot(re[k], im[k]));
  }
  return mag;
}

/**
 * Spectrogram frames of 16-bit mono PCM at SAMPLE_RATE.
 * @param {Int16Array} pcm
 * @returns {Float32Array[]}
 */
export function spectrogram(pcm) {
  const frames = [];
  const frame = new Float64Array(FFT_SIZE);
  for (let start = 0; start + FFT_SIZE <= pcm.length; start += HOP) {
    for (let i = 0; i < FFT_SIZE; i++) {
      frame[i] = pcm[start + i] / 32768;
    }
    frames.push(magnitudes(frame));
  }
  return frames;
}

/** Local maxima of the spectrogram, strongest first per second of audio. */
export function peaks(frames) {
  const found = [];
  for (let t = 0; t < frames.length; t++) {
    const f = frames[t];
    for (let k = MIN_BIN; k < MAX_BIN; k++) {
      const v = f[k];
      if (v <= 0.05) {
        continue;
      }
      let isMax = true;
      for (let dt = -PEAK_NEIGHBORHOOD_FRAMES; dt <= PEAK_NEIGHBORHOOD_FRAMES && isMax; dt++) {
        const g = frames[t + dt];
        if (!g) {
          continue;
        }
        for (let dk = -PEAK_NEIGHBORHOOD_BINS; dk <= PEAK_NEIGHBORHOOD_BINS; dk++) {
          if ((dt || dk) && g[k + dk] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) {
        found.push({ t, k, v });
      }
    }
  }
  // Density cap: the PEAKS_PER_SECOND strongest of each second.
  const perSecond = Math.round(1 / FRAME_SECONDS);
  const buckets = new Map();
  for (const p of found) {
    const second = Math.floor(p.t / perSecond);
    if (!buckets.has(second)) {
      buckets.set(second, []);
    }
    buckets.get(second).push(p);
  }
  const kept = [];
  for (const bucket of buckets.values()) {
    kept.push(...bucket.sort((a, b) => b.v - a.v).slice(0, PEAKS_PER_SECOND));
  }
  return kept.sort((a, b) => a.t - b.t || a.k - b.k);
}

/**
 * Landmark hashes: `{hash, t}` with t in frames (see FRAME_SECONDS).
 * hash = f1 (9 bits) | f2 (9 bits) | dt (6 bits), a 24-bit integer.
 */
export function landmarks(peakList) {
  const out = [];
  for (let i = 0; i < peakList.length; i++) {
    const a = peakList[i];
    let paired = 0;
    for (let j = i + 1; j < peakList.length && paired < FAN_OUT; j++) {
      const b = peakList[j];
      const dt = b.t - a.t;
      if (dt === 0) {
        continue;
      }
      if (dt > MAX_PAIR_FRAMES) {
        break;
      }
      out.push({ hash: (a.k << 15) | (b.k << 6) | dt, t: a.t });
      paired += 1;
    }
  }
  return out;
}

/** PCM -> landmark hashes in one go. */
export function fingerprint(pcm) {
  return landmarks(peaks(spectrogram(pcm)));
}

/** Index hashes for matching: hash -> array of frame times. */
export function indexHashes(hashes) {
  const index = new Map();
  for (const { hash, t } of hashes) {
    let times = index.get(hash);
    if (!times) {
      times = [];
      index.set(hash, times);
    }
    times.push(t);
  }
  return index;
}

/**
 * Best alignment between `query` hashes and an indexed reference: the time
 * offset (reference frame - query frame) most hashes agree on, and how many
 * do. A real shared segment gives a sharp peak (tens of hashes per second of
 * shared audio); unrelated audio gives a handful of chance matches.
 * @returns {{offset: number, score: number, queryFrames: number[]}}
 *   queryFrames: query times of the agreeing matches (where the shared part is)
 */
export function bestOffset(query, refIndex) {
  const votes = new Map();
  for (const { hash, t } of query) {
    const times = refIndex.get(hash);
    if (!times) {
      continue;
    }
    for (const rt of times) {
      const offset = rt - t;
      let v = votes.get(offset);
      if (!v) {
        v = [];
        votes.set(offset, v);
      }
      v.push(t);
    }
  }
  let best = { offset: 0, score: 0, queryFrames: [] };
  for (const [offset, frames] of votes) {
    // Tolerate ±1 frame of jitter between two encodings of the same audio.
    const score =
      frames.length + (votes.get(offset - 1)?.length ?? 0) + (votes.get(offset + 1)?.length ?? 0);
    if (score > best.score) {
      best = { offset, score, queryFrames: frames };
    }
  }
  return best;
}

/**
 * Every alignment shared by `query` and an indexed reference with at least
 * `minScore` agreeing hashes, strongest first — several distinct shared
 * segments (a jingle and, elsewhere, a repeated ad) come out separately.
 * Offsets within ±2 frames of a stronger one are the same alignment.
 * @returns {Array<{offset: number, score: number, queryFrames: number[]}>}
 */
export function sharedRegions(query, refIndex, minScore) {
  const votes = new Map();
  for (const { hash, t } of query) {
    const times = refIndex.get(hash);
    if (!times) {
      continue;
    }
    for (const rt of times) {
      const offset = rt - t;
      let frames = votes.get(offset);
      if (!frames) {
        frames = [];
        votes.set(offset, frames);
      }
      frames.push(t);
    }
  }
  const scored = [...votes.entries()]
    .map(([offset, frames]) => ({
      offset,
      score:
        frames.length + (votes.get(offset - 1)?.length ?? 0) + (votes.get(offset + 1)?.length ?? 0),
      queryFrames: [...frames, ...(votes.get(offset - 1) ?? []), ...(votes.get(offset + 1) ?? [])],
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
  const kept = [];
  for (const region of scored) {
    if (!kept.some((k) => Math.abs(k.offset - region.offset) <= 2)) {
      kept.push(region);
    }
  }
  return kept;
}
