// Presence is one entry per open tab, but duty belongs to a person: a player with the timer open on a
// phone and a PC is one person. Names are free text per browser, so a person is "the same name".

import type { PresenceEntry } from '../sync/SyncAdapter.ts';

/** Compares names trimmed, with inner spaces collapsed, ignoring case. */
export function normName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface Person {
  /** normName of the name; unique in a list. */
  key: string;
  name: string;
  /** Open tabs/devices. */
  devices: number;
  onDuty: boolean;
  /** One of the devices is this tab. */
  me: boolean;
}

/**
 * Who is on duty, as seen from this tab. This tab's own entry in the presence list is ignored (it can
 * be stale, e.g. written before going offline); `self` is the tab's real state.
 */
export interface DutyView {
  /** This tab, or another tab under my name, is on duty. */
  mine: boolean;
  /** Names of other people on duty. */
  others: string[];
}

export function dutyView(presence: PresenceEntry[], self: PresenceEntry): DutyView {
  const myKey = normName(self.name);
  let mine = self.onDuty;
  const others = new Map<string, string>();
  for (const p of presence) {
    if (p.cid === self.cid || !p.onDuty) continue;
    const key = normName(p.name);
    if (key === myKey) mine = true;
    else if (!others.has(key)) others.set(key, p.name.trim());
  }
  return { mine, others: [...others.values()] };
}

/**
 * One row per person: on duty first, then by name. `self` is this tab when it has joined (null
 * before), merged in with its real state instead of its presence entry.
 */
export function groupPeople(presence: PresenceEntry[], self: PresenceEntry | null): Person[] {
  const people = new Map<string, Person>();
  const add = (p: PresenceEntry, me: boolean) => {
    const key = normName(p.name);
    if (!key) return;
    const cur = people.get(key);
    if (cur) {
      cur.devices++;
      cur.onDuty ||= p.onDuty;
      cur.me ||= me;
      if (me) cur.name = p.name.trim();
    } else {
      people.set(key, { key, name: p.name.trim(), devices: 1, onDuty: p.onDuty, me });
    }
  };
  for (const p of presence) if (!self || p.cid !== self.cid) add(p, false);
  if (self) add(self, true);
  return [...people.values()].sort((a, b) => Number(b.onDuty) - Number(a.onDuty) || a.name.localeCompare(b.name));
}
