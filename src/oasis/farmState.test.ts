import rulesText from '../../database.rules.json?raw';
import { describe, expect, it } from 'vitest';
import { analyze, type OasisGroup } from './analyze.ts';
import { EMPTY_FARM, lastSaved, listKey, mergePaste, parseFarm, viewFromFarm, type FarmState, type StoredMark } from './farmState.ts';
import type { ParsedPaste, PastedList, PastedTarget, PastedVillage } from './parsePaste.ts';
import type { OasisWorld } from './scanFormat.ts';

const A: PastedVillage = { name: 'Alpha', x: 0, y: 0 };
const B: PastedVillage = { name: 'Beta', x: 100, y: 100 };
const oasis = (x: number, y: number): PastedTarget => ({ name: `Unoccupied oasis (${x}|${y})`, pop: 0, dist: 1, oasis: true, occupied: false, x, y });
const farm = (name: string): PastedTarget => ({ name, pop: 50, dist: 3, oasis: false, occupied: null, x: null, y: null });
/** A list as pasted: rows = the targets copied (none when collapsed); total = what the game counts. */
const list = (village: string | null, name: string, total: number, targets: PastedTarget[] = []): PastedList => ({ village, name, active: total, total, targets });
const paste = (lists: PastedList[], villages = [A, B]): ParsedPaste => ({ villages, lists, deactivated: [] });

const FULL = paste([
  list('Alpha', 'A oases', 3, [oasis(1, 1), oasis(2, 2), farm('x')]),
  list('Alpha', 'A farms', 1, [farm('y')]),
  list('Beta', 'B oases', 1, [oasis(101, 101)]),
]);

/** Applies a merge the way the store would, so the next merge starts from it. */
function apply(state: FarmState, p: ParsedPaste, by = 'nd', now = 1000): { state: FarmState; result: ReturnType<typeof mergePaste> } {
  const result = mergePaste(state, p, by, now);
  return { state: result.ok ? result.next : state, result };
}

const WORLD: OasisWorld = {
  v: 1,
  world: 't',
  serverUrl: 'https://t.travian.com',
  scannedAt: 1,
  bounds: { minX: -200, maxX: 200, minY: -200, maxY: 200 },
  bonuses: ['25% Iron'],
  oases: [
    [1, 1, 0, 0, ''],
    [2, 2, 0, 0, ''],
    [3, 3, 0, 0, ''],
    [4, 4, 0, 0, ''],
    [101, 101, 0, 0, ''],
    [102, 102, 0, 0, ''],
  ],
};
const ALL = new Set<OasisGroup>(['easy', 'medium', 'hard']);
const missing = (s: FarmState, marks: StoredMark[] = s.marks) =>
  analyze(WORLD, viewFromFarm({ ...s, marks }), { radius: 20, groups: ALL, allVillages: true });

describe('mergePaste: first paste', () => {
  const { result } = apply(EMPTY_FARM, FULL);
  it('saves every list and the villages', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({ replaced: 3, kept: 0, unknown: 0, deleted: 0 });
    expect(Object.keys(result.writes).sort()).toEqual([
      `lists/${listKey(0, 0, 'A farms')}`,
      `lists/${listKey(0, 0, 'A oases')}`,
      `lists/${listKey(100, 100, 'B oases')}`,
      'villages',
    ].sort());
    expect(result.writes[`lists/${listKey(0, 0, 'A oases')}`]).toEqual({ v: 'Alpha', vx: 0, vy: 0, n: 'A oases', total: 3, known: 3, oases: '1|1,2|2', by: 'nd' });
    // No oases: the field is left out (the rules don't take empty strings well).
    expect(result.writes[`lists/${listKey(0, 0, 'A farms')}`]).toEqual({ v: 'Alpha', vx: 0, vy: 0, n: 'A farms', total: 1, known: 1, by: 'nd' });
  });

  it('writes only keys and values the rules accept', () => {
    const rules = JSON.parse(rulesText).rules.rooms.$room.farm.$w;
    const lkRe = new RegExp(/\$lk\.matches\(\/(.+?)\/\)/.exec(rules.lists.$lk['.write'])![1]);
    if (!result.ok) throw new Error('merge failed');
    for (const [path, value] of Object.entries(result.writes)) {
      if (!path.startsWith('lists/')) continue;
      expect(path.slice(6)).toMatch(lkRe);
      const oases = (value as { oases?: string }).oases ?? '';
      expect(oases).toMatch(/^[-0-9|,]*$/);
    }
    expect(listKey(-199, -199, 'x'.repeat(100))).toMatch(lkRe);
  });

  it('changes nothing when the same paste comes again', () => {
    const once = apply(EMPTY_FARM, FULL).state;
    const twice = mergePaste(once, FULL, 'kv', 2000);
    // Only the village list, whose time is the team's "last paste".
    expect(twice.ok && Object.keys(twice.writes)).toEqual(['villages']);
    expect(twice.ok && twice.next.villagesBy).toBe('kv');
  });
});

describe('mergePaste: later pastes with collapsed lists', () => {
  const saved = apply(EMPTY_FARM, FULL).state;

  it('keeps the saved oases of a collapsed list', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 3), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'kv', 2000);
    expect(r.ok && r.report).toMatchObject({ kept: 3, replaced: 0, recounted: 0 });
    expect(r.ok && Object.keys(r.writes)).toEqual(['villages']);
    expect(missing(r.ok ? r.next : saved).villages.find((v) => v.village.name === 'Alpha')!.missing.map((m) => [m.x, m.y])).toEqual([[3, 3], [4, 4]]);
  });

  it('moves the “last paste” time and name even when nothing changed', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 3), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'kv', 5000);
    expect(r.ok && lastSaved(r.next)).toEqual({ at: 5000, by: 'kv' });
  });

  it('replaces a list that was expanded again', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 4, [oasis(1, 1), oasis(2, 2), oasis(3, 3), farm('x')]), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'kv', 2000);
    expect(r.ok && r.report).toMatchObject({ replaced: 1, kept: 2 });
    expect(r.ok && r.writes[`lists/${listKey(0, 0, 'A oases')}`]).toMatchObject({ total: 4, known: 4, oases: '1|1,2|2,3|3', by: 'kv' });
  });

  it('merges a list read only in part', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 5, [oasis(4, 4)]), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'kv', 2000);
    expect(r.ok && r.report.merged).toBe(1);
    expect(r.ok && r.writes[`lists/${listKey(0, 0, 'A oases')}`]).toMatchObject({ total: 5, known: 3, oases: '1|1,2|2,4|4' });
  });

  it('warns about growth only when the ticks don’t explain it', () => {
    const tick: StoredMark = { x: 3, y: 3, vx: 0, vy: 0, by: 'kv', at: 1500 };
    // Someone ticked (3|3) for Alpha and added it in the game: A oases now counts 4, collapsed.
    const grown = mergePaste({ ...saved, marks: [tick] }, paste([list('Alpha', 'A oases', 4), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'nd', 2000);
    if (!grown.ok) throw new Error('merge failed');
    expect(grown.report.recounted).toBe(1);
    expect(missing(grown.next).warnings.grownLists).toEqual([]);
    // One more target added without a tick: 2 new targets, 1 tick.
    const again = mergePaste(grown.next, paste([list('Alpha', 'A oases', 5), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'nd', 3000);
    if (!again.ok) throw new Error('merge failed');
    expect(missing(again.next).warnings.grownLists).toEqual([{ village: 'Alpha', list: 'A oases', total: 5, known: 3 }]);
    // Without the tick, the first growth already warns.
    expect(missing(grown.next, []).warnings.grownLists).toHaveLength(1);
  });

  it('holds back oases near a list never seen expanded, and only there', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 3), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1), list('Beta', 'B new', 7)]), 'kv', 2000);
    if (!r.ok) throw new Error('merge failed');
    expect(r.report.unknown).toBe(1);
    expect(r.writes[`lists/${listKey(100, 100, 'B new')}`]).toEqual({ v: 'Beta', vx: 100, vy: 100, n: 'B new', total: 7, by: 'kv' });
    const a = missing(r.next);
    expect(a.warnings.neverExpanded).toEqual([{ village: 'Beta', list: 'B new', total: 7 }]);
    expect(a.villages.find((v) => v.village.name === 'Beta')).toMatchObject({ missing: [], heldBack: 1 });
    expect(a.villages.find((v) => v.village.name === 'Alpha')!.missing).toHaveLength(2);
  });

  it('keeps lists with the same name in one village apart', () => {
    const r = mergePaste(EMPTY_FARM, paste([list('Alpha', 'Same', 1, [oasis(1, 1)]), list('Alpha', 'Same', 1, [oasis(2, 2)]), list('Alpha', 'Same', 1, [oasis(3, 3)])]), 'nd', 1000);
    expect(r.ok && r.writes[`lists/${listKey(0, 0, 'Same')}`]).toMatchObject({ n: 'Same', total: 1, oases: '1|1' });
    expect(r.ok && r.writes[`lists/${listKey(0, 0, 'Same#2')}`]).toMatchObject({ n: 'Same', total: 1, oases: '2|2' });
    expect(r.ok && r.writes[`lists/${listKey(0, 0, 'Same#3')}`]).toMatchObject({ n: 'Same', total: 1, oases: '3|3' });
  });

  it('gives a list renamed while collapsed the oases of the list it replaces', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases renamed', 3), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'kv', 2000);
    if (!r.ok) throw new Error('merge failed');
    expect(r.writes[`lists/${listKey(0, 0, 'A oases')}`]).toBeNull();
    expect(r.writes[`lists/${listKey(0, 0, 'A oases renamed')}`]).toMatchObject({ total: 3, oases: '1|1,2|2' });
    expect(r.writes[`lists/${listKey(0, 0, 'A oases renamed')}`]).not.toHaveProperty('known');
    // Its oases still count as taken while it waits to be expanded.
    const a = missing(r.next);
    expect(a.villages.flatMap((v) => v.missing).some((m) => (m.x === 1 && m.y === 1) || (m.x === 2 && m.y === 2))).toBe(false);
  });

  it('lowers the baseline when a collapsed list shrank, so later growth still shows', () => {
    const shrunk = mergePaste(saved, paste([list('Alpha', 'A oases', 2), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'kv', 2000);
    if (!shrunk.ok) throw new Error('merge failed');
    expect(shrunk.writes[`lists/${listKey(0, 0, 'A oases')}`]).toMatchObject({ total: 2, known: 2 });
    const grew = mergePaste(shrunk.next, paste([list('Alpha', 'A oases', 3), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'kv', 3000);
    if (!grew.ok) throw new Error('merge failed');
    expect(missing(grew.next).warnings.grownLists).toEqual([{ village: 'Alpha', list: 'A oases', total: 3, known: 2 }]);
  });

  it('skips a list the rules would refuse, instead of failing the whole save', () => {
    const r = mergePaste(EMPTY_FARM, paste([list('Alpha', 'x'.repeat(101), 1, [oasis(1, 1)]), list('Alpha', 'ok', 1, [oasis(2, 2)])]), 'nd', 1000);
    expect(r.ok && r.report.unmatched).toEqual(['x'.repeat(101)]);
    expect(r.ok && r.writes[`lists/${listKey(0, 0, 'ok')}`]).toMatchObject({ oases: '2|2' });
  });
});

describe('mergePaste: removals and refusals', () => {
  const saved = apply(EMPTY_FARM, FULL).state;

  it('removes a list gone from a village that is in the paste', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 3), list('Beta', 'B oases', 1)]), 'kv', 2000);
    expect(r.ok && r.writes[`lists/${listKey(0, 0, 'A farms')}`]).toBeNull();
    expect(r.ok && r.report.deleted).toBe(1);
  });

  it('keeps the lists of a village with no lists in the paste', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 3), list('Alpha', 'A farms', 1)]), 'kv', 2000);
    expect(r.ok && r.report.deleted).toBe(0);
  });

  it('removes the lists of a village that left the village list (lost)', () => {
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 3), list('Alpha', 'A farms', 1)], [A]), 'kv', 2000);
    expect(r.ok && r.writes[`lists/${listKey(100, 100, 'B oases')}`]).toBeNull();
  });

  it('refuses two own villages with the same name', () => {
    const r = mergePaste(EMPTY_FARM, paste([list(null, 'X', 0)], [A, { name: 'Alpha', x: 5, y: 5 }]), 'nd', 1000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Two of your villages are called “Alpha”/);
  });

  it('refuses a paste with none of the saved villages, unless told to replace', () => {
    const gamma = paste([list('Gamma', 'G', 1, [oasis(51, 51)])], [{ name: 'Gamma', x: 50, y: 50 }]);
    const r = mergePaste({ ...saved, marks: [{ x: 3, y: 3, vx: 0, vy: 0, by: 'kv', at: 1 }] }, gamma, 'nd', 2000);
    expect(!r.ok && r.reason).toBe('no-overlap');
    const replaced = mergePaste({ ...saved, marks: [{ x: 3, y: 3, vx: 0, vy: 0, by: 'kv', at: 1 }] }, gamma, 'nd', 2000, { replace: true });
    if (!replaced.ok) throw new Error('replace failed');
    expect(replaced.report.deleted).toBe(3);
    expect(replaced.report.removedTicks).toBe(1);
    expect(replaced.next.villages).toEqual([{ name: 'Gamma', x: 50, y: 50 }]);
  });

  it('deletes nothing, and keeps saved villages, when a list could not be matched', () => {
    // Beta is missing from the village list, so its list comes back unmatched.
    const r = mergePaste(saved, paste([list('Alpha', 'A oases', 3), list(null, 'B oases', 1)], [A]), 'kv', 2000);
    if (!r.ok) throw new Error('merge failed');
    expect(r.report.deleted).toBe(0);
    expect(Object.values(r.writes).includes(null)).toBe(false);
    expect(r.next.villages).toEqual([A, B]);
    expect(r.next.lists).toHaveLength(3);
  });

  it('removes the ticks of a village that is no longer yours', () => {
    const r = mergePaste({ ...saved, marks: [{ x: 102, y: 102, vx: 100, vy: 100, by: 'kv', at: 1 }] }, paste([list('Alpha', 'A oases', 3), list('Alpha', 'A farms', 1)], [A]), 'kv', 2000);
    expect(r.ok && r.writes['marks/102_102']).toBeNull();
    expect(r.ok && r.report.removedTicks).toBe(1);
  });

  it('refuses a paste without lists or villages', () => {
    expect(mergePaste(EMPTY_FARM, paste([]), 'nd', 1).ok).toBe(false);
    expect(mergePaste(EMPTY_FARM, paste([list('Alpha', 'A', 0)], []), 'nd', 1).ok).toBe(false);
  });

  it('does not save lists it can’t match to a village', () => {
    const r = mergePaste(EMPTY_FARM, paste([list(null, 'Orphan', 2, [oasis(1, 1), oasis(2, 2)])]), 'nd', 1000);
    expect(r.ok && r.report.unmatched).toEqual(['Orphan']);
    expect(r.ok && Object.keys(r.writes)).toEqual(['villages']);
  });
});

describe('ticks', () => {
  it('of a village that is not one of yours hide nothing', () => {
    const lost: StoredMark = { x: 4, y: 4, vx: 500, vy: 500, by: 'kv', at: 1 };
    const a = missing({ ...apply(EMPTY_FARM, FULL).state, marks: [lost] });
    expect(a.villages.find((v) => v.village.name === 'Alpha')!.missing.map((m) => [m.x, m.y])).toEqual([[3, 3], [4, 4]]);
  });

  const saved = apply(EMPTY_FARM, FULL).state;
  const tick: StoredMark = { x: 3, y: 3, vx: 0, vy: 0, by: 'kv', at: 1500 };

  it('count as taken, and show as ticked for their village', () => {
    const v = missing({ ...saved, marks: [tick] }).villages.find((x) => x.village.name === 'Alpha')!;
    expect(v.missing.map((m) => [m.x, m.y])).toEqual([[4, 4]]);
    expect(v.ticked).toMatchObject([{ x: 3, y: 3, by: 'kv', at: 1500 }]);
  });

  it('are cleared once the oasis shows up in a list', () => {
    const r = mergePaste({ ...saved, marks: [tick] }, paste([list('Alpha', 'A oases', 4, [oasis(1, 1), oasis(2, 2), oasis(3, 3), farm('x')]), list('Alpha', 'A farms', 1), list('Beta', 'B oases', 1)]), 'nd', 2000);
    expect(r.ok && r.writes['marks/3_3']).toBeNull();
    expect(r.ok && r.report.confirmedTicks).toBe(1);
    expect(r.ok && r.next.marks).toEqual([]);
  });
});

describe('parseFarm', () => {
  it('reads what Firebase returns and skips damaged entries', () => {
    const raw = {
      villages: { list: JSON.stringify([A, B]), by: 'nd', at: 5 },
      lists: {
        [listKey(0, 0, 'A oases')]: { v: 'Alpha', vx: 0, vy: 0, n: 'A oases', total: 3, known: 3, oases: '1|1,2|2', by: 'nd', at: 7 },
        bad: { v: 'x' },
      },
      marks: { '3_3': { vx: 0, vy: 0, by: 'kv', at: 9 }, nope: { vx: 0 } },
    };
    const s = parseFarm(raw);
    expect(s.villages).toEqual([A, B]);
    expect(s.lists).toEqual([{ lk: listKey(0, 0, 'A oases'), v: 'Alpha', vx: 0, vy: 0, n: 'A oases', total: 3, known: 3, oases: '1|1,2|2', by: 'nd', at: 7 }]);
    expect(s.marks).toEqual([{ x: 3, y: 3, vx: 0, vy: 0, by: 'kv', at: 9 }]);
    expect(lastSaved(s)).toEqual({ at: 7, by: 'nd' });
    expect(parseFarm(null)).toEqual(EMPTY_FARM);
  });
});
