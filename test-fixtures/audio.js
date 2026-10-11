// Synthetic radio audio for the ad-break jingle tests (src/adbreak/).

import { SAMPLE_RATE } from '../src/adbreak/bands.js';

// Deterministic pseudo-random "radio": a new mix of tones and noise every
// 0.25 s (its spectrum keeps changing, like voice and music), never twice
// the same. Jingles are fixed sounds dropped in at different places.
export function rng(seed) {
  // mulberry32: a plain LCG repeats itself within seconds of audio.
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function radioAudio(seconds, seed) {
  const random = rng(seed);
  const out = new Int16Array(seconds * SAMPLE_RATE);
  let lowpassed = 0;
  for (let s = 0; s < out.length;) {
    // Segments of 80-300 ms, 1-6 tones, noise of a random color.
    const length = Math.round(SAMPLE_RATE * (0.08 + random() * 0.22));
    const tones = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({
      f: 150 + random() * 4500,
      a: random() * 4000,
    }));
    const noise = random() * 4000;
    const color = random();
    for (let i = s; i < Math.min(s + length, out.length); i++) {
      lowpassed = color * lowpassed + (1 - color) * (random() - 0.5);
      let v = lowpassed * noise * 2;
      for (const { f, a } of tones) {
        v += a * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
      }
      out[i] = v;
    }
    s += length;
  }
  return out;
}
// A 2 s jingle: a rising chirp over a noise "swoosh" (seeded: always the same).
export function jingleAudio(seed, fromHz, toHz) {
  const random = rng(seed);
  const n = 2 * SAMPLE_RATE;
  let phase = 0;
  return Int16Array.from({ length: n }, (_, i) => {
    phase += (2 * Math.PI * (fromHz + ((toHz - fromHz) * i) / n)) / SAMPLE_RATE;
    return 8000 * Math.sin(phase) + (random() - 0.5) * 6000 * Math.sin((Math.PI * i) / n);
  });
}
