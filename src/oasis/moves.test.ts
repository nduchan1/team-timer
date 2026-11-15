import { describe, expect, it } from 'vitest';
import { analyze, distance2, viewFromPaste, type OasisGroup } from './analyze.ts';
import { EMPTY_FARM, mergePaste, viewFromFarm, type FarmState, type StoredList } from './farmState.ts';
import { checkMoves, keyedView, planMoves, type Alarm, type MovePlan } from './moves.ts';
import type { ParsedPaste, PastedList, PastedTarget, PastedVillage } from './parsePaste.ts';
import type { OasisRow, OasisWorld } from './scanFormat.ts';

// Made-up villages only.
const A: PastedVillage = { name: 'Alpha', x: 0, y: 0 };
const B: PastedVillage = { name: 'Beta', x: 30, y: 0 };
const C: PastedVillage = { name: 'Charlie', x: 0, y: 30 };
const G: PastedVillage = { name: 'Gamma', x: -30, y: 0 }; // a list of villages only
const oasis = (x: number, y: number): PastedTarget => ({ name: `Unoccupied oasis (${x}|${y})`, pop: 0, dist: 1, oasis: true, occupied: false, x, y });
const farm = (name: string): PastedTarget => ({ name, pop: 50, dist: 3, oasis: false, occupied: null, x: null, y: null });
/** A list as pasted: rows = the targets copied (none when collapsed); total = what the game counts. */
const list = (village: string | null, name: string, total: number, targets: PastedTarget[] = []): PastedList => ({ village, name, active: total, total, targets });
const paste = (lists: PastedList[], villages: PastedVillage[] = [A, B, C, G]): ParsedPaste => ({ villages, lists, deactivated: [] });
const BOUNDS = { minX: -200, maxX: 200, minY: -200, maxY: 200 };

function save(p: ParsedPaste, s: FarmState = EMPTY_FARM, by = 'nd', now = 1000): FarmState {
  const r = mergePaste(s, p, by, now);
  if (!r.ok) throw new Error(r.error);
  return r.next;
}
const plan = (s: FarmState, prefer?: Record<string, string>) => planMoves(viewFromFarm(s), BOUNDS, { prefer });
const rows = (pl: MovePlan) => pl.steps.flatMap((s) => s.rows.map((r) => `${s.kind} ${r.x}|${r.y} ${s.fromVillage.name}:${s.from.name}->${s.to.name}:${s.toList?.name ?? '-'}`));

describe('planMoves: what counts as a move', () => {
  const s = save(paste([list('Alpha', 'A oases', 3, [oasis(1, 1), oasis(20, 0), oasis(-25, 0)]), list('Beta', 'B oases', 1, [oasis(31, 0)]), list('Gamma', 'G farms', 1, [farm('v')])]));

  it('moves an oasis to a nearer village that farms oases', () => {
    const p = plan(s);
    expect(rows(p)).toEqual(['move 20|0 Alpha:A oases->Beta:B oases']);
    expect(p.steps[0].rows[0]).toMatchObject({ fromDist: 20, toDist: 10, gain: 10 });
  });

  it('leaves out a village without an oasis list', () => {
    expect(rows(plan(s)).some((r) => r.includes('-25|0'))).toBe(false);
  });

  it('measures across the map edge', () => {
    const E = { name: 'East', x: 190, y: 0 };
    const W = { name: 'West', x: -195, y: 0 };
    const p = plan(save(paste([list('East', 'E', 2, [oasis(-200, 0), oasis(185, 0)]), list('West', 'W', 1, [oasis(-190, 0)])], [E, W])));
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].rows[0]).toMatchObject({ x: -200, fromDist: 11, toDist: 5 });
  });

  it('keeps ties and gains under 1 field where they are', () => {
    const P = { name: 'P', x: 0, y: 0 };
    const Q = { name: 'Q', x: 10, y: 0 };
    // (5|0) and (5|9) are ties, (6|9) gains 0.97; (6|7) gains 1.16 and (6|0) gains 2.
    const p = plan(save(paste([list('P', 'P oases', 5, [oasis(5, 0), oasis(6, 0), oasis(6, 7), oasis(6, 9), oasis(5, 9)]), list('Q', 'Q oases', 1, [oasis(12, 0)])], [P, Q])));
    expect(p.steps.flatMap((x) => x.rows.map((r) => `${r.x}|${r.y}`)).sort()).toEqual(['6|0', '6|7']);
  });

  it('gives a tie between two nearer villages to the first in village order', () => {
    const C1 = { name: 'C1', x: 7, y: 6 };
    const C2 = { name: 'C2', x: 9, y: 2 };
    const H = { name: 'Far', x: 15, y: 15 };
    expect(Math.hypot(7, 6) === Math.hypot(9, 2)).toBe(false); // why distance2 is used
    expect(distance2(C1, { x: 0, y: 0 }, BOUNDS)).toBe(distance2(C2, { x: 0, y: 0 }, BOUNDS));
    for (const villages of [[H, C1, C2], [H, C2, C1]]) {
      const p = plan(save(paste([list('Far', 'F', 1, [oasis(0, 0)]), list('C1', 'c1', 1, [oasis(8, 8)]), list('C2', 'c2', 1, [oasis(10, 3)])], villages)));
      expect(p.steps.map((x) => x.to.name)).toEqual([villages[1].name]);
    }
  });

  it('leaves out moves where the nearer village is over 20 fields away too', () => {
    // (60|0): Alpha 60, Beta 30. A Tournament Square in Alpha could make it faster from there.
    const p = plan(save(paste([list('Alpha', 'A oases', 2, [oasis(1, 1), oasis(60, 0)]), list('Beta', 'B oases', 1, [oasis(31, 0)])])));
    expect(p.steps).toEqual([]);
    expect(p.leftFar).toBe(1);
  });

  it('leaves an oasis alone when a list holding it is unclear', () => {
    const s0 = save(paste([list('Alpha', 'A oases', 2, [oasis(1, 1), oasis(20, 0)]), list('Beta', 'B oases', 1, [oasis(31, 0)])]));
    // In a list never seen expanded (as a renamed list carries it).
    const never = save(paste([list('Alpha', 'A oases', 2), list('Alpha', 'A new', 4), list('Beta', 'B oases', 1)]), s0);
    const carried = { ...never, lists: never.lists.map((l) => (l.n === 'A new' ? { ...l, oases: '20|0' } : l)) };
    expect(plan(carried).count).toBe(0);
    const v = viewFromFarm(s0);
    expect(planMoves({ ...v, lists: [...v.lists, { village: null, vx: null, vy: null, name: 'Orphan', total: 1, known: 1, oases: [{ x: 20, y: 0 }] }] }, BOUNDS).count).toBe(0);
    expect(planMoves({ ...v, deactivated: [{ x: 20, y: 0 }] }, BOUNDS).count).toBe(0);
    // Rows of the "Abandoned farm lists" section added to a list (known > total).
    expect(planMoves({ ...v, lists: v.lists.map((l) => (l.name === 'A oases' ? { ...l, known: 3 } : l)) }, BOUNDS).count).toBe(0);
  });
});

describe('planMoves: copies in two villages', () => {
  const D: PastedVillage = { name: 'Delta', x: 0, y: 10 };

  it('a copy in a farther village gets an extra step to the list that holds it', () => {
    const s = save(paste([list('Alpha', 'A oases', 2, [oasis(1, 1), oasis(20, 0)]), list('Beta', 'B oases', 2, [oasis(31, 0), oasis(20, 0)])]));
    expect(rows(plan(s))).toEqual(['extra 20|0 Alpha:A oases->Beta:B oases']);
  });

  it('in two farther villages: the nearer holder moves, the other is an extra, moves first whatever the order', () => {
    const lists = [list('Alpha', 'A oases', 2, [oasis(1, 1), oasis(25, 0)]), list('Beta', 'B oases', 1, [oasis(31, 0)]), list('Delta', 'D oases', 2, [oasis(0, 11), oasis(25, 0)])];
    const want = ['move 25|0 Alpha:A oases->Beta:B oases', 'extra 25|0 Delta:D oases->Beta:B oases'];
    const s = save(paste(lists, [A, B, G, D]));
    expect(rows(plan(s))).toEqual(want);
    expect(rows(plan(save(paste(lists, [D, A, B, G]))))).toEqual(want);
    expect(plan(s).covered.has('25|0')).toBe(true);
  });

  it('tells the second list of a name apart in a paste on its own', () => {
    const p = paste([list('Alpha', 'Same', 1, [oasis(1, 1)]), list('Alpha', 'Same', 1, [oasis(20, 0)]), list('Beta', 'B oases', 1, [oasis(31, 0)])]);
    const pl = planMoves(keyedView(viewFromPaste(p)), BOUNDS);
    expect(pl.steps.map((x) => x.fromTwin)).toEqual([2]);
  });
});

describe('planMoves: destination lists', () => {
  const many = (n: number, x0: number) => Array.from({ length: n }, (_, i) => oasis(x0 + Math.floor(i / 10), (i % 10) - 5));
  const s = save(
    paste([
      list('Alpha', 'A oases', 3, [oasis(1, 1), oasis(20, 0), oasis(21, 1)]),
      list('Beta', 'Full', 100, many(100, 40)),
      list('Beta', 'Small', 13, [...many(12, 60), oasis(31, 0)]),
      list('Beta', 'Farms', 5, [farm('a'), farm('b'), farm('c'), farm('d'), farm('e')]),
      list('Beta', 'Empty', 0, []),
    ]),
  );
  const edit = (st: FarmState, name: string, patch: Partial<StoredList>) => ({ ...st, lists: st.lists.map((l) => (l.n === name ? { ...l, ...patch } : l)) });

  it('skips a full list and lists of villages', () => {
    const p = plan(s);
    expect(p.steps.map((x) => [x.toList?.name, x.after])).toEqual([['Small', 15]]);
  });

  it('spills into an empty list, and has no list when nothing has room', () => {
    const tight = edit(s, 'Small', { total: 99, known: 99 });
    expect(plan(tight).steps.map((x) => [x.toList?.name, x.rows.length])).toEqual([['Small', 1], ['Empty', 1]]);
    const none = edit({ ...tight, lists: tight.lists.filter((l) => l.n !== 'Empty') }, 'Small', { total: 100, known: 100 });
    expect(plan(none).steps.map((x) => x.toList)).toEqual([null]);
  });

  it('takes the roomiest list, or the player’s pick', () => {
    const two = edit(s, 'Full', { total: 10, known: 10 });
    expect(plan(two).steps[0].toList?.name).toBe('Full');
    expect(plan(two).steps[0].options).toHaveLength(2);
    const small = two.lists.find((l) => l.n === 'Small')!.lk;
    expect(plan(two, { '30|0': small }).steps[0].toList?.name).toBe('Small');
  });

  it('counts open ticks as used room, but not twice after a collapsed paste counted them', () => {
    const ticks = [90, 91].map((x) => ({ x, y: 90, vx: 30, vy: 0, by: 'kv', at: 1 }));
    expect(plan({ ...s, marks: ticks }).steps[0].after).toBe(17);
    expect(plan(edit({ ...s, marks: ticks }, 'Small', { total: 15 })).steps[0].after).toBe(17);
  });
});

describe('planMoves: order and stale lists', () => {
  const s = save(
    paste([
      list('Alpha', 'Zed', 2, [oasis(22, 0), oasis(1, 1)]),
      list('Alpha', 'Same', 1, [oasis(1, 2)]),
      list('Alpha', 'Same', 2, [oasis(21, 1), oasis(20, 0)]),
      list('Beta', 'B oases', 1, [oasis(31, 0)]),
    ]),
  );

  it('orders steps by list name and twin, rows by the game’s Dist.', () => {
    expect(plan(s).steps.map((x) => [x.from.name, x.fromTwin, x.rows.map((r) => r.fromDist)])).toEqual([
      ['Same', 2, [20, 21]],
      ['Zed', 1, [22]],
    ]);
  });

  it('marks a step stale when its list shrank while collapsed', () => {
    const shrunk = save(paste([list('Alpha', 'Zed', 1), list('Alpha', 'Same', 1), list('Alpha', 'Same', 2), list('Beta', 'B oases', 1)]), s);
    expect(plan(shrunk).steps.find((x) => x.from.name === 'Zed')?.stale).toBe(true);
  });

  it('uses only lists copied in full when there is no saved state', () => {
    const p = paste([list('Alpha', 'A oases', 2, [oasis(1, 1), oasis(20, 0)]), list('Alpha', 'A more', 5, [oasis(21, 1)]), list('Beta', 'B oases', 1, [oasis(31, 0)])]);
    expect(planMoves(keyedView(viewFromPaste(p)), BOUNDS).steps.flatMap((x) => x.rows.map((r) => `${r.x}|${r.y}`))).toEqual(['20|0']);
  });
});

// ---- the check after a move ----------------------------------------------------------------------------

// Alpha's list holds three oases of its own and two nearer to Beta: the plan moves (20|0) and (21|1) to Beta.
// Charlie farms oases too, but is farther from both than Alpha. Gamma has a list of villages only.
const SAVED_LISTS = [
  list('Alpha', 'A oases', 5, [oasis(1, 1), oasis(2, 2), oasis(3, 3), oasis(20, 0), oasis(21, 1)]),
  list('Beta', 'B oases', 2, [oasis(31, 0), oasis(32, 0)]),
  list('Charlie', 'C oases', 1, [oasis(0, 31)]),
  list('Gamma', 'G farms', 1, [farm('v')]),
];
const savedLists = () => SAVED_LISTS.map((l) => ({ ...l }));
const SAVED = save(paste(savedLists()));
const own3 = [oasis(1, 1), oasis(2, 2), oasis(3, 3)];
const B2 = [oasis(31, 0), oasis(32, 0)];
const moved2 = [oasis(20, 0), oasis(21, 1)];
/** The Farm List page after a move: Alpha's list as given; Beta, Charlie and Gamma collapsed unless given. */
const after = (a: [number, PastedTarget[]?], b: [number, PastedTarget[]?] = [2], c: [number, PastedTarget[]?] = [1], g: [number, PastedTarget[]?] = [1]) =>
  paste([list('Alpha', 'A oases', a[0], a[1]), list('Beta', 'B oases', b[0], b[1]), list('Charlie', 'C oases', c[0], c[1]), list('Gamma', 'G farms', g[0], g[1])]);

/** A paste checked the way the page does it: plan from the saved lists, merge, compare. */
function check(saved: FarmState, p: ParsedPaste, prev: Alarm[] = []) {
  const before = viewFromFarm(saved, p.deactivated);
  const pl = planMoves(before, BOUNDS, { skip: new Set(prev.filter((a) => a.level !== 'quiet').map((a) => a.key)) });
  const r = mergePaste(saved, p, 'kv', 2000);
  if (!r.ok) throw new Error(r.error);
  const result = checkMoves(before, keyedView(viewFromPaste(p)), BOUNDS, pl, prev);
  return { plan: pl, result, next: r.next, open: [...result.alarms, ...result.quiet] };
}
const keys = (xs: { x: number; y: number }[]) => xs.map((o) => `${o.x}|${o.y}`).sort();
const alarmKeys = (as: Alarm[]) => as.map((a) => a.key).sort();
const brief = (as: Alarm[]) => as.map((a) => `${a.key} ${a.level} ${a.why}${a.at ? ` @${a.at.village}` : ''}`).sort();
const WORLD: OasisWorld = {
  v: 1,
  world: 't',
  serverUrl: 'https://t.travian.com',
  scannedAt: 1,
  bounds: BOUNDS,
  bonuses: ['25% Iron'],
  oases: [[1, 1], [2, 2], [3, 3], [20, 0], [21, 1], [31, 0], [32, 0], [0, 31], [40, 40]].map(([x, y]): OasisRow => [x, y, 0, 0, '']),
};
const ALL = new Set<OasisGroup>(['easy', 'medium', 'hard']);
const card2 = (s: FarmState) => analyze(WORLD, viewFromFarm(s), { radius: 20, groups: ALL, allVillages: false });

describe('checkMoves: a step done right', () => {
  it('plans one step of two oases', () => {
    expect(rows(plan(SAVED))).toEqual(['move 20|0 Alpha:A oases->Beta:B oases', 'move 21|1 Alpha:A oases->Beta:B oases']);
  });

  it('is done when the paste shows them in the new list', () => {
    const { result, next } = check(SAVED, after([3, own3], [4, [...B2, ...moved2]]));
    expect(result.done).toEqual([{ key: plan(SAVED).steps[0].key, kind: 'move', from: { village: 'Alpha', list: 'A oases', twin: 1 }, to: { village: 'Beta', list: 'B oases', twin: 1 }, moved: 2, left: 0 }]);
    expect(result.alarms).toEqual([]);
    expect(result.quiet).toEqual([]);
    expect(plan(next).steps).toEqual([]);
    expect(card2(next).warnings.grownLists).toEqual([]);
  });

  it('is not confirmed while the new list is collapsed (even when it grew by as many); expanding it confirms', () => {
    const first = check(SAVED, after([3, own3], [4]));
    expect(first.result.done).toEqual([]);
    expect(brief(first.result.alarms)).toEqual(['20|0 amber unconfirmed', '21|1 amber unconfirmed']);
    expect(first.result.alarms[0].grown.map((g) => [g.spot.village, g.by, g.farther])).toEqual([['Beta', 2, false]]);
    expect(first.result.alarms[0].fix).toEqual({ village: 'Beta', list: 'B oases', twin: 1 });
    const then = check(first.next, after([3, own3], [4, [...B2, ...moved2]]), first.open);
    expect(then.result.alarms).toEqual([]);
    expect(then.result.confirmed.map((c) => [c.at.village, c.at.list, keys(c.rows)])).toEqual([['Beta', 'B oases', ['20|0', '21|1']]]);
  });

  it('is done when another list of the same village shows them', () => {
    const s = save(paste([...savedLists(), list('Beta', 'B more', 1, [oasis(33, 0)])]));
    const { result } = check(s, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Beta', 'B more', 3, [oasis(33, 0), ...moved2]), list('Charlie', 'C oases', 1), list('Gamma', 'G farms', 1)]));
    expect(result.done.map((d) => d.moved)).toEqual([2]);
    expect(result.alarms).toEqual([]);
  });

  it('says nothing moved yet when the lists are as before', () => {
    const { result } = check(SAVED, after([5, [...own3, ...moved2]]));
    expect(result).toMatchObject({ done: [], alarms: [], quiet: [], notes: [], waiting: 2 });
  });

  it('copied instead of moved: nothing done, nothing alarming (both villages raid them)', () => {
    const { result } = check(SAVED, after([5, [...own3, ...moved2]], [4, [...B2, ...moved2]]));
    expect(result).toMatchObject({ done: [], alarms: [], waiting: 2 });
  });

  it('can’t tell which oases moved when the old list was copied collapsed', () => {
    const { result } = check(SAVED, after([3], [4]));
    expect(result.done).toEqual([]);
    expect(result.alarms).toEqual([]);
    expect(result.unchecked).toEqual([{ from: { village: 'Alpha', list: 'A oases', twin: 1 }, drop: 2 }]);
  });

  it('works on two pastes without saved lists, every list expanded', () => {
    const p1 = after([5, [...own3, ...moved2]], [2, B2], [1, [oasis(0, 31)]], [1, [farm('v')]]);
    const p2 = after([3, own3], [4, [...B2, ...moved2]], [1, [oasis(0, 31)]], [1, [farm('v')]]);
    const before = keyedView(viewFromPaste(p1));
    const r = checkMoves(before, keyedView(viewFromPaste(p2)), BOUNDS, planMoves(before, BOUNDS));
    expect(r.done.map((d) => d.moved)).toEqual([2]);
    expect(r.alarms).toEqual([]);
  });

  it('an extra copy deleted as its step says', () => {
    const s = save(after([5, [...own3, ...moved2]], [3, [...B2, oasis(20, 0)]], [1, [oasis(0, 31)]], [1, [farm('v')]]));
    expect(rows(plan(s))).toEqual(['move 21|1 Alpha:A oases->Beta:B oases', 'extra 20|0 Alpha:A oases->Beta:B oases']);
    // Beta's list shown with its copy: done.
    const shown = check(s, after([4, [...own3, oasis(21, 1)]], [3, [...B2, oasis(20, 0)]]));
    expect(shown.result.done.map((d) => [d.kind, d.moved])).toEqual([['extra', 1]]);
    expect(shown.result.alarms).toEqual([]);
    // Beta's list collapsed: is the copy really there? Not trusted until shown.
    const collapsed = check(s, after([4, [...own3, oasis(21, 1)]], [3]));
    expect(collapsed.result.done).toEqual([]);
    expect(collapsed.result.alarms.map((a) => [a.key, a.level, a.why, a.holder?.village])).toEqual([['20|0', 'amber', 'check', 'Beta']]);
  });
});

describe('checkMoves: mistakes', () => {
  it('the wrong list, shown: red, with the fix', () => {
    const { result } = check(SAVED, after([3, own3], [2], [3, [oasis(0, 31), ...moved2]]));
    expect(result.done).toEqual([]);
    expect(result.alarms.map((a) => [a.key, a.level, a.why, a.at?.village, a.fix.village, a.fix.list, a.wasDist, a.nowDist])).toEqual([
      ['20|0', 'red', 'farther', 'Charlie', 'Beta', 'B oases', 20, 36.1],
      ['21|1', 'red', 'farther', 'Charlie', 'Beta', 'B oases', 21, 35.8],
    ]);
  });

  it('the wrong list, collapsed, with the new list expanded: red “missing”, with the list that grew', () => {
    const { result } = check(SAVED, after([3, own3], [2, B2], [3]));
    expect(brief(result.alarms)).toEqual(['20|0 red missing', '21|1 red missing']);
    expect(result.alarms[0].grown.map((g) => [g.spot.village, g.by, g.farther])).toEqual([['Charlie', 2, true]]);
  });

  it('the wrong list, everything collapsed: amber until shown, with the farther list that grew', () => {
    const first = check(SAVED, after([3, own3], [2], [3]));
    expect(brief(first.result.alarms)).toEqual(['20|0 amber unconfirmed', '21|1 amber unconfirmed']);
    expect(first.result.alarms[0].grown.map((g) => [g.spot.village, g.farther])).toEqual([['Charlie', true]]);
    // Beta expanded (as the step asks): not there, so red.
    const beta = check(first.next, after([3, own3], [2, B2], [3]), first.open);
    expect(brief(beta.result.alarms)).toEqual(['20|0 red missing', '21|1 red missing']);
    // Charlie expanded: there they are, farther away.
    const charlie = check(beta.next, after([3, own3], [2], [3, [oasis(0, 31), ...moved2]]), beta.open);
    expect(brief(charlie.result.alarms)).toEqual(['20|0 red farther @Charlie', '21|1 red farther @Charlie']);
  });

  it('nothing ticked, so the whole list moved, new list expanded: the step is done, the rest are red', () => {
    const { result } = check(SAVED, after([0, []], [7, [...B2, ...own3, ...moved2]]));
    expect(result.done.map((d) => d.moved)).toEqual([2]);
    expect(result.alarms.map((a) => [a.key, a.why, a.at?.village, a.fix.village, a.fix.list])).toEqual([
      ['1|1', 'farther', 'Beta', 'Alpha', 'A oases'],
      ['2|2', 'farther', 'Beta', 'Alpha', 'A oases'],
      ['3|3', 'farther', 'Beta', 'Alpha', 'A oases'],
    ]);
  });

  it('nothing ticked, new list collapsed: the step unconfirmed, the rest “along”', () => {
    const { result } = check(SAVED, after([0, []], [7]));
    expect(brief(result.alarms)).toEqual(['1|1 amber along', '20|0 amber unconfirmed', '21|1 amber unconfirmed', '2|2 amber along', '3|3 amber along']);
    expect(result.alarms.find((a) => a.key === '1|1')!.grown.map((g) => [g.spot.village, g.by, g.farther])).toEqual([['Beta', 5, true]]);
  });

  it('a wrong row ticked: the right one done, the wrong one red', () => {
    const { result } = check(SAVED, after([3, [oasis(2, 2), oasis(3, 3), oasis(21, 1)]], [4, [...B2, oasis(20, 0), oasis(1, 1)]]));
    expect(result.done.map((d) => [d.moved, d.left])).toEqual([[1, 1]]);
    expect(result.waiting).toBe(1);
    expect(brief(result.alarms)).toEqual(['1|1 red farther @Beta']);
  });

  it('a step moved to a list nobody can find: amber, and red once it shows up farther away', () => {
    const first = check(SAVED, after([3, own3]));
    expect(brief(first.result.alarms)).toEqual(['20|0 amber unconfirmed', '21|1 amber unconfirmed']);
    expect(first.result.alarms[0].grown).toEqual([]);
    const later = check(first.next, after([3, own3], [2], [3, [oasis(0, 31), ...moved2]]), first.open);
    expect(later.result.alarms.map((a) => [a.key, a.why, a.at?.village, a.fix.village])).toEqual([
      ['20|0', 'farther', 'Charlie', 'Beta'],
      ['21|1', 'farther', 'Charlie', 'Beta'],
    ]);
  });

  it('a step moved to a nearer village than before, but not the planned one: a note, no alarm', () => {
    // Delta is nearer to the two oases than Alpha, but farther than Beta.
    const D: PastedVillage = { name: 'Delta', x: 8, y: -8 };
    const s = save(paste([...savedLists(), list('Delta', 'D oases', 1, [oasis(8, -12)])], [A, B, C, G, D]));
    expect(rows(plan(s))).toEqual(['move 20|0 Alpha:A oases->Beta:B oases', 'move 21|1 Alpha:A oases->Beta:B oases']);
    const p = paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 1), list('Gamma', 'G farms', 1), list('Delta', 'D oases', 3, [oasis(8, -12), ...moved2])], [A, B, C, G, D]);
    const { result } = check(s, p);
    expect(result.alarms).toEqual([]);
    expect(result.notes.map((n) => [n.kind, n.at?.village, keys(n.rows)])).toEqual([['went', 'Delta', ['20|0', '21|1']]]);
  });
});

describe('checkMoves: not alarms', () => {
  it('a deleted oasis (watched quietly, as its list has a step)', () => {
    const { result } = check(SAVED, after([4, [oasis(1, 1), oasis(2, 2), ...moved2]]));
    expect(result).toMatchObject({ alarms: [], notes: [], waiting: 2 });
    expect(brief(result.quiet)).toEqual(['3|3 quiet watch']);
  });

  it('a deleted oasis from a list with no step: nothing shown (watched quietly)', () => {
    const { result } = check(SAVED, after([5, [...own3, ...moved2]], [1, [oasis(31, 0)]]));
    expect(result.alarms).toEqual([]);
    expect(brief(result.quiet)).toEqual(['32|0 quiet watch']);
  });

  it('a copy removed while a farther village still raids it: fine once that list shows it', () => {
    const s = save(after([5, [...own3, ...moved2]], [2, B2], [2, [oasis(0, 31), oasis(3, 3)]], [1, [farm('v')]]));
    const shown = check(s, after([4, [oasis(1, 1), oasis(2, 2), ...moved2]], [2], [2, [oasis(0, 31), oasis(3, 3)]]));
    expect(shown.result.alarms).toEqual([]);
    // Charlie collapsed: its saved copy isn't trusted, so ask.
    const collapsed = check(s, after([4, [oasis(1, 1), oasis(2, 2), ...moved2]]));
    expect(collapsed.result.alarms.map((a) => [a.key, a.level, a.why, a.holder?.village])).toEqual([['3|3', 'amber', 'check', 'Charlie']]);
    // Shown there later: confirmed.
    const later = check(collapsed.next, after([4, [oasis(1, 1), oasis(2, 2), ...moved2]], [2], [2, [oasis(0, 31), oasis(3, 3)]]), collapsed.open);
    expect(later.result.alarms).toEqual([]);
  });

  it('a routine paste after a deletion: nothing shown while no farther list grew; amber “along” when one did (it could be a wrong row)', () => {
    const left4 = [oasis(1, 1), oasis(2, 2), ...moved2];
    const plain = check(SAVED, after([4, left4]));
    expect(plain.result.alarms).toEqual([]);
    expect(plain.result.waiting).toBe(2);
    for (const grown of [after([4, left4], [3]), after([4, left4], [2], [2])]) {
      const { result } = check(SAVED, grown);
      expect(brief(result.alarms)).toEqual(['3|3 amber along']);
      expect(result.waiting).toBe(2);
    }
  });

  it('a village that raided it before still does: no alarm, and the note says so', () => {
    const D: PastedVillage = { name: 'Delta', x: 20, y: 30 };
    const vs = [A, B, C, D];
    const s = save(paste([list('Alpha', 'A oases', 4, [...own3, oasis(20, 0)]), list('Beta', 'B oases', 2, B2), list('Charlie', 'C oases', 1, [oasis(0, 31)]), list('Delta', 'D oases', 2, [oasis(20, 31), oasis(20, 0)])], vs));
    const { result } = check(s, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 2, [oasis(0, 31), oasis(20, 0)]), list('Delta', 'D oases', 2, [oasis(20, 31), oasis(20, 0)])], vs));
    expect(result.alarms).toEqual([]);
    expect(result.notes.map((n) => [n.kind, n.at?.village, keys(n.rows)])).toEqual([['kept', 'Delta', ['20|0']]]);
    // Delta collapsed: shown farther (Charlie), and Delta's copy isn't shown, so ask (amber: Delta didn't shrink).
    const collapsed = check(s, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 2, [oasis(0, 31), oasis(20, 0)]), list('Delta', 'D oases', 2)], vs));
    expect(collapsed.result.alarms.map((a) => [a.key, a.level, a.why, a.at?.village, a.holder?.village])).toEqual([['20|0', 'amber', 'twice', 'Charlie', 'Delta']]);
  });
});

describe('checkMoves: alarms stay until a paste shows them as near as before', () => {
  it('a red alarm stays on pastes without the fix, and goes when the planned list shows them', () => {
    const wrong = check(SAVED, after([3, own3], [2], [3, [oasis(0, 31), ...moved2]]));
    const again = check(wrong.next, after([3, own3], [2], [3]), wrong.open);
    expect(brief(again.result.alarms)).toEqual(['20|0 red farther @Charlie', '21|1 red farther @Charlie']);
    // Moved to Beta, Beta collapsed: Charlie is shown without them, so they're "lost" until Beta shows them.
    const moved = check(again.next, after([3, own3], [4], [1, [oasis(0, 31)]]), again.open);
    expect(brief(moved.result.alarms)).toEqual(['20|0 amber lost @Charlie', '21|1 amber lost @Charlie']);
    const shown = check(moved.next, after([3, own3], [4, [...B2, ...moved2]]), moved.open);
    expect(shown.result.alarms).toEqual([]);
    expect(shown.result.confirmed.map((c) => [c.at.village, keys(c.rows)])).toEqual([['Beta', ['20|0', '21|1']]]);
  });

  it('the old list copied collapsed (shrank), the new one shown with them: red now, and it stays', () => {
    const first = check(SAVED, after([3], [2], [3, [oasis(0, 31), ...moved2]]));
    expect(first.result.alarms.map((a) => [a.key, a.level, a.why, a.at?.village, a.holder?.village, a.fix.village])).toEqual([
      ['20|0', 'red', 'twice', 'Charlie', 'Alpha', 'Beta'],
      ['21|1', 'red', 'twice', 'Charlie', 'Alpha', 'Beta'],
    ]);
    // Nothing changed, both collapsed: the saved copy in Alpha's list doesn't clear it.
    const same = check(first.next, after([3], [2], [3]), first.open);
    expect(alarmKeys(same.result.alarms)).toEqual(['20|0', '21|1']);
    // Then the old list expanded without them: moved for sure, raided from Charlie.
    const then = check(same.next, after([3, own3], [2], [3]), same.open);
    expect(brief(then.result.alarms)).toEqual(['20|0 red farther @Charlie', '21|1 red farther @Charlie']);
    expect(then.result.notes).toEqual([]);
  });

  it('shown farther while the old list isn’t shown and didn’t shrink (a teammate’s paste): amber, red once the old list shows them gone', () => {
    // P1 all collapsed (the old list shrank: "expand it"), then a paste with only Charlie expanded.
    const p1 = check(SAVED, after([3], [2], [3]));
    expect(p1.result.unchecked.map((u) => u.drop)).toEqual([2]);
    const p2 = check(p1.next, after([3], [2], [3, [oasis(0, 31), ...moved2]]), p1.open);
    expect(brief(p2.result.alarms)).toEqual(['20|0 amber twice @Charlie', '21|1 amber twice @Charlie']);
    const p3 = check(p2.next, after([3, own3], [2, B2], [3]), p2.open);
    expect(brief(p3.result.alarms)).toEqual(['20|0 red farther @Charlie', '21|1 red farther @Charlie']);
  });

  it('a list renamed while collapsed: its saved oases aren’t shown, so nothing is confirmed by them', () => {
    const wrong = check(SAVED, after([3], [2], [3, [oasis(0, 31), ...moved2]]));
    const renamed = check(wrong.next, paste([list('Alpha', 'A near', 3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 3), list('Gamma', 'G farms', 1)]), wrong.open);
    expect(renamed.result.confirmed).toEqual([]);
    // The two alarms stay; Alpha's own oases are asked about in the renamed list.
    expect(brief(renamed.result.alarms.filter((a) => a.key === '20|0' || a.key === '21|1')).map((b) => b.split(' ')[1])).toEqual(['red', 'red']);
    expect(renamed.result.alarms.filter((a) => a.why === 'check').map((a) => [a.key, a.level, a.holder?.list])).toEqual([
      ['1|1', 'amber', 'A near'],
      ['2|2', 'amber', 'A near'],
      ['3|3', 'amber', 'A near'],
    ]);
  });

  it('a village’s only list deleted after the whole list moved to a farther list: red', () => {
    const s = save(paste([list('Alpha', 'A oases', 5, [...own3, ...moved2]), list('Beta', 'B oases', 2, B2), list('Charlie', 'C oases', 1, [oasis(0, 31)])]));
    const { result } = check(s, paste([list('Beta', 'B oases', 2), list('Charlie', 'C oases', 6, [oasis(0, 31), ...own3, ...moved2])]));
    expect(alarmKeys(result.alarms)).toEqual(['1|1', '20|0', '21|1', '2|2', '3|3']);
    expect(result.alarms.every((a) => a.level === 'red' && a.why === 'farther')).toBe(true);
  });

  it('an amber “missing” stays amber while a near list that grew isn’t shown, and turns red once it is shown without them', () => {
    const fifty = [oasis(33, 0), ...Array.from({ length: 49 }, (_, i) => farm(`f${i}`))];
    const s = save(paste([...savedLists(), list('Beta', 'B more', 50, fifty)]));
    const lists = (more: PastedList) => paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2, B2), more, list('Charlie', 'C oases', 3), list('Gamma', 'G farms', 1)]);
    const p1 = check(s, lists(list('Beta', 'B more', 52)));
    expect(brief(p1.result.alarms)).toEqual(['20|0 amber missing', '21|1 amber missing']);
    // Same lists again: still amber (B more still not shown).
    const p2 = check(p1.next, lists(list('Beta', 'B more', 52)), p1.open);
    expect(brief(p2.result.alarms)).toEqual(['20|0 amber missing', '21|1 amber missing']);
    // B more shown in full without them: red.
    const p3 = check(p2.next, lists(list('Beta', 'B more', 52, [...fifty, farm('g1'), farm('g2')])), p2.open);
    expect(brief(p3.result.alarms)).toEqual(['20|0 red missing', '21|1 red missing']);
  });

  it('deleting the first of two lists with the same name: no false alarm from the shifted keys', () => {
    const s = save(paste([list('Alpha', 'Oases', 6, ['a', 'b', 'c', 'd', 'e', 'f'].map(farm)), list('Alpha', 'Oases', 4, [oasis(1, 1), oasis(2, 2), ...moved2]), list('Beta', 'B oases', 2, B2), list('Charlie', 'C oases', 1, [oasis(0, 31)])]));
    const { result } = check(s, paste([list('Alpha', 'Oases', 4), list('Beta', 'B oases', 2, B2), list('Charlie', 'C oases', 1)]));
    expect(result.alarms).toEqual([]);
  });

  it('an alarm stays when the oases move on to a list still farther than before', () => {
    const D: PastedVillage = { name: 'Delta', x: 20, y: 25 };
    const vs = [A, B, C, G, D];
    const s0 = save(paste([...savedLists(), list('Delta', 'D oases', 1, [oasis(20, 26)])], vs));
    const wrong = check(s0, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 3, [oasis(0, 31), ...moved2]), list('Gamma', 'G farms', 1), list('Delta', 'D oases', 1)], vs));
    // Moved from Charlie to Delta (collapsed): Delta is farther than Alpha was, so still red.
    const collapsed = check(wrong.next, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 1, [oasis(0, 31)]), list('Gamma', 'G farms', 1), list('Delta', 'D oases', 3)], vs), wrong.open);
    expect(brief(collapsed.result.alarms)).toEqual(['20|0 red lost @Charlie', '21|1 red lost @Charlie']);
    const shown = check(collapsed.next, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 1), list('Gamma', 'G farms', 1), list('Delta', 'D oases', 3, [oasis(20, 26), ...moved2])], vs), collapsed.open);
    expect(shown.result.alarms.map((a) => [a.key, a.why, a.at?.village, a.wasDist, a.fix.village])).toEqual([
      ['20|0', 'farther', 'Delta', 20, 'Beta'],
      ['21|1', 'farther', 'Delta', 21, 'Beta'],
    ]);
  });

  it('an alarmed oasis gets no step of its own (card 3 must not contradict the alarm)', () => {
    // Whole list into Beta with Alpha's only oasis list emptied: the plan would send (1|1) on to Charlie.
    const wrong = check(SAVED, after([0, []], [7, [...B2, ...own3, ...moved2]]));
    const skip = new Set(wrong.result.alarms.map((a) => a.key));
    expect(planMoves(viewFromFarm(wrong.next), BOUNDS, { skip }).steps.flatMap((s) => s.rows.map((r) => `${r.x}|${r.y}`))).toEqual([]);
  });
});

// ---- regressions from the two reviews ------------------------------------------------------------------

/** Alpha has two step lists into Beta: 'A more' (22|0),(22|1) and 'A oases' (20|0),(21|1)[,(20|1)]. */
const twoSteps = (third: boolean) =>
  save(
    paste([
      list('Alpha', 'A oases', third ? 6 : 5, [...own3, ...moved2, ...(third ? [oasis(20, 1)] : [])]),
      list('Alpha', 'A more', 3, [oasis(1, 2), oasis(22, 0), oasis(22, 1)]),
      list('Beta', 'B oases', 2, B2),
      list('Charlie', 'C oases', 1, [oasis(0, 31)]),
      list('Gamma', 'G farms', 1, [farm('v')]),
    ]),
  );

describe('review: the plan', () => {
  it('one source list, two destination villages: each oasis goes to its own nearer village', () => {
    const D: PastedVillage = { name: 'Delta', x: 0, y: -30 };
    const s = save(paste([list('Alpha', 'A oases', 3, [oasis(1, 1), oasis(20, 0), oasis(0, -20)]), list('Beta', 'B oases', 1, [oasis(31, 0)]), list('Delta', 'D oases', 1, [oasis(0, -31)])], [A, B, C, G, D]));
    const p = plan(s);
    expect(rows(p)).toEqual(['move 20|0 Alpha:A oases->Beta:B oases', 'move 0|-20 Alpha:A oases->Delta:D oases']);
    for (const st of p.steps)
      for (const r of st.rows) {
        expect(distance2(st.to, r, BOUNDS)).toBeLessThan(distance2(st.fromVillage, r, BOUNDS));
        expect(distance2(st.to, r, BOUNDS)).toBeLessThanOrEqual(400);
      }
  });

  it('a nearer village 21 fields away is left out; 20 fields away is a move', () => {
    const at21 = plan(save(paste([list('Alpha', 'A oases', 2, [oasis(1, 1), oasis(51, 0)]), list('Beta', 'B oases', 1, [oasis(31, 0)])])));
    expect(at21.steps).toEqual([]);
    expect(at21.leftFar).toBe(1);
    const at20 = plan(save(paste([list('Alpha', 'A oases', 2, [oasis(1, 1), oasis(50, 0)]), list('Beta', 'B oases', 1, [oasis(31, 0)])])));
    expect(rows(at20)).toEqual(['move 50|0 Alpha:A oases->Beta:B oases']);
  });
});

describe('review: counts never give a ✓', () => {
  it('the planned village grew too (a teammate added a target): amber, with both lists named', () => {
    const s = save(paste([list('Alpha', 'A oases', 4, [...own3, oasis(20, 0)]), list('Beta', 'B mixed', 3, [...B2, farm('f')]), list('Charlie', 'C oases', 1, [oasis(0, 31)])]));
    const { result } = check(s, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B mixed', 4), list('Charlie', 'C oases', 2)]));
    expect(result.done).toEqual([]);
    expect(brief(result.alarms)).toEqual(['20|0 amber unconfirmed']);
    expect(result.alarms[0].grown.map((g) => [g.spot.village, g.farther])).toEqual([
      ['Beta', false],
      ['Charlie', true],
    ]);
  });

  it('two steps into one village, one sent to a farther list: nothing done until shown, then exactly right', () => {
    const s = twoSteps(true);
    const p = paste([list('Alpha', 'A oases', 3, own3), list('Alpha', 'A more', 1, [oasis(1, 2)]), list('Beta', 'B oases', 5), list('Charlie', 'C oases', 3), list('Gamma', 'G farms', 1)]);
    const first = check(s, p);
    expect(first.result.done).toEqual([]);
    expect(alarmKeys(first.result.alarms)).toEqual(['20|0', '20|1', '21|1', '22|0', '22|1']);
    const shown = check(first.next, paste([list('Alpha', 'A oases', 3, own3), list('Alpha', 'A more', 1, [oasis(1, 2)]), list('Beta', 'B oases', 5, [...B2, ...moved2, oasis(20, 1)]), list('Charlie', 'C oases', 3, [oasis(0, 31), oasis(22, 0), oasis(22, 1)]), list('Gamma', 'G farms', 1)]), first.open);
    expect(brief(shown.result.alarms)).toEqual(['22|0 red farther @Charlie', '22|1 red farther @Charlie']);
    expect(shown.result.confirmed.map((c) => keys(c.rows))).toEqual([['20|0', '20|1', '21|1']]);
  });

  it('two steps into one village, Beta expanded: the wrong step is red at once', () => {
    const s = twoSteps(false);
    const { result } = check(s, paste([list('Alpha', 'A oases', 3, own3), list('Alpha', 'A more', 1, [oasis(1, 2)]), list('Beta', 'B oases', 4, [...B2, ...moved2]), list('Charlie', 'C oases', 3), list('Gamma', 'G farms', 1)]));
    expect(result.done.map((d) => [d.from.list, d.moved])).toEqual([['A oases', 2]]);
    expect(brief(result.alarms)).toEqual(['22|0 red missing', '22|1 red missing']);
  });

  it('a list of villages took them (farther): named in the hints, red once Beta shows they aren’t there', () => {
    const { result, next, open } = check(SAVED, after([3, own3], [2], [1], [3]));
    expect(brief(result.alarms)).toEqual(['20|0 amber unconfirmed', '21|1 amber unconfirmed']);
    expect(result.alarms[0].grown.map((g) => [g.spot.village, g.spot.list, g.farther])).toEqual([['Gamma', 'G farms', true]]);
    expect(brief(check(next, after([3, own3], [2, B2], [1], [3]), open).result.alarms)).toEqual(['20|0 red missing', '21|1 red missing']);
  });

  it('the whole list into a farther list of villages: every oasis is flagged', () => {
    const { result } = check(SAVED, after([0, []], [2], [1], [6]));
    expect(alarmKeys(result.alarms)).toEqual(['1|1', '20|0', '21|1', '2|2', '3|3']);
  });

  it('the planned list shown in full without them, while a farther list grew: red', () => {
    const { result } = check(SAVED, after([3, own3], [4, [...B2, farm('a'), farm('b')]], [3]));
    expect(brief(result.alarms)).toEqual(['20|0 red missing', '21|1 red missing']);
  });

  it('the planned list shown without them, but another list of that village grew: amber (maybe there)', () => {
    // 'B more' is fuller, so the plan picks 'B oases'.
    const fifty = [oasis(33, 0), ...Array.from({ length: 49 }, (_, i) => farm(`f${i}`))];
    const s = save(paste([...savedLists(), list('Beta', 'B more', 50, fifty)]));
    expect(plan(s).steps[0].toList?.name).toBe('B oases');
    const { result } = check(s, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2, B2), list('Beta', 'B more', 52), list('Charlie', 'C oases', 1), list('Gamma', 'G farms', 1)]));
    expect(brief(result.alarms)).toEqual(['20|0 amber missing', '21|1 amber missing']);
  });

  it('only a wrong row moved (no step row), new list collapsed: amber, red once it shows up farther away', () => {
    const first = check(SAVED, after([4, [oasis(2, 2), oasis(3, 3), ...moved2]], [3]));
    expect(brief(first.result.alarms)).toEqual(['1|1 amber along']);
    const later = check(first.next, after([4, [oasis(2, 2), oasis(3, 3), ...moved2]], [3, [...B2, oasis(1, 1)]]), first.open);
    expect(brief(later.result.alarms)).toEqual(['1|1 red farther @Beta']);
  });

  it('a “maybe” list expanded without them doesn’t clear the alarm', () => {
    const D: PastedVillage = { name: 'Delta', x: 20, y: 40 };
    const vs = [A, B, C, G, D];
    const s0 = save(paste([...savedLists(), list('Delta', 'D oases', 1, [oasis(20, 41)])], vs));
    // Went to Delta (collapsed, +2) while Charlie also grew by 2.
    const first = check(s0, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 3), list('Gamma', 'G farms', 1), list('Delta', 'D oases', 3)], vs));
    expect(first.result.alarms[0].grown.map((g) => g.spot.village).sort()).toEqual(['Charlie', 'Delta']);
    // Only Charlie expanded (without them): still open.
    const charlie = check(first.next, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 3, [oasis(0, 31), farm('x'), farm('y')]), list('Gamma', 'G farms', 1), list('Delta', 'D oases', 3)], vs), first.open);
    expect(alarmKeys(charlie.result.alarms)).toEqual(['20|0', '21|1']);
  });

  it('raided by two villages before, now by one between them: measured from the nearer one, fixed to the step’s list', () => {
    const D: PastedVillage = { name: 'Delta', x: 20, y: 30 };
    const E: PastedVillage = { name: 'Echo', x: 20, y: -25 };
    const vs = [D, A, B, E];
    const s = save(paste([list('Delta', 'D oases', 2, [oasis(20, 31), oasis(20, 0)]), list('Alpha', 'A oases', 4, [...own3, oasis(20, 0)]), list('Beta', 'B oases', 2, B2), list('Echo', 'E oases', 1, [oasis(20, -26)])], vs));
    expect(rows(plan(s))).toEqual(['move 20|0 Alpha:A oases->Beta:B oases', 'extra 20|0 Delta:D oases->Beta:B oases']);
    const { result } = check(s, paste([list('Delta', 'D oases', 1, [oasis(20, 31)]), list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Echo', 'E oases', 2, [oasis(20, -26), oasis(20, 0)])], vs));
    expect(result.alarms.map((a) => [a.key, a.wasDist, a.nowDist, a.at?.village, a.from.village, a.fix.village])).toEqual([['20|0', 20, 25, 'Echo', 'Alpha', 'Beta']]);
  });

  it('the old list moved whole into a farther list, then deleted', () => {
    const s = save(paste([...savedLists(), list('Alpha', 'A farms', 1, [farm('x')])]));
    const { result } = check(s, paste([list('Alpha', 'A farms', 1), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 6, [oasis(0, 31), ...own3, ...moved2]), list('Gamma', 'G farms', 1)]));
    expect(alarmKeys(result.alarms)).toEqual(['1|1', '20|0', '21|1', '2|2', '3|3']);
  });

  it('a red alarm whose list is shown without it, nothing else shown: stays (lost), never goes quiet', () => {
    const wrong = check(SAVED, after([3, own3], [2], [3, [oasis(0, 31), ...moved2]]));
    const gone = check(wrong.next, after([3, own3], [2], [1, [oasis(0, 31)]]), wrong.open);
    expect(brief(gone.result.alarms)).toEqual(['20|0 red lost @Charlie', '21|1 red lost @Charlie']);
  });
});

describe('review: list keys when villages share list names', () => {
  const vs = [A, B, C, G];
  const p1 = paste([list('Charlie', 'Oases', 1, [oasis(0, 31)]), list('Beta', 'Oases', 2, B2), list('Alpha', 'Oases', 5, [...own3, ...moved2]), list('Gamma', 'G farms', 1, [farm('v')])], vs);
  const p2 = paste([list('Charlie', 'Oases', 3, [oasis(0, 31), ...moved2]), list('Beta', 'Oases', 2, B2), list('Alpha', 'Oases', 3, own3), list('Gamma', 'G farms', 1, [farm('v')])], vs);

  it('every village calls its list "Oases" (saved lists)', () => {
    const s = save(p1);
    expect(rows(plan(s))).toEqual(['move 20|0 Alpha:Oases->Beta:Oases', 'move 21|1 Alpha:Oases->Beta:Oases']);
    expect(brief(check(s, p2).result.alarms)).toEqual(['20|0 red farther @Charlie', '21|1 red farther @Charlie']);
  });

  it('the same with two pastes in the tab', () => {
    const before = keyedView(viewFromPaste(p1));
    const r = checkMoves(before, keyedView(viewFromPaste(p2)), BOUNDS, planMoves(before, BOUNDS));
    expect(brief(r.alarms)).toEqual(['20|0 red farther @Charlie', '21|1 red farther @Charlie']);
  });

  it('the step’s list is the second of that name in its village', () => {
    const s = save(paste([list('Alpha', 'Oases', 1, [oasis(1, 1)]), list('Alpha', 'Oases', 4, [oasis(2, 2), oasis(3, 3), ...moved2]), list('Beta', 'B oases', 2, B2), list('Charlie', 'C oases', 1, [oasis(0, 31)]), list('Gamma', 'G farms', 1, [farm('v')])]));
    expect(plan(s).steps.map((x) => [x.from.name, x.fromTwin])).toEqual([['Oases', 2]]);
    const { result } = check(s, paste([list('Alpha', 'Oases', 1, [oasis(1, 1)]), list('Alpha', 'Oases', 2, [oasis(2, 2), oasis(3, 3)]), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 3, [oasis(0, 31), ...moved2]), list('Gamma', 'G farms', 1)]));
    expect(result.alarms.map((a) => [a.key, a.from.twin, a.at?.village])).toEqual([
      ['20|0', 2, 'Charlie'],
      ['21|1', 2, 'Charlie'],
    ]);
  });
});

describe('review round 4', () => {
  /** A teammate's paste in another tab: this tab checks against its own baseline, with the teammate's lists in between. */
  function checkAfterTeammate(tabBase: FarmState, teammate: ParsedPaste, mine: ParsedPaste, prev: Alarm[] = []) {
    const shared = save(teammate, tabBase);
    const before = viewFromFarm(tabBase, mine.deactivated);
    const pl = planMoves(before, BOUNDS, { skip: new Set(prev.filter((a) => a.level !== 'quiet').map((a) => a.key)) });
    return checkMoves(before, keyedView(viewFromPaste(mine)), BOUNDS, pl, prev, viewFromFarm(shared));
  }

  it('fixing an alarm with nothing ticked: the other oases of that list that left with it are flagged', () => {
    const s0 = save(paste([...savedLists().filter((l) => l.village !== 'Charlie'), list('Charlie', 'C oases', 3, [oasis(0, 31), oasis(1, 33), oasis(-2, 29)])]));
    const wrong = check(s0, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 5, [oasis(0, 31), oasis(1, 33), oasis(-2, 29), ...moved2]), list('Gamma', 'G farms', 1)]));
    expect(alarmKeys(wrong.result.alarms)).toEqual(['20|0', '21|1']);
    // The fix with nothing ticked: Charlie's whole list goes to Beta (collapsed).
    const fixed = check(wrong.next, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 7), list('Charlie', 'C oases', 0, []), list('Gamma', 'G farms', 1)]), wrong.open);
    expect(brief(fixed.result.alarms.filter((a) => ['0|31', '1|33', '-2|29'].includes(a.key)))).toEqual(['-2|29 amber along', '0|31 amber along', '1|33 amber along']);
    // Beta shown: Charlie's own oases are far from Beta now.
    const shown = check(fixed.next, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 7, [...B2, ...moved2, oasis(0, 31), oasis(1, 33), oasis(-2, 29)]), list('Charlie', 'C oases', 0, []), list('Gamma', 'G farms', 1)]), fixed.open);
    expect(brief(shown.result.alarms)).toEqual(['-2|29 red farther @Beta', '0|31 red farther @Beta', '1|33 red farther @Beta']);
    expect(shown.result.confirmed.map((c) => keys(c.rows))).toEqual([['20|0', '21|1']]);
  });

  it('a teammate pasted between the move and my paste (every list expanded): my paste still flags it', () => {
    const teammate = after([3, own3], [2, B2], [3, [oasis(0, 31), ...moved2]], [1, [farm('v')]]);
    const mine = after([3, own3], [2, B2]);
    const r = checkAfterTeammate(SAVED, teammate, mine);
    expect(brief(r.alarms)).toEqual(['20|0 red farther @Charlie', '21|1 red farther @Charlie']);
  });

  it('a teammate pasted with my old list collapsed and Charlie expanded: still red in my tab, never “no gap”', () => {
    const teammate = after([3], [2], [3, [oasis(0, 31), ...moved2]]);
    const mine = after([3, own3], [2, B2]);
    const r = checkAfterTeammate(SAVED, teammate, mine);
    expect(brief(r.alarms)).toEqual(['20|0 red farther @Charlie', '21|1 red farther @Charlie']);
    expect(r.notes).toEqual([]);
  });

  it('a teammate pasted with my old list expanded and Charlie collapsed: my paste isn’t silent', () => {
    const teammate = after([3, own3], [2], [3]);
    const mine = after([3, own3], [2, B2]);
    const r = checkAfterTeammate(SAVED, teammate, mine);
    expect(brief(r.alarms)).toEqual(['20|0 red missing', '21|1 red missing']);
  });

  it('a copy step done on the wrong row, the nearer list collapsed: amber, not silence', () => {
    const s = save(after([5, [...own3, ...moved2]], [3, [...B2, oasis(20, 0)]], [1, [oasis(0, 31)]], [1, [farm('v')]]));
    // The plan: move (21|1), extra (20|0). The player opens (2|2)'s menu instead and saves it to Beta.
    const { result } = check(s, after([4, [oasis(1, 1), oasis(3, 3), ...moved2]], [4]));
    expect(brief(result.alarms)).toEqual(['2|2 amber along']);
  });

  it('an open “twice” alarm stays amber while the list it asked about isn’t shown', () => {
    const D: PastedVillage = { name: 'Delta', x: 20, y: 30 };
    const vs = [A, B, C, D];
    const s = save(paste([list('Alpha', 'A oases', 4, [...own3, oasis(20, 0)]), list('Beta', 'B oases', 2, B2), list('Charlie', 'C oases', 1, [oasis(0, 31)]), list('Delta', 'D oases', 2, [oasis(20, 31), oasis(20, 0)])], vs));
    const first = check(s, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 2, [oasis(0, 31), oasis(20, 0)]), list('Delta', 'D oases', 2)], vs));
    expect(brief(first.result.alarms)).toEqual(['20|0 amber twice @Charlie']);
    const again = check(first.next, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2, B2), list('Charlie', 'C oases', 2, [oasis(0, 31), oasis(20, 0)]), list('Delta', 'D oases', 2)], vs), first.open);
    expect(brief(again.result.alarms)).toEqual(['20|0 amber twice @Charlie']);
  });

  it('the fix of an oasis that isn’t a step’s is the nearest list that raided it before', () => {
    // (5|25): in Alpha's list (25.5) and, nearer, in Charlie's (7.1). Moved from Alpha to Delta (13.0) by mistake.
    const D: PastedVillage = { name: 'Delta', x: 5, y: 12 };
    const vs = [A, B, C, D];
    const s = save(paste([list('Alpha', 'A oases', 4, [...own3, oasis(5, 25)]), list('Beta', 'B oases', 2, B2), list('Charlie', 'C oases', 2, [oasis(0, 31), oasis(5, 25)]), list('Delta', 'D oases', 1, [oasis(5, 11)])], vs));
    const { result } = check(s, paste([list('Alpha', 'A oases', 3, own3), list('Beta', 'B oases', 2), list('Charlie', 'C oases', 2), list('Delta', 'D oases', 2, [oasis(5, 11), oasis(5, 25)])], vs));
    expect(result.alarms.map((a) => [a.key, a.why, a.fix.village])).toEqual([['5|25', 'twice', 'Charlie']]);
  });
});
