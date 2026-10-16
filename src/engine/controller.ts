// TimerController: one per open room, outside React. It owns the sync adapter, the clock, the tick
// worker and the chime schedule, and exposes an immutable Snapshot for useSyncExternalStore.
// The network only carries rare changes; every tick recomputes the countdown locally from the shared
// state and the server clock, so a dropped connection never delays a chime.

import { audio, type SoundState } from '../audio/audioEngine.ts';
import { countUnread, latestAt, layoutMessages, normalizeChatText, type ChatItem, type ChatMessage } from '../lib/chat.ts';
import { ClockSync, type ClockQuality } from '../lib/clockSync.ts';
import { formatAgo, formatCountdown, formatSpan } from '../lib/format.ts';
import { getUid, loadDutyState, loadPrefs, rememberRoom, saveDutyState, savePrefs, type DutyState, type Prefs } from '../lib/prefs.ts';
import { dutyView, groupPeople, normName, type Person } from '../lib/presence.ts';
import {
  ARTWORK,
  instanceKey,
  phaseOf,
  ReminderTracker,
  SNOOZE_MS,
  withPresets,
  type Reminder,
  type ReminderPhase,
} from '../lib/reminders.ts';
import { randomId } from '../lib/roomId.ts';
import { formatServerTime } from '../lib/serverTime.ts';
import { versionCheck } from '../lib/version.ts';
import { applyOp, opCreate, opTime, timerView, zerosBetween, type Phase, type TimerAction, type TimerOp, type TimerState } from '../lib/timerMath.ts';
import { firebaseConfigured, getDb } from '../sync/firebase.ts';
import { createFirebaseSync } from '../sync/firebaseAdapter.ts';
import { createLocalSync } from '../sync/localAdapter.ts';
import type { PresenceEntry, ReminderPatch, RoomSync, TimerBuild } from '../sync/SyncAdapter.ts';
import { audioRanThrough, judgePassedZeros } from './chimePlan.ts';
import { isLockHeld, notify, onLife, wasDiscarded } from './lifecycle.ts';
import { pipWindow, subscribePip } from './pip.ts';
import { Ticker } from './ticker.ts';
import { setWakeWanted, subscribeWakeLock, wakeLockHeld, wakeLockSupported } from './wakeLock.ts';

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
/** A tab reloaded within this time of its last save gets its on-duty flag back without asking. */
const DUTY_RESTORE_MS = 120_000;
/** Older than the restore window but younger than this: ask "still on duty?" instead. */
const DUTY_PROMPT_MAX_MS = 12 * 3_600_000;
/** While on duty the saved flag is re-stamped this often, so a crash or an OS kill counts as recent. */
const DUTY_REFRESH_MS = 30_000;

export type BannerId =
  | 'discarded'
  | 'frozen'
  | 'missed'
  | 'sound'
  | 'offline'
  | 'pip'
  | 'local'
  | 'update'
  | 'cover'
  | 'duty-restore'
  | 'reminder';

export interface BannerAction {
  id: 'sound' | 'pip' | 'reload' | 'off-duty' | 'duty-yes' | 'duty-no' | 'remind-used' | 'remind-snooze';
  label: string;
  /** The reminder id, for the reminder actions. */
  arg?: string;
}

/** A reminder as shown now. */
export interface ReminderView extends Reminder {
  phase: ReminderPhase;
  remainingMs: number;
  /** "4 h 10 min ago" for the last "Used now". */
  usedAgo: string | null;
}

export interface Banner {
  id: BannerId;
  tone: 'red' | 'amber' | 'info';
  text: string;
  actions?: BannerAction[];
  dismissable: boolean;
}

export interface ChatView {
  loaded: boolean;
  items: ChatItem[];
  error: string | null;
}

/**
 * take: on duty. cover: ask for cover and keep raiding (on duty) until tapping "I'm off now"; once
 * someone else goes on duty, a banner offers it. off: this device off duty.
 */
export type Handoff = 'take' | 'cover' | 'off' | 'back';

const HANDOFF_TEXT: Record<Handoff, string> = {
  take: '🛡️ Taking over the raids.',
  cover: '🆘 Who can take over the raids? I keep raiding until then.',
  off: '💤 Off raid duty.',
  back: '👋 Back.',
};

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
  /** Server time of the next raid. */
  nextRaidMs: number | null;
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
  /** Other people on duty, when "chime only while I'm on duty" is what keeps this tab silent. */
  silencedBy: string[];
  /** One row per person (their tabs and devices grouped by name), this tab included once joined. */
  people: Person[];
  /** The team list could not be read (it then counts as nobody else on duty, so chimes still play). */
  presenceError: boolean;
  me: PresenceEntry;
  joined: boolean;
  canControl: boolean;
  busy: boolean;
  toast: string | null;
  banners: Banner[];
  missedTotal: number;
  /** missedTotal while its banner is up, 0 once dismissed. */
  missedShown: number;
  /** A newer version is deployed and its banner is still up: reload to get it. */
  updateReady: boolean;
  wakeSupported: boolean;
  /** The screen is kept awake (this device is on duty and the page or pop-out is visible). */
  wakeHeld: boolean;
  prefs: Prefs;
  pipOpen: boolean;
  lockHeld: boolean;
  usesWorker: boolean;
  debugVersion: number;
  /** Chat messages from teammates that arrived while the tab was hidden. */
  chatUnread: number;
  canChat: boolean;
  /** A hand-off message is being sent (the quick buttons wait for it). */
  handoffBusy: boolean;
  /** The room's reminders (with the artwork row once they have loaded; empty before). */
  reminders: ReminderView[];
  remindersLoaded: boolean;
  /** A due reminder this tab has not dismissed yet. */
  remindDue: { id: string; label: string } | null;
  canRemind: boolean;
  remindersError: string | null;
}

export class TimerController {
  readonly roomId: string;
  readonly clientId = randomId();
  /** Stable per-browser id for chat authorship. */
  readonly uid = getUid();

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
  private presenceError = false;
  private onDuty = false;
  /** The on-duty state the previous page of this tab saved, judged against this page's load time. */
  private readonly loadedAt = Date.now();
  private savedDuty: DutyState | null;
  private dutySavedAt = -Infinity;
  /** The saved state was too old to restore silently: ask whether the player is still on duty. */
  private dutyPrompt = false;
  /** While asking for cover: names already on duty then, so a newcomer on duty can be spotted. */
  private coverAsk: { before: Set<string> } | null = null;
  private updateDismissed = false;
  private remembered = false;
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
  private chatMsgs: ChatMessage[] = [];
  private chatView: ChatView = { loaded: false, items: [], error: null };
  private handoffBusy = false;
  private chatListeners = new Set<() => void>();
  private chatSeenAt: number | null = null;
  private chatUnread = 0;
  private reminders: Reminder[] = [];
  /** Until the first snapshot, the made-up artwork row must not be written over real data. */
  private remindersLoaded = false;
  private remindersError: string | null = null;
  private remindBusy = false;
  private readonly remindTracker = new ReminderTracker();
  /** Due reminder instances (id@dueAt) whose banner this tab dismissed. */
  private remindAcked = new Set<string>();
  private snapshot: Snapshot;
  private snapshotKey = '';
  private listeners = new Set<() => void>();
  private cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(roomId: string) {
    this.roomId = roomId;
    this.savedDuty = loadDutyState(roomId);
    this.sync = firebaseConfigured ? createFirebaseSync(getDb(), roomId, this.clientId) : createLocalSync(roomId, this.clientId);
    this.clock = new ClockSync({
      perfNow: () => performance.now(),
      wallNow: () => Date.now(),
      sample: () => this.sync.sampleClock(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    audio.setVolume(this.prefs.volume, this.prefs.muted);
    audio.setPlaybackSession(this.prefs.ringInSilent);
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
      this.sync.subscribeChat(
        (msgs) => this.onChat(msgs),
        (msg) => {
          this.chatView = { ...this.chatView, error: msg };
          this.log(`chat subscription error: ${msg}`);
          for (const cb of this.chatListeners) cb();
        },
      ),
      this.sync.subscribePresence(
        (list) => {
          this.presence = list;
          this.presenceError = false;
          this.scheduleChimes(); // "chime only while I'm on duty" depends on who is on duty
          this.touch();
        },
        (msg) => {
          // An unreadable list must not keep duty-only tabs silent: count it as nobody else on duty.
          this.presence = [];
          this.presenceError = true;
          this.log(`presence subscription error: ${msg}`);
          this.scheduleChimes();
          this.touch();
        },
      ),
      this.sync.subscribeReminders(
        (list) => {
          this.reminders = list;
          this.remindersLoaded = true;
          this.remindersError = null;
          this.evaluateReminders();
          this.touch();
        },
        (msg) => {
          this.remindersError = msg;
          this.log(`reminders subscription error: ${msg}`);
          this.touch();
        },
      ),
      versionCheck.subscribe(() => {
        this.log('a newer version is deployed');
        this.touch();
      }),
      subscribeWakeLock(() => this.touch()),
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
        if (e.type === 'visible') versionCheck.maybeCheck(true);
        if (e.type === 'visible') this.markChatSeen();
        this.updateTickPeriod();
        this.onTick();
        this.touch();
      }),
      subscribePip((closedUnexpectedly) => {
        if (closedUnexpectedly && this.timer?.running) {
          this.addBanner({
            id: 'pip',
            tone: 'info',
            text: 'The pop-out timer closed.',
            actions: [{ id: 'pip', label: 'Re-open pop-out' }],
            dismissable: true,
          });
        } else if (pipWindow()) {
          this.events.delete('pip');
        }
        this.updateTickPeriod();
        this.touch();
      }),
    );

    // The on-duty flag is saved on every change, every 30 s while on duty, and when the page goes
    // away, so a reload within a couple of minutes (F5, a crash) can restore it.
    const onPageHide = () => this.saveDuty();
    window.addEventListener('pagehide', onPageHide);
    this.cleanups.push(() => window.removeEventListener('pagehide', onPageHide));

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

  subscribeChat = (cb: () => void): (() => void) => {
    this.chatListeners.add(cb);
    return () => this.chatListeners.delete(cb);
  };

  getChat = (): ChatView => this.chatView;

  // ---- actions --------------------------------------------------------------------------------

  /** The "Enable sound & join" click. */
  async join(name?: string): Promise<void> {
    if (name !== undefined) this.setPrefs({ name: name.trim().slice(0, 24) });
    if (!this.prefs.name || this.disposed) return;
    const ok = await audio.unlock();
    if (!ok) this.log('audio did not start');
    if (this.joined || this.disposed) return;
    this.joined = true;
    this.restoreDuty();
    this.sync.setPresence({ name: this.prefs.name, onDuty: this.onDuty });
    if (this.timer) this.remember();
    this.updateWake();
    this.scheduleChimes();
    this.touch();
  }

  /** Answers the "still on raid duty?" question asked after the browser reloaded a discarded tab. */
  answerDutyRestore(stillOnDuty: boolean): void {
    this.dutyPrompt = false;
    this.setOnDuty(stillOnDuty);
  }

  async enableSound(): Promise<void> {
    await audio.unlock();
    this.scheduleChimes();
    this.touch();
  }

  setOnDuty(onDuty: boolean): void {
    this.onDuty = onDuty;
    this.dutyPrompt = false;
    if (!onDuty) this.coverAsk = null;
    this.saveDuty();
    if (this.joined) this.sync.setPresence({ name: this.prefs.name, onDuty });
    // Called from the click itself, so the wake lock request counts as user-initiated (iPhones need that).
    this.updateWake();
    this.scheduleChimes();
    this.touch();
  }

  setPrefs(patch: Partial<Prefs>): void {
    const nameChanged = patch.name !== undefined && patch.name !== this.prefs.name;
    this.prefs = { ...this.prefs, ...patch };
    savePrefs(this.prefs);
    audio.setVolume(this.prefs.volume, this.prefs.muted);
    if (patch.ringInSilent !== undefined) {
      audio.setPlaybackSession(this.prefs.ringInSilent);
      void audio.unlock(); // from the click: re-activates the session with the new type
    }
    if (nameChanged && this.joined && this.prefs.name) this.sync.setPresence({ name: this.prefs.name, onDuty: this.onDuty });
    this.updateWake();
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
    if (id === 'cover') this.coverAsk = null;
    if (id === 'update') this.updateDismissed = true;
    if (id === 'reminder') {
      const now = this.effNow();
      for (const r of this.reminders) if (phaseOf(r, now) === 'due') this.remindAcked.add(instanceKey(r)!);
      this.onTickTitle();
    }
    this.touch();
  }

  // ---- reminders ------------------------------------------------------------------------------

  /** "Used now": the cooldown starts over from this moment. */
  remindUsedNow(id: string): Promise<boolean> {
    const r = this.reminderById(id);
    return this.writeReminder(id, { ...this.basePatch(r), dueAt: this.clock.serverNow() + r.restartMs, used: true });
  }

  /** The time left as the game shows it. */
  remindReadyIn(id: string, ms: number): Promise<boolean> {
    return this.writeReminder(id, { ...this.basePatch(this.reminderById(id)), dueAt: this.clock.serverNow() + ms, clearUsed: true });
  }

  remindSnooze(id: string): Promise<boolean> {
    const r = this.reminderById(id);
    const now = this.clock.serverNow();
    return this.writeReminder(id, { ...this.basePatch(r), dueAt: Math.max(now, r.dueAt ?? now) + SNOOZE_MS });
  }

  remindClear(id: string): Promise<boolean> {
    return this.writeReminder(id, { ...this.basePatch(this.reminderById(id)), dueAt: null });
  }

  /** The duration a "Used now" restarts with. */
  remindSetCooldown(id: string, ms: number): Promise<boolean> {
    return this.writeReminder(id, { ...this.basePatch(this.reminderById(id)), restartMs: ms });
  }

  /** Sends a chat message; resolves false (with a toast) if it was not sent. */
  async sendChat(text: string): Promise<boolean> {
    const clean = normalizeChatText(text);
    if (!clean) return false;
    if (!this.canChat()) {
      // Only the banners can get here (the chat form is disabled): the duty change happened, the post didn't.
      this.showToast(this.joined ? 'Offline: message not sent.' : 'Join to chat first.');
      this.touch();
      return false;
    }
    const res = await this.sync.sendChat({ uid: this.uid, name: this.prefs.name, text: clean });
    if (!res.ok) {
      this.showToast(res.error ?? 'Message not sent. Try again.');
      this.log(`chat send failed: ${res.error ?? 'unknown'}`);
      this.touch();
    }
    return res.ok;
  }

  /** One-click hand-off: sets the on-duty flag to match and tells the team. */
  async handoff(kind: Handoff): Promise<void> {
    if (this.handoffBusy) return; // a double-click must not post the hand-off twice
    // Duty changes first, inside the click: the wake lock needs the click, and a lost chat message
    // must not leave the flag at odds with what the player chose. Asking for cover means "I keep
    // raiding until then", so it puts this device on duty unless one of mine already is.
    const mine = dutyView(this.presence, this.meEntry()).mine;
    if (kind === 'take' || (kind === 'cover' && !mine)) this.setOnDuty(true);
    if (kind === 'off') this.setOnDuty(false);
    this.coverAsk =
      kind === 'cover' ? { before: new Set(dutyView(this.presence, this.meEntry()).others.map(normName)) } : null;
    // A tab can only clear its own flag: another device of mine still on duty needs its own untick.
    if (kind === 'off' && dutyView(this.presence, this.meEntry()).mine) {
      this.showToast('Your other device is still on raid duty: untick “I’m on raid duty” there.');
    }
    this.handoffBusy = true;
    this.touch();
    try {
      await this.sendChat(HANDOFF_TEXT[kind]);
    } finally {
      this.handoffBusy = false;
      this.touch();
    }
  }

  create(intervalMs: number): Promise<void> {
    return this.write((cur, now) => (cur ? null : opCreate(intervalMs, now)), 'create');
  }

  act(op: TimerOp): Promise<void> {
    return this.write((cur, clickNow) => (cur ? applyOp(cur, op, opTime(cur, clickNow)) : null), op.kind);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ticker.stop();
    for (const c of this.cleanups) c();
    this.sync.dispose();
    setWakeWanted(this.clientId, false);
    audio.cancel('zero', this.clientId);
    audio.cancel('warn', this.clientId);
    this.listeners.clear();
    this.chatListeners.clear();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    document.title = 'Team Timer';
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
    if (action === 'create' && res.ok) this.remember();
    this.touch();
  }

  /** Adds the room to the landing page's Recent list, once it has both joined and loaded. */
  private remember(): void {
    if (this.remembered) return;
    this.remembered = true;
    rememberRoom(this.roomId);
  }

  private meEntry(): PresenceEntry {
    return { cid: this.clientId, name: this.prefs.name, onDuty: this.onDuty };
  }

  /**
   * On-duty is per tab and in memory. It comes back silently after a quick reload that is joined
   * quickly too; otherwise (a crash or discard noticed later, a slow Join) the player is asked.
   */
  private restoreDuty(): void {
    const saved = this.savedDuty;
    this.savedDuty = null;
    if (!saved?.onDuty || this.onDuty) return;
    const age = this.loadedAt - saved.at;
    if (age < DUTY_RESTORE_MS && Date.now() - this.loadedAt < DUTY_RESTORE_MS) {
      this.onDuty = true;
      this.log('back on duty after a reload');
    } else if (age < DUTY_PROMPT_MAX_MS) {
      this.dutyPrompt = true;
    }
  }

  /** Before Join (nothing restored yet) or while "still on duty?" is open, keep the saved state as is. */
  private saveDuty(): void {
    if (!this.joined || this.dutyPrompt) return;
    saveDutyState(this.roomId, this.onDuty);
    this.dutySavedAt = Date.now();
  }

  private updateWake(): void {
    setWakeWanted(this.clientId, !this.disposed && this.joined && this.onDuty && this.prefs.keepAwake);
  }

  private reminderById(id: string): Reminder {
    return withPresets(this.reminders).find((r) => r.id === id) ?? { ...ARTWORK, id, by: '', at: 0 };
  }

  private basePatch(r: Reminder): ReminderPatch {
    return { label: r.label, restartMs: r.restartMs, by: this.prefs.name, t: this.clock.serverNow() };
  }

  /**
   * Reminder writes have their own busy flag (they must never block "Raided now"), and wait for the
   * first snapshot and a readable list (else they'd write over data this tab can't see).
   */
  private canRemind(): boolean {
    return (
      !this.disposed &&
      this.joined &&
      !this.remindBusy &&
      this.remindersLoaded &&
      this.remindersError === null &&
      this.prefs.name.length > 0 &&
      (this.sync.mode === 'local' || (this.connected && this.clock.quality !== 'none'))
    );
  }

  private async writeReminder(id: string, patch: ReminderPatch): Promise<boolean> {
    if (!this.canRemind()) {
      // The banner's buttons can get here (the card's are disabled): say why nothing was saved.
      if (!this.disposed && this.joined && !this.remindBusy) {
        this.showToast(
          this.remindersError !== null
            ? 'Not saved: reminders are unavailable here. Reload the page.'
            : this.sync.mode === 'firebase' && !this.connected
              ? 'Offline: not saved. Try again when the connection is back.'
              : 'Not saved: the timer is still loading. Try again in a moment.',
        );
        this.touch();
      }
      return false;
    }
    this.remindBusy = true;
    this.touch();
    const res = await this.sync.writeReminder(id, patch);
    this.remindBusy = false;
    if (!res.ok) {
      this.showToast(res.error ?? 'Not saved. Try again.');
      this.log(`reminder write failed: ${res.error ?? 'unknown'}`);
    }
    this.touch();
    return res.ok;
  }

  /**
   * Rings reminders that just came due, in every joined tab, whatever "chime only while I'm on duty"
   * says: a reminder is for the whole team. Each due moment rings once per tab (ReminderTracker).
   */
  private evaluateReminders(): void {
    // Before the first clock sync "now" can be off by the PC clock's error: don't judge yet.
    if (this.sync.mode === 'firebase' && this.clock.quality === 'none') return;
    for (const r of this.remindTracker.update(this.reminders, this.effNow())) {
      const played = this.joined && !this.prefs.muted && audio.playNow('remind');
      this.log(`reminder "${r.label}" is due (${played ? 'tone played' : 'silent'})`);
      // The pop-out shows it, unless its one line is taken by the 🔕 warning (which outranks it).
      const seen = pipWindow() !== null && this.silencedBy().length === 0;
      if (document.hidden && !seen) notify(`⏰ ${r.label} is ready`, 'Open the timer to restart it.', 'reminder', instanceKey(r)!);
    }
  }

  /** A reminder that will ring in this tab is counting down. */
  private reminderWillRing(): boolean {
    if (!this.joined || this.prefs.muted) return false;
    const now = this.effNow();
    return this.reminders.some((r) => phaseOf(r, now) === 'running');
  }

  /** This tab still has to make sound: raid chimes, or a reminder that will ring here. */
  private soundNeeded(): boolean {
    return this.soundWanted() || this.reminderWillRing();
  }

  /** A due reminder this tab has not dismissed (none while the list can't be read: it may be stale). */
  private remindDue(): Reminder | null {
    if (this.remindersError !== null) return null;
    const now = this.effNow();
    return this.reminders.find((r) => phaseOf(r, now) === 'due' && !this.remindAcked.has(instanceKey(r)!)) ?? null;
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

  private canChat(): boolean {
    return !this.disposed && this.joined && this.prefs.name.length > 0 && (this.sync.mode === 'local' || this.connected);
  }

  private onChat(msgs: ChatMessage[]): void {
    this.chatMsgs = msgs;
    // History that was already there when the room opened is not "unread".
    if (this.chatSeenAt === null || !document.hidden) this.chatSeenAt = Math.max(this.chatSeenAt ?? -Infinity, latestAt(msgs));
    this.chatUnread = countUnread(msgs, this.chatSeenAt, this.uid);
    this.chatView = { loaded: true, items: layoutMessages(msgs, this.uid, this.clock.serverNow()), error: null };
    for (const cb of this.chatListeners) cb();
    this.onTickTitle();
    this.touch();
  }

  private markChatSeen(): void {
    this.chatSeenAt = Math.max(this.chatSeenAt ?? -Infinity, latestAt(this.chatMsgs));
    this.chatUnread = 0;
    this.onTickTitle();
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
        // ...unless our own pending raid of the previous state falls before it: that one must still chime.
        const prevNext = prev?.running ? timerView(prev, from).nextZeroMs : null;
        if (prevNext === null || prevNext > t.anchorMs) from = t.anchorMs;
      }
    }
    // Zeros are judged against one state only: a change is not a raid moment.
    this.lastEvalNow = from;
    if (t && this.joined) this.remember();
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
    versionCheck.maybeCheck();
    if (this.onDuty && Date.now() - this.dutySavedAt >= DUTY_REFRESH_MS) this.saveDuty();
    this.evaluateZeros(audioRan, gap > GAP_MS ? `the tab was paused for ${formatSpan(gap)}` : null);
    this.evaluateReminders();
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
      audio.playNow(this.prefs.preset, lastZero);
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

  /**
   * With "chime only while I'm on duty", a tab chimes while any of MY devices is on duty, or while
   * nobody else is. Duty belongs to a person: my phone must not go silent because my PC is on duty.
   */
  private soundWanted(): boolean {
    if (!this.joined || this.prefs.muted) return false;
    if (!this.prefs.dutyOnly) return true;
    const duty = dutyView(this.presence, this.meEntry());
    return duty.mine || duty.others.length === 0;
  }

  /** Other people on duty, when duty-only is what keeps this tab silent. */
  private silencedBy(): string[] {
    if (!this.joined || this.prefs.muted || !this.prefs.dutyOnly) return [];
    const duty = dutyView(this.presence, this.meEntry());
    return duty.mine ? [] : duty.others;
  }

  /** People who went on duty after this tab asked for cover, while I (on any device) still am. */
  private coverTakenBy(): string[] {
    const ask = this.coverAsk;
    if (!ask) return [];
    const duty = dutyView(this.presence, this.meEntry());
    return duty.mine ? duty.others.filter((n) => !ask.before.has(normName(n))) : [];
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
      if (this.remindDue()) title = `⏰ ${title}`;
      if (this.chatUnread > 0) title = `(${this.chatUnread}) ${title}`;
      const soundProblem =
        (t.running && !this.joined) || (!audio.running && ((t.running && this.soundWanted()) || this.reminderWillRing()));
      if (soundProblem) title = `🔇 ${title}`;
      else if (t.running && this.silencedBy().length > 0) title = `🔕 ${title}`;
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
    if (this.joined && this.soundNeeded() && sound !== 'running') {
      list.push({
        id: 'sound',
        tone: 'red',
        text:
          sound === 'unsupported'
            ? 'This browser cannot play sound.'
            : this.soundWanted()
              ? 'Sound is OFF: the raid chime cannot play.'
              : 'Sound is OFF: reminders cannot ring.',
        actions: sound === 'unsupported' ? undefined : [{ id: 'sound', label: 'Turn sound on' }],
        dismissable: false,
      });
    }
    if (this.dutyPrompt) {
      list.push({
        id: 'duty-restore',
        tone: 'amber',
        text: 'You were on raid duty before this tab reloaded. Still on duty?',
        actions: [
          { id: 'duty-yes', label: 'Yes, on duty' },
          { id: 'duty-no', label: 'No' },
        ],
        dismissable: false,
      });
    }
    const due = this.remindDue();
    if (due) {
      // Static text: the banner is a live region, so it must not change every minute.
      const used = due.usedBy && due.usedAt !== undefined ? ` (used by ${due.usedBy} at ${formatServerTime(due.usedAt, false)} ST)` : '';
      list.push({
        id: 'reminder',
        tone: 'amber',
        text: `⏰ ${due.label} is ready${used}.`,
        actions: [
          { id: 'remind-used', label: 'Used now ↻', arg: due.id },
          { id: 'remind-snooze', label: '+10 min', arg: due.id },
        ],
        dismissable: true,
      });
    }
    const taken = this.coverTakenBy();
    if (taken.length > 0) {
      list.push({
        id: 'cover',
        tone: 'amber',
        text: `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} on raid duty now.`,
        actions: [{ id: 'off-duty', label: '💤 I’m off now' }],
        dismissable: true,
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
    if (versionCheck.updateReady && !this.updateDismissed) {
      list.push({
        id: 'update',
        tone: 'info',
        text: 'Team Timer was updated. Reload this tab between raids (the pop-out closes, and you may need to click Join again).',
        actions: [{ id: 'reload', label: 'Reload' }],
        dismissable: true,
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
    const due = this.remindDue();
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
      nextRaidMs: v?.nextZeroMs ?? null,
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
      silencedBy: this.silencedBy(),
      people: groupPeople(this.presence, this.joined ? this.meEntry() : null),
      presenceError: this.presenceError,
      me: this.meEntry(),
      joined: this.joined,
      canControl: this.canControl(),
      busy: this.busy,
      toast: this.toast,
      banners: this.banners(),
      missedTotal: this.missedTotal,
      missedShown: this.events.has('missed') ? this.missedTotal : 0,
      updateReady: versionCheck.updateReady && !this.updateDismissed,
      wakeSupported: wakeLockSupported,
      wakeHeld: wakeLockHeld(),
      prefs: this.prefs,
      pipOpen: pipWindow() !== null,
      lockHeld: isLockHeld(),
      usesWorker: this.ticker?.usesWorker ?? false,
      debugVersion: this.debugVersion,
      chatUnread: this.chatUnread,
      canChat: this.canChat(),
      handoffBusy: this.handoffBusy,
      reminders: this.remindersLoaded
        ? withPresets(this.reminders).map((r) => ({
            ...r,
            phase: phaseOf(r, now),
            // Whole seconds (as displayed), so the snapshot changes once a second, not every tick.
            remainingMs: r.dueAt === undefined ? 0 : Math.max(0, Math.ceil((r.dueAt - now) / 1000) * 1000),
            usedAgo: r.usedAt === undefined ? null : formatAgo(now - r.usedAt),
          }))
        : [],
      remindersLoaded: this.remindersLoaded,
      remindDue: due ? { id: due.id, label: due.label } : null,
      canRemind: this.canRemind(),
      remindersError: this.remindersError,
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
