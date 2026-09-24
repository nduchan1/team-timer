// TimerController: one per open room, outside React. It owns the sync adapter, the clock, the tick
// worker and the chime schedule, and exposes an immutable Snapshot for useSyncExternalStore.
// The network only carries rare changes; every tick recomputes the countdown locally from the shared
// state and the server clock, so a dropped connection never delays a chime.

import { audio, type SoundState } from '../audio/audioEngine.ts';
import { ClockSync, type ClockQuality } from '../lib/clockSync.ts';
import { formatAgo, formatClock, formatCountdown, formatSpan } from '../lib/format.ts';
import { loadPrefs, rememberRoom, savePrefs, type Prefs } from '../lib/prefs.ts';
import { randomId } from '../lib/roomId.ts';
import { applyOp, opCreate, timerView, zerosBetween, type Phase, type TimerAction, type TimerOp, type TimerState } from '../lib/timerMath.ts';
import { firebaseConfigured, getDb } from '../sync/firebase.ts';
import { createFirebaseSync } from '../sync/firebaseAdapter.ts';
import { createLocalSync } from '../sync/localAdapter.ts';
import type { PresenceEntry, RoomSync, TimerBuild } from '../sync/SyncAdapter.ts';
import { audioRanThrough, judgePassedZeros } from './chimePlan.ts';
import { isLockHeld, notify, onLife, wasDiscarded } from './lifecycle.ts';
import { pipWindow, subscribePip } from './pip.ts';
import { Ticker } from './ticker.ts';

const TICK_VISIBLE_MS = 250;
const TICK_HIDDEN_MS = 1000;
const GAP_MS = 3000;
const FLASH_MS = 3000;
const OFFLINE_BANNER_MS = 10_000;
/** Backward clock corrections larger than this are not smoothed over (see onClockStep). */
const BIG_BACKSTEP_MS = 5000;
/** The rules reject timer writes less than 100 ms apart; keep ours further apart than that. */
const WRITE_GAP_MS = 150;
const DEBUG_LINES = 60;

export type BannerId = 'discarded' | 'frozen' | 'missed' | 'sound' | 'offline' | 'pip' | 'local';

export interface Banner {
  id: BannerId;
  tone: 'red' | 'amber' | 'info';
  text: string;
  action?: 'sound' | 'pip';
  dismissable: boolean;
}

export interface Snapshot {
  roomId: string;
  mode: 'firebase' | 'local';
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  exists: boolean;
  phase: Phase;
  countdown: string;
  loops: number;
  intervalMs: number;
  nextRaidAt: string | null;
  warn: boolean;
  flash: boolean;
  canResume: boolean;
  session: string | null;
  changedBy: string | null;
  changedAction: TimerAction | null;
  changedAgo: string | null;
  connected: boolean;
  clockQuality: ClockQuality;
  clockErrorMs: number;
  pcClockNote: string | null;
  sound: SoundState;
  soundWanted: boolean;
  presence: PresenceEntry[];
  me: PresenceEntry;
  joined: boolean;
  canControl: boolean;
  busy: boolean;
  toast: string | null;
  banners: Banner[];
  missedTotal: number;
  prefs: Prefs;
  pipOpen: boolean;
  lockHeld: boolean;
  usesWorker: boolean;
  debugVersion: number;
}

export class TimerController {
  readonly roomId: string;
  readonly clientId = randomId();

  private sync: RoomSync;
  private clock: ClockSync;
  private ticker: Ticker;
  private prefs: Prefs = loadPrefs();
  private timer: TimerState | null = null;
  private status: Snapshot['status'] = 'loading';
  private error: string | null = null;
  private connected = false;
  private disconnectedAt = performance.now();
  private presence: PresenceEntry[] = [];
  private onDuty = false;
  private joined = false;
  private busy = false;
  private lastWriteDone = -Infinity;
  private toast: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private events = new Map<BannerId, Banner>();
  private missedTotal = 0;
  private flashUntil = -Infinity;
  private lastTickPerf = performance.now();
  private lastTickCtx: number | null = null;
  /**
   * Server time up to which zeros have been judged. It only moves forward (small backward clock
   * corrections must not replay a chime), so it can briefly be ahead of serverNow().
   */
  private lastEvalNow: number | null = null;
  private debug: string[] = [];
  private debugVersion = 0;
  private snapshot: Snapshot;
  private snapshotKey = '';
  private listeners = new Set<() => void>();
  private cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(roomId: string) {
    this.roomId = roomId;
    this.sync = firebaseConfigured ? createFirebaseSync(getDb(), roomId, this.clientId) : createLocalSync(roomId, this.clientId);
    this.clock = new ClockSync({
      perfNow: () => performance.now(),
      wallNow: () => Date.now(),
      sample: () => this.sync.sampleClock(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    audio.setVolume(this.prefs.volume, this.prefs.muted);
    if (wasDiscarded) {
      this.addBanner({
        id: 'discarded',
        tone: 'red',
        text: 'The browser unloaded this tab in the background, so raids may have been missed. Fix: add this site to "Always keep these sites active" (see Setup).',
        dismissable: true,
      });
    }
    if (this.sync.mode === 'local') {
      this.addBanner({
        id: 'local',
        tone: 'info',
        text: 'Local mode: Firebase is not configured, so this timer only syncs between tabs of this browser.',
        dismissable: true,
      });
    }

    this.cleanups.push(
      this.sync.subscribeTimer(
        (t) => this.onTimer(t),
        (msg) => {
          this.status = 'error';
          this.error = msg;
          this.log(`timer subscription error: ${msg}`);
          this.touch();
        },
      ),
      this.sync.subscribeConnection((c) => this.onConnection(c)),
      this.sync.subscribeRoughOffset((off) => {
        this.clock.setRough(off);
        this.touch();
      }),
      this.sync.subscribePresence((list) => {
        this.presence = list;
        this.scheduleChimes(); // "chime only while I'm on duty" depends on who is on duty
        this.touch();
      }),
      this.clock.onChange((delta, prev) => this.onClockStep(delta, prev)),
      audio.subscribe(() => {
        this.log(`audio ${audio.state}`);
        // Autoplay may be allowed a moment after load ("Sound: Allow", earlier click on the page).
        if (!this.joined && this.prefs.name && audio.running) void this.join();
        this.scheduleChimes();
        this.touch();
      }),
      onLife((e) => {
        if (e.type === 'resume') {
          this.log(`resumed after freeze of ${formatSpan(e.frozenMs)}`);
          if (e.frozenMs > GAP_MS) {
            this.addBanner({
              id: 'frozen',
              tone: 'amber',
              text: `The browser froze this tab for ${formatSpan(e.frozenMs)}. Add this site to "Always keep these sites active" (see Setup).`,
              dismissable: true,
            });
          }
        }
        if (e.type === 'visible' || e.type === 'resume' || e.type === 'online') {
          void this.clock.sync(this.clock.needsRound);
          this.sync.kick();
        }
        this.updateTickPeriod();
        this.onTick();
        this.touch();
      }),
      subscribePip((closedUnexpectedly) => {
        if (closedUnexpectedly && this.timer?.running) {
          this.addBanner({ id: 'pip', tone: 'info', text: 'The pop-out timer closed.', action: 'pip', dismissable: true });
        } else if (pipWindow()) {
          this.events.delete('pip');
        }
        this.updateTickPeriod();
        this.touch();
      }),
    );

    this.ticker = new Ticker(() => this.onTick());
    this.updateTickPeriod();
    this.snapshot = this.buildSnapshot();

    // With "Sound: Allow" (or an earlier click on this page) the audio can start without the gate.
    void audio.unlock().then((ok) => {
      if (this.disposed) return;
      if (ok && this.prefs.name) void this.join();
      else if (wasDiscarded) notify('Team Timer needs a click', 'The timer tab was reloaded. Click it to turn the raid chime back on.');
      this.touch();
    });
  }

  // ---- store API for React -------------------------------------------------------------------

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  getDebug(): string[] {
    return this.debug;
  }

  // ---- actions --------------------------------------------------------------------------------

  /** The "Enable sound & join" click. */
  async join(name?: string): Promise<void> {
    if (name !== undefined) this.setPrefs({ name: name.trim().slice(0, 24) });
    if (!this.prefs.name || this.disposed) return;
    const ok = await audio.unlock();
    if (!ok) this.log('audio did not start');
    if (this.joined || this.disposed) return;
    this.joined = true;
    this.sync.setPresence({ name: this.prefs.name, onDuty: this.onDuty });
    if (this.timer) rememberRoom(this.roomId);
    this.scheduleChimes();
    this.touch();
  }

  async enableSound(): Promise<void> {
    await audio.unlock();
    this.scheduleChimes();
    this.touch();
  }

  setOnDuty(onDuty: boolean): void {
    this.onDuty = onDuty;
    if (this.joined) this.sync.setPresence({ name: this.prefs.name, onDuty });
    this.scheduleChimes();
    this.touch();
  }

  setPrefs(patch: Partial<Prefs>): void {
    const nameChanged = patch.name !== undefined && patch.name !== this.prefs.name;
    this.prefs = { ...this.prefs, ...patch };
    savePrefs(this.prefs);
    audio.setVolume(this.prefs.volume, this.prefs.muted);
    if (nameChanged && this.joined && this.prefs.name) this.sync.setPresence({ name: this.prefs.name, onDuty: this.onDuty });
    this.scheduleChimes();
    this.touch();
  }

  testSound(): void {
    void audio.unlock().then(() => {
      audio.playNow(this.prefs.preset);
      this.touch();
    });
  }

  testWarning(): void {
    void audio.unlock().then(() => audio.playNow('warn'));
  }

  dismissBanner(id: BannerId): void {
    this.events.delete(id);
    this.touch();
  }

  create(intervalMs: number): Promise<void> {
    return this.write((cur, now) => (cur ? null : opCreate(intervalMs, now)), 'create');
  }

  act(op: TimerOp): Promise<void> {
    return this.write((cur, now) => (cur ? applyOp(cur, op, now) : null), op.kind);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ticker.stop();
    for (const c of this.cleanups) c();
    this.sync.dispose();
    audio.cancel('zero', this.clientId);
    audio.cancel('warn', this.clientId);
    this.listeners.clear();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  // ---- internals ------------------------------------------------------------------------------

  private async write(build: TimerBuild, action: TimerAction): Promise<void> {
    if (!this.canControl()) return;
    // The click moment is what "Raided now" means, even if the write waits or is retried later.
    const clickNow = this.clock.serverNow();
    this.busy = true;
    this.touch();
    const wait = this.lastWriteDone + WRITE_GAP_MS - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await this.sync.write(build, { action, by: this.prefs.name }, clickNow, () => this.clock.serverNow());
    this.lastWriteDone = performance.now();
    this.busy = false;
    if (!res.ok) {
      this.showToast(res.error ?? 'Not saved. Try again.');
      this.log(`write ${action} failed: ${res.error ?? 'aborted'}`);
    }
    if (action === 'create' && res.ok) rememberRoom(this.roomId);
    this.touch();
  }

  private canControl(): boolean {
    return (
      !this.disposed &&
      this.status === 'ready' &&
      this.joined &&
      !this.busy &&
      this.prefs.name.length > 0 &&
      (this.sync.mode === 'local' || (this.connected && this.clock.quality !== 'none'))
    );
  }

  /** Server time used for everything shown or scheduled: never behind what was already judged. */
  private effNow(): number {
    const now = this.clock.serverNow();
    return this.lastEvalNow !== null && this.lastEvalNow > now ? this.lastEvalNow : now;
  }

  private onTimer(t: TimerState | null): void {
    const prev = this.timer;
    this.timer = t;
    this.status = 'ready';
    this.error = null;
    const now = this.clock.serverNow();
    let from = Math.max(now, this.lastEvalNow ?? now);
    if (t && prev?.v !== t.v) {
      this.log(`state v${t.v}: ${t.action} by ${t.updatedBy}`);
      // A teammate's click lands a few ms "in the future" on a client whose clock estimate lags
      // theirs. The click itself is not a raid moment, so never chime for it.
      if (t.running && (t.action === 'start' || t.action === 'raided') && t.anchorMs > from && t.anchorMs - now < 2000) {
        from = t.anchorMs;
      }
    }
    // Zeros are judged against one state only: a change is not a raid moment.
    this.lastEvalNow = from;
    if (t && !t.running) this.flashUntil = -Infinity;
    this.scheduleChimes();
    this.onTickTitle();
    this.touch();
  }

  private onConnection(c: boolean): void {
    if (c === this.connected) return;
    this.connected = c;
    this.log(c ? 'connected' : 'disconnected');
    if (c) void this.clock.sync(this.clock.needsRound || this.clock.quality !== 'precise');
    else this.disconnectedAt = performance.now();
    this.touch();
  }

  /**
   * A clock correction moves serverNow. Forward: a zero may now lie in the skipped span; its
   * unstarted chime is cancelled by scheduleChimes, then the span is judged (late chime or missed).
   * Backward: lastEvalNow stays put, so a zero that already chimed is not scheduled again. The very
   * first estimate, and big backward corrections, just restart the judging.
   */
  private onClockStep(delta: number, prev: ClockQuality): void {
    this.log(`clock ${this.clock.quality} offset step ${delta >= 0 ? '+' : ''}${delta.toFixed(0)} ms, ±${this.clock.errorMs.toFixed(0)} ms`);
    const now = this.clock.serverNow();
    if (prev === 'none' || delta < -BIG_BACKSTEP_MS || this.lastEvalNow === null) {
      this.lastEvalNow = now;
    } else if (delta > 0) {
      this.scheduleChimes();
      this.evaluateZeros(true, 'the clock was corrected');
    }
    this.scheduleChimes();
    this.touch();
  }

  private updateTickPeriod(): void {
    this.ticker.setPeriod(!document.hidden || pipWindow() ? TICK_VISIBLE_MS : TICK_HIDDEN_MS);
  }

  private onTick(): void {
    if (this.disposed) return;
    const perf = performance.now();
    const gap = perf - this.lastTickPerf;
    const ctxNow = audio.ctxTime;
    let audioRan = true;
    if (gap > GAP_MS) {
      audioRan = ctxNow !== null && this.lastTickCtx !== null && audioRanThrough(gap, ctxNow - this.lastTickCtx, audio.running);
      this.log(`tick gap ${formatSpan(gap)} (audio ${audioRan ? 'kept running' : 'stopped'})`);
    }
    this.lastTickPerf = perf;
    this.lastTickCtx = ctxNow;

    this.clock.tick();
    this.sync.kick();
    this.evaluateZeros(audioRan, gap > GAP_MS ? `the tab was paused for ${formatSpan(gap)}` : null);
    this.scheduleChimes();
    this.onTickTitle();
    this.touch();
  }

  /** Judges zeros that passed since they were last judged: played on time, played late, or missed. */
  private evaluateZeros(audioRan: boolean, pauseReason: string | null): void {
    const t = this.timer;
    const now = this.clock.serverNow();
    const from = this.lastEvalNow;
    if (!t || !t.running || from === null || now <= from) {
      this.lastEvalNow = from === null ? now : Math.max(from, now);
      return;
    }
    this.lastEvalNow = now;
    const passed = zerosBetween(t, from, now);
    if (passed === 0) return;
    this.flashUntil = performance.now() + FLASH_MS;
    if (!this.soundWanted()) return;
    const firstKey = timerView(t, from).nextZeroMs;
    const lastZero = timerView(t, now).lastZeroMs ?? now;
    const r = judgePassedZeros({
      passed,
      firstCovered: firstKey !== null && audio.wasCovered(firstKey) && audioRan,
      latenessMs: now - lastZero,
      audioRunning: audio.running,
    });
    if (r.playLate) {
      audio.playNow(this.prefs.preset);
      this.log(`raid chime played late (${(now - lastZero).toFixed(0)} ms)`);
    } else if (r.played) {
      this.log('raid chime played');
    }
    if (r.missed > 0) {
      this.missedTotal += r.missed;
      const why = !audio.running ? 'the sound was off' : (pauseReason ?? 'the chime could not be scheduled in time');
      this.log(`${r.missed} raid chime(s) missed: ${why}`);
      this.addBanner({
        id: 'missed',
        tone: 'red',
        text: `${this.missedTotal} raid chime${this.missedTotal === 1 ? '' : 's'} missed (latest: ${why}). Check the loop count before raiding.`,
        dismissable: true,
      });
      notify('Raid time!', audio.running ? `The chime was missed: ${why}.` : 'The timer sound is off. Click here to turn it back on.');
    }
  }

  private soundWanted(): boolean {
    if (!this.joined || this.prefs.muted) return false;
    if (!this.prefs.dutyOnly) return true;
    const anyoneOnDuty = this.presence.some((p) => p.onDuty);
    return this.onDuty || !anyoneOnDuty;
  }

  private scheduleChimes(): void {
    if (this.disposed) return;
    const t = this.timer;
    const v = t ? timerView(t, this.effNow()) : null;
    if (!t || !v || v.nextZeroMs === null || !this.soundWanted()) {
      audio.cancel('zero', this.clientId);
      audio.cancel('warn', this.clientId);
      return;
    }
    const key = v.nextZeroMs;
    const targetPerf = key - this.clock.offset;
    const d = audio.schedule('zero', key, targetPerf, this.prefs.preset, this.clientId);
    if (d === 'schedule') this.log(`raid chime scheduled in ${formatSpan(targetPerf - performance.now())}`);
    if (this.prefs.preWarnSec > 0) audio.schedule('warn', key, targetPerf - this.prefs.preWarnSec * 1000, 'warn', this.clientId);
    else audio.cancel('warn', this.clientId);
  }

  private onTickTitle(): void {
    const t = this.timer;
    let title = 'Team Timer';
    if (t) {
      const v = timerView(t, this.effNow());
      if (!t.running) title = `Stopped · Team Timer`;
      else if (performance.now() < this.flashUntil) title = 'RAID! · Team Timer';
      else title = `${formatCountdown(v.remainingMs)} · L${v.loops} · Team Timer`;
      const soundProblem = t.running && (!this.joined || (this.soundWanted() && !audio.running));
      if (soundProblem) title = `🔇 ${title}`;
    }
    // Updating the title in the background also keeps Chrome's Memory Saver from discarding the tab.
    if (title !== document.title) document.title = title;
  }

  private addBanner(b: Banner): void {
    this.events.set(b.id, b);
    this.touch();
  }

  private showToast(text: string): void {
    this.toast = text;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.touch();
    }, 5000);
  }

  private log(msg: string): void {
    const d = new Date();
    const stamp = `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    this.debug = [`${stamp} ${msg}`, ...this.debug].slice(0, DEBUG_LINES);
    this.debugVersion++;
  }

  private banners(): Banner[] {
    const list: Banner[] = [];
    const sound = audio.state;
    if (this.joined && this.soundWanted() && sound !== 'running') {
      list.push({
        id: 'sound',
        tone: 'red',
        text: sound === 'unsupported' ? 'This browser cannot play sound.' : 'Sound is OFF: the raid chime cannot play.',
        action: sound === 'unsupported' ? undefined : 'sound',
        dismissable: false,
      });
    }
    if (!this.connected && performance.now() - this.disconnectedAt > OFFLINE_BANNER_MS) {
      list.push({
        id: 'offline',
        tone: 'amber',
        text: 'Offline. The timer keeps running here, but changes are paused until the connection is back.',
        dismissable: false,
      });
    }
    return [...list, ...this.events.values()];
  }

  private buildSnapshot(): Snapshot {
    const t = this.timer;
    const now = this.effNow();
    const v = t ? timerView(t, now) : null;
    const pcErr = this.clock.pcClockErrorMs();
    const pcClockNote =
      this.clock.quality === 'precise' && Math.abs(pcErr) > 2000
        ? `Your PC clock is ${formatSpan(Math.abs(pcErr))} ${pcErr > 0 ? 'behind' : 'ahead'}. The timer is not affected.`
        : null;
    const presence = [...this.presence].sort((a, b) => Number(b.onDuty) - Number(a.onDuty) || a.name.localeCompare(b.name));
    return {
      roomId: this.roomId,
      mode: this.sync.mode,
      status: this.status,
      error: this.error,
      exists: t !== null,
      phase: v?.phase ?? 'stopped',
      countdown: formatCountdown(v?.remainingMs ?? 0),
      loops: v?.loops ?? 0,
      intervalMs: t?.intervalMs ?? 0,
      nextRaidAt: v?.nextZeroMs != null ? formatClock(v.nextZeroMs) : null,
      warn: v !== null && v.phase !== 'stopped' && this.prefs.preWarnSec > 0 && v.remainingMs <= this.prefs.preWarnSec * 1000,
      flash: t?.running === true && performance.now() < this.flashUntil,
      canResume: t !== null && !t.running && t.pausedRemainingMs !== undefined,
      session: t?.running && t.startedAtMs !== undefined ? formatSpan(now - t.startedAtMs) : null,
      changedBy: t?.updatedBy ?? null,
      changedAction: t?.action ?? null,
      changedAgo: t ? formatAgo(now - t.updatedAt) : null,
      connected: this.connected,
      clockQuality: this.clock.quality,
      clockErrorMs: this.clock.errorMs,
      pcClockNote,
      sound: audio.state,
      soundWanted: this.soundWanted(),
      presence,
      me: { cid: this.clientId, name: this.prefs.name, onDuty: this.onDuty },
      joined: this.joined,
      canControl: this.canControl(),
      busy: this.busy,
      toast: this.toast,
      banners: this.banners(),
      missedTotal: this.missedTotal,
      prefs: this.prefs,
      pipOpen: pipWindow() !== null,
      lockHeld: isLockHeld(),
      usesWorker: this.ticker?.usesWorker ?? false,
      debugVersion: this.debugVersion,
    };
  }

  /**
   * Rebuilds the snapshot and notifies React if anything visible changed. While the tab is hidden and
   * no pop-out is open, React is not updated at all (only the title and the chime are), to save CPU;
   * the 'visible' lifecycle event refreshes it.
   */
  private touch(): void {
    if (this.disposed || (document.hidden && !pipWindow())) return;
    const next = this.buildSnapshot();
    const key = JSON.stringify(next);
    if (key === this.snapshotKey) return;
    this.snapshotKey = key;
    this.snapshot = next;
    for (const cb of this.listeners) cb();
  }
}

// ---- registry: one controller per room, surviving StrictMode's double mount ----------------------

const registry = new Map<string, { ctrl: TimerController; refs: number }>();

export function getController(roomId: string): TimerController {
  let entry = registry.get(roomId);
  if (!entry) {
    entry = { ctrl: new TimerController(roomId), refs: 0 };
    registry.set(roomId, entry);
  }
  return entry.ctrl;
}

export function retainController(roomId: string): void {
  const entry = registry.get(roomId);
  if (!entry) return;
  entry.refs++;
  // Switching rooms: the previous room's controller must stop ticking and chiming right away.
  for (const [id, other] of registry) {
    if (id !== roomId && other.refs <= 0) {
      registry.delete(id);
      other.ctrl.dispose();
    }
  }
}

export function releaseController(roomId: string): void {
  const entry = registry.get(roomId);
  if (!entry) return;
  entry.refs--;
  setTimeout(() => {
    if (entry.refs <= 0 && registry.get(roomId) === entry) {
      registry.delete(roomId);
      entry.ctrl.dispose();
    }
  }, 1000);
}
