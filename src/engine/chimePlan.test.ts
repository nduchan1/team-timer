import { describe, expect, it } from 'vitest';
import { audioRanThrough, judgePassedZeros, planSlot, toCtxTime } from './chimePlan.ts';

describe('toCtxTime', () => {
  it('maps through the output timestamp', () => {
    expect(toCtxTime(11_000, { contextTime: 5, performanceTime: 10_000 }, 5.02, 10_020)).toBeCloseTo(6, 9);
  });

  it('falls back to currentTime before the first rendered block ({0, 0})', () => {
    expect(toCtxTime(12_000, { contextTime: 0, performanceTime: 0 }, 0.5, 10_000)).toBeCloseTo(2.5, 9);
    expect(toCtxTime(12_000, {}, 0.5, 10_000)).toBeCloseTo(2.5, 9);
  });
});

describe('planSlot', () => {
  it('schedules a new key in the future', () => {
    expect(planSlot(null, 1, 10, 5)).toBe('schedule');
    expect(planSlot({ key: 0, when: 4 }, 1, 10, 5)).toBe('schedule');
  });

  it('keeps the same key within 15 ms, reschedules beyond', () => {
    expect(planSlot({ key: 1, when: 10 }, 1, 10.01, 5)).toBe('keep');
    expect(planSlot({ key: 1, when: 10 }, 1, 10.05, 5)).toBe('schedule');
  });

  it('never replays a key that already started', () => {
    expect(planSlot({ key: 1, when: 10 }, 1, 12, 10.2)).toBe('keep');
  });

  it('reports a target already in the past', () => {
    expect(planSlot(null, 1, 4.999, 5)).toBe('past');
    expect(planSlot({ key: 1, when: 6 }, 1, 4.9, 5)).toBe('past');
  });
});

describe('audioRanThrough', () => {
  it('is true only when the audio clock kept pace', () => {
    expect(audioRanThrough(60_000, 60.01, true)).toBe(true);
    expect(audioRanThrough(60_000, 2, true)).toBe(false); // frozen: audio paused
    expect(audioRanThrough(60_000, 60, false)).toBe(false);
  });
});

describe('judgePassedZeros', () => {
  it('counts a covered zero as played', () => {
    expect(judgePassedZeros({ passed: 1, firstCovered: true, latenessMs: 100, audioRunning: true })).toEqual({ played: 1, playLate: false, missed: 0 });
  });

  it('plays late once when under 1.5 s late', () => {
    expect(judgePassedZeros({ passed: 1, firstCovered: false, latenessMs: 900, audioRunning: true })).toEqual({ played: 0, playLate: true, missed: 0 });
  });

  it('skips and counts as missed when later than 1.5 s', () => {
    expect(judgePassedZeros({ passed: 1, firstCovered: false, latenessMs: 1600, audioRunning: true })).toEqual({ played: 0, playLate: false, missed: 1 });
  });

  it('never plays a burst after a long pause', () => {
    expect(judgePassedZeros({ passed: 4, firstCovered: false, latenessMs: 200, audioRunning: true })).toEqual({ played: 0, playLate: false, missed: 4 });
    expect(judgePassedZeros({ passed: 3, firstCovered: true, latenessMs: 200, audioRunning: true })).toEqual({ played: 1, playLate: false, missed: 2 });
  });

  it('counts zeros as missed while the audio is off', () => {
    expect(judgePassedZeros({ passed: 1, firstCovered: false, latenessMs: 100, audioRunning: false })).toEqual({ played: 0, playLate: false, missed: 1 });
  });

  it('does nothing when no zero passed', () => {
    expect(judgePassedZeros({ passed: 0, firstCovered: false, latenessMs: 0, audioRunning: true })).toEqual({ played: 0, playLate: false, missed: 0 });
  });
});
