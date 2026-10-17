// Which oases near the team's villages are not in any farm list yet. Pure functions, no I/O.

import { cleanGameText, LIST_MAX, type ParsedPaste, type PastedVillage } from './parsePaste.ts';
import type { Bounds, OasisWorld } from './scanFormat.ts';

/** Travian's oasis-farming guide: how hard the animals usually are, by oasis type. */
export type OasisGroup = 'easy' | 'medium' | 'hard';

export const GROUP_LABEL: Record<OasisGroup, string> = {
  easy: 'Easy (iron, clay)',
  medium: 'Medium (wood)',
  hard: 'Hard (crop)',
};

export function groupOf(bonus: string): OasisGroup {
  if (/iron|clay/i.test(bonus)) return 'easy';
  if (/lumber|wood/i.test(bonus)) return 'medium';
  return 'hard';
}

/**
 * Distance on a map that wraps around at the edges, as the game measures it. The bounds are the scanned
 * area; the world is at least the standard -200..200 map (a scan of part of the map doesn't shrink it).
 */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }, bounds: Bounds): number {
  const r = Math.max(200, -bounds.minX, bounds.maxX, -bounds.minY, bounds.maxY);
  const size = 2 * r + 1;
  let dx = Math.abs(a.x - b.x) % size;
  let dy = Math.abs(a.y - b.y) % size;
  dx = Math.min(dx, size - dx);
  dy = Math.min(dy, size - dy);
  return Math.hypot(dx, dy);
}

const key = (x: number, y: number) => `${x}|${y}`;
const vkey = (v: { x: number; y: number }) => key(v.x, v.y);

// ---- input: what is known about the team's farm lists ----------------------------------------------

export interface ListView {
  /** Key of the saved list (team state only). */
  id?: string;
  /** Village name, or null when the list couldn't be matched to a village. */
  village: string | null;
  /** The village's coordinates (null when unmatched). */
  vx: number | null;
  vy: number | null;
  name: string;
  /** Targets in the list (oases and villages), as the game counts them. */
  total: number;
  /** Targets the list had when it was last read in full; undefined = never seen expanded. */
  known?: number;
  /** Oases known to be in the list. */
  oases: { x: number; y: number }[];
}

/** A shared "Added" tick: an oasis someone added for a village. */
export interface MarkView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  by: string;
  at: number;
}

export interface FarmView {
  villages: PastedVillage[];
  lists: ListView[];
  marks: MarkView[];
  /** Targets the game deactivated after an owner change (only from a fresh paste). */
  deactivated: { x: number; y: number }[];
}

/** A view of one paste on its own (no saved state): lists not fully copied count as never expanded. */
export function viewFromPaste(p: ParsedPaste): FarmView {
  // A name shared by two own villages can't say which one a list belongs to.
  const count = new Map<string, number>();
  for (const v of p.villages) count.set(v.name, (count.get(v.name) ?? 0) + 1);
  const byName = new Map(p.villages.filter((v) => count.get(v.name) === 1).map((v) => [v.name, v]));
  return {
    villages: p.villages,
    marks: [],
    deactivated: p.deactivated,
    lists: p.lists.map((l) => {
      const v = l.village !== null ? byName.get(l.village) : undefined;
      const oases = l.targets.filter((t) => t.oasis && t.x !== null && t.y !== null).map((t) => ({ x: t.x!, y: t.y! }));
      return {
        village: v ? l.village : null,
        vx: v ? v.x : null,
        vy: v ? v.y : null,
        name: l.name,
        total: l.total,
        known: l.targets.length >= l.total ? l.total : undefined,
        oases,
      };
    }),
  };
}

// ---- output ---------------------------------------------------------------------------------------

export interface MissingOasis {
  x: number;
  y: number;
  dist: number;
  bonus: string;
  group: OasisGroup;
  /** Animals at scan time, "31:3,35:1" (may have changed since). */
  animals: string;
}

export interface TickedOasis extends MissingOasis {
  by: string;
  at: number;
}

export interface VillageResult {
  village: PastedVillage;
  lists: ListView[];
  /** Oases already in this village's lists. */
  listedOases: number;
  missing: MissingOasis[];
  /** Oases ticked as added for this village (not yet seen in a list). */
  ticked: TickedOasis[];
  /** Free oases near this village held back because one of its lists was never seen expanded. */
  heldBack: number;
}

export interface ListRef {
  village: string | null;
  list: string;
}

export interface Warnings {
  fullLists: ListRef[];
  deactivated: { x: number; y: number }[];
  /** The same oasis in the lists of more than one village. */
  inSeveralVillages: { x: number; y: number; villages: string[] }[];
  /** Lists never seen expanded: their oases are unknown, so free oases near their village are held back. */
  neverExpanded: (ListRef & { total: number })[];
  /** Lists that grew since they were last expanded, by more than their village's ticks explain. */
  grownLists: (ListRef & { total: number; known: number })[];
  /** Lists that couldn't be matched to one of the villages (an unknown or repeated village name). */
  unmatchedLists: string[];
}

export interface Analysis {
  villages: VillageResult[];
  warnings: Warnings;
  /** Unoccupied oases within range that are in no list, before the type filter. */
  totalMissing: number;
}

export interface AnalyzeOptions {
  radius: number;
  groups: Set<OasisGroup>;
  /** Show every village, not just those that already have an oasis in a list. */
  allVillages: boolean;
  /** Villages typed in by hand (no paste needed). */
  extraVillages?: PastedVillage[];
}

export function analyze(world: OasisWorld, view: FarmView | null, opts: AnalyzeOptions): Analysis {
  const lists = view?.lists ?? [];
  const known = view?.villages ?? [];
  // A tick counts only for one of your villages (a lost village's ticks would hide oases for good).
  const ownKeys = new Set(known.map(vkey));
  const marks = (view?.marks ?? []).filter((m) => ownKeys.has(key(m.vx, m.vy)));
  const nameAt = new Map(known.map((v) => [vkey(v), v.name]));

  // Where each listed oasis sits: oasis key -> village names.
  const listedBy = new Map<string, Set<string>>();
  const addListed = (x: number, y: number, village: string) => {
    const k = key(x, y);
    if (!listedBy.has(k)) listedBy.set(k, new Set());
    listedBy.get(k)!.add(village);
  };
  for (const l of lists) for (const o of l.oases) addListed(o.x, o.y, l.village ?? '?');
  const inLists = new Set(listedBy.keys());
  const deactivated = new Set((view?.deactivated ?? []).map((d) => key(d.x, d.y)));
  const ticked = new Set(marks.map((m) => key(m.x, m.y)));

  const withOasis = new Set<string>();
  for (const l of lists) if (l.vx !== null && l.vy !== null && l.oases.length > 0) withOasis.add(key(l.vx, l.vy));
  for (const m of marks) withOasis.add(key(m.vx, m.vy));
  const extras = opts.extraVillages ?? [];
  const typed = (v: PastedVillage) => extras.some((e) => e.x === v.x && e.y === v.y);
  const shown = [
    ...known.filter((v) => opts.allVillages || withOasis.has(vkey(v)) || typed(v)),
    ...extras.filter((e) => !known.some((v) => v.x === e.x && v.y === e.y)),
  ];

  // A list never seen expanded may hold any oasis near its village: those stay back.
  const neverExpanded = lists.filter((l) => l.known === undefined && l.total > 0);
  // ...and one that isn't matched to a village may belong to any of them: then everything waits.
  const holdAll = neverExpanded.some((l) => l.vx === null || l.vy === null);
  const holdAreas = neverExpanded
    .filter((l) => l.vx !== null && l.vy !== null)
    .map((l) => {
      const c = { x: l.vx!, y: l.vy! };
      const reach = Math.max(opts.radius, ...l.oases.map((o) => distance(c, o, world.bounds)));
      return { c, reach };
    });

  // Each free oasis in range goes to the nearest shown village (ties: the first one).
  const missingBy = new Map<string, MissingOasis[]>(shown.map((v) => [vkey(v), []]));
  const heldBy = new Map<string, number>();
  const info = new Map<string, { bonus: string; group: OasisGroup; animals: string }>();
  let totalMissing = 0;
  if (shown.length > 0) {
    for (const [x, y, b, occupied, animals] of world.oases) {
      const k = key(x, y);
      if (ticked.has(k)) info.set(k, { bonus: world.bonuses[b], group: groupOf(world.bonuses[b]), animals });
      if (occupied || inLists.has(k) || ticked.has(k) || deactivated.has(k)) continue;
      let best: PastedVillage | null = null;
      let bestD = Infinity;
      for (const v of shown) {
        const d = distance(v, { x, y }, world.bounds);
        if (d <= opts.radius && d < bestD) {
          best = v;
          bestD = d;
        }
      }
      if (!best) continue;
      if (holdAll || holdAreas.some((h) => distance(h.c, { x, y }, world.bounds) <= h.reach)) {
        heldBy.set(vkey(best), (heldBy.get(vkey(best)) ?? 0) + 1);
        continue;
      }
      totalMissing++;
      const bonus = world.bonuses[b];
      const group = groupOf(bonus);
      if (!opts.groups.has(group)) continue;
      missingBy.get(vkey(best))!.push({ x, y, dist: Math.round(bestD * 10) / 10, bonus, group, animals });
    }
  }

  const byDist = (a: MissingOasis, b: MissingOasis) => a.dist - b.dist || a.x - b.x || a.y - b.y;
  const villages: VillageResult[] = shown.map((v) => {
    const own = lists.filter((l) => l.vx === v.x && l.vy === v.y);
    const tickedHere: TickedOasis[] = marks
      .filter((m) => m.vx === v.x && m.vy === v.y && !inLists.has(key(m.x, m.y)))
      .map((m) => {
        const i = info.get(key(m.x, m.y)) ?? { bonus: 'Unknown', group: 'hard' as const, animals: '' };
        return { x: m.x, y: m.y, dist: Math.round(distance(v, m, world.bounds) * 10) / 10, ...i, by: m.by, at: m.at };
      })
      .sort(byDist);
    return {
      village: v,
      lists: own,
      listedOases: own.reduce((n, l) => n + l.oases.length, 0),
      missing: missingBy.get(vkey(v))!.sort(byDist),
      ticked: tickedHere,
      heldBack: heldBy.get(vkey(v)) ?? 0,
    };
  });

  // Growth since the last expanded copy that the village's open ticks don't explain. Only lists that held
  // oases count: a list of villages ("Steppes") growing says nothing about oases.
  const grownLists: Warnings['grownLists'] = [];
  const villageKeys = new Set(lists.filter((l) => l.vx !== null && l.vy !== null).map((l) => key(l.vx!, l.vy!)));
  for (const vk of villageKeys) {
    const own = lists.filter((l) => l.vx !== null && key(l.vx, l.vy!) === vk && l.known !== undefined && l.oases.length > 0);
    const growth = own.reduce((n, l) => n + Math.max(0, l.total - l.known!), 0);
    const open = marks.filter((m) => key(m.vx, m.vy) === vk && !inLists.has(key(m.x, m.y))).length;
    if (growth > open) {
      for (const l of own) if (l.total > l.known!) grownLists.push({ village: l.village ?? nameAt.get(vk) ?? null, list: l.name, total: l.total, known: l.known! });
    }
  }

  const inSeveralVillages = [...listedBy.entries()]
    .filter(([, vs]) => vs.size > 1)
    .map(([k, vs]) => {
      const [x, y] = k.split('|').map(Number);
      return { x, y, villages: [...vs] };
    });

  return {
    villages,
    totalMissing,
    warnings: {
      fullLists: lists.filter((l) => l.total >= LIST_MAX).map((l) => ({ village: l.village, list: l.name })),
      deactivated: view?.deactivated ?? [],
      inSeveralVillages,
      neverExpanded: neverExpanded.map((l) => ({ village: l.village, list: l.name, total: l.total })),
      grownLists,
      unmatchedLists: lists.filter((l) => l.village === null).map((l) => l.name),
    },
  };
}

/** "(x|y)" as the game's coordinate fields accept it. */
export const coordText = (x: number, y: number) => `(${x}|${y})`;

/** Parses "x|y", "(x|y)", "x,y" or "x y" typed by a player. */
export function parseCoords(text: string): { x: number; y: number } | null {
  const m = /^\s*\(?\s*(-?\d{1,3})\s*[|,;\s]\s*(-?\d{1,3})\s*\)?\s*$/.exec(cleanGameText(text));
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}
