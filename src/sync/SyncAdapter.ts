// Everything the app needs from the sync backend. Firebase RTDB implements it today; a Cloudflare
// Durable Object (or anything else with push + a server clock) can replace it by implementing this.

import type { ClockSample } from '../lib/clockSync.ts';
import type { TimerAction, TimerCore, TimerState } from '../lib/timerMath.ts';

export interface PresenceEntry {
  cid: string;
  name: string;
  onDuty: boolean;
}

/** Computes the next timer from the current one; null aborts the write. */
export type TimerBuild = (cur: TimerState | null, serverNow: number) => TimerCore | null;

export interface WriteResult {
  ok: boolean;
  error?: string;
}

export interface RoomSync {
  readonly mode: 'firebase' | 'local';
  /** Fires with the stored timer (null = no timer in this room yet) on load and on every change. */
  subscribeTimer(cb: (t: TimerState | null) => void, onError: (message: string) => void): () => void;
  /**
   * Atomic read-modify-write; stale writers retry against the latest value. build() always gets the
   * click time; the write is abandoned if it cannot be applied within a few seconds of it.
   * On failure, error is a user-facing sentence.
   */
  write(build: TimerBuild, meta: { action: TimerAction; by: string }, clickNow: number, serverNow: () => number): Promise<WriteResult>;
  subscribeConnection(cb: (connected: boolean) => void): () => void;
  /** Rough server-clock offset (server ≈ Date.now() + offset), available right after connecting. */
  subscribeRoughOffset(cb: (offsetMs: number) => void): () => void;
  /** One round-trip-bracketed server timestamp for ClockSync. */
  sampleClock(): Promise<ClockSample>;
  subscribePresence(cb: (list: PresenceEntry[]) => void): () => void;
  /** Announces (or, with null, withdraws) this tab in the room's presence list. */
  setPresence(p: { name: string; onDuty: boolean } | null): void;
  /** Called on every tick: reconnect watchdog. */
  kick(): void;
  dispose(): void;
}

/** A write retried later than this after the click is abandoned (it would land at the wrong moment). */
export const STALE_WRITE_MS = 5000;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Removes undefined fields (Firebase rejects them). */
export function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
