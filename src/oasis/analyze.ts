// Which oases near the team's villages are not in any farm list yet. Pure functions, no I/O.

import { cleanGameText, LIST_MAX, type ParsedPaste, type PastedList, type PastedVillage } from './parsePaste.ts';
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
const vkey = (v: PastedVillage) => key(v.x, v.y);

export interface MissingOasis {
  x: number;
  y: number;
  dist: number;
  bonus: string;
  group: OasisGroup;
  /** Animals at scan time, "31:3,35:1" (may have changed since). */
  animals: string;
}

export interface VillageResult {
  village: PastedVillage;
  lists: PastedList[];
  /** Oases already in this village's lists. */
  listedOases: number;
  missing: MissingOasis[];
}

export interface Warnings {
  fullLists: { village: string | null; list: string }[];
  deactivated: { x: number; y: number }[];
  /** The same oasis in the lists of more than one village. */
  inSeveralVillages: { x: number; y: number; villages: string[] }[];
  /**
   * Lists whose targets weren't all in the paste (a collapsed list, for example). Their oases would look
   * free, so no oases are suggested while there are any.
   */
  incompleteLists: { village: string | null; list: string; read: number; total: number }[];
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

export function analyze(world: OasisWorld, paste: ParsedPaste | null, opts: AnalyzeOptions): Analysis {
  const lists = paste?.lists ?? [];
  // Where each listed oasis sits: oasis key -> village names.
  const listedBy = new Map<string, Set<string>>();
  for (const l of lists) {
    for (const t of l.targets) {
      if (!t.oasis || t.x === null || t.y === null) continue;
      const k = key(t.x, t.y);
      if (!listedBy.has(k)) listedBy.set(k, new Set());
      listedBy.get(k)!.add(l.village ?? '?');
    }
  }

  const pasted = paste?.villages ?? [];
  const withOasisLists = new Set(lists.filter((l) => l.targets.some((t) => t.oasis)).map((l) => l.village));
  const extras = opts.extraVillages ?? [];
  const typed = (v: PastedVillage) => extras.some((e) => e.x === v.x && e.y === v.y);
  const shown = [
    ...pasted.filter((v) => opts.allVillages || withOasisLists.has(v.name) || typed(v)),
    ...extras.filter((e) => !pasted.some((v) => v.x === e.x && v.y === e.y)),
  ];
  const incompleteLists = lists
    .filter((l) => l.targets.length < l.total)
    .map((l) => ({ village: l.village, list: l.name, read: l.targets.length, total: l.total }));

  // Each free oasis in range goes to the nearest shown village (ties: the first one).
  const missingBy = new Map<string, MissingOasis[]>(shown.map((v) => [vkey(v), []]));
  let totalMissing = 0;
  if (shown.length > 0 && incompleteLists.length === 0) {
    for (const [x, y, b, occupied, animals] of world.oases) {
      if (occupied || listedBy.has(key(x, y))) continue;
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
      totalMissing++;
      const bonus = world.bonuses[b];
      const group = groupOf(bonus);
      if (!opts.groups.has(group)) continue;
      missingBy.get(vkey(best))!.push({ x, y, dist: Math.round(bestD * 10) / 10, bonus, group, animals });
    }
  }

  const villages: VillageResult[] = shown.map((v) => {
    const own = lists.filter((l) => l.village === v.name);
    return {
      village: v,
      lists: own,
      listedOases: own.reduce((n, l) => n + l.targets.filter((t) => t.oasis).length, 0),
      missing: missingBy.get(vkey(v))!.sort((a, b) => a.dist - b.dist || a.x - b.x || a.y - b.y),
    };
  });

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
      fullLists: lists.filter((l) => l.targets.length >= LIST_MAX || l.total >= LIST_MAX).map((l) => ({ village: l.village, list: l.name })),
      deactivated: paste?.deactivated ?? [],
      inSeveralVillages,
      incompleteLists,
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
