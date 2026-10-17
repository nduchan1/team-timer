// The team's saved farm-list state (in the room, per world) and how a new paste is merged into it.
// Pure functions, no I/O. Saved: own villages (name, coordinates), each list's name, target count,
// the count when it was last read in full, and the oases in it; plus the shared "Added" ticks.
// No player names.
//
//   rooms/{room}/farm/{world}/villages      {list: JSON [{name,x,y}], by, at}
//   rooms/{room}/farm/{world}/lists/{lk}    {v, vx, vy, n, total, known?, oases?, by, at}
//   rooms/{room}/farm/{world}/marks/{x_y}   {vx, vy, by, at}

import type { FarmView, ListView } from './analyze.ts';
import type { ParsedPaste, PastedVillage } from './parsePaste.ts';

export interface StoredList {
  lk: string;
  /** Village name. */
  v: string;
  vx: number;
  vy: number;
  /** List name. */
  n: string;
  total: number;
  /** Targets when last read in full; undefined = never seen expanded. */
  known?: number;
  /** "x|y,x|y" */
  oases: string;
  by: string;
  at: number;
}

export interface StoredMark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  by: string;
  at: number;
}

export interface FarmState {
  villages: PastedVillage[];
  villagesBy: string | null;
  villagesAt: number | null;
  lists: StoredList[];
  marks: StoredMark[];
}

export const EMPTY_FARM: FarmState = { villages: [], villagesBy: null, villagesAt: null, lists: [], marks: [] };

/** 32-bit FNV-1a, base 36: a short, stable key part for a list name (names can hold any character). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const listKey = (vx: number, vy: number, name: string) => `${vx}_${vy}_${fnv1a(name)}`;
export const markKey = (x: number, y: number) => `${x}_${y}`;

export function oasesText(oases: { x: number; y: number }[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const o of [...oases].sort((a, b) => a.x - b.x || a.y - b.y)) {
    const k = `${o.x}|${o.y}`;
    if (!seen.has(k)) {
      seen.add(k);
      parts.push(k);
    }
  }
  return parts.join(',');
}

export function parseOases(text: string): { x: number; y: number }[] {
  if (!text) return [];
  const out: { x: number; y: number }[] = [];
  for (const part of text.split(',')) {
    const m = /^(-?\d{1,3})\|(-?\d{1,3})$/.exec(part);
    if (m) out.push({ x: Number(m[1]), y: Number(m[2]) });
  }
  return out;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length >= 1 && v.length <= max ? v : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** Reads the saved state as Firebase returns it, skipping anything malformed. */
export function parseFarm(raw: unknown): FarmState {
  if (!raw || typeof raw !== 'object') return EMPTY_FARM;
  const o = raw as Record<string, unknown>;
  let villages: PastedVillage[] = [];
  let villagesBy: string | null = null;
  let villagesAt: number | null = null;
  const vr = o.villages as Record<string, unknown> | undefined;
  if (vr && typeof vr.list === 'string') {
    try {
      const list = JSON.parse(vr.list) as unknown;
      if (Array.isArray(list)) {
        villages = list.filter((v): v is PastedVillage => !!v && typeof v.name === 'string' && int(v.x) !== null && int(v.y) !== null);
      }
    } catch {
      // ignore a damaged village list
    }
    villagesBy = str(vr.by, 24);
    villagesAt = int(vr.at);
  }
  const lists: StoredList[] = [];
  for (const [lk, value] of Object.entries((o.lists as Record<string, unknown>) ?? {})) {
    const l = value as Record<string, unknown> | null;
    if (!l) continue;
    const [v, vx, vy, n, total, by, at] = [str(l.v, 60), int(l.vx), int(l.vy), str(l.n, 100), int(l.total), str(l.by, 24), int(l.at)];
    if (v === null || vx === null || vy === null || n === null || total === null || by === null || at === null) continue;
    const known = int(l.known);
    lists.push({ lk, v, vx, vy, n, total, ...(known === null ? {} : { known }), oases: typeof l.oases === 'string' ? l.oases : '', by, at });
  }
  const marks: StoredMark[] = [];
  for (const [k, value] of Object.entries((o.marks as Record<string, unknown>) ?? {})) {
    const m = value as Record<string, unknown> | null;
    const xy = /^(-?\d{1,3})_(-?\d{1,3})$/.exec(k);
    if (!m || !xy) continue;
    const [vx, vy, by, at] = [int(m.vx), int(m.vy), str(m.by, 24), int(m.at)];
    if (vx === null || vy === null || by === null || at === null) continue;
    marks.push({ x: Number(xy[1]), y: Number(xy[2]), vx, vy, by, at });
  }
  return { villages, villagesBy, villagesAt, lists, marks };
}

/** The saved state as the analysis reads it. */
export function viewFromFarm(state: FarmState, deactivated: { x: number; y: number }[] = []): FarmView {
  let villages = state.villages;
  if (villages.length === 0) {
    // No village list saved yet: take the villages from the lists.
    const seen = new Map<string, PastedVillage>();
    for (const l of state.lists) seen.set(`${l.vx}|${l.vy}`, { name: l.v, x: l.vx, y: l.vy });
    villages = [...seen.values()];
  }
  const lists: ListView[] = state.lists.map((l) => ({
    village: l.v,
    vx: l.vx,
    vy: l.vy,
    name: l.n,
    total: l.total,
    known: l.known,
    oases: parseOases(l.oases),
  }));
  return { villages, lists, marks: state.marks, deactivated };
}

/** When the saved state was last changed by a paste, and by whom. */
export function lastSaved(state: FarmState): { at: number; by: string } | null {
  let best: { at: number; by: string } | null = state.villagesAt !== null && state.villagesBy ? { at: state.villagesAt, by: state.villagesBy } : null;
  for (const l of state.lists) if (!best || l.at > best.at) best = { at: l.at, by: l.by };
  return best;
}

export interface MergeReport {
  /** Lists read in full that changed (or are new). */
  replaced: number;
  /** Lists read in part, merged with what was saved. */
  merged: number;
  /** Collapsed lists whose saved oases were kept as they were. */
  kept: number;
  /** Collapsed lists whose count changed (their saved oases were kept). */
  recounted: number;
  /** Collapsed lists never seen expanded before. */
  unknown: number;
  /** Lists removed: gone from the game, or their village was lost. */
  deleted: number;
  /** Ticks cleared because the oasis now shows up in a list. */
  confirmedTicks: number;
  /** Lists that couldn't be matched to a village, so they weren't saved. */
  unmatched: string[];
}

export type ListRecord = Omit<StoredList, 'lk' | 'at'>;

export type MergeResult =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Paths under farm/{world} → new value (without "at"; the store adds the server time) or null to delete. */
      writes: Record<string, ListRecord | { list: string; by: string } | null>;
      report: MergeReport;
      next: FarmState;
    };

const sameRecord = (a: ListRecord, b: StoredList) =>
  a.v === b.v && a.vx === b.vx && a.vy === b.vy && a.n === b.n && a.total === b.total && a.known === b.known && a.oases === b.oases;

/** Merges a paste into the saved state. Lists not fully copied keep what was saved before. */
export function mergePaste(state: FarmState, p: ParsedPaste, by: string, now: number): MergeResult {
  if (p.villages.length === 0 || p.lists.length === 0) {
    return { ok: false, error: 'Copy the whole Farm List page (Ctrl+A, then Ctrl+C): both the farm lists and the village list are needed.' };
  }
  const count = new Map<string, number>();
  for (const v of p.villages) count.set(v.name, (count.get(v.name) ?? 0) + 1);
  const twins = [...count.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  if (twins.length > 0) {
    return {
      ok: false,
      error: `Two of your villages are called “${twins[0]}”, so their farm lists can’t be told apart. Rename one in the game, then paste again. Nothing was saved.`,
    };
  }
  if (state.villages.length > 0 && !p.villages.some((v) => state.villages.some((s) => s.x === v.x && s.y === v.y))) {
    return { ok: false, error: 'None of these villages are in the saved farm lists. Is this the right account and server? Nothing was saved.' };
  }

  const villageOf = new Map(p.villages.map((v) => [v.name, v]));
  const stored = new Map(state.lists.map((l) => [l.lk, l]));
  const report: MergeReport = { replaced: 0, merged: 0, kept: 0, recounted: 0, unknown: 0, deleted: 0, confirmedTicks: 0, unmatched: [] };

  // Group the pasted lists by village and name (two lists with the same name are combined).
  const groups = new Map<string, { v: PastedVillage; n: string; total: number; rows: number; oases: { x: number; y: number }[] }>();
  for (const l of p.lists) {
    const v = l.village !== null ? villageOf.get(l.village) : undefined;
    if (!v) {
      report.unmatched.push(l.name);
      continue;
    }
    const lk = listKey(v.x, v.y, l.name);
    const g = groups.get(lk) ?? { v, n: l.name, total: 0, rows: 0, oases: [] };
    g.total += l.total;
    g.rows += l.targets.length;
    for (const t of l.targets) if (t.oasis && t.x !== null && t.y !== null) g.oases.push({ x: t.x, y: t.y });
    groups.set(lk, g);
  }

  const writes: Extract<MergeResult, { ok: true }>['writes'] = {};
  const nextLists = new Map(state.lists.map((l) => [l.lk, l]));
  for (const [lk, g] of groups) {
    const old = stored.get(lk);
    const base = { v: g.v.name, vx: g.v.x, vy: g.v.y, n: g.n, total: g.total, by };
    let rec: ListRecord;
    if (g.rows >= g.total) {
      rec = { ...base, known: Math.max(g.rows, g.total), oases: oasesText(g.oases) };
      if (!old || !sameRecord(rec, old)) report.replaced++;
    } else if (g.rows === 0) {
      if (old) {
        rec = { ...base, ...(old.known === undefined ? {} : { known: old.known }), oases: old.oases };
        if (old.total !== g.total) report.recounted++;
        else report.kept++;
      } else {
        rec = { ...base, oases: '' };
        report.unknown++;
      }
    } else {
      rec = { ...base, ...(old?.known === undefined ? {} : { known: old.known }), oases: oasesText([...parseOases(old?.oases ?? ''), ...g.oases]) };
      report.merged++;
    }
    if (!old || !sameRecord(rec, old)) {
      const { oases, known, ...rest } = rec;
      writes[`lists/${lk}`] = { ...rest, ...(known === undefined ? {} : { known }), ...(oases ? { oases } : {}) } as ListRecord;
      nextLists.set(lk, { ...rec, lk, at: now });
    }
  }

  // Removed lists: only for villages that have lists in this paste. Lists of lost villages go too.
  const pastedVillages = new Set([...groups.values()].map((g) => `${g.v.x}|${g.v.y}`));
  const ownVillages = new Set(p.villages.map((v) => `${v.x}|${v.y}`));
  for (const l of state.lists) {
    const vk = `${l.vx}|${l.vy}`;
    if ((pastedVillages.has(vk) && !groups.has(l.lk)) || !ownVillages.has(vk)) {
      writes[`lists/${l.lk}`] = null;
      nextLists.delete(l.lk);
      report.deleted++;
    }
  }

  const villageText = JSON.stringify(p.villages.map((v) => ({ name: v.name, x: v.x, y: v.y })));
  if (villageText !== JSON.stringify(state.villages.map((v) => ({ name: v.name, x: v.x, y: v.y })))) writes.villages = { list: villageText, by };

  // Ticks for oases that now show up in a list are done.
  const listed = new Set<string>();
  for (const l of nextLists.values()) for (const o of parseOases(l.oases)) listed.add(`${o.x}|${o.y}`);
  const marks = state.marks.filter((m) => {
    if (!listed.has(`${m.x}|${m.y}`)) return true;
    writes[`marks/${markKey(m.x, m.y)}`] = null;
    report.confirmedTicks++;
    return false;
  });

  const next: FarmState = {
    villages: p.villages.map((v) => ({ name: v.name, x: v.x, y: v.y })),
    villagesBy: writes.villages ? by : state.villagesBy,
    villagesAt: writes.villages ? now : state.villagesAt,
    lists: [...nextLists.values()],
    marks,
  };
  return { ok: true, writes, report, next };
}
