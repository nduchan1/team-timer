// Where the oasis map data comes from:
//   built-in   public/oasis-data/ (made by scripts/oasis-data.ts; deployed with the site, not on GitHub)
//   team       uploaded once by a teammate, kept in the room on Firebase:
//                rooms/{room}/oasisIndex/{world key}  {world, serverUrl, scannedAt, count, by, at}
//                rooms/{room}/oasisData/{world key}   the compact world as one JSON string
// Small reads and writes use the helper's own Firebase connection, which stays open while the page is
// open. (Switching it off right after a read made the SDK note a "websocket failure" in this browser, so
// the next connections started on slow long polling and a 360 KB upload timed out.) The scan itself
// (hundreds of KB) goes over the database's REST API: one request, whatever the connection does.

import { get, ref, remove, serverTimestamp, update, type Database } from 'firebase/database';
import { databaseURL, firebaseConfigured, getHelperDb } from '../sync/firebase.ts';
import { markKey, parseFarm, type FarmState, type MergeResult } from './farmState.ts';
import { compactScan, metaOf, worldKey, type OasisWorld, type WorldMeta } from './scanFormat.ts';

export type Source = 'built-in' | 'team' | 'this tab';

export interface WorldEntry extends WorldMeta {
  source: Source;
  /** Who uploaded it (team data). */
  by?: string;
}

/** The longest compact world the rules accept. */
export const MAX_DATA_CHARS = 2_000_000;

const BASE = `${import.meta.env.BASE_URL}oasis-data/`;

export const teamStorageAvailable = firebaseConfigured;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Without the file, a dev or preview server answers with the app's index.html.
  const text = await res.text();
  return JSON.parse(text) as unknown;
}

function isMeta(v: unknown): v is WorldMeta {
  const m = v as Partial<WorldMeta> | null;
  return !!m && typeof m.key === 'string' && typeof m.world === 'string' && typeof m.serverUrl === 'string' && worldKey(m.serverUrl) === m.key && typeof m.scannedAt === 'number' && typeof m.count === 'number';
}

/** Worlds shipped with the site (none when the file is missing). */
export async function listBuiltIn(): Promise<WorldEntry[]> {
  try {
    const list = await fetchJson(`${BASE}index.json`);
    return Array.isArray(list) ? list.filter(isMeta).map((m) => ({ ...m, source: 'built-in' as const })) : [];
  } catch {
    return [];
  }
}

export async function loadBuiltIn(key: string): Promise<OasisWorld> {
  if (!/^[a-z0-9_-]{3,60}$/.test(key)) throw new Error('Unknown world.');
  return compactScan(await fetchJson(`${BASE}${key}.json`));
}

/** Runs fn on the helper's own connection; the timeout only decides when to tell the player. */
function online<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return withTimeout(fn(getHelperDb()), 20_000);
}

/** A request to the database's REST API (same rules as the SDK). Refusals come back as permission_denied. */
async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(`${databaseURL}/${path}.json`, { ...init, signal: ctl.signal, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) throw new Error('permission_denied');
    if (!res.ok) throw new Error(`The server answered ${res.status}. Try again.`);
    return (await res.json()) as unknown;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('No answer from the server. Check the connection and try again.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

let saving: Promise<unknown> | null = null;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('No answer from the server. Check the connection and try again.')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function friendly(e: unknown, op: 'read' | 'write'): Error {
  const s = e instanceof Error ? e.message : String(e);
  if (/permission[_ ]denied/i.test(s)) {
    return new Error(
      op === 'read'
        ? 'not available yet (the database rules for it are not published).'
        : 'The server refused it. (Are the new database rules published? A second upload within a minute is also refused.)',
    );
  }
  return e instanceof Error ? e : new Error(s);
}

/** Worlds a teammate uploaded to this room. */
export async function listTeam(roomId: string): Promise<WorldEntry[]> {
  if (!firebaseConfigured) return [];
  try {
    const snap = await online((db) => get(ref(db, `rooms/${roomId}/oasisIndex`)));
    const val = (snap.val() ?? {}) as Record<string, Record<string, unknown>>;
    const out: WorldEntry[] = [];
    for (const [key, m] of Object.entries(val)) {
      const meta = { key, world: m.world, serverUrl: m.serverUrl, scannedAt: m.scannedAt, count: m.count };
      if (isMeta(meta)) out.push({ ...meta, source: 'team', by: typeof m.by === 'string' ? m.by : undefined });
    }
    return out;
  } catch (e) {
    throw friendly(e, 'read');
  }
}

export async function loadTeam(roomId: string, key: string): Promise<OasisWorld> {
  try {
    const text = await rest(`rooms/${roomId}/oasisData/${key}`);
    if (typeof text !== 'string') throw new Error('This world’s data is missing.');
    return compactScan(JSON.parse(text));
  } catch (e) {
    throw friendly(e, 'read');
  }
}

/** Saves a world for everyone with the room link. */
export async function saveTeam(roomId: string, world: OasisWorld, by: string): Promise<WorldEntry> {
  const meta = metaOf(world);
  const data = JSON.stringify(world);
  if (data.length > MAX_DATA_CHARS) throw new Error(`This scan is too big to share (${Math.round(data.length / 1000)} k characters; the limit is ${MAX_DATA_CHARS / 1000} k).`);
  const name = (by.trim() || 'Someone').slice(0, 24);
  if (saving) throw new Error('The last upload is still being saved. Wait a moment.');
  // One multi-path PATCH: the rules need the index and the data written together.
  const write = rest(`rooms/${roomId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      [`oasisIndex/${meta.key}`]: { world: meta.world, serverUrl: meta.serverUrl, scannedAt: meta.scannedAt, count: meta.count, by: name, at: { '.sv': 'timestamp' } },
      [`oasisData/${meta.key}`]: data,
    }),
  });
  saving = write;
  write.then(
    () => (saving = null),
    () => (saving = null),
  );
  try {
    await write;
  } catch (e) {
    throw friendly(e, 'write');
  }
  return { ...meta, source: 'team', by: name };
}

// ---- the team's saved farm lists and ticks (rooms/{room}/farm/{world}) ------------------------------

const farmPath = (roomId: string, key: string) => `rooms/${roomId}/farm/${key}`;

export async function loadFarm(roomId: string, key: string): Promise<FarmState> {
  try {
    const snap = await online((db) => get(ref(db, farmPath(roomId, key))));
    return parseFarm(snap.val());
  } catch (e) {
    throw friendly(e, 'read');
  }
}

/** Writes a merge's changes in one update; every record gets the server time. */
export async function saveFarm(roomId: string, key: string, writes: Extract<MergeResult, { ok: true }>['writes']): Promise<void> {
  const data: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(writes)) data[path] = value === null ? null : { ...value, at: serverTimestamp() };
  if (Object.keys(data).length === 0) return;
  try {
    await online((db) => update(ref(db, farmPath(roomId, key)), data));
  } catch (e) {
    throw friendly(e, 'write');
  }
}

/** Removes one saved list (it no longer exists in the game). */
export async function removeList(roomId: string, key: string, lk: string): Promise<void> {
  try {
    await online((db) => remove(ref(db, `${farmPath(roomId, key)}/lists/${lk}`)));
  } catch (e) {
    throw friendly(e, 'write');
  }
}

/** The shared "Added" tick: on (for village vx|vy) or off. */
export async function setMark(roomId: string, key: string, x: number, y: number, village: { x: number; y: number } | null, by: string): Promise<void> {
  const path = `${farmPath(roomId, key)}/marks/${markKey(x, y)}`;
  try {
    await online((db) =>
      village ? update(ref(db, path), { vx: village.x, vy: village.y, by: (by.trim() || 'Someone').slice(0, 24), at: serverTimestamp() }) : remove(ref(db, path)),
    );
  } catch (e) {
    throw friendly(e, 'write');
  }
}

/** One entry per world: the newest scan wins (a team upload replaces an older built-in scan). */
export function mergeWorlds(...lists: WorldEntry[][]): WorldEntry[] {
  const best = new Map<string, WorldEntry>();
  for (const e of lists.flat()) {
    const cur = best.get(e.key);
    if (!cur || e.scannedAt > cur.scannedAt) best.set(e.key, e);
  }
  return [...best.values()].sort((a, b) => b.scannedAt - a.scannedAt);
}
