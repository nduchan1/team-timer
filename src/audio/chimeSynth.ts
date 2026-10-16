// Chimes are synthesized into a sample buffer once, so there are no audio files to load.

import type { ChimePreset } from '../lib/prefs.ts';

interface Tone {
  /** Start offset in seconds. */
  at: number;
  freq: number;
  amp: number;
  /** Exponential decay time constant in seconds. */
  decay: number;
  length: number;
}

const ATTACK_S = 0.005;

const PRESETS: Record<ChimePreset | 'warn' | 'remind', { tones: Tone[]; peak: number }> = {
  // Bell: a few inharmonic-ish partials with a long ring.
  bell: {
    peak: 0.8,
    tones: [
      { at: 0, freq: 880, amp: 1, decay: 0.45, length: 1.4 },
      { at: 0, freq: 1320, amp: 0.5, decay: 0.3, length: 1.2 },
      { at: 0, freq: 1760, amp: 0.25, decay: 0.2, length: 1 },
      { at: 0, freq: 2640, amp: 0.2, decay: 0.12, length: 0.8 },
    ],
  },
  // Two short high beeps.
  double: {
    peak: 0.7,
    tones: [
      { at: 0, freq: 1046.5, amp: 1, decay: 0.08, length: 0.2 },
      { at: 0, freq: 2093, amp: 0.3, decay: 0.05, length: 0.2 },
      { at: 0.28, freq: 1046.5, amp: 1, decay: 0.08, length: 0.2 },
      { at: 0.28, freq: 2093, amp: 0.3, decay: 0.05, length: 0.2 },
    ],
  },
  // Soft low tone.
  soft: {
    peak: 0.6,
    tones: [
      { at: 0, freq: 660, amp: 1, decay: 0.25, length: 0.9 },
      { at: 0, freq: 990, amp: 0.3, decay: 0.15, length: 0.6 },
    ],
  },
  // Pre-warning: one quiet tick, clearly different from the raid chime.
  warn: {
    peak: 0.35,
    tones: [{ at: 0, freq: 587.3, amp: 1, decay: 0.07, length: 0.25 }],
  },
  // Reminder (artwork ready): a rising three-note "ding-ding-dong", unlike any raid chime.
  remind: {
    peak: 0.6,
    tones: [
      { at: 0, freq: 659.3, amp: 1, decay: 0.18, length: 0.45 },
      { at: 0.22, freq: 784, amp: 1, decay: 0.18, length: 0.45 },
      { at: 0.44, freq: 1046.5, amp: 1, decay: 0.35, length: 0.9 },
      { at: 0.44, freq: 2093, amp: 0.15, decay: 0.15, length: 0.5 },
    ],
  },
};

export type ChimeKind = ChimePreset | 'warn' | 'remind';

export function synthChime(kind: ChimeKind, sampleRate: number): Float32Array<ArrayBuffer> {
  const { tones, peak } = PRESETS[kind];
  const lengthS = Math.max(...tones.map((t) => t.at + t.length));
  const out = new Float32Array(Math.ceil(lengthS * sampleRate));
  for (const t of tones) {
    const start = Math.floor(t.at * sampleRate);
    const n = Math.min(out.length - start, Math.floor(t.length * sampleRate));
    const w = (2 * Math.PI * t.freq) / sampleRate;
    const fadeOut = Math.floor(0.02 * sampleRate);
    for (let i = 0; i < n; i++) {
      const s = i / sampleRate;
      let env = t.amp * Math.exp(-s / t.decay);
      if (s < ATTACK_S) env *= s / ATTACK_S;
      if (i > n - fadeOut) env *= (n - i) / fadeOut; // no click at the cut
      out[start + i] += env * Math.sin(w * i);
    }
  }
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < out.length; i++) out[i] *= k;
  }
  return out;
}
