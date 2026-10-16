// Reads the text of the game's Farm List page as copied with Ctrl+A, Ctrl+C (English game texts).
// Only coordinates, counts and names are kept; nothing is sent anywhere.

export interface PastedVillage {
  name: string;
  x: number;
  y: number;
}

export interface PastedTarget {
  name: string;
  pop: number;
  /** Distance as the game shows it (one decimal). */
  dist: number;
  oasis: boolean;
  /** For oases: the game's current label ("Occupied oasis"), null for villages. */
  occupied: boolean | null;
  x: number | null;
  y: number | null;
}

export interface PastedList {
  /** The village the list belongs to, or null if the header couldn't be matched. */
  village: string | null;
  name: string;
  /** "85/89 being raided": active targets / all targets. */
  active: number;
  total: number;
  targets: PastedTarget[];
}

export interface ParsedPaste {
  villages: PastedVillage[];
  lists: PastedList[];
  /** Targets the game deactivated after an owner change (from the banner at the top). */
  deactivated: { x: number; y: number }[];
}

/** The game's limit per farm list. */
export const LIST_MAX = 100;

/** Removes the game's invisible direction marks and uses ASCII minus signs. */
export function cleanGameText(s: string): string {
  return s.replace(/[‎‏‪-‮⁦-⁩﻿]/g, '').replace(/[−‒–]/g, '-');
}

const COORD_LINE = /^\s*\((-?\d{1,3})\|(-?\d{1,3})\)\s*$/;
const COORDS = /\((-?\d{1,3})\|(-?\d{1,3})\)/g;
const RAIDED = /^(\d+)\/(\d+) being raided$/;
const TARGET = /^\t+(.+?)\t([\d,.]+)\t(\d+(?:\.\d+)?)\t?\s*$/;

const num = (s: string) => Number(s.replace(/[,.](?=\d{3}\b)/g, ''));

export function parsePaste(text: string): ParsedPaste {
  const lines = cleanGameText(text).split(/\r?\n/);

  // Own villages: the village list at the bottom shows a name line followed by a "(x|y)" line.
  const villages: PastedVillage[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < lines.length; i++) {
    const m = COORD_LINE.exec(lines[i + 1]);
    const name = lines[i].trim();
    const id = m ? `${name}|${m[1]}|${m[2]}` : '';
    if (m && name && !COORD_LINE.test(lines[i]) && !seen.has(id)) {
      seen.add(id);
      villages.push({ name, x: Number(m[1]), y: Number(m[2]) });
    }
  }
  // Two own villages with the same name can't be told apart in the list headers.
  const nameCount = new Map<string, number>();
  for (const v of villages) nameCount.set(v.name, (nameCount.get(v.name) ?? 0) + 1);

  const deactivated: { x: number; y: number }[] = [];
  const lists: PastedList[] = [];
  let village: string | null = null;
  let current: PastedList | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^The following targets were deactivated/i.test(t)) {
      // The coordinates follow on the same line or the next one.
      const rest = `${t}\n${lines[i + 1] ?? ''}`;
      for (const m of rest.matchAll(COORDS)) deactivated.push({ x: Number(m[1]), y: Number(m[2]) });
      continue;
    }
    const raided = RAIDED.exec(t);
    if (raided) {
      // "<village>" (only when the village changes), "<list name>", "a/b being raided".
      // Lists of the same village follow a "Start (N)" line; anything else is a village header.
      const listName = (lines[i - 1] ?? '').trim();
      const header = (lines[i - 2] ?? '').trim();
      if (nameCount.get(header) === 1) village = header;
      else if (header && !/^Start \(\d+\)$/.test(header)) village = null; // unknown or ambiguous village
      current = { village, name: listName, active: Number(raided[1]), total: Number(raided[2]), targets: [] };
      lists.push(current);
      continue;
    }
    const row = current ? TARGET.exec(lines[i]) : null;
    if (row && current) {
      const name = row[1].trim();
      const c = /\((-?\d{1,3})\|(-?\d{1,3})\)/.exec(name);
      const pop = num(row[2]);
      // The game's label, or coordinates with no population (a village called "Desert Oasis" is not one).
      const oasis = /^(?:un)?occupied oasis\b/i.test(name) || (c !== null && pop === 0);
      current.targets.push({
        name,
        pop,
        dist: Number(row[3]),
        oasis,
        occupied: oasis ? /^occupied/i.test(name) : null,
        x: c ? Number(c[1]) : null,
        y: c ? Number(c[2]) : null,
      });
    }
  }
  return { villages, lists, deactivated };
}
