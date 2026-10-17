import { describe, expect, it } from 'vitest';
import { analyze, coordText, distance, groupOf, parseCoords, viewFromPaste, type OasisGroup } from './analyze.ts';
import { cleanGameText, parsePaste } from './parsePaste.ts';
import { animalsLabel, compactScan, worldKey, type OasisWorld } from './scanFormat.ts';

// A made-up farm-list page in the game's format: direction marks around numbers, U+2212 minus signs,
// CRLF line ends, and the village header only where the village changes.
const L = '‭';
const R = '‬';
const c = (x: number, y: number) => `${L}(${L}${x < 0 ? `−${L}${-x}${R}` : x}${R}|${L}${y < 0 ? `−${L}${-y}${R}` : y}${R})${R}`;
const row = (name: string, pop: number, dist: number) => `\t\t${name}\t${pop}\t${dist}\t\n1\n12:00:00\n${L}0${R}\n${L}1,234${R}`;
const PASTE = [
  'Farm List',
  'The following targets were deactivated due to a change of ownership:',
  `Occupied oasis ${c(-199, 4)}`,
  'V1 Alpha',
  'V1 - Oases',
  `${L}${L}2${R}/${L}3${R}${R} being raided`,
  '',
  'Start (2)',
  row(`Unoccupied oasis ${c(11, 10)}`, 0, 1),
  row(`Unoccupied oasis ${c(10, 12)}`, 0, 2),
  row(`Occupied oasis ${c(13, 14)}`, 0, 5),
  'Start (2)',
  'V1 - Farms',
  `${L}1${R}/${L}1${R} being raided`,
  row('Some Village', 1_234, 7.3),
  'V2 Edge',
  'V2 - Oases',
  `${L}1${R}/${L}100${R} being raided`,
  row(`Unoccupied oasis ${c(-199, 2)}`, 0, 2),
  row(`Unoccupied oasis ${c(11, 10)}`, 0, 99),
  ...Array.from({ length: 98 }, (_, i) => row(`Village ${i}`, 10, 30)),
  'Villages 3/3',
  'V1 Alpha',
  c(10, 10),
  'V2 Edge',
  c(200, 0),
  'V3 Nolists',
  c(-50, -50),
].join('\r\n');

const WORLD: OasisWorld = {
  v: 1,
  world: 'ts1.x1.test',
  serverUrl: 'https://ts1.x1.test.travian.com',
  scannedAt: 1_792_000_000_000,
  bounds: { minX: -200, maxX: 200, minY: -200, maxY: 200 },
  bonuses: ['25% Iron', '25% Lumber', '50% Crop'],
  oases: [
    [11, 10, 0, 0, ''], // listed by V1 and V2
    [10, 12, 1, 0, ''], // listed by V1
    [12, 10, 2, 0, '31:3,36:1'], // free, 2 from V1
    [10, 25, 0, 0, ''], // free, 15 from V1
    [10, 31, 0, 0, ''], // free, 21 from V1: out of range
    [14, 10, 0, 1, ''], // occupied at scan
    [-198, 0, 1, 0, ''], // free, 3 from V2 across the map edge
    [-50, -45, 0, 0, ''], // free, near V3 (no oasis list)
  ],
};

const ALL = new Set<OasisGroup>(['easy', 'medium', 'hard']);

describe('cleanGameText', () => {
  it('drops direction marks and uses ASCII minus', () => {
    expect(cleanGameText(c(-5, 7))).toBe('(-5|7)');
  });
});

describe('parsePaste', () => {
  const p = parsePaste(PASTE);

  it('finds the own villages with coordinates', () => {
    expect(p.villages).toEqual([
      { name: 'V1 Alpha', x: 10, y: 10 },
      { name: 'V2 Edge', x: 200, y: 0 },
      { name: 'V3 Nolists', x: -50, y: -50 },
    ]);
  });

  it('assigns lists to villages, carrying the header over', () => {
    expect(p.lists.map((l) => [l.village, l.name, l.active, l.total, l.targets.length])).toEqual([
      ['V1 Alpha', 'V1 - Oases', 2, 3, 3],
      ['V1 Alpha', 'V1 - Farms', 1, 1, 1],
      ['V2 Edge', 'V2 - Oases', 1, 100, 100],
    ]);
  });

  it('reads oasis rows with coordinates and village rows by name', () => {
    const [a, , occ] = p.lists[0].targets;
    expect(a).toMatchObject({ oasis: true, occupied: false, x: 11, y: 10, dist: 1, pop: 0 });
    expect(occ).toMatchObject({ oasis: true, occupied: true, x: 13, y: 14 });
    expect(p.lists[1].targets[0]).toMatchObject({ name: 'Some Village', pop: 1234, dist: 7.3, oasis: false, x: null });
  });

  it('reads the deactivated banner', () => {
    expect(p.deactivated).toEqual([{ x: -199, y: 4 }]);
  });

  it('copes with an empty or unrelated paste', () => {
    expect(parsePaste('')).toEqual({ villages: [], lists: [], deactivated: [] });
    expect(parsePaste('hello\nworld').lists).toEqual([]);
  });
});

describe('analyze', () => {
  const p = parsePaste(PASTE);

  it('measures across the map edge', () => {
    expect(distance({ x: 200, y: 0 }, { x: -198, y: 0 }, WORLD.bounds)).toBe(3);
    expect(Math.round(distance({ x: 10, y: 10 }, { x: 11, y: 12 }, WORLD.bounds) * 10) / 10).toBe(2.2);
  });

  it('lists free oases in range that no list has, for villages with oasis lists', () => {
    const a = analyze(WORLD, viewFromPaste(p), { radius: 20, groups: ALL, allVillages: false });
    expect(a.villages.map((v) => v.village.name)).toEqual(['V1 Alpha', 'V2 Edge']);
    expect(a.villages[0].missing.map((m) => [m.x, m.y, m.dist, m.group, m.animals])).toEqual([
      [12, 10, 2, 'hard', '31:3,36:1'],
      [10, 25, 15, 'easy', ''],
    ]);
    expect(a.villages[1].missing.map((m) => [m.x, m.y, m.dist])).toEqual([[-198, 0, 3]]);
    expect(a.villages[0].listedOases).toBe(3);
    expect(a.totalMissing).toBe(3);
  });

  it('includes villages without oasis lists on request', () => {
    const a = analyze(WORLD, viewFromPaste(p), { radius: 20, groups: ALL, allVillages: true });
    expect(a.villages.find((v) => v.village.name === 'V3 Nolists')!.missing.map((m) => [m.x, m.y])).toEqual([[-50, -45]]);
  });

  it('offers an oasis only to the nearest village', () => {
    const near = { name: 'Near', x: 12, y: 12 };
    const a = analyze(WORLD, viewFromPaste(p), { radius: 20, groups: ALL, allVillages: false, extraVillages: [near] });
    expect(a.villages.find((v) => v.village.name === 'V1 Alpha')!.missing.map((m) => [m.x, m.y])).toEqual([[12, 10]]);
    // (12|10) is 2 from both: the tie goes to the first village. (10|31) is 19.1 from Near: in range.
    expect(a.villages.find((v) => v.village.name === 'Near')!.missing.map((m) => [m.x, m.y])).toEqual([[10, 25], [10, 31]]);
  });

  it('filters by oasis type group', () => {
    const a = analyze(WORLD, viewFromPaste(p), { radius: 20, groups: new Set<OasisGroup>(['easy']), allVillages: false });
    expect(a.villages[0].missing.map((m) => m.group)).toEqual(['easy']);
    expect(a.totalMissing).toBe(3);
  });

  it('works without a paste, from typed coordinates', () => {
    const a = analyze(WORLD, null, { radius: 5, groups: ALL, allVillages: false, extraVillages: [{ name: '(10|10)', x: 10, y: 10 }] });
    expect(a.villages[0].missing.map((m) => [m.x, m.y])).toEqual([[11, 10], [10, 12], [12, 10]]);
  });

  it('warns about full lists, deactivated targets and oases in two villages', () => {
    const { warnings } = analyze(WORLD, viewFromPaste(p), { radius: 20, groups: ALL, allVillages: false });
    expect(warnings.fullLists).toEqual([{ village: 'V2 Edge', list: 'V2 - Oases' }]);
    expect(warnings.deactivated).toEqual([{ x: -199, y: 4 }]);
    expect(warnings.inSeveralVillages).toEqual([{ x: 11, y: 10, villages: ['V1 Alpha', 'V2 Edge'] }]);
  });

  it('groups oasis types like Travian’s oasis guide', () => {
    expect(['25% Iron', '25% Clay; 25% Crop', '25% Lumber', '25% Lumber; 25% Crop', '25% Crop', '50% Crop'].map(groupOf)).toEqual([
      'easy',
      'easy',
      'medium',
      'medium',
      'hard',
      'hard',
    ]);
  });

  it('holds back only the oases near a list that was not fully copied', () => {
    // V1 - Farms says 1/3: two of its rows are missing (a collapsed list). Its oases are unknown.
    const p2 = parsePaste(PASTE.replace(`${L}1${R}/${L}1${R} being raided`, `${L}1${R}/${L}3${R} being raided`));
    const a = analyze(WORLD, viewFromPaste(p2), { radius: 20, groups: ALL, allVillages: false });
    expect(a.warnings.neverExpanded).toEqual([{ village: 'V1 Alpha', list: 'V1 - Farms', total: 3 }]);
    const v1 = a.villages.find((v) => v.village.name === 'V1 Alpha')!;
    expect(v1.missing).toEqual([]);
    expect(v1.heldBack).toBe(2);
    // Far from V1, V2 still gets its suggestion.
    expect(a.villages.find((v) => v.village.name === 'V2 Edge')!.missing.map((m) => [m.x, m.y])).toEqual([[-198, 0]]);
    expect(analyze(WORLD, viewFromPaste(p), { radius: 20, groups: ALL, allVillages: false }).warnings.neverExpanded).toEqual([]);
  });

  it('does not give a village’s lists to the previous village when its name is unknown', () => {
    const p2 = parsePaste(PASTE.replace(`V2 Edge\r\n${c(200, 0)}`, ''));
    expect(p2.lists.map((l) => l.village)).toEqual(['V1 Alpha', 'V1 Alpha', null]);
    const a = analyze(WORLD, viewFromPaste(p2), { radius: 20, groups: ALL, allVillages: false });
    expect(a.warnings.unmatchedLists).toEqual(['V2 - Oases']);
    // Its oases still count as taken.
    expect(a.villages[0].missing.map((m) => [m.x, m.y])).toEqual([[12, 10], [10, 25]]);
  });

  it('keeps two own villages with the same name apart', () => {
    const p2 = parsePaste(PASTE.replace(`V3 Nolists\r\n${c(-50, -50)}`, `V1 Alpha\r\n${c(-50, -50)}`));
    expect(p2.villages.filter((v) => v.name === 'V1 Alpha')).toHaveLength(2);
    expect(p2.lists[0].village).toBeNull(); // which "V1 Alpha"? can't tell
    const a = analyze(WORLD, viewFromPaste(p2), { radius: 20, groups: ALL, allVillages: true });
    expect(a.villages.filter((v) => v.village.name === 'V1 Alpha').map((v) => v.missing.length)).toEqual([2, 1]);
  });

  it('does not take a village called "… Oasis" for an oasis', () => {
    const p2 = parsePaste(PASTE.replace('Some Village', 'Desert Oasis'));
    expect(p2.lists[1].targets[0]).toMatchObject({ name: 'Desert Oasis', oasis: false });
  });

  it('shows a pasted village whose coordinates were typed in, under its own name', () => {
    const a = analyze(WORLD, viewFromPaste(p), { radius: 20, groups: ALL, allVillages: false, extraVillages: [{ name: '(-50|-50)', x: -50, y: -50 }] });
    expect(a.villages.map((v) => v.village.name)).toEqual(['V1 Alpha', 'V2 Edge', 'V3 Nolists']);
  });

  it('wraps on the full map even when only part of it was scanned', () => {
    expect(distance({ x: 200, y: 0 }, { x: -198, y: 0 }, { minX: -100, maxX: 200, minY: -50, maxY: 50 })).toBe(3);
  });

  it('reads and writes coordinates', () => {
    expect(parseCoords(c(34, -11))).toEqual({ x: 34, y: -11 }); // copied from the game, with its marks
    expect(parseCoords('(−12|34)')).toEqual({ x: -12, y: 34 });
    expect(parseCoords('5 | -6')).toEqual({ x: 5, y: -6 });
    expect(parseCoords('5,6')).toEqual({ x: 5, y: 6 });
    expect(parseCoords('abc')).toBeNull();
    expect(coordText(-3, 4)).toBe('(-3|4)');
  });
});

describe('scan format', () => {
  const scan = {
    meta: { world: 'ts1.x1.test', server_url: 'https://ts1.x1.test.travian.com/', finished: '2026-10-14T10:35:46Z', bounds: { min_x: -200, max_x: 200, min_y: -200, max_y: 200 } },
    oases: [
      { x: 1, y: 2, bonus: '25% Iron', occupied: 'no', animals: 4, animal_types: { u36: 1, u31: 3 }, owner: null },
      { x: 3, y: 4, bonus: '50% Crop', occupied: 'yes', animals: 0, animal_types: {}, owner: { player: 'Someone' } },
      { x: 1, y: 2, bonus: '25% Iron', occupied: 'no' }, // duplicate
      { x: 999, y: 0, bonus: '25% Iron', occupied: 'no' }, // off the map
    ],
    villages: [{ x: 5, y: 5, name: 'x', player: 'Someone' }],
  };

  it('keeps only what the helper needs (no player names)', () => {
    const w = compactScan(scan);
    expect(w).toEqual({
      v: 1,
      world: 'ts1.x1.test',
      serverUrl: 'https://ts1.x1.test.travian.com',
      scannedAt: Date.parse('2026-10-14T10:35:46Z'),
      bounds: { minX: -200, maxX: 200, minY: -200, maxY: 200 },
      bonuses: ['25% Iron', '50% Crop'],
      oases: [
        [1, 2, 0, 0, '31:3,36:1'],
        [3, 4, 1, 1, ''],
      ],
    });
    expect(JSON.stringify(w)).not.toContain('Someone');
  });

  it('round-trips the compact form', () => {
    const w = compactScan(scan);
    expect(compactScan(JSON.parse(JSON.stringify(w)))).toEqual(w);
  });

  it('refuses files that are not oasis scans', () => {
    expect(() => compactScan({ hello: 1 })).toThrow(/not an oasis scan/);
    expect(() => compactScan({ ...scan, meta: { ...scan.meta, server_url: 'https://evil.example.com' } })).toThrow(/server address/);
    expect(() => compactScan({ v: 1, bonuses: [], oases: [[1, 2, 5, 0, '']], world: 'w', serverUrl: 'https://a.travian.com', scannedAt: 1, bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } })).toThrow(/damaged/);
  });

  it('refuses a scan that did not finish', () => {
    expect(() => compactScan({ ...scan, meta: { ...scan.meta, complete: false, reason: 'rate limited' } })).toThrow(/did not finish \(rate limited\)/);
    expect(() => compactScan({ ...scan, meta: { ...scan.meta, failed_regions: [[1, 2]] } })).toThrow(/did not finish/);
    expect(() => compactScan({ ...scan, meta: { ...scan.meta, regions_ok: 3, regions_total: 4 } })).toThrow(/did not finish/);
  });

  it('reads a scan time without a zone as UTC', () => {
    expect(compactScan({ ...scan, meta: { ...scan.meta, finished: '2026-10-14T10:35:46' } }).scannedAt).toBe(Date.UTC(2026, 9, 14, 10, 35, 46));
  });

  it('makes a Firebase-safe world key', () => {
    expect(worldKey('https://ts33.x3.international.travian.com')).toBe('ts33_x3_international');
    expect(worldKey('https://example.com')).toBeNull();
  });

  it('names animals', () => {
    expect(animalsLabel('31:3,36:1')).toBe('3 rats, 1 wolf');
    expect(animalsLabel('')).toBe('');
  });
});
