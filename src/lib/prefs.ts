// Per-player preferences in localStorage. Storage can be missing or throw (private windows, blocked
// site data), so every access is wrapped and the app works with defaults.

export type ChimePreset = 'bell' | 'double' | 'soft';

export interface Prefs {
  name: string;
  /** 0–100 */
  volume: number;
  muted: boolean;
  preset: ChimePreset;
  /** Seconds before the raid for the soft warning chime; 0 = off. */
  preWarnSec: number;
  /** Chime only while I'm on duty (or while nobody is). */
  dutyOnly: boolean;
  checklist: Record<string, boolean>;
}

export interface RecentRoom {
  id: string;
  at: number;
}

const PREFS_KEY = 'tt.prefs';
const RECENT_KEY = 'tt.recent';

export const DEFAULT_PREFS: Prefs = {
  name: '',
  volume: 80,
  muted: false,
  preset: 'bell',
  preWarnSec: 0,
  dutyOnly: false,
  checklist: {},
};

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: keep working in memory
  }
}

export function loadPrefs(): Prefs {
  const p = read<Partial<Prefs>>(PREFS_KEY) ?? {};
  return {
    name: typeof p.name === 'string' ? p.name.slice(0, 24) : DEFAULT_PREFS.name,
    volume: typeof p.volume === 'number' ? Math.min(100, Math.max(0, p.volume)) : DEFAULT_PREFS.volume,
    muted: p.muted === true,
    preset: p.preset === 'double' || p.preset === 'soft' ? p.preset : 'bell',
    preWarnSec: [0, 5, 10, 15, 30].includes(p.preWarnSec as number) ? (p.preWarnSec as number) : 0,
    dutyOnly: p.dutyOnly === true,
    checklist: p.checklist && typeof p.checklist === 'object' ? p.checklist : {},
  };
}

export function savePrefs(p: Prefs): void {
  write(PREFS_KEY, p);
}

export function loadRecent(): RecentRoom[] {
  const list = read<RecentRoom[]>(RECENT_KEY);
  return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string').slice(0, 8) : [];
}

export function rememberRoom(id: string): void {
  const list = loadRecent().filter((r) => r.id !== id);
  list.unshift({ id, at: Date.now() });
  write(RECENT_KEY, list.slice(0, 8));
}

export function forgetRoom(id: string): void {
  write(RECENT_KEY, loadRecent().filter((r) => r.id !== id));
}
