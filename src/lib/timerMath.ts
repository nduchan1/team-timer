// Pure timer math. A "zero" is a raid moment (a chime). While running, zeros fall at
// anchorMs + k·intervalMs for k ≥ 0, and loops = loopBase + k. Nothing is ever accumulated:
// every view is recomputed from the shared state and the server clock, so there is no drift and
// a tab that wakes from a freeze or sleep jumps straight to the right numbers.

export const MIN_INTERVAL_MS = 10_000;
export const MAX_INTERVAL_MS = 86_400_000;
export const DEFAULT_INTERVAL_MS = 210_000; // 03:30

export type TimerAction = 'create' | 'start' | 'stop' | 'resume' | 'raided' | 'nudge' | 'interval';

/** The part of the shared state that the ops compute. */
export interface TimerCore {
  running: boolean;
  intervalMs: number;
  /** Server-epoch ms of a zero (running), or of the moment it was stopped. */
  anchorMs: number;
  /** Loop count at the anchor zero. */
  loopBase: number;
  /** Written by Stop, used by Resume. */
  pausedRemainingMs?: number;
  /** Server-epoch ms of the Start click, for "running 2 h 14 m". */
  startedAtMs?: number;
  /** While pending after a nudge or interval change: the last real zero before the anchor. */
  prevZeroMs?: number;
}

/** What is stored at rooms/{id}/timer. */
export interface TimerState extends TimerCore {
  /** Version, +1 on every write. */
  v: number;
  updatedAt: number;
  updatedBy: string;
  action: TimerAction;
}

export type Phase = 'stopped' | 'pending' | 'running';

export interface TimerView {
  phase: Phase;
  /** Time until the next zero, in (0, intervalMs] while running. */
  remainingMs: number;
  /** Raids completed since Start. The Start click itself is loop 0. */
  loops: number;
  nextZeroMs: number | null;
  lastZeroMs: number | null;
}

export function timerView(t: TimerCore, now: number): TimerView {
  if (!t.running) {
    return { phase: 'stopped', remainingMs: t.pausedRemainingMs ?? t.intervalMs, loops: t.loopBase, nextZeroMs: null, lastZeroMs: null };
  }
  const el = now - t.anchorMs;
  if (el < 0) {
    // The next zero was set explicitly in the future (nudge, resume, interval change).
    return { phase: 'pending', remainingMs: -el, loops: Math.max(0, t.loopBase - 1), nextZeroMs: t.anchorMs, lastZeroMs: t.prevZeroMs ?? null };
  }
  const k = Math.floor(el / t.intervalMs);
  const lastZeroMs = t.anchorMs + k * t.intervalMs;
  return {
    phase: 'running',
    remainingMs: t.intervalMs - (el - k * t.intervalMs),
    loops: t.loopBase + k,
    nextZeroMs: lastZeroMs + t.intervalMs,
    lastZeroMs,
  };
}

function core(t: TimerCore): TimerCore {
  const c: TimerCore = { running: t.running, intervalMs: t.intervalMs, anchorMs: t.anchorMs, loopBase: t.loopBase };
  if (t.pausedRemainingMs !== undefined) c.pausedRemainingMs = t.pausedRemainingMs;
  if (t.startedAtMs !== undefined) c.startedAtMs = t.startedAtMs;
  if (t.prevZeroMs !== undefined) c.prevZeroMs = t.prevZeroMs;
  return c;
}

/**
 * Moves the anchor to the latest zero (and drops the pending-only prevZeroMs once the anchor zero has
 * passed). The view is unchanged; every op rebases first.
 */
export function rebase(t: TimerCore, now: number): TimerCore {
  if (!t.running || now < t.anchorMs) return core(t);
  const k = Math.floor((now - t.anchorMs) / t.intervalMs);
  const c = core(t);
  delete c.prevZeroMs;
  c.anchorMs = t.anchorMs + k * t.intervalMs;
  c.loopBase = t.loopBase + k;
  return c;
}

function without(t: TimerCore, ...keys: ('pausedRemainingMs' | 'startedAtMs' | 'prevZeroMs')[]): TimerCore {
  const c = core(t);
  for (const k of keys) delete c[k];
  return c;
}

export function clampInterval(ms: number): number {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms / 1000) * 1000));
}

export function opCreate(intervalMs: number, now: number): TimerCore {
  return { running: false, intervalMs: clampInterval(intervalMs), anchorMs: now, loopBase: 0 };
}

/** "I just raided": the click is loop 0 and the next raid is one interval away. */
export function opStart(t: TimerCore, now: number): TimerCore {
  return { running: true, intervalMs: t.intervalMs, anchorMs: now, loopBase: 0, startedAtMs: now };
}

export function opStop(t: TimerCore, now: number): TimerCore {
  if (!t.running) return core(t);
  const cur = timerView(t, now);
  return { ...without(t, 'prevZeroMs'), running: false, anchorMs: now, loopBase: cur.loops, pausedRemainingMs: cur.remainingMs };
}

/** Continue a stopped timer: the next raid is the saved remaining time away, and loops carry on. */
export function opResume(t: TimerCore, now: number): TimerCore {
  if (t.running) return core(t);
  const remaining = t.pausedRemainingMs ?? t.intervalMs;
  const c: TimerCore = { ...without(t, 'pausedRemainingMs', 'prevZeroMs'), running: true, anchorMs: now + remaining, loopBase: t.loopBase + 1 };
  if (c.startedAtMs === undefined) c.startedAtMs = now;
  return c;
}

/**
 * Re-sync: "I clicked raid just now". A click in the first half of a loop is a late click for the zero
 * that just passed (already counted); a click in the second half is an early raid (counts one more).
 */
export function opRaided(t: TimerCore, now: number): TimerCore {
  if (!t.running) return opStart(t, now);
  const r = rebase(t, now);
  const cur = timerView(r, now);
  const base = without(r, 'prevZeroMs');
  if (cur.phase === 'pending') {
    // Half-way between the last real zero and the upcoming one (after Resume: half an interval).
    const prev = r.prevZeroMs;
    const late = prev !== undefined ? now - prev < (r.anchorMs - prev) / 2 : r.anchorMs - now > r.intervalMs / 2;
    return { ...base, anchorMs: now, loopBase: late ? Math.max(0, r.loopBase - 1) : r.loopBase };
  }
  const sinceLast = now - (cur.lastZeroMs ?? now);
  const loopBase = sinceLast < r.intervalMs / 2 ? cur.loops : cur.loops + 1;
  return { ...base, anchorMs: now, loopBase };
}

/** Moves the next raid by deltaMs (+ = later). While stopped it adjusts the saved remaining time. */
export function opNudge(t: TimerCore, now: number, deltaMs: number): TimerCore {
  if (!t.running) {
    const remaining = (t.pausedRemainingMs ?? t.intervalMs) + deltaMs;
    return { ...core(t), anchorMs: now, pausedRemainingMs: Math.min(MAX_INTERVAL_MS, Math.max(1000, remaining)) };
  }
  const r = rebase(t, now);
  const cur = timerView(r, now);
  const x = Math.min(now + MAX_INTERVAL_MS, Math.max(now + 1000, (cur.nextZeroMs ?? now) + deltaMs));
  if (cur.phase === 'pending') return { ...r, anchorMs: x };
  const c: TimerCore = { ...r, anchorMs: x, loopBase: cur.loops + 1 };
  if (cur.lastZeroMs !== null) c.prevZeroMs = cur.lastZeroMs;
  return c;
}

/** A new interval takes effect after the next raid; the next raid itself does not move. */
export function opInterval(t: TimerCore, now: number, intervalMs: number): TimerCore {
  const ms = clampInterval(intervalMs);
  if (!t.running) return { ...core(t), anchorMs: now, intervalMs: ms };
  const r = rebase(t, now);
  const cur = timerView(r, now);
  if (cur.phase === 'pending') return { ...r, intervalMs: ms };
  const c: TimerCore = { ...r, intervalMs: ms, anchorMs: cur.nextZeroMs ?? now, loopBase: cur.loops + 1 };
  if (cur.lastZeroMs !== null) c.prevZeroMs = cur.lastZeroMs;
  return c;
}

export type TimerOp =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'resume' }
  | { kind: 'raided' }
  | { kind: 'nudge'; deltaMs: number }
  | { kind: 'interval'; intervalMs: number };

export function applyOp(t: TimerCore, op: TimerOp, now: number): TimerCore {
  switch (op.kind) {
    case 'start': return opStart(t, now);
    case 'stop': return opStop(t, now);
    case 'resume': return opResume(t, now);
    case 'raided': return opRaided(t, now);
    case 'nudge': return opNudge(t, now, op.deltaMs);
    case 'interval': return opInterval(t, now, op.intervalMs);
  }
}

/**
 * The moment an op is applied at: the click, but never before the state it applies to (a teammate's
 * write that landed between our click and our write). A start/raided anchor is a click moment, not a
 * future raid, so an op must not treat it as a pending zero either.
 */
export function opTime(cur: TimerState, clickNow: number): number {
  let at = Math.max(clickNow, cur.updatedAt);
  if (cur.running && (cur.action === 'start' || cur.action === 'raided')) at = Math.max(at, cur.anchorMs);
  return at;
}

/** Raids (chimes) after fromMs and at or before toMs, for counting raids missed during a freeze or sleep. */
export function zerosBetween(t: TimerCore, fromMs: number, toMs: number): number {
  if (!t.running || toMs <= fromMs) return 0;
  return Math.max(0, timerView(t, toMs).loops - timerView(t, fromMs).loops);
}
