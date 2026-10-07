// -----------------------------------------------------------------------------
// Band-energy patterns: how ad-break jingles are compared.
//
// Radio jingles are often "swoosh" sounds (wide-band noise) under the host's
// voice. Landmark fingerprints (spectral peaks, the Shazam idea) fail on
// them: the peaks of noise are different at every airing — measured on OUI
// FM, two airings of its ad jingle shared no landmark at all. The *shape*
// of the spectrum over time, however, repeats: so a sound is described by
// its energy in BANDS log-spaced frequency bands, frame by frame, and two
// sounds are compared by the correlation of those patterns. Each frame is
// level-normalized (overall volume does not matter), and the correlation
// tolerates a voice over one of them: on OUI FM, the learned jingle matched
// its 5 airings of a 2.5 h recording at 0.74-0.90, and nothing else of it
// reached 0.4.
// -----------------------------------------------------------------------------

export const SAMPLE_RATE = 11025;
const FFT_SIZE = 1024; // ~93 ms window
const HOP = 512; // ~46 ms per frame
export const FRAME_SECONDS = HOP / SAMPLE_RATE;
export const BANDS = 32;
const LOW_HZ = 150;
const HIGH_HZ = 5400;

const EDGES = Array.from({ length: BANDS + 1 }, (_, i) =>
  Math.round((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / BANDS)) / (SAMPLE_RATE / FFT_SIZE)),
);

// Precomputed Hann window, twiddles and bit-reversal for the radix-2 FFT.
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
const cosTable = Float64Array.from({ length: FFT_SIZE / 2 }, (_, k) =>
  Math.cos((-2 * Math.PI * k) / FFT_SIZE),
);
const sinTable = Float64Array.from({ length: FFT_SIZE / 2 }, (_, k) =>
  Math.sin((-2 * Math.PI * k) / FFT_SIZE),
);

const re = new Float64Array(FFT_SIZE);
const im = new Float64Array(FFT_SIZE);

/** One frame (FFT_SIZE samples from `start`) -> level-normalized band energies. */
function bandFrame(pcm, start) {
  im.fill(0);
  for (let i = 0; i < FFT_SIZE; i++) {
    re[reversed[i]] = (pcm[start + i] / 32768) * hann[i];
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const stride = FFT_SIZE / size;
    for (let s = 0; s < FFT_SIZE; s += size) {
      for (let k = 0; k < half; k++) {
        const cos = cosTable[k * stride];
        const sin = sinTable[k * stride];
        const a = s + k;
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
  const frame = new Float32Array(BANDS);
  let mean = 0;
  for (let k = 0; k < BANDS; k++) {
    let energy = 1e-9;
    const to = Math.max(EDGES[k + 1], EDGES[k] + 1);
    for (let j = EDGES[k]; j < to; j++) {
      energy += re[j] * re[j] + im[j] * im[j];
    }
    frame[k] = Math.log(energy);
    mean += frame[k];
  }
  mean /= BANDS;
  for (let k = 0; k < BANDS; k++) {
    frame[k] -= mean;
  }
  return frame;
}

/**
 * Band frames of 16-bit mono PCM at SAMPLE_RATE.
 * @param {Int16Array} pcm
 * @returns {Float32Array[]}
 */
export function bandFrames(pcm) {
  const frames = [];
  for (let start = 0; start + FFT_SIZE <= pcm.length; start += HOP) {
    frames.push(bandFrame(pcm, start));
  }
  return frames;
}

/**
 * Streaming version: feed PCM chunks of any size, get each frame once.
 * @param {(frame: Float32Array, endSample: number) => void} onFrame
 *   endSample: index (from the first sample pushed) just after the frame
 */
export function createBandStream(onFrame) {
  let buffer = new Int16Array(0);
  let consumed = 0; // samples dropped from the front of buffer
  return {
    push(samples) {
      const merged = new Int16Array(buffer.length + samples.length);
      merged.set(buffer);
      merged.set(samples, buffer.length);
      buffer = merged;
      let start = 0;
      for (; start + FFT_SIZE <= buffer.length; start += HOP) {
        onFrame(bandFrame(buffer, start), consumed + start + FFT_SIZE);
      }
      buffer = buffer.slice(start);
      consumed += start;
    },
  };
}

/**
 * `length` frames from `from`, flattened, each band zero-mean, unit-norm:
 * ready for a correlation (a dot product). Null for a flat (silent) window.
 */
export function normalizedWindow(frames, from, length) {
  const width = frames[from].length;
  const out = new Float32Array(length * width);
  for (let i = 0; i < length; i++) {
    out.set(frames[from + i], i * width);
  }
  // Each band centered on its mean over the window: what is compared is how
  // the spectrum moves, not its overall color (all audio has more energy in
  // the low bands — that alone made unrelated sounds correlate).
  for (let k = 0; k < width; k++) {
    let mean = 0;
    for (let i = 0; i < length; i++) {
      mean += out[i * width + k];
    }
    mean /= length;
    for (let i = 0; i < length; i++) {
      out[i * width + k] -= mean;
    }
  }
  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-6) {
    return null;
  }
  for (let i = 0; i < out.length; i++) {
    out[i] /= norm;
  }
  return out;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
  }
  return s;
}

/**
 * Best match of a template (normalizedWindow of `length` frames) in frames.
 * @returns {{at: number, score: number}} at: frame index, score in [-1, 1]
 */
export function bestMatch(frames, template, length) {
  let best = { at: -1, score: -1 };
  for (let at = 0; at + length <= frames.length; at++) {
    const window = normalizedWindow(frames, at, length);
    const score = window ? dot(window, template) : -1;
    if (score > best.score) {
      best = { at, score };
    }
  }
  return best;
}

/** Halve time and band resolution (for a fast first search). */
export function coarse(frames) {
  const out = [];
  for (let i = 0; i + 1 < frames.length; i += 2) {
    const a = frames[i];
    const b = frames[i + 1];
    const f = new Float32Array(a.length / 2);
    for (let k = 0; k < f.length; k++) {
      f[k] = (a[2 * k] + a[2 * k + 1] + b[2 * k] + b[2 * k + 1]) / 4;
    }
    out.push(f);
  }
  return out;
}

// Storage: frames quantized to int8 (1/8 resolution, values span about
// ±15), base64 — a 160 s sample is ~150 KB instead of ~1 MB of JSON.
const SCALE = 8;

export function encodeFrames(frames) {
  const width = frames[0]?.length ?? BANDS;
  const bytes = new Int8Array(frames.length * width);
  frames.forEach((f, i) => {
    for (let k = 0; k < width; k++) {
      bytes[i * width + k] = Math.max(-127, Math.min(127, Math.round(f[k] * SCALE)));
    }
  });
  return { width, data: Buffer.from(bytes.buffer).toString('base64') };
}

export function decodeFrames({ width, data }) {
  const buf = Buffer.from(data, 'base64');
  const bytes = new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  const frames = [];
  for (let i = 0; i + width <= bytes.length; i += width) {
    frames.push(Float32Array.from(bytes.subarray(i, i + width), (v) => v / SCALE));
  }
  return frames;
}
