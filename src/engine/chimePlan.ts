// Pure decisions for the chime scheduler, kept apart from the Web Audio code so they can be tested.

export const RESCHEDULE_TOLERANCE_S = 0.015;
export const LATE_PLAY_MS = 1500;

export interface OutputTimestampLike {
  contextTime?: number;
  performanceTime?: number;
}

/**
 * Maps a performance.now() instant to AudioContext time. getOutputTimestamp() pairs the context time
 * being heard at the speakers with a performance.now() instant, so output latency is included.
 * Before the first rendered block it returns {0, 0}; fall back to currentTime then.
 */
export function toCtxTime(targetPerf: number, ts: OutputTimestampLike, ctxNow: number, perfNow: number): number {
  if (!ts.performanceTime || ts.contextTime === undefined) return ctxNow + (targetPerf - perfNow) / 1000;
  return ts.contextTime + (targetPerf - ts.performanceTime) / 1000;
}

export interface ScheduledSlot {
  key: number;
  /** Context time the source was started for. */
  when: number;
}

export type SlotDecision = 'keep' | 'schedule' | 'past';

/** Should the slot's source be (re)created for this key and target time? */
export function planSlot(slot: ScheduledSlot | null, key: number, when: number, ctxNow: number): SlotDecision {
  if (slot && slot.key === key) {
    if (ctxNow >= slot.when) return 'keep'; // already sounding or done: never play the same zero twice
    if (Math.abs(when - slot.when) <= RESCHEDULE_TOLERANCE_S) return 'keep';
  }
  return when <= ctxNow + 0.005 ? 'past' : 'schedule';
}

/** True when the audio clock kept pace with real time across a tick gap (so scheduled chimes played). */
export function audioRanThrough(gapPerfMs: number, gapCtxS: number, running: boolean): boolean {
  return running && Math.abs(gapCtxS * 1000 - gapPerfMs) < 500;
}

export interface PassInput {
  /** Zeros that passed since the previous tick. */
  passed: number;
  /** A source was scheduled in time for the first of them and the audio kept running. */
  firstCovered: boolean;
  /** How long ago the most recent passed zero was. */
  latenessMs: number;
  audioRunning: boolean;
}

export interface PassResult {
  played: number;
  playLate: boolean;
  missed: number;
}

/**
 * Judges zeros that passed between two ticks. At most one late chime is played, and only if it is
 * less than 1.5 s late; older zeros are skipped and counted as missed, so a waking tab never plays a burst.
 */
export function judgePassedZeros(i: PassInput): PassResult {
  if (i.passed <= 0) return { played: 0, playLate: false, missed: 0 };
  const played = i.firstCovered ? 1 : 0;
  if (!i.firstCovered && i.passed === 1 && i.audioRunning && i.latenessMs <= LATE_PLAY_MS) {
    return { played: 0, playLate: true, missed: 0 };
  }
  return { played, playLate: false, missed: i.passed - played };
}
