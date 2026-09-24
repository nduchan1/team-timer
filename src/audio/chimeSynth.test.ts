import { describe, expect, it } from 'vitest';
import { synthChime } from './chimeSynth.ts';

describe('synthChime', () => {
  for (const kind of ['bell', 'double', 'soft', 'warn'] as const) {
    it(`${kind}: finite samples, peak within (0, 1], silent ends`, () => {
      const rate = 48_000;
      const s = synthChime(kind, rate);
      expect(s.length).toBeGreaterThan(rate * 0.2);
      expect(s.length).toBeLessThan(rate * 2);
      let peak = 0;
      for (const v of s) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak).toBeGreaterThan(0.2);
      expect(peak).toBeLessThanOrEqual(1);
      expect(Math.abs(s[0])).toBeLessThan(0.01); // attack ramp: no click
      expect(Math.abs(s[s.length - 1])).toBeLessThan(0.01); // fade-out: no click
    });
  }
});
