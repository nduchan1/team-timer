// Web Audio chime player. Chimes are scheduled ahead with start(when) on the audio clock, which runs on
// the audio thread: main-thread timer throttling in a background tab cannot delay them. Only the next
// raid (and its optional warning) is scheduled, and it is re-anchored every loop.

import { planSlot, toCtxTime, type ScheduledSlot, type SlotDecision } from '../engine/chimePlan.ts';
import { synthChime, type ChimeKind } from './chimeSynth.ts';

export type SoundState = 'locked' | 'running' | 'suspended' | 'interrupted' | 'closed' | 'error' | 'unsupported';
export type SlotName = 'zero' | 'warn';

/** Safari's Audio Session API; on iPhones its 'playback' type rings through the silent switch. */
export const audioSessionSupported = typeof navigator !== 'undefined' && navigator.audioSession !== undefined;

interface LiveSlot extends ScheduledSlot {
  node: AudioBufferSourceNode;
  kind: ChimeKind;
  /** Controller that scheduled it (only one room is active, but two can overlap briefly). */
  owner: string;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<ChimeKind, AudioBuffer>();
  private slots: Record<SlotName, LiveSlot | null> = { zero: null, warn: null };
  /** Raid chimes (key → context time) scheduled in the future while the context was running. */
  private covered = new Map<number, number>();
  private errored = false;
  private gain = 0.64;
  private playback = false;
  private listeners = new Set<() => void>();

  get state(): SoundState {
    if (typeof AudioContext === 'undefined') return 'unsupported';
    if (!this.ctx) return 'locked';
    if (this.errored) return 'error';
    return this.ctx.state as SoundState;
  }

  get running(): boolean {
    return this.state === 'running';
  }

  /** Audio clock in seconds, or null without a running context. */
  get ctxTime(): number | null {
    return this.ctx && this.running ? this.ctx.currentTime : null;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Creates and resumes the context. Call it from a click (autoplay policy). Without a click it only
   * succeeds when the site has "Sound: Allow" or the page already had a user gesture.
   */
  async unlock(): Promise<boolean> {
    if (typeof AudioContext === 'undefined') return false;
    this.applySession();
    if (!this.ctx || this.ctx.state === 'closed' || this.errored) this.create();
    const ctx = this.ctx!;
    try {
      // Without a user gesture Chrome keeps resume() pending until one arrives, so don't wait forever.
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 500))]);
    } catch {
      // stays suspended; the sound gate stays up
    }
    this.emit();
    return ctx.state === 'running';
  }

  setVolume(volume: number, muted: boolean): void {
    this.gain = muted ? 0 : (volume / 100) ** 2;
    if (this.master) this.master.gain.value = this.gain;
  }

  /**
   * Opt-in: Safari's 'playback' audio session plays through the iPhone's silent switch, but it can
   * pause music or voice chat in other apps. Off means Safari's default ('auto').
   */
  setPlaybackSession(on: boolean): void {
    this.playback = on;
    this.applySession();
  }

  private applySession(): void {
    const session = typeof navigator === 'undefined' ? undefined : navigator.audioSession;
    if (!session) return;
    try {
      session.type = this.playback ? 'playback' : 'auto';
    } catch {
      // older Safari: keeps its default
    }
  }

  /** Schedules (or keeps) the slot's chime for a zero at performance.now() time targetPerf. */
  schedule(slot: SlotName, key: number, targetPerf: number, kind: ChimeKind, owner: string): SlotDecision | 'off' {
    const ctx = this.ctx;
    if (!ctx || !this.running || !this.master) return 'off';
    // Never schedule a raid chime that already sounded (e.g. after a backward clock correction).
    const playedAt = slot === 'zero' ? this.covered.get(key) : undefined;
    if (playedAt !== undefined && ctx.currentTime >= playedAt) return 'keep';
    const when = toCtxTime(targetPerf, ctx.getOutputTimestamp(), ctx.currentTime, performance.now());
    const cur = this.slots[slot];
    const pending = cur !== null && cur.key === key && ctx.currentTime < cur.when;
    let decision = planSlot(cur, key, when, ctx.currentTime);
    if (decision === 'keep' && pending && cur.kind !== kind) decision = 'schedule'; // chime preset changed
    if (decision === 'past' && pending && cur.kind === kind && cur.when - when <= 0.05) return 'keep'; // sounds within ms anyway
    if (decision === 'keep') return decision;
    this.cancel(slot);
    if (decision === 'past') return decision;
    const node = ctx.createBufferSource();
    node.buffer = this.buffer(kind);
    node.connect(this.master);
    node.onended = () => node.disconnect();
    node.start(when);
    this.slots[slot] = { key, when, node, kind, owner };
    if (slot === 'zero') {
      this.covered.set(key, when);
      if (this.covered.size > 4) this.covered.delete(this.covered.keys().next().value!);
    }
    return decision;
  }

  /** Was a chime for this raid scheduled in time, and not cancelled before it started? */
  wasCovered(key: number): boolean {
    return this.covered.has(key);
  }

  /**
   * Stops the slot's chime if it has not started yet (never cuts off a chime that is sounding).
   * With an owner, only that owner's chime is cancelled.
   */
  cancel(slot: SlotName, owner?: string): void {
    const cur = this.slots[slot];
    if (cur && owner !== undefined && cur.owner !== owner) return;
    this.slots[slot] = null;
    if (!cur || !this.ctx || this.ctx.currentTime >= cur.when) return;
    if (slot === 'zero') this.covered.delete(cur.key);
    try {
      cur.node.stop();
    } catch {
      // already stopped
    }
    cur.node.disconnect();
  }

  /** Plays right away; with a key, that raid counts as sounded (never scheduled again). */
  playNow(kind: ChimeKind, key?: number): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.running || !this.master) return false;
    if (key !== undefined) this.covered.set(key, ctx.currentTime);
    const node = ctx.createBufferSource();
    node.buffer = this.buffer(kind);
    node.connect(this.master);
    node.onended = () => node.disconnect();
    node.start();
    return true;
  }

  private create(): void {
    const old = this.ctx;
    if (old && old.state !== 'closed') void old.close().catch(() => {});
    const ctx = new AudioContext();
    this.errored = false;
    this.buffers.clear();
    this.slots = { zero: null, warn: null };
    this.covered.clear();
    ctx.onstatechange = () => {
      if (ctx !== this.ctx) return;
      if (ctx.state !== 'running') {
        this.cancel('zero');
        this.cancel('warn');
      }
      this.emit();
    };
    // Chrome 128+: the output device failed. A new context is needed (via the sound banner click).
    ctx.addEventListener('error', () => {
      if (ctx !== this.ctx) return;
      this.errored = true;
      this.covered.clear();
      this.emit();
    });
    this.master = ctx.createGain();
    this.master.gain.value = this.gain;
    this.master.connect(ctx.destination);
    this.ctx = ctx;
  }

  private buffer(kind: ChimeKind): AudioBuffer {
    let b = this.buffers.get(kind);
    if (!b) {
      const ctx = this.ctx!;
      const data = synthChime(kind, ctx.sampleRate);
      b = ctx.createBuffer(1, data.length, ctx.sampleRate);
      b.copyToChannel(data, 0);
      this.buffers.set(kind, b);
    }
    return b;
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

export const audio = new AudioEngine();
