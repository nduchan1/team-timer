// Where the oasis map data comes from:
//   built-in   public/oasis-data/ (made by scripts/oasis-data.ts; deployed with the site, not on GitHub)
//   team       uploaded once by a teammate, kept in the room on Firebase:
//                rooms/{room}/oasisIndex/{world key}  {world, serverUrl, scannedAt, count, by, at}
//                rooms/{room}/oasisData/{world key}   the compact world as one JSON string
// The helper connects to Firebase only while it reads or writes, so an open helper tab doesn't hold
// one of the free plan's connections.

import { child, get, goOffline, goOnline, ref, serverTimestamp, update, type Database } from 'firebase/database';
import { firebaseConfigured, getHelperDb } from '../sync/firebase.ts';
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

let users = 0;

/**
 * Runs fn with the helper's own connection online, and takes it offline again once nothing is pending.
 * It stays online until the request settles even after the timeout fired, so a slow write is never left
 * queued for a later reconnect.
 */
function online<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = getHelperDb();
  if (users++ === 0) goOnline(db);
  const work = fn(db);
  const done = () => {
    if (--users === 0) goOffline(db);
  };
  work.then(done, done);
  return withTimeout(work, 20_000);
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
    const snap = await online((db) => get(ref(db, `rooms/${roomId}/oasisData/${key}`)));
    const text = snap.val();
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
  const write = online((db) =>
    update(child(ref(db, 'rooms'), roomId), {
      [`oasisIndex/${meta.key}`]: { world: meta.world, serverUrl: meta.serverUrl, scannedAt: meta.scannedAt, count: meta.count, by: name, at: serverTimestamp() },
      [`oasisData/${meta.key}`]: data,
    }),
  );
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

/** One entry per world: the newest scan wins (a team upload replaces an older built-in scan). */
export function mergeWorlds(...lists: WorldEntry[][]): WorldEntry[] {
  const best = new Map<string, WorldEntry>();
  for (const e of lists.flat()) {
    const cur = best.get(e.key);
    if (!cur || e.scannedAt > cur.scannedAt) best.set(e.key, e);
  }
  return [...best.values()].sort((a, b) => b.scannedAt - a.scannedAt);
}
