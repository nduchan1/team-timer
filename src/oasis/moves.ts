// "3. Oases to move": oases in the farm list of one village while another village that farms oases is
// nearer, and the check of a paste made after moving them. Pure functions, no I/O.
//
// Raid rounds go every few minutes. An oasis that goes longer than that between two hits gets animals
// back, and the next small raid on it dies. Moving an oasis to a nearer village only makes its next hit
// come sooner; a farther village makes it later. So:
// - planMoves suggests only moves to a village at least MIN_GAIN fields nearer and within FAR fields. A
//   Tournament Square only speeds up the part of a trip beyond 20 fields, so within that the nearer village
//   is always faster, whatever either village has built. Moves are grouped into one bulk move in the game
//   per source list and destination list.
// - checkMoves compares a paste with the lists as they were before it: which steps are done, and which
//   oases are now raided from farther away than before, or not seen since they left their list. Those stay
//   flagged until a paste shows them in a list as near as before. List counts never clear a flag.

import { distance2, type FarmView, type ListView } from './analyze.ts';
import { listKey } from './farmState.ts';
import { LIST_MAX, type ParsedPaste, type PastedVillage } from './parsePaste.ts';
import type { Bounds } from './scanFormat.ts';

type XY = { x: number; y: number };

/** Moves that save less than this many fields aren't suggested. */
export const MIN_GAIN = 1;
/** Beyond this many fields a Tournament Square can make a farther village faster: no moves there. */
export const FAR = 20;

/** A list of one of your villages, with its key. */
export type OwnList = ListView & { id: string; vx: number; vy: number };

export interface MoveRow {
  /** Oasis + source list id. */
  key: string;
  x: number;
  y: number;
  /** Fields from the village it is with now (the game's Dist. column), and from the nearer one. */
  fromDist: number;
  toDist: number;
  /** How many fields nearer. */
  gain: number;
}

export interface MoveStep {
  key: string;
  /** move: to a village that doesn't have it yet. extra: a second copy; the nearer village has it (or gets it first). */
  kind: 'move' | 'extra';
  from: OwnList;
  fromVillage: PastedVillage;
  /** 1 = the first list of that name in its village, 2 = the second... */
  fromTwin: number;
  to: PastedVillage;
  /** null: no list of `to` has room (make one first). */
  toList: OwnList | null;
  toTwin: number;
  /** Lists of `to` with room (the picker; move steps only). */
  options: OwnList[];
  /** toList's count once this step and the earlier ones are done. */
  after: number | null;
  rows: MoveRow[];
  /** The source list changed since it was last expanded. */
  stale: boolean;
}

export interface MovePlan {
  steps: MoveStep[];
  /** Rows over all steps. */
  count: number;
  /** village "x|y" -> oases it gets from move steps. */
  incoming: Map<string, number>;
  /** Oases with a step (left out of the "In the lists of two villages" banner). */
  covered: Set<string>;
  /** Oases left out because the nearer village is over FAR fields away too. */
  leftFar: number;
}

export interface PlanOptions {
  /** village "x|y" -> the destination list the player picked (this tab only). */
  prefer?: Record<string, string>;
  /** Oases with an open alarm ("x|y"): the alarm says where they go, so no step for them. */
  skip?: Set<string>;
}

const k = (x: number, y: number) => `${x}|${y}`;
const vk = (v: XY) => k(v.x, v.y);
const r1 = (d2: number) => Math.round(Math.sqrt(d2) * 10) / 10;
const xyOf = (key: string): XY => {
  const [x, y] = key.split('|').map(Number);
  return { x, y };
};
const push = <T>(m: Map<string, T[]>, key: string, v: T) => {
  const a = m.get(key);
  if (a) a.push(v);
  else m.set(key, [v]);
};

/** 1 for the first list of that name in its village, 2 for the second... (from the saved key, else list order). */
function twinOf(l: OwnList, lists: OwnList[]): number {
  if (!l.id.startsWith('#')) {
    for (let n = 1; n <= 20; n++) if (listKey(l.vx, l.vy, n === 1 ? l.name : `${l.name}#${n}`) === l.id) return n;
    return 1;
  }
  return 1 + lists.slice(0, lists.indexOf(l)).filter((o) => o.vx === l.vx && o.vy === l.vy && o.name === l.name).length;
}

/** Gives a paste's lists the keys mergePaste saves them under, so two pastes (or a paste and the saved lists) compare. */
export function keyedView(view: FarmView): FarmView {
  const nth = new Map<string, number>();
  return {
    ...view,
    lists: view.lists.map((l) => {
      if (l.id || l.vx === null || l.vy === null) return l;
      const twin = `${l.vx}|${l.vy}|${l.name}`;
      const n = nth.get(twin) ?? 0;
      nth.set(twin, n + 1);
      return { ...l, id: listKey(l.vx, l.vy, n === 0 ? l.name : `${l.name}#${n + 1}`) };
    }),
  };
}

/** The keys of the lists a paste copied in full (every row), as mergePaste saves them. */
export function fullLists(p: ParsedPaste): Set<string> {
  const count = new Map<string, number>();
  for (const v of p.villages) count.set(v.name, (count.get(v.name) ?? 0) + 1);
  const byName = new Map(p.villages.filter((v) => count.get(v.name) === 1).map((v) => [v.name, v]));
  const nth = new Map<string, number>();
  const out = new Set<string>();
  for (const l of p.lists) {
    const v = l.village !== null ? byName.get(l.village) : undefined;
    if (!v) continue;
    const twin = `${v.x}|${v.y}|${l.name}`;
    const n = nth.get(twin) ?? 0;
    nth.set(twin, n + 1);
    if (l.targets.length >= l.total) out.add(listKey(v.x, v.y, n === 0 ? l.name : `${l.name}#${n + 1}`));
  }
  return out;
}

// ---- the plan ---------------------------------------------------------------------------------------

export function planMoves(view: FarmView, bounds: Bounds, opts: PlanOptions = {}): MovePlan {
  const empty: MovePlan = { steps: [], count: 0, incoming: new Map(), covered: new Set(), leftFar: 0 };
  const order = new Map(view.villages.map((v, i) => [vk(v), i]));
  const villageAt = new Map(view.villages.map((v) => [vk(v), v]));
  const all = view.lists.map((l, i) => ({ ...l, id: l.id ?? `#${i}` }));
  const isOwn = (l: (typeof all)[number]): l is OwnList => l.vx !== null && l.vy !== null && villageAt.has(k(l.vx, l.vy));
  const own = all.filter(isOwn);
  // Seen expanded, and read cleanly (known > total: rows of the "Abandoned farm lists" section were added to it).
  const clean = (l: ListView) => l.known !== undefined && l.known <= l.total;
  const at = (l: OwnList, v: XY) => l.vx === v.x && l.vy === v.y;
  // Only villages that farm oases take part.
  const cands = view.villages.filter((v) => own.some((l) => at(l, v) && clean(l) && l.oases.length > 0));
  if (cands.length < 2) return empty;
  const deactivated = new Set(view.deactivated.map((d) => k(d.x, d.y)));
  const twin = (l: OwnList) => twinOf(l, own);

  const holders = new Map<string, (typeof all)[number][]>();
  for (const l of all)
    for (const o of l.oases) {
      const ok = k(o.x, o.y);
      if (!holders.has(ok)) holders.set(ok, []);
      if (!holders.get(ok)!.includes(l)) holders.get(ok)!.push(l);
    }

  type Raw = { x: number; y: number; kind: MoveStep['kind']; from: OwnList; fromVillage: PastedVillage; fromD2: number; to: PastedVillage; toD2: number; hold: OwnList | null };
  const raw: Raw[] = [];
  let leftFar = 0;
  for (const [ok, hs] of holders) {
    if (deactivated.has(ok) || opts.skip?.has(ok)) continue;
    // A list never seen expanded, read with extra rows, or not matched to a village: leave the oasis alone.
    if (hs.some((l) => !isOwn(l) || !clean(l))) continue;
    const o = xyOf(ok);
    let best: PastedVillage | null = null;
    let bestD2 = Infinity;
    for (const c of cands) {
      const d2 = distance2(c, o, bounds);
      if (d2 < bestD2) {
        best = c;
        bestD2 = d2;
      }
    }
    if (!best) continue;
    const held = (hs as OwnList[])
      .map((l) => ({ l, v: villageAt.get(k(l.vx, l.vy))!, d2: distance2({ x: l.vx, y: l.vy }, o, bounds) }))
      .sort((a, b) => a.d2 - b.d2 || order.get(vk(a.v))! - order.get(vk(b.v))! || a.l.name.localeCompare(b.l.name) || a.l.id.localeCompare(b.l.id));
    // The squares are whole numbers, so a gain of exactly MIN_GAIN only happens between perfect squares.
    const gain = (d2: number) => Math.sqrt(d2) - Math.sqrt(bestD2);
    // A holder less than MIN_GAIN farther than the nearest oasis village keeps it (the nearest such holder).
    const near = held.find((h) => gain(h.d2) < MIN_GAIN);
    let keeper: PastedVillage;
    let keeperD2: number;
    if (near) [keeper, keeperD2] = [near.v, near.d2];
    else if (bestD2 > FAR * FAR) {
      // Over FAR fields from every oasis village: a Tournament Square can make the current one faster.
      [keeper, keeperD2] = [held[0].v, held[0].d2];
      leftFar++;
    } else [keeper, keeperD2] = [best, bestD2];
    const kept = held.filter((h) => vk(h.v) === vk(keeper));
    let first = kept.length === 0;
    for (const h of held) {
      if (vk(h.v) === vk(keeper)) continue; // two lists of the keeping village: not this tool's job
      raw.push({ x: o.x, y: o.y, kind: first ? 'move' : 'extra', from: h.l, fromVillage: h.v, fromD2: h.d2, to: keeper, toD2: keeperD2, hold: kept[0]?.l ?? null });
      first = false;
    }
  }

  // Moves first (extras clean up copies, after the moves they may depend on); then game order: source village,
  // source list, destination village, then the Dist. column.
  raw.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'move' ? -1 : 1) ||
      order.get(vk(a.fromVillage))! - order.get(vk(b.fromVillage))! ||
      a.from.name.localeCompare(b.from.name) ||
      twin(a.from) - twin(b.from) ||
      a.from.id.localeCompare(b.from.id) ||
      order.get(vk(a.to))! - order.get(vk(b.to))! ||
      a.fromD2 - b.fromD2 ||
      a.x - b.x ||
      a.y - b.y,
  );

  // Room: 100 - total - ticks not yet counted in the saved totals - moves planned into the list.
  const used = new Map<string, number>();
  const room = (l: OwnList) => LIST_MAX - l.total - (used.get(l.id) ?? 0);
  const take = (l: OwnList, n: number) => used.set(l.id, (used.get(l.id) ?? 0) + n);
  const oasisLists = (v: XY) => own.filter((l) => at(l, v) && clean(l) && l.oases.length > 0);
  const emptyLists = (v: XY) => own.filter((l) => at(l, v) && clean(l) && l.total === 0);
  const byRoom = (pick?: string) => (a: OwnList, b: OwnList) =>
    (a.id === pick ? -1 : b.id === pick ? 1 : 0) || room(b) - room(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const inLists = new Set(all.flatMap((l) => l.oases.map((o) => k(o.x, o.y))));
  for (const v of cands) {
    // Ticked oases are in the game's counts once a collapsed paste saw them: don't count them twice.
    const open = view.marks.filter((m) => m.vx === v.x && m.vy === v.y && !inLists.has(k(m.x, m.y))).length;
    const growth = own.filter((l) => at(l, v) && l.known !== undefined && l.oases.length > 0).reduce((n, l) => n + Math.max(0, l.total - l.known!), 0);
    let unseen = Math.max(0, open - growth);
    for (const l of oasisLists(v).sort(byRoom())) {
      const n = Math.min(unseen, Math.max(0, room(l)));
      take(l, n);
      unseen -= n;
    }
  }

  const steps: MoveStep[] = [];
  const movedTo = new Map<string, OwnList | null>(); // oasis -> the list its move step goes to (for extras of the same oasis)
  const stale = (l: OwnList) => l.known !== l.total || l.oases.length > l.total;
  const row = (r: Raw): MoveRow => ({
    key: `${k(r.x, r.y)}@${r.from.id}`,
    x: r.x,
    y: r.y,
    fromDist: r1(r.fromD2),
    toDist: r1(r.toD2),
    gain: Math.round((Math.sqrt(r.fromD2) - Math.sqrt(r.toD2)) * 10) / 10,
  });
  const base = (r: Raw) => ({ from: r.from, fromVillage: r.fromVillage, fromTwin: twin(r.from), to: r.to, stale: stale(r.from) });
  for (let i = 0; i < raw.length; ) {
    const r0 = raw[i];
    let j = i;
    while (j < raw.length && raw[j].kind === r0.kind && raw[j].from.id === r0.from.id && vk(raw[j].to) === vk(r0.to)) j++;
    const batch = raw.slice(i, j);
    i = j;
    if (r0.kind === 'move') {
      const queue = [...batch];
      while (queue.length > 0) {
        const withOases = oasisLists(r0.to).filter((l) => room(l) > 0);
        const options = withOases.length > 0 ? withOases : emptyLists(r0.to).filter((l) => room(l) > 0);
        const target = [...options].sort(byRoom(opts.prefer?.[vk(r0.to)]))[0] ?? null;
        const n = target ? Math.min(room(target), queue.length) : queue.length;
        const chunk = queue.splice(0, n);
        if (target) take(target, n);
        for (const r of chunk) movedTo.set(k(r.x, r.y), target);
        steps.push({
          key: `move:${r0.from.id}>${target?.id ?? vk(r0.to)}`,
          kind: 'move',
          ...base(r0),
          toList: target,
          toTwin: target ? twin(target) : 1,
          options,
          after: target ? target.total + (used.get(target.id) ?? 0) : null,
          rows: chunk.map(row),
        });
      }
    } else {
      // One step per destination list (the keeper's list that holds it, or the list its move goes to).
      const byList = new Map<string, Raw[]>();
      for (const r of batch) {
        const dest = r.hold ?? movedTo.get(k(r.x, r.y)) ?? null;
        push(byList, dest?.id ?? vk(r.to), r);
      }
      for (const [id, rs] of byList) {
        const dest = rs[0].hold ?? movedTo.get(k(rs[0].x, rs[0].y)) ?? null;
        steps.push({ key: `extra:${r0.from.id}>${id}`, kind: 'extra', ...base(r0), toList: dest, toTwin: dest ? twin(dest) : 1, options: [], after: null, rows: rs.map(row) });
      }
    }
  }

  const incoming = new Map<string, number>();
  for (const s of steps) if (s.kind === 'move') incoming.set(vk(s.to), (incoming.get(vk(s.to)) ?? 0) + s.rows.length);
  return {
    steps,
    count: steps.reduce((n, s) => n + s.rows.length, 0),
    incoming,
    covered: new Set(steps.flatMap((s) => s.rows.map((r) => k(r.x, r.y)))),
    leftFar,
  };
}

// ---- the check of a paste ---------------------------------------------------------------------------
//
// Only what the paste shows counts: the rows it contains, and the lists it shows in full (every row). An
// oasis that left its list is fine only once a paste shows it in a list as near as before. A list the paste
// doesn't show in full is never trusted to still hold an oasis, whatever the saved copy says. Counts of
// collapsed lists only add hints, or turn amber into red; they never clear anything.

/** A village and one of its lists (list null: a new list, or not known). */
export interface Spot {
  village: string;
  list: string | null;
  /** 2 = the second list of that name in its village. */
  twin: number;
}

/** A list copied collapsed that grew: where an oasis that left may be. */
export interface Grown {
  id: string;
  spot: Spot;
  by: number;
  /** Fields from the oasis to that list's village. */
  dist: number;
  /** Farther than the village that raided the oasis before. */
  farther: boolean;
}

/**
 * An oasis to watch after a paste, until a paste shows it in a list as near as before (or it's dismissed).
 * - farther (red): the paste shows it in a farther village's list, and nowhere as near as before;
 * - twice (amber, red if that list shrank): shown in a farther list, while the nearer list it was in isn't
 *   shown in full, so it may still be there too (a copy) or not (moved);
 * - check (amber): it left a list, and another list it was in isn't shown in full: is it still there?
 * - missing (red, amber if a collapsed list as near as before grew): it left, and the list it should be in is
 *   shown in full without it;
 * - lost (red or amber, same rule): it was shown farther, that list is shown without it now, and no list
 *   shows it anywhere;
 * - unconfirmed (amber): an oasis of a step left its list, and no list the paste shows has it yet;
 * - along (amber): it left a list together with a step's oases, but isn't one of them;
 * - watch (quiet, not shown): it left a list that has a step, while no step row left it.
 */
export interface Alarm {
  /** "x|y" */
  key: string;
  x: number;
  y: number;
  why: 'farther' | 'twice' | 'check' | 'missing' | 'lost' | 'unconfirmed' | 'along' | 'watch';
  level: 'red' | 'amber' | 'quiet';
  /** Before the move: the nearest village that raided it (squared fields, and fields). */
  safeD2: number;
  wasDist: number;
  /** The list it left. */
  from: Spot;
  /** Where it should be: its step's list, or back where it came from. */
  fix: Spot;
  fixId: string;
  /** Where the paste showed it (farther). */
  at: Spot | null;
  atId: string;
  atV: XY | null;
  nowDist: number;
  /** twice/check: a list it was in that the paste doesn't show in full. */
  holder: Spot | null;
  holderId: string;
  /** Collapsed lists that grew since it left. */
  grown: Grown[];
}

export interface StepDone {
  key: string;
  kind: MoveStep['kind'];
  from: Spot;
  to: Spot;
  /** Oases of the step the paste shows with the nearer village (moves), or copies gone (extras). */
  moved: number;
  /** Still to do (or not seen yet). */
  left: number;
}

/** Oases of a move step that left their list and are fine, but not where the step said. */
export interface StepNote {
  key: string;
  from: Spot;
  expected: Spot;
  rows: XY[];
  /** went: shown in another village's list, nearer than before. kept: shown still in a list of a village that raided them before. */
  kind: 'went' | 'kept';
  at: Spot | null;
}

export interface MoveCheck {
  done: StepDone[];
  /** Earlier alarms now shown in a list as near as before (or still in the list they were thought to have left). */
  confirmed: { at: Spot; rows: XY[] }[];
  /** Open alarms (red and amber): new ones and earlier ones not resolved. */
  alarms: Alarm[];
  /** Quiet watches, passed back in with the alarms on the next check. */
  quiet: Alarm[];
  notes: StepNote[];
  /** Step source lists copied collapsed that shrank: which oases left can't be told. */
  unchecked: { from: Spot; drop: number }[];
  /** Oases of steps still in their list (shown in full). */
  waiting: number;
}

/**
 * Compares a paste with the lists before it.
 * - before: the lists before the paste (viewFromFarm of the saved or last known lists);
 * - pasted: the paste itself, keyed (keyedView(viewFromPaste(p))): its rows, and which lists it shows in full;
 * - plan: the steps as they were before the paste (what the player was doing);
 * - prev: alarms and quiet watches still open from earlier checks;
 * - between: in a team room, the team's lists just before this paste, when teammates pasted since `before`
 *   (this tab's own baseline): what their pastes showed counts as seen, or as gone from a list.
 */
export function checkMoves(before: FarmView, pasted: FarmView, bounds: Bounds, plan: MovePlan | null, prev: Alarm[] = [], between?: FarmView): MoveCheck {
  const villageAt = new Map<string, PastedVillage>();
  for (const v of [...pasted.villages, ...before.villages, ...(between?.villages ?? [])]) if (!villageAt.has(vk(v))) villageAt.set(vk(v), v);
  const ownOf = (view: FarmView) => view.lists.filter((l): l is OwnList => !!l.id && l.vx !== null && l.vy !== null && villageAt.has(k(l.vx, l.vy)));
  const ownB = ownOf(before);
  const ownP = ownOf(pasted);
  const B = new Map(ownB.map((l) => [l.id, l]));
  const P = new Map(ownP.map((l) => [l.id, l]));
  const sets = new Map<OwnList, Set<string>>();
  const setOf = (l: OwnList) => {
    let s = sets.get(l);
    if (!s) sets.set(l, (s = new Set(l.oases.map((o) => k(o.x, o.y)))));
    return s;
  };
  const held = (l: OwnList | undefined, ok: string) => !!l && setOf(l).has(ok);
  const lv = (l: OwnList): XY => ({ x: l.vx, y: l.vy });
  const d2 = (v: XY, o: XY) => distance2(v, o, bounds);
  const spot = (l: OwnList | null, v: XY): Spot => ({ village: villageAt.get(vk(v))?.name ?? l?.village ?? '?', list: l ? l.name : null, twin: l ? twinOf(l, []) : 1 });
  const sameV = (a: XY, b: XY) => a.x === b.x && a.y === b.y;
  const nearestList = (ls: OwnList[], o: XY) => [...ls].sort((a, b) => d2(lv(a), o) - d2(lv(b), o))[0];
  const steps = plan?.steps ?? [];
  const prevBy = new Map(prev.map((a) => [a.key, a]));

  // Lists of the same name in a village are told apart by their order. When their number changed, the keys
  // may point at other lists: nothing is read from them in this paste.
  const group = (l: OwnList) => `${l.vx}|${l.vy}|${l.name}`;
  const countOf = (ls: OwnList[]) => ls.reduce((m, l) => m.set(group(l), (m.get(group(l)) ?? 0) + 1), new Map<string, number>());
  const [countB, countP] = [countOf(ownB), countOf(ownP)];
  const shifted = (l: OwnList) => {
    const [b, p] = [countB.get(group(l)) ?? 0, countP.get(group(l)) ?? 0];
    return b > 0 && p > 0 && b !== p;
  };
  // Shown in full: the paste copied every row of it.
  const full = (id: string) => {
    const lp = P.get(id);
    return !!lp && lp.known !== undefined && !shifted(lp);
  };
  // Gone: every list of the paste was matched, its village is in the paste's village list, and it isn't there.
  const complete = pasted.lists.every((l) => l.vx !== null && l.vy !== null);
  const pasteVillages = new Set(pasted.villages.map(vk));
  const goneList = (lb: OwnList) => complete && !P.has(lb.id) && !shifted(lb) && pasteVillages.has(vk(lv(lb)));
  const goneId = (id: string) => !!B.get(id) && goneList(B.get(id)!);
  // Not seen into: a list that held it, but the paste doesn't show it in full (collapsed, renamed twins, or its
  // village isn't in the paste).
  const unshown = (lb: OwnList) => !full(lb.id) && !goneList(lb);
  const shrank = (lb: OwnList) => P.has(lb.id) && !full(lb.id) && !shifted(lb) && P.get(lb.id)!.total < lb.total;
  // A list renamed while collapsed shows up as a new collapsed list of its village: it may hold its oases.
  const renamedTo = (lb: OwnList) => (goneList(lb) ? ownP.filter((lp) => !B.has(lp.id) && !full(lp.id) && sameV(lv(lp), lv(lb))) : []);

  // Before: every list that held each oasis. Seen: every list whose rows in this paste show it.
  const heldBefore = new Map<string, OwnList[]>();
  for (const l of ownB) for (const ok of setOf(l)) push(heldBefore, ok, l);
  const seenIn = new Map<string, OwnList[]>();
  for (const lp of ownP) for (const ok of setOf(lp)) push(seenIn, ok, lp);

  // What surely left a list: a list shown in full without it, or a list gone.
  const leftSure = new Map<string, OwnList[]>();
  for (const lb of ownB) if (full(lb.id) || goneList(lb)) for (const ok of setOf(lb)) if (!held(P.get(lb.id), ok)) push(leftSure, ok, lb);
  // Teammates' pastes since this tab's baseline: a list that got an oasis counts as a sighting, a list that
  // lost one counts as left (unless this paste shows that list in full: then this paste says what it holds).
  if (between) {
    const T = new Map(ownOf(between).map((l) => [l.id, l]));
    for (const lt of T.values()) {
      if (full(lt.id)) continue;
      for (const ok of setOf(lt)) if (!held(B.get(lt.id), ok) && !(seenIn.get(ok) ?? []).some((l) => l.id === lt.id)) push(seenIn, ok, lt);
    }
    for (const lb of ownB) {
      if (full(lb.id) || goneList(lb)) continue;
      const lt = T.get(lb.id);
      for (const ok of setOf(lb)) if ((!lt || !held(lt, ok)) && !held(P.get(lb.id), ok) && !(leftSure.get(ok) ?? []).includes(lb)) push(leftSure, ok, lb);
    }
  }

  // Collapsed lists that grew: hints for where an oasis that left may be.
  const grownNow = ownP.flatMap((lp) => {
    const by = lp.total - (B.get(lp.id)?.total ?? 0);
    return !full(lp.id) && !shifted(lp) && by > 0 ? [{ lp, by }] : [];
  });
  const hints = (o: XY, safeD2: number, old: Grown[] = []): Grown[] => {
    const out = new Map<string, Grown>();
    // Earlier hints stay until a paste shows that list in full (then it isn't there).
    for (const g of old) if (!full(g.id) && !goneId(g.id)) out.set(g.id, g);
    for (const { lp, by } of grownNow) out.set(lp.id, { id: lp.id, spot: spot(lp, lv(lp)), by, dist: r1(d2(lv(lp), o)), farther: d2(lv(lp), o) > safeD2 });
    return [...out.values()].sort((a, b) => a.dist - b.dist);
  };

  // The step an oasis is in, and the lists a step's oases surely left in this paste (the player worked on them).
  const stepOf = new Map<string, MoveStep>();
  for (const s of steps) if (s.kind === 'move') for (const r of s.rows) stepOf.set(k(r.x, r.y), s);
  const worked = new Set<string>();
  for (const s of steps) if (s.rows.some((r) => (leftSure.get(k(r.x, r.y)) ?? []).some((l) => l.id === s.from.id))) worked.add(s.from.id);
  // Fixing an alarm is work on a list too: other oases that leave it with the alarmed one get flagged.
  for (const p of prev) if (p.level !== 'quiet') for (const l of leftSure.get(p.key) ?? []) worked.add(l.id);
  const hasStep = (id: string) => steps.some((st) => st.from.id === id);

  // Oases to look at: what left a list, earlier alarms, and oases shown newly in a list farther than any list
  // that held them before.
  const candidates = new Set([...leftSure.keys(), ...prevBy.keys()]);
  for (const [ok, ls] of seenIn) {
    const was = heldBefore.get(ok) ?? [];
    if (was.length === 0) continue;
    const o = xyOf(ok);
    const safeD2 = Math.min(...was.map((l) => d2(lv(l), o)));
    if (ls.some((l) => !held(B.get(l.id), ok) && d2(lv(l), o) > safeD2)) candidates.add(ok);
  }

  const alarms: Alarm[] = [];
  const quiet: Alarm[] = [];
  const keep = (a: Alarm) => (a.level === 'quiet' ? quiet : alarms).push(a);
  const confirmed = new Map<string, { at: Spot; rows: XY[] }>();
  const confirm = (p: Alarm | undefined, l: OwnList, o: XY) => {
    if (!p || p.level === 'quiet') return;
    const s = spot(l, lv(l));
    const ck = `${s.village}|${s.list}|${s.twin}`;
    if (!confirmed.has(ck)) confirmed.set(ck, { at: s, rows: [] });
    confirmed.get(ck)!.rows.push(o);
  };
  /** Was this alarm about an oasis of a step (it should go to the step's list, in another village)? */
  const viaStepOf = (p: Alarm) => p.fixId !== '' && p.fix.village !== p.from.village;
  const keepsRhythm = new Map<string, OwnList>();
  const nearer = new Map<string, OwnList>(); // shown in a list as near as before (or nearer)
  for (const ok of candidates) {
    const o = xyOf(ok);
    const p = prevBy.get(ok);
    const was = heldBefore.get(ok) ?? [];
    // An open alarm or watch keeps the distance from before the first move.
    const safeD2 = p ? p.safeD2 : Math.min(...was.map((l) => d2(lv(l), o)));
    if (!Number.isFinite(safeD2)) continue;
    const seen = seenIn.get(ok) ?? [];
    const near = seen.filter((l) => d2(lv(l), o) <= safeD2);
    if (near.length > 0) {
      const at = nearestList(near, o);
      nearer.set(ok, at);
      confirm(p, at, o);
      continue;
    }
    // Still shown in a list of a village that raided it before: that village keeps its rhythm, so no gap.
    // After a flagged move, only the list the alarm asked about counts (a copy that was there all along).
    const keeper = p ? seen.find((l) => l.id === p.holderId) : seen.find((l) => was.some((w) => sameV(lv(w), lv(l))));
    if (keeper) {
      keepsRhythm.set(ok, keeper);
      confirm(p, keeper, o);
      continue;
    }
    // The list it left, and where it should be: its step's list, else back to the nearest list it left.
    const lf = leftSure.get(ok) ?? [];
    const s = stepOf.get(ok);
    const src = lf.length > 0 ? (lf.find((l) => s?.from.id === l.id) ?? nearestList(lf, o)) : null;
    // An oasis of a step goes to the step's list (also when the paste doesn't show it leaving the step's list).
    const viaStep = !!s && (src ? s.from.id === src.id : was.some((w) => w.id === s.from.id));
    // Back home: the nearest list that raided it before (never one farther than where it is now).
    const home = was.length > 0 ? nearestList(was, o) : src;
    if (!p && !home) continue;
    const left = src ?? home;
    const from = left ? spot(left, lv(left)) : p!.from;
    const [fix, fixId] = p ? [p.fix, p.fixId] : viaStep ? [spot(s!.toList, s!.to), s!.toList?.id ?? ''] : [spot(home!, lv(home!)), home!.id];
    const grown = hints(o, safeD2, p?.grown);
    const maybeNear = grown.some((g) => !g.farther);
    // Lists it was in that the paste doesn't show in full: it may still be there.
    const maybeIn = [...was.filter(unshown), ...was.flatMap(renamedTo)].sort((a, b) => d2(lv(a), o) - d2(lv(b), o));
    const base = { key: ok, x: o.x, y: o.y, safeD2, wasDist: r1(safeD2), from, fix, fixId, at: null, atId: '', atV: null, nowDist: 0, holder: null, holderId: '', grown };
    if (seen.length > 0) {
      // Shown only farther away.
      const at = nearestList(seen, o);
      const shownAt = { at: spot(at, lv(at)), atId: at.id, atV: lv(at), nowDist: r1(d2(lv(at), o)) };
      // A nearer list it was in isn't shown: it may still be there. (An open alarm keeps the list it asked about.)
      const ph = p && (p.why === 'twice' || p.why === 'check') ? B.get(p.holderId) : undefined;
      const h = !p ? maybeIn[0] : ph && unshown(ph) ? ph : undefined;
      if (h) keep({ ...base, ...shownAt, why: 'twice', level: shrank(h) ? 'red' : 'amber', holder: spot(h, lv(h)), holderId: h.id });
      else keep({ ...base, ...shownAt, why: 'farther', level: 'red' });
      continue;
    }
    if (p) {
      // Not shown anywhere. Look again at what the alarm said, with what this paste shows.
      const holderGone = !!p.holderId && ((full(p.holderId) && !held(P.get(p.holderId), ok)) || goneId(p.holderId));
      const atGone = !!p.atId && (full(p.atId) || goneId(p.atId));
      const fixShown = !!p.fixId && full(p.fixId);
      const level = maybeNear ? 'amber' : 'red';
      if (p.why === 'twice' && holderGone) keep({ ...p, why: 'farther', level: 'red', holder: null, holderId: '', grown });
      else if (p.why === 'check' && holderGone) keep({ ...p, why: viaStepOf(p) ? 'missing' : 'lost', level, holder: null, holderId: '', grown });
      else if ((p.why === 'farther' || p.why === 'twice') && atGone) keep({ ...p, why: 'lost', level, holder: null, holderId: '', grown });
      else if ((p.why === 'unconfirmed' || p.why === 'along') && fixShown) keep({ ...p, why: 'missing', level, grown });
      else if (p.why === 'missing' || p.why === 'lost') keep({ ...p, level, grown });
      else keep({ ...p, grown });
      continue;
    }
    // It surely left a list, and no list the paste shows has it.
    if (maybeIn.length > 0) {
      keep({ ...base, why: 'check', level: 'amber', holder: spot(maybeIn[0], lv(maybeIn[0])), holderId: maybeIn[0].id });
    } else if (viaStep && src && worked.has(src.id)) {
      const fixShown = !!s!.toList && full(s!.toList.id);
      keep({ ...base, why: fixShown ? 'missing' : 'unconfirmed', level: fixShown && !maybeNear ? 'red' : 'amber' });
    } else if (src && (worked.has(src.id) || (hasStep(src.id) && grown.some((g) => g.farther)))) keep({ ...base, why: 'along', level: 'amber' });
    // Anything else that left a list and isn't shown: watched quietly (flagged if it shows up farther away).
    else keep({ ...base, why: 'watch', level: 'quiet' });
  }

  // Steps: done (shown with the planned village), still waiting, or fine elsewhere.
  const done: StepDone[] = [];
  const notes: StepNote[] = [];
  let waiting = 0;
  for (const s of steps) {
    let moved = 0;
    const off = new Map<string, StepNote>();
    const from = spot(s.from, s.fromVillage);
    const to = spot(s.toList, s.to);
    for (const r of s.rows) {
      const ok = k(r.x, r.y);
      if (!(leftSure.get(ok) ?? []).some((l) => l.id === s.from.id)) {
        if (full(s.from.id)) waiting++;
        continue;
      }
      const kept = keepsRhythm.get(ok);
      const nl = nearer.get(ok);
      if ((seenIn.get(ok) ?? []).some((l) => sameV(lv(l), s.to))) {
        moved++;
        continue;
      }
      if (s.kind !== 'move') continue;
      const kind: StepNote['kind'] | null = nl ? 'went' : kept ? 'kept' : null;
      if (!kind) continue; // in the alarms
      const at = kind === 'went' ? spot(nl!, lv(nl!)) : spot(kept!, lv(kept!));
      const gk = `${kind}|${at.village}|${at.list}|${at.twin}`;
      if (!off.has(gk)) off.set(gk, { key: s.key, from, expected: to, rows: [], kind, at });
      off.get(gk)!.rows.push({ x: r.x, y: r.y });
    }
    if (moved > 0) done.push({ key: s.key, kind: s.kind, from, to, moved, left: s.rows.length - moved });
    notes.push(...off.values());
  }

  // Step source lists copied collapsed that shrank: which oases left can't be told.
  const unchecked: MoveCheck['unchecked'] = [];
  for (const id of new Set(steps.map((s) => s.from.id))) {
    const lb = B.get(id);
    if (lb && shrank(lb)) unchecked.push({ from: spot(lb, lv(lb)), drop: lb.total - P.get(id)!.total });
  }

  return { done, confirmed: [...confirmed.values()], alarms, quiet, notes, unchecked, waiting };
}
