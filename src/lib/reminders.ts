// Shared reminders in a room: one-off countdowns next to the raid loop, starting with the hero's
// artwork cooldown (12 h on this x3 world). All times are server times (ms since the epoch).

export interface Reminder {
  /** Fixed key per kind ('artwork'), so two first clicks can't create two rows. */
  id: string;
  label: string;
  /** When it is ready; absent while it is not running. */
  dueAt?: number;
  /** "Used now" restarts it with this duration. */
  restartMs: number;
  /** The last "Used now", and who pressed it. */
  usedAt?: number;
  usedBy?: string;
  /** The last change, and who made it. */
  by: string;
  at: number;
}

export const ARTWORK = { id: 'artwork', label: 'Artwork', restartMs: 12 * 3_600_000 } as const;

export const MIN_REMINDER_MS = 60_000;
/** The rules accept a due time less than 7 days ahead. */
export const MAX_READY_IN_MS = 7 * 24 * 3_600_000 - 3_600_000;
/** The rules accept a restart duration up to 48 h. */
export const MAX_RESTART_MS = 48 * 3_600_000;
export const SNOOZE_MS = 10 * 60_000;
/** Noticed later than this after its due time (the device slept), a reminder no longer rings. */
export const LATE_RING_MS = 10 * 60_000;

/** A stored reminder, or null if the data is malformed. */
export function parseReminder(id: string, v: unknown): Reminder | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.label !== 'string' || typeof o.by !== 'string' || typeof o.at !== 'number') return null;
  const r: Reminder = {
    id,
    label: o.label,
    restartMs: typeof o.restartMs === 'number' ? o.restartMs : ARTWORK.restartMs,
    by: o.by,
    at: o.at,
  };
  if (typeof o.dueAt === 'number') r.dueAt = o.dueAt;
  if (typeof o.usedAt === 'number') r.usedAt = o.usedAt;
  if (typeof o.usedBy === 'string') r.usedBy = o.usedBy;
  return r;
}

/** The artwork row is always there; stored data, once someone used it, wins. */
export function withPresets(list: Reminder[]): Reminder[] {
  return list.some((r) => r.id === ARTWORK.id) ? list : [{ ...ARTWORK, by: '', at: 0 }, ...list];
}

export type ReminderPhase = 'idle' | 'running' | 'due';

export function phaseOf(r: Reminder, now: number): ReminderPhase {
  return r.dueAt === undefined ? 'idle' : now < r.dueAt ? 'running' : 'due';
}

/** One due moment of one reminder: changing the due time makes a new instance. */
export function instanceKey(r: Reminder): string | null {
  return r.dueAt === undefined ? null : `${r.id}@${r.dueAt}`;
}

/**
 * Time left as the game shows it: "7:41" is 7 h 41 min, "7:41:10" adds seconds, a bare number is
 * minutes ("45"). Null if invalid or outside 1 min … maxMs.
 */
export function parseHours(text: string, maxMs: number): number | null {
  const s = text.normalize('NFKC').trim();
  let ms: number;
  const hms = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (hms) {
    const [h, m, sec] = [Number(hms[1]), Number(hms[2]), Number(hms[3] ?? 0)];
    if (m >= 60 || sec >= 60) return null;
    ms = ((h * 60 + m) * 60 + sec) * 1000;
  } else if (/^\d{1,4}$/.test(s)) {
    ms = Number(s) * 60_000;
  } else {
    return null;
  }
  return ms >= MIN_REMINDER_MS && ms <= maxMs ? ms : null;
}

/** Reminder time as the game shows it, always with hours ("0:41:10", "12:00:00"), so parseHours reads it back. */
export function formatHours(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** For pasting into Discord: <t:…:R> shows "in 3 hours" / "5 minutes ago" in each reader's time zone. */
export function discordText(r: Reminder): string {
  if (r.dueAt === undefined) return `${r.label}: not running`;
  return `⏰ ${r.label} ready <t:${Math.floor(r.dueAt / 1000)}:R>`;
}

/**
 * Rings each due instance at most once per tab, and only if this tab saw it coming: an instance
 * first seen at or after its due time (a tab opened later) stays silent, and so does one noticed
 * more than LATE_RING_MS late (the device slept). A fired instance never re-arms, so a backward
 * clock correction can't ring it twice.
 */
export class ReminderTracker {
  private state = new Map<string, { s: 'armed' | 'silent' | 'fired'; dueAt: number }>();

  /** Returns the reminders that should ring now. */
  update(list: Reminder[], now: number): Reminder[] {
    const ring: Reminder[] = [];
    for (const r of list) {
      const key = instanceKey(r);
      if (key === null || r.dueAt === undefined) continue;
      const cur = this.state.get(key);
      if (cur === undefined) {
        this.state.set(key, { s: now < r.dueAt ? 'armed' : 'silent', dueAt: r.dueAt });
      } else if (cur.s === 'armed' && now >= r.dueAt) {
        cur.s = 'fired';
        if (now - r.dueAt <= LATE_RING_MS) ring.push(r);
      }
    }
    // Instances that are gone are kept for a day: the list can blink empty on a reconnect, and an
    // armed instance must still ring when it comes back.
    for (const [key, v] of this.state) if (now - v.dueAt > 24 * 3_600_000) this.state.delete(key);
    return ring;
  }
}
