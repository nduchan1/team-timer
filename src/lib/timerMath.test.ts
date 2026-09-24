import { describe, expect, it } from 'vitest';
import {
  applyOp,
  clampInterval,
  opCreate,
  opInterval,
  opNudge,
  opRaided,
  opResume,
  opStart,
  opStop,
  rebase,
  timerView,
  zerosBetween,
  type TimerCore,
} from './timerMath.ts';

const I = 210_000;
const T0 = 1_750_000_000_000;

function started(at = T0, interval = I): TimerCore {
  return opStart(opCreate(interval, at - 5000), at);
}

describe('timerView', () => {
  const t = started();

  it('counts down from the full interval right after Start (loop 0)', () => {
    expect(timerView(t, T0)).toMatchObject({ phase: 'running', remainingMs: I, loops: 0, nextZeroMs: T0 + I, lastZeroMs: T0 });
  });

  it('is 1 ms from the zero at I − 1', () => {
    expect(timerView(t, T0 + I - 1)).toMatchObject({ remainingMs: 1, loops: 0 });
  });

  it('rolls over exactly at the zero', () => {
    expect(timerView(t, T0 + I)).toMatchObject({ remainingMs: I, loops: 1, nextZeroMs: T0 + 2 * I });
    expect(timerView(t, T0 + I + 1)).toMatchObject({ remainingMs: I - 1, loops: 1 });
  });

  it('stays exact after 10,000 loops (no drift)', () => {
    const v = timerView(t, T0 + 10_000 * I + 1234);
    expect(v.loops).toBe(10_000);
    expect(v.remainingMs).toBe(I - 1234);
  });

  it('keeps remaining in (0, I] and loops non-decreasing', () => {
    let lastLoops = -1;
    for (let dt = 0; dt < 5 * I; dt += 997) {
      const v = timerView(t, T0 + dt);
      expect(v.remainingMs).toBeGreaterThan(0);
      expect(v.remainingMs).toBeLessThanOrEqual(I);
      expect(v.loops).toBeGreaterThanOrEqual(lastLoops);
      lastLoops = v.loops;
    }
  });

  it('shows the full interval when stopped fresh, and the saved time when paused', () => {
    const fresh = opCreate(I, T0);
    expect(timerView(fresh, T0 + 99_999)).toMatchObject({ phase: 'stopped', remainingMs: I, loops: 0, nextZeroMs: null });
    const stopped = opStop(t, T0 + 50_000);
    expect(timerView(stopped, T0 + 9_999_999)).toMatchObject({ phase: 'stopped', remainingMs: I - 50_000, loops: 0 });
  });
});

describe('rebase', () => {
  it('never changes the view', () => {
    const t = started();
    for (let i = 0; i < 200; i++) {
      const now = T0 + ((i * 7919) % (20 * I));
      const later = now + ((i * 104_729) % (3 * I));
      expect(timerView(rebase(t, now), later)).toEqual(timerView(t, later));
    }
  });

  it('moves the anchor to the latest zero', () => {
    const r = rebase(started(), T0 + 3 * I + 5);
    expect(r.anchorMs).toBe(T0 + 3 * I);
    expect(r.loopBase).toBe(3);
  });
});

describe('ops', () => {
  it('Start: loop 0 now, next raid one interval away', () => {
    const t = opStart(opCreate(I, T0 - 1000), T0);
    expect(t).toMatchObject({ running: true, anchorMs: T0, loopBase: 0, startedAtMs: T0 });
    expect(timerView(t, T0).nextZeroMs).toBe(T0 + I);
  });

  it('Stop then Resume keeps the remaining time and the loop count', () => {
    const t = started();
    const stopAt = T0 + 2 * I + 30_000;
    const stopped = opStop(t, stopAt);
    expect(stopped).toMatchObject({ running: false, loopBase: 2, pausedRemainingMs: I - 30_000 });
    const resumeAt = stopAt + 600_000;
    const resumed = opResume(stopped, resumeAt);
    expect(resumed.pausedRemainingMs).toBeUndefined();
    expect(timerView(resumed, resumeAt)).toMatchObject({ phase: 'pending', remainingMs: I - 30_000, loops: 2 });
    const atZero = resumeAt + I - 30_000;
    expect(timerView(resumed, atZero)).toMatchObject({ phase: 'running', loops: 3, remainingMs: I });
  });

  it('Raided now, late click (first half of a loop): loop count unchanged', () => {
    const t = started();
    const now = T0 + I + 4000; // zero at T0+I passed 4 s ago; the click belongs to it
    const r = opRaided(t, now);
    expect(timerView(r, now)).toMatchObject({ loops: 1, remainingMs: I, nextZeroMs: now + I });
  });

  it('Raided now, early click (second half of a loop): counts one more raid', () => {
    const t = started();
    const now = T0 + I - 10_000; // 10 s before the zero
    const r = opRaided(t, now);
    expect(timerView(r, now)).toMatchObject({ loops: 1, remainingMs: I, nextZeroMs: now + I });
  });

  it('Raided now while stopped acts as Start', () => {
    const r = opRaided(opCreate(I, T0 - 1), T0);
    expect(r).toMatchObject({ running: true, loopBase: 0, anchorMs: T0 });
  });

  it('Raided now while pending uses the same half-loop rule as while running', () => {
    const pending = opNudge(started(), T0 + 1000, 5000); // next zero at T0+I+5000
    const early = T0 + I - 10_000;
    expect(timerView(pending, T0 + 20_000).phase).toBe('pending');
    // 20 s after the last zero: a late click for it, nothing new counted
    expect(timerView(opRaided(pending, T0 + 20_000), T0 + 20_000)).toMatchObject({ phase: 'running', loops: 0, nextZeroMs: T0 + 20_000 + I });
    // 10 s before the (nudged) zero: an early raid, counts one more
    expect(timerView(opRaided(pending, early), early)).toMatchObject({ phase: 'running', loops: 1, nextZeroMs: early + I });
  });

  it('a nudge followed by a late Raided now does not double-count', () => {
    const t = started();
    const z = T0 + 5 * I; // loop 5
    const n = opNudge(t, z + 2000, 1000);
    expect(timerView(n, z + 3000)).toMatchObject({ phase: 'pending', loops: 5 });
    expect(timerView(opRaided(n, z + 4000), z + 4000).loops).toBe(5);
    expect(timerView(opRaided(t, z + 4000), z + 4000).loops).toBe(5); // same as without the nudge
  });

  it('an interval change followed by a late or early Raided now', () => {
    const t = started();
    const z = T0 + 5 * I;
    const c = opInterval(t, z + 5000, 60_000); // next zero stays at z+I
    expect(timerView(opRaided(c, z + 8000), z + 8000).loops).toBe(5); // late click for z
    expect(timerView(opRaided(c, z + 150_000), z + 150_000).loops).toBe(6); // early click for z+I
  });

  it('Raided now right after Resume is late; near the resumed zero it is early', () => {
    const s = opStop(started(), T0 + 2 * I + 30_000); // loop 2, 3:00 left
    const res = opResume(s, T0 + 1_000_000);
    expect(timerView(opRaided(res, T0 + 1_001_000), T0 + 1_001_000).loops).toBe(2);
    expect(timerView(opRaided(res, T0 + 1_170_000), T0 + 1_170_000).loops).toBe(3);
  });

  it('drops prevZeroMs once the pending zero has passed', () => {
    const n = opNudge(started(), T0 + 1000, 5000);
    expect(n.prevZeroMs).toBe(T0);
    expect(rebase(n, T0 + I + 6000).prevZeroMs).toBeUndefined();
    expect(opStop(n, T0 + 2000).prevZeroMs).toBeUndefined();
  });

  it('Nudge +5 s moves the next raid later without changing loops', () => {
    const t = started();
    const now = T0 + 100_000;
    const before = timerView(t, now);
    const n = opNudge(t, now, 5000);
    const after = timerView(n, now);
    expect(after.nextZeroMs).toBe(before.nextZeroMs! + 5000);
    expect(after.loops).toBe(before.loops);
    // at the moved zero the loop count goes up by exactly one, then the old cadence resumes
    expect(timerView(n, after.nextZeroMs!)).toMatchObject({ loops: before.loops + 1, remainingMs: I });
  });

  it('Nudge −5 s moves the next raid sooner, repeated nudges stack', () => {
    const t = started();
    const now = T0 + 100_000;
    const n = opNudge(opNudge(t, now, -5000), now + 10, -5000);
    expect(timerView(n, now + 10).nextZeroMs).toBe(T0 + I - 10_000);
  });

  it('Nudge never moves the next raid into the past (clamps to now + 1 s)', () => {
    const t = started();
    const now = T0 + I - 2000;
    const n = opNudge(t, now, -5000);
    expect(timerView(n, now).nextZeroMs).toBe(now + 1000);
  });

  it('Nudge while stopped adjusts the paused remaining time', () => {
    const s = opStop(started(), T0 + 10_000);
    expect(opNudge(s, T0 + 20_000, 5000).pausedRemainingMs).toBe(I - 10_000 + 5000);
    expect(opNudge(opCreate(I, T0), T0, -5000).pausedRemainingMs).toBe(I - 5000);
  });

  it('Interval change keeps the next raid, then uses the new cadence', () => {
    const t = started();
    const now = T0 + 60_000;
    const next = timerView(t, now).nextZeroMs!;
    const c = opInterval(t, now, 180_000);
    expect(timerView(c, now)).toMatchObject({ nextZeroMs: next, loops: 0 });
    expect(timerView(c, next)).toMatchObject({ loops: 1, remainingMs: 180_000, nextZeroMs: next + 180_000 });
  });

  it('Interval change while stopped just sets it; clamped to 10 s … 24 h', () => {
    expect(opInterval(opCreate(I, T0), T0, 240_000).intervalMs).toBe(240_000);
    expect(clampInterval(1)).toBe(10_000);
    expect(clampInterval(1e12)).toBe(86_400_000);
    expect(clampInterval(210_400)).toBe(210_000);
  });

  it('never produces undefined fields (Firebase rejects them)', () => {
    const t = started();
    const ops = [
      { kind: 'start' },
      { kind: 'stop' },
      { kind: 'resume' },
      { kind: 'raided' },
      { kind: 'nudge', deltaMs: 1000 },
      { kind: 'interval', intervalMs: 200_000 },
    ] as const;
    for (const op of ops) {
      for (const base of [t, opStop(t, T0 + 5000), opCreate(I, T0)]) {
        const out = applyOp(base, op, T0 + 7000);
        for (const v of Object.values(out)) expect(v).not.toBeUndefined();
      }
    }
  });
});

describe('zerosBetween', () => {
  it('counts raids in a window, ignoring the Start click itself', () => {
    const t = started();
    expect(zerosBetween(t, T0 - 1000, T0 + 1000)).toBe(0);
    expect(zerosBetween(t, T0, T0 + I)).toBe(1);
    expect(zerosBetween(t, T0 + I, T0 + 4 * I - 1)).toBe(2);
    expect(zerosBetween(t, T0 + 10, T0 + 10)).toBe(0);
  });

  it('counts the pending zero set by a nudge', () => {
    const n = opNudge(started(), T0 + 1000, 5000);
    const x = timerView(n, T0 + 1000).nextZeroMs!;
    expect(zerosBetween(n, x - 10, x + 10)).toBe(1);
  });
});
