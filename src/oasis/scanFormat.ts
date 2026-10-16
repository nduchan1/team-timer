// Oasis map data for one game world, in a compact form: only what the oasis helper needs (no player
// names, no villages). Built from the oasis-finder scan JSON, either by scripts/oasis-data.ts (the
// data shipped with the site) or in the browser when someone uploads a scan.

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** [x, y, index into bonuses, occupied at scan (1) or not (0), animals at scan as "31:3,35:1"] */
export type OasisRow = [number, number, number, 0 | 1, string];

export interface OasisWorld {
  v: 1;
  /** e.g. "ts33.x3.international" */
  world: string;
  /** e.g. "https://ts33.x3.international.travian.com" */
  serverUrl: string;
  /** When the scan finished (epoch ms). */
  scannedAt: number;
  bounds: Bounds;
  bonuses: string[];
  oases: OasisRow[];
}

export interface WorldMeta {
  key: string;
  world: string;
  serverUrl: string;
  scannedAt: number;
  count: number;
}

const SERVER_RE = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.travian\.com$/;

/** Firebase-safe key for a world: the host without ".travian.com", dots as "_" (ts33_x3_international). */
export function worldKey(serverUrl: string): string | null {
  const m = SERVER_RE.exec(serverUrl);
  return m ? m[1].replace(/\./g, '_') : null;
}

export function metaOf(w: OasisWorld): WorldMeta {
  return { key: worldKey(w.serverUrl)!, world: w.world, serverUrl: w.serverUrl, scannedAt: w.scannedAt, count: w.oases.length };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function readBounds(b: unknown): Bounds | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  const [minX, maxX, minY, maxY] = [o.min_x ?? o.minX, o.max_x ?? o.maxX, o.min_y ?? o.minY, o.max_y ?? o.maxY];
  if (![minX, maxX, minY, maxY].every(isInt)) return null;
  const r = { minX, maxX, minY, maxY } as Bounds;
  return r.maxX > r.minX && r.maxY > r.minY && r.maxX - r.minX <= 1000 && r.maxY - r.minY <= 1000 ? r : null;
}

function animalsText(types: unknown): string {
  if (!types || typeof types !== 'object') return '';
  return Object.entries(types as Record<string, unknown>)
    .map(([k, n]) => [Number(k.replace(/^u/, '')), n] as const)
    .filter(([id, n]) => id >= 31 && id <= 40 && isInt(n) && n > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([id, n]) => `${id}:${n}`)
    .join(',');
}

function checkCompact(o: Record<string, unknown>): OasisWorld {
  const bounds = readBounds(o.bounds);
  const bonuses = o.bonuses;
  if (o.v !== 1 || typeof o.world !== 'string' || typeof o.serverUrl !== 'string' || !worldKey(o.serverUrl) || !isInt(o.scannedAt) || !bounds) {
    throw new Error('This oasis data file is damaged.');
  }
  if (!Array.isArray(bonuses) || !bonuses.every((b) => typeof b === 'string') || !Array.isArray(o.oases)) throw new Error('This oasis data file is damaged.');
  const oases: OasisRow[] = [];
  for (const r of o.oases as unknown[]) {
    if (!Array.isArray(r) || !isInt(r[0]) || !isInt(r[1]) || !isInt(r[2]) || r[2] < 0 || r[2] >= bonuses.length || (r[3] !== 0 && r[3] !== 1) || typeof r[4] !== 'string') {
      throw new Error('This oasis data file is damaged.');
    }
    oases.push([r[0], r[1], r[2], r[3], r[4]]);
  }
  return { v: 1, world: o.world, serverUrl: o.serverUrl, scannedAt: o.scannedAt, bounds, bonuses: bonuses as string[], oases };
}

/**
 * Turns a parsed scan JSON (the oasis finder's format, with meta/oases/villages) or an already compact
 * file into an OasisWorld. Throws an Error with a message for the player when the file doesn't fit.
 */
export function compactScan(raw: unknown): OasisWorld {
  if (!raw || typeof raw !== 'object') throw new Error('This is not an oasis scan file.');
  const o = raw as Record<string, unknown>;
  if (o.v === 1 && 'bonuses' in o) return checkCompact(o);

  const meta = o.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object' || !Array.isArray(o.oases)) throw new Error('This is not an oasis scan file (no meta or oases).');
  const serverUrl = typeof meta.server_url === 'string' ? meta.server_url.replace(/\/+$/, '') : '';
  if (!worldKey(serverUrl)) throw new Error('The scan has no valid Travian server address (meta.server_url).');
  const bounds = readBounds(meta.bounds);
  if (!bounds) throw new Error('The scan has no valid map size (meta.bounds).');
  // A scan that stopped early lacks part of the map: its "missing" oases would be wrong.
  const failed = Array.isArray(meta.failed_regions) ? meta.failed_regions.length : 0;
  const partial =
    meta.complete === false ||
    (typeof meta.status === 'string' && meta.status !== 'complete') ||
    failed > 0 ||
    (isInt(meta.regions_ok) && isInt(meta.regions_total) && meta.regions_ok < meta.regions_total);
  if (partial) {
    const why = typeof meta.reason === 'string' && meta.reason ? ` (${meta.reason})` : '';
    throw new Error(`This scan did not finish${why}: part of the map is missing. Run a full scan and upload that.`);
  }
  // The finder writes times without a zone: read them as UTC, so every browser gets the same moment.
  const rawDate = String(meta.finished ?? meta.started ?? '');
  const scannedAt = Date.parse(/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(rawDate) ? `${rawDate}Z` : rawDate);
  if (!Number.isFinite(scannedAt)) throw new Error('The scan has no valid date (meta.finished).');
  const world = typeof meta.world === 'string' && meta.world ? meta.world : serverUrl.replace(/^https:\/\//, '').replace(/\.travian\.com$/, '');

  const bonuses: string[] = [];
  const bonusIndex = new Map<string, number>();
  const seen = new Set<string>();
  const oases: OasisRow[] = [];
  for (const item of o.oases as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (!isInt(r.x) || !isInt(r.y) || r.x < bounds.minX || r.x > bounds.maxX || r.y < bounds.minY || r.y > bounds.maxY) continue;
    const key = `${r.x}|${r.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bonus = typeof r.bonus === 'string' && r.bonus ? r.bonus : 'Unknown';
    let b = bonusIndex.get(bonus);
    if (b === undefined) {
      b = bonuses.length;
      bonuses.push(bonus);
      bonusIndex.set(bonus, b);
    }
    oases.push([r.x, r.y, b, r.occupied === 'yes' || r.occupied === true ? 1 : 0, animalsText(r.animal_types)]);
  }
  if (oases.length === 0) throw new Error('The scan contains no oases.');
  return { v: 1, world, serverUrl, scannedAt: Math.round(scannedAt), bounds, bonuses, oases };
}

export const ANIMALS: Record<number, [string, string]> = {
  31: ['rat', 'rats'],
  32: ['spider', 'spiders'],
  33: ['snake', 'snakes'],
  34: ['bat', 'bats'],
  35: ['wild boar', 'wild boars'],
  36: ['wolf', 'wolves'],
  37: ['bear', 'bears'],
  38: ['crocodile', 'crocodiles'],
  39: ['tiger', 'tigers'],
  40: ['elephant', 'elephants'],
};

/** "3 rats, 1 wolf", or "" for none. */
export function animalsLabel(text: string): string {
  if (!text) return '';
  return text
    .split(',')
    .map((part) => {
      const [id, n] = part.split(':').map(Number);
      const name = ANIMALS[id];
      return name ? `${n} ${n === 1 ? name[0] : name[1]}` : '';
    })
    .filter(Boolean)
    .join(', ');
}
