// Server-clock estimate shared by the whole team. The only local clock used for timing is the
// monotonic performance.now(); Date.now() jumps when someone changes the PC clock, so it is used
// only to detect such jumps and for the rough bootstrap.
//
// A precise round is Cristian's algorithm: each sample brackets one server timestamp between two
// local readings t0 and t3, so offset = server − (t0 + t3) / 2 with error ≤ rtt / 2.

export interface ClockSample {
  /** performance.now() just before the request. */
  t0: number;
  /** performance.now() when the answer arrived. */
  t3: number;
  /** Server epoch ms stamped between t0 and t3. */
  serverMs: number;
}

export interface ClockDeps {
  perfNow(): number;
  wallNow(): number;
  sample(): Promise<ClockSample>;
  sleep(ms: number): Promise<void>;
}

export type ClockQuality = 'none' | 'rough' | 'precise';

export const SAMPLES_PER_ROUND = 5;
export const MIN_ROUND_GAP_MS = 30_000;
export const PERIODIC_ROUND_MS = 300_000;
export const JUMP_THRESHOLD_MS = 1000;
export const RETRY_MS = 10_000;
const BEST_RTT_TTL_MS = 3_600_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class ClockSync {
  /** serverNow = performance.now() + offset */
  offset: number;
  quality: ClockQuality = 'none';
  /** Error bound of the current offset in ms (max accepted rtt / 2). */
  errorMs = Infinity;
  lastRoundAt = -Infinity;
  rounds = 0;
  rejected = 0;

  private deps: ClockDeps;
  private bestRtt = Infinity;
  private bestRttAt = 0;
  private rejectStreak = 0;
  private afterJump = false;
  private failed = false;
  private inflight: Promise<boolean> | null = null;
  private lastTick: { wall: number; perf: number } | null = null;
  private listeners = new Set<(deltaMs: number, prevQuality: ClockQuality) => void>();

  constructor(deps: ClockDeps) {
    this.deps = deps;
    this.offset = deps.wallNow() - deps.perfNow();
  }

  serverNow(): number {
    return this.deps.perfNow() + this.offset;
  }

  /** How far the PC clock is from server time (+ = PC is behind). */
  pcClockErrorMs(): number {
    return this.serverNow() - this.deps.wallNow();
  }

  /** A round is owed: the PC clock jumped (or the PC slept) or the last round failed. */
  get needsRound(): boolean {
    return this.afterJump || this.failed;
  }

  onChange(cb: (deltaMs: number, prevQuality: ClockQuality) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Rough bootstrap from Firebase's .info/serverTimeOffset (server ≈ Date.now() + offsetMs). */
  setRough(serverTimeOffsetMs: number): void {
    if (this.quality === 'precise') return;
    const prev = this.quality;
    this.quality = 'rough';
    this.apply(this.deps.wallNow() + serverTimeOffsetMs - this.deps.perfNow(), prev);
  }

  /** Runs a sync round unless one ran less than 30 s ago (force skips that limit). Concurrent calls share one round. */
  sync(force = false): Promise<boolean> {
    if (this.inflight) return this.inflight;
    const now = this.deps.perfNow();
    if (!force && now - this.lastRoundAt < MIN_ROUND_GAP_MS) return Promise.resolve(false);
    this.lastRoundAt = now;
    this.inflight = this.round(force)
      .catch(() => false)
      .then((ok) => {
        this.failed = !ok && (this.failed || this.afterJump || this.quality !== 'precise');
        return ok;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Call on every tick: detects PC clock changes / sleep and runs the periodic round. */
  tick(): void {
    const wall = this.deps.wallNow();
    const perf = this.deps.perfNow();
    const last = this.lastTick;
    this.lastTick = { wall, perf };
    if (last && Math.abs(wall - last.wall - (perf - last.perf)) > JUMP_THRESHOLD_MS) {
      // Either the PC clock was changed or the PC slept (performance.now() pauses in suspend on
      // macOS/Linux). Drop to 'rough' so the fresh .info/serverTimeOffset of a reconnect is accepted.
      this.afterJump = true;
      if (this.quality === 'precise') this.quality = 'rough';
      void this.sync(true);
      return;
    }
    if (this.needsRound && !this.inflight && perf - this.lastRoundAt > RETRY_MS) void this.sync(true);
    else if (perf - this.lastRoundAt > PERIODIC_ROUND_MS) void this.sync();
  }

  private async round(force: boolean): Promise<boolean> {
    const rows: { rtt: number; off: number }[] = [];
    try {
      await this.deps.sample(); // warm-up: opens connections, primes caches
      for (let i = 0; i < SAMPLES_PER_ROUND; i++) {
        await this.deps.sleep(200);
        const s = await this.deps.sample();
        rows.push({ rtt: s.t3 - s.t0, off: s.serverMs - (s.t0 + s.t3) / 2 });
      }
    } catch {
      if (rows.length < 3) return false;
    }
    this.rounds++;
    const minRtt = Math.min(...rows.map((r) => r.rtt));
    const now = this.deps.perfNow();
    if (now - this.bestRttAt > BEST_RTT_TTL_MS) this.bestRtt = Infinity;
    const congested = minRtt > 3 * this.bestRtt;
    if (congested && this.quality === 'precise' && !force && !this.afterJump) {
      this.rejected++;
      if (++this.rejectStreak >= 3) this.bestRtt = Infinity;
      return false;
    }
    const accepted = rows.filter((r) => r.rtt <= 1.25 * minRtt + 5);
    this.rejectStreak = 0;
    this.afterJump = false;
    if (minRtt < this.bestRtt) {
      this.bestRtt = minRtt;
      this.bestRttAt = now;
    }
    this.errorMs = Math.max(...accepted.map((r) => r.rtt)) / 2;
    const prev = this.quality;
    this.quality = 'precise';
    this.failed = false;
    this.apply(median(accepted.map((r) => r.off)), prev);
    return true;
  }

  private apply(offset: number, prevQuality: ClockQuality): void {
    const delta = offset - this.offset;
    this.offset = offset;
    for (const cb of this.listeners) cb(delta, prevQuality);
  }
}
