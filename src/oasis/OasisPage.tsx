import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { formatAgo } from '../lib/format.ts';
import { loadPrefs } from '../lib/prefs.ts';
import { analyze, coordText, GROUP_LABEL, parseCoords, viewFromPaste, type MissingOasis, type OasisGroup, type TickedOasis, type VillageResult } from './analyze.ts';
import { EMPTY_FARM, forgetWrites, lastSaved, mergePaste, viewFromFarm, type FarmState, type MergeReport } from './farmState.ts';
import { checkMoves, FAR, keyedView, MIN_GAIN, planMoves, type Alarm, type Grown, type MoveCheck, type MovePlan, type MoveStep, type Spot } from './moves.ts';
import {
  listBuiltIn,
  listTeam,
  loadBuiltIn,
  loadFarm,
  loadTeam,
  mergeWorlds,
  saveFarm,
  removeList,
  saveTeam,
  setMark,
  teamStorageAvailable,
  type WorldEntry,
} from './oasisStore.ts';
import { LIST_MAX, parsePaste, type ParsedPaste, type PastedVillage } from './parsePaste.ts';
import { animalsLabel, compactScan, metaOf, type Bounds, type OasisWorld } from './scanFormat.ts';

const GROUPS: OasisGroup[] = ['easy', 'medium', 'hard'];
const SETTINGS_KEY = 'tt.oasis';

interface Settings {
  radius: number;
  groups: OasisGroup[];
  allVillages: boolean;
}

// Only the view settings are remembered; the paste itself is never stored.
function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return {
      radius: typeof s.radius === 'number' && s.radius >= 1 && s.radius <= 50 ? s.radius : 20,
      groups: Array.isArray(s.groups) && s.groups.every((g) => GROUPS.includes(g)) && s.groups.length > 0 ? s.groups : GROUPS,
      allVillages: s.allVillages === true,
    };
  } catch {
    return { radius: 20, groups: GROUPS, allVillages: false };
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: settings last for this tab
  }
}

const WHOLE_PAGE = 'Copy the whole Farm List page (Ctrl+A, then Ctrl+C): both the farm lists and the village list are needed.';

// Open move alarms, per room and world: in this tab only (sessionStorage), so a reload doesn't drop one.
const ALARMS_KEY = 'tt.oasis.alarms';
const WHYS = new Set(['farther', 'twice', 'check', 'missing', 'lost', 'unconfirmed', 'along', 'watch']);
const isSpot = (s: unknown) => !!s && typeof (s as Spot).village === 'string' && typeof (s as Spot).twin === 'number';
/** An alarm as this build writes it (one from an older build is dropped). */
const isAlarm = (a: unknown): a is Alarm => {
  const x = a as Alarm;
  return (
    !!x &&
    typeof x.key === 'string' &&
    typeof x.x === 'number' &&
    typeof x.y === 'number' &&
    WHYS.has(x.why) &&
    ['red', 'amber', 'quiet'].includes(x.level) &&
    typeof x.safeD2 === 'number' &&
    typeof x.wasDist === 'number' &&
    typeof x.nowDist === 'number' &&
    isSpot(x.from) &&
    isSpot(x.fix) &&
    (x.at === null || isSpot(x.at)) &&
    (x.holder === null || isSpot(x.holder)) &&
    typeof x.fixId === 'string' &&
    typeof x.atId === 'string' &&
    typeof x.holderId === 'string' &&
    Array.isArray(x.grown) &&
    x.grown.every((g) => !!g && typeof g.id === 'string' && isSpot(g.spot) && typeof g.by === 'number' && typeof g.dist === 'number')
  );
};

function loadAlarms(key: string): Record<string, Alarm[]> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, Alarm[]> = {};
    for (const [world, list] of Object.entries(raw as Record<string, unknown>)) if (Array.isArray(list)) out[world] = list.filter(isAlarm);
    return out;
  } catch {
    return {};
  }
}

// Without a team room: the lists as this tab knows them (sessionStorage), to check the next paste against.
const LOCAL_FARM_KEY = 'tt.oasis.localFarm';

function loadLocalFarm(): FarmState | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(LOCAL_FARM_KEY) ?? 'null') as FarmState | null;
    const ok = !!raw && Array.isArray(raw.villages) && Array.isArray(raw.lists) && Array.isArray(raw.marks) && raw.lists.every((l) => typeof l.lk === 'string' && typeof l.oases === 'string');
    return ok ? raw : null;
  } catch {
    return null;
  }
}

/** A paste merged into this tab's lists; from another account or server, it starts over (nothing to compare). */
function mergeLocal(base: FarmState, p: ParsedPaste) {
  const r = mergePaste(base, p, 'me', Date.now());
  return !r.ok && r.reason === 'no-overlap' ? mergePaste(EMPTY_FARM, p, 'me', Date.now()) : r;
}

function saveLocalFarm(state: FarmState): void {
  try {
    sessionStorage.setItem(LOCAL_FARM_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable: the baseline lasts until the page is reloaded
  }
}

// In a team room: the lists as this tab last saw them itself, per world (sessionStorage).
const TAB_BASE_KEY = 'tt.oasis.tabBase';
/** Older than this, the tab's baseline gives way to the team's lists (teammates' changes are long settled). */
const TAB_BASE_MS = 60 * 60 * 1000;
type TabBase = { state: FarmState; at: number };

function loadTabBase(key: string): Record<string, TabBase> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, TabBase>;
    const out: Record<string, TabBase> = {};
    for (const [world, tb] of Object.entries(raw ?? {})) {
      const s = tb?.state;
      if (typeof tb?.at === 'number' && s && Array.isArray(s.villages) && Array.isArray(s.lists) && Array.isArray(s.marks) && s.lists.every((l) => typeof l.lk === 'string' && typeof l.oases === 'string'))
        out[world] = tb;
    }
    return out;
  } catch {
    return {};
  }
}

function saveTabBase(key: string, bases: Record<string, TabBase>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(bases));
  } catch {
    // storage unavailable: the baseline lasts until the page is reloaded
  }
}

function saveAlarms(key: string, alarms: Record<string, Alarm[]>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(alarms));
  } catch {
    // storage unavailable: alarms last until the page is reloaded
  }
}

/** One line about what a paste changed in the team's saved lists. */
function reportText(r: MergeReport): string {
  const parts: string[] = [];
  if (r.replaced) parts.push(`${r.replaced} updated`);
  if (r.merged) parts.push(`${r.merged} merged`);
  if (r.kept + r.recounted) parts.push(`${r.kept + r.recounted} kept as saved`);
  if (r.unknown) parts.push(`${r.unknown} never expanded`);
  if (r.deleted) parts.push(`${r.deleted} removed`);
  if (r.confirmedTicks) parts.push(`${r.confirmedTicks} ${r.confirmedTicks === 1 ? 'tick' : 'ticks'} confirmed`);
  const text = parts.length ? `Saved for the team: ${parts.join(', ')}.` : 'Saved for the team: nothing changed.';
  return r.unmatched.length ? `${text} Not saved (no village matched): ${r.unmatched.join(', ')}.` : text;
}

interface SaveNote {
  tone: 'ok' | 'error';
  text: string;
  /** The paste and world it is about. */
  paste: string;
  key: string;
  /** The paste is from another account or server: offer to replace the saved lists with it. */
  canReplace?: boolean;
}

/** The last paste's check: its result, or why it wasn't saved (then result is null: not checked). */
interface CheckState {
  key: string;
  at: number;
  result: MoveCheck | null;
  error: string | null;
}

const timeText = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateText = (ms: number) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const tileUrl = (w: OasisWorld, x: number, y: number) => `${w.serverUrl}/position_details.php?x=${x}&y=${y}`;
const farmListUrl = (w: OasisWorld) => `${w.serverUrl}/build.php?gid=16&tt=99`;

export default function OasisPage({ roomId }: { roomId: string | null }) {
  const [entries, setEntries] = useState<WorldEntry[] | null>(null);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState('');
  const [uploaded, setUploaded] = useState<OasisWorld[]>([]);
  const [paste, setPaste] = useState('');
  const [settings, setSettings] = useState(loadSettings);
  const [extra, setExtra] = useState<PastedVillage[]>([]);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [radiusText, setRadiusText] = useState(() => String(settings.radius));

  useEffect(() => {
    const set = () => {
      document.title = 'Oasis helper · Team Timer';
    };
    set();
    // A room left in this tab resets the title when its timer stops, about a second later.
    const t = setTimeout(set, 1100);
    return () => clearTimeout(t);
  }, []);

  // The list of worlds: shipped with the site, plus what the team uploaded to this room.
  useEffect(() => {
    let live = true;
    const builtIn = listBuiltIn();
    const team: Promise<WorldEntry[]> =
      roomId && teamStorageAvailable
        ? listTeam(roomId).catch((e: Error) => {
            if (live) setListError(`Team data: ${e.message}`);
            return [];
          })
        : Promise.resolve([]);
    void Promise.all([builtIn, team]).then(([built, shared]) => {
      if (!live) return;
      const all = mergeWorlds(built, shared);
      setEntries(all);
      setSelected((cur) => cur || all[0]?.key || '');
    });
    return () => {
      live = false;
    };
  }, [roomId]);

  const options = useMemo(
    () => mergeWorlds(entries ?? [], uploaded.map((w) => ({ ...metaOf(w), source: 'this tab' as const }))),
    [entries, uploaded],
  );
  const entry = options.find((e) => e.key === selected) ?? null;
  // A world uploaded in this tab is used as it is; others are loaded (and kept) by their source.
  const local = entry ? uploaded.find((w) => metaOf(w).key === entry.key && w.scannedAt === entry.scannedAt) : undefined;
  const loadKey = entry && !local ? `${entry.source}:${entry.key}:${entry.scannedAt}` : null;
  const [loaded, setLoaded] = useState<Record<string, OasisWorld>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  // Already loaded worlds are not downloaded again when the dropdown comes back to them.
  const have = loadKey !== null && loadKey in loaded;

  useEffect(() => {
    if (!entry || !loadKey || have) return;
    let live = true;
    const load = entry.source === 'team' && roomId ? loadTeam(roomId, entry.key) : loadBuiltIn(entry.key);
    load.then(
      (w) => live && setLoaded((cur) => ({ ...cur, [loadKey]: w })),
      (e: Error) => live && setLoadErrors((cur) => ({ ...cur, [loadKey]: e.message })),
    );
    return () => {
      live = false;
    };
  }, [entry, loadKey, roomId, have, attempt]);

  const retry = () => {
    if (loadKey) {
      setLoadErrors((cur) => {
        const next = { ...cur };
        delete next[loadKey];
        return next;
      });
    }
    setAttempt((n) => n + 1);
  };

  const world: OasisWorld | null = local ?? (loadKey ? (loaded[loadKey] ?? null) : null);
  const worldError = loadKey ? (loadErrors[loadKey] ?? '') : '';

  const parsed = useMemo(() => (paste.trim() ? parsePaste(paste) : null), [paste]);
  const groups = useMemo(() => new Set(settings.groups), [settings.groups]);

  // ---- the team's saved farm lists and ticks (room mode) ----
  const shared = roomId !== null && teamStorageAvailable;
  const worldKey = world ? metaOf(world).key : null;
  // Saved state per world, so a late answer for another world can't take this one's place.
  const [farms, setFarms] = useState<Record<string, FarmState>>({});
  const [farmError, setFarmError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<SaveNote | null>(null);
  const [handled, setHandled] = useState<{ paste: string; key: string } | null>(null);
  const lastLoad = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const myName = () => loadPrefs().name.trim() || 'Someone';
  const putFarm = (key: string, state: FarmState) => setFarms((cur) => ({ ...cur, [key]: state }));

  // ---- oases to move: the plan, the check of each paste, and alarms that stay until fixed (this tab) ----
  // The destination list the player picked per village (this tab only), as state for rendering and as a ref
  // for the save chain.
  const [prefer, setPrefer] = useState<Record<string, string>>({});
  const preferRef = useRef<Record<string, string>>({});
  const [pointer, setPointer] = useState<{ key: string | null; index: number }>({ key: null, index: 0 });
  const [moveCheck, setMoveCheck] = useState<CheckState | null>(null);
  // Alarms and quiet watches per world (only the alarms are shown). Kept for this tab across reloads.
  const alarmsKey = `${ALARMS_KEY}.${roomId ?? 'local'}`;
  const [alarms, setAlarms] = useState<Record<string, Alarm[]>>(() => loadAlarms(alarmsKey));
  const alarmsRef = useRef<Record<string, Alarm[]>>(alarms);
  const putAlarms = useCallback(
    (next: Record<string, Alarm[]>) => {
      alarmsRef.current = next;
      setAlarms(next);
      saveAlarms(alarmsKey, next);
    },
    [alarmsKey],
  );
  /** Without a team room: the lists as this tab knows them (pastes merged), to check the next paste against. */
  const [localState, setLocalState] = useState<FarmState | null>(() => (roomId === null ? loadLocalFarm() : null));
  const localFarm = useRef<FarmState | null>(localState);
  /**
   * In a team room: the team's lists as this tab last saw them itself (loaded, or after its own paste). A paste
   * is checked against this, so a teammate's paste in between can't hide a move made from this tab.
   */
  const tabBaseKey = `${TAB_BASE_KEY}.${roomId ?? 'local'}`;
  const [tabStart] = useState(() => (roomId !== null ? loadTabBase(tabBaseKey) : {}));
  const tabBase = useRef<Record<string, TabBase>>(tabStart);
  const putTabBase = useCallback(
    (key: string, state: FarmState | null) => {
      const next = { ...tabBase.current };
      if (state) next[key] = { state, at: Date.now() };
      else delete next[key];
      tabBase.current = next;
      saveTabBase(tabBaseKey, next);
    },
    [tabBaseKey],
  );
  const publishCheck = useCallback(
    (key: string, result: MoveCheck) => {
      putAlarms({ ...alarmsRef.current, [key]: [...result.alarms, ...result.quiet] });
      setMoveCheck({ key, at: Date.now(), result, error: null });
    },
    [putAlarms],
  );
  /** A paste that couldn't be saved: checked but not saved, or not checked at all (then the last check goes). */
  const noCheck = useCallback((key: string, error: string, checked: boolean) => {
    setMoveCheck((cur) => (checked && cur?.key === key ? { ...cur, error } : { key, at: Date.now(), result: null, error }));
  }, []);

  const reload = async (key = worldKey) => {
    if (!shared || !roomId || !key) return;
    try {
      const state = await loadFarm(roomId, key);
      lastLoad.current = Date.now();
      putFarm(key, state);
      setFarmError('');
    } catch (e) {
      setFarmError((e as Error).message);
    }
  };

  useEffect(() => {
    if (!shared || !roomId || !worldKey) return;
    let live = true;
    const load = (first: boolean) =>
      loadFarm(roomId, worldKey).then(
        (state) => {
          if (!live) return;
          lastLoad.current = Date.now();
          setFarms((cur) => ({ ...cur, [worldKey]: state }));
          setFarmError('');
          // The first look at this world in this tab (or an old one) becomes the tab's baseline.
          const tb = tabBase.current[worldKey];
          if (!tb || Date.now() - tb.at > TAB_BASE_MS) putTabBase(worldKey, state);
        },
        (e: Error) => live && first && setFarmError(e.message),
      );
    void load(true);
    // Coming back to the tab shows teammates' ticks and pastes (at most every 30 s).
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad.current >= 30_000) void load(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [shared, roomId, worldKey, putTabBase]);

  /**
   * Merges a paste into the team's saved lists. Saves run one at a time, each on a fresh read. With the map's
   * bounds, the paste is also checked against the lists as they were (moves done, oases now farther away).
   */
  const saveFromPaste = useCallback(
    (text: string, key: string, bounds: Bounds | null, replace = false) => {
      const put = (state: FarmState) => setFarms((cur) => ({ ...cur, [key]: state }));
      saveChain.current = saveChain.current.then(async () => {
        if (!roomId) return;
        const p = parsePaste(text);
        if (p.villages.length === 0 || p.lists.length === 0) {
          // The paste summary says what is wrong; card 3 mustn't keep showing the last check.
          if (bounds && !replace) noCheck(key, WHOLE_PAGE, false);
          return;
        }
        setSaving(true);
        let checked = false;
        try {
          const fresh = await loadFarm(roomId, key);
          const r = mergePaste(fresh, p, loadPrefs().name.trim() || 'Someone', Date.now(), { replace });
          if (!r.ok) {
            put(fresh);
            setSaveNote({ tone: 'error', text: r.error, paste: text, key, canReplace: r.reason === 'no-overlap' });
            if (bounds && !replace) noCheck(key, r.error, false);
            return;
          }
          if (bounds && !replace) {
            checked = true;
            const open = alarmsRef.current[key] ?? [];
            // Against this tab's own baseline (recent), with what teammates' pastes changed since in between.
            const tb = tabBase.current[key];
            const own = tb && Date.now() - tb.at <= TAB_BASE_MS ? tb.state : null;
            const before = viewFromFarm(own ?? fresh, p.deactivated);
            const plan = planMoves(before, bounds, { prefer: preferRef.current, skip: alarmedKeys(open) });
            // Shown before the save, so a failed save can't hide an alarm.
            publishCheck(key, checkMoves(before, keyedView(viewFromPaste(p)), bounds, plan, open, own ? viewFromFarm(fresh, p.deactivated) : undefined));
          }
          await saveFarm(roomId, key, r.writes);
          put(r.next);
          putTabBase(key, r.next);
          setSaveNote({ tone: 'ok', text: reportText(r.report), paste: text, key });
          // The lists were replaced with another account's: nothing to compare, so no check to show.
          if (replace) setMoveCheck((cur) => (cur?.key === key ? null : cur));
          // Read back, so the records carry the server's times.
          put(await loadFarm(roomId, key));
          lastLoad.current = Date.now();
        } catch (e) {
          setSaveNote({ tone: 'error', text: (e as Error).message, paste: text, key });
          if (bounds && !replace) noCheck(key, (e as Error).message, checked);
        } finally {
          setSaving(false);
        }
      });
    },
    [roomId, publishCheck, noCheck, putTabBase],
  );

  // A paste is saved 0.6 s after it last changed (also one made before the server data finished loading).
  const bounds = world?.bounds ?? null;
  useEffect(() => {
    if (!shared || !roomId || !worldKey || !paste.trim()) return;
    if (handled && handled.paste === paste && handled.key === worldKey) return;
    const key = worldKey;
    const text = paste;
    const t = setTimeout(() => {
      setHandled({ paste: text, key });
      saveFromPaste(text, key, bounds);
    }, 600);
    return () => clearTimeout(t);
  }, [shared, roomId, worldKey, paste, handled, saveFromPaste, bounds]);

  /**
   * Without a team room, a paste is checked against the lists as this tab knows them: earlier pastes merged
   * (like the team's saved lists), so a list copied collapsed keeps what it showed last time.
   */
  const checkLocal = (text: string, w: OasisWorld | null) => {
    const p = parsePaste(text);
    const key = w ? metaOf(w).key : null;
    if (p.villages.length === 0 || p.lists.length === 0) {
      if (key) noCheck(key, WHOLE_PAGE, false);
      return;
    }
    const base = localFarm.current ?? EMPTY_FARM;
    // The map isn't loaded yet: only the first paste is kept (a later one is checked once the map is there).
    if (!w || !key) {
      if (base.villages.length === 0) {
        const first = mergeLocal(base, p);
        if (first.ok) putLocalFarm(first.next);
      }
      return;
    }
    const r = mergeLocal(base, p);
    if (!r.ok) {
      noCheck(key, r.error, false);
      return;
    }
    if (base.villages.length > 0 && p.villages.some((v) => base.villages.some((q) => q.x === v.x && q.y === v.y))) {
      const open = alarmsRef.current[key] ?? [];
      const before = viewFromFarm(base, p.deactivated);
      const plan = planMoves(before, w.bounds, { prefer: preferRef.current, skip: alarmedKeys(open) });
      publishCheck(key, checkMoves(before, keyedView(viewFromPaste(p)), w.bounds, plan, open));
    }
    putLocalFarm(r.next);
  };
  const putLocalFarm = (state: FarmState) => {
    localFarm.current = state;
    setLocalState(state);
    saveLocalFarm(state);
  };

  const onPasteChange = (text: string) => {
    setPaste(text);
    setSaveNote(null);
    if (!shared && text.trim()) checkLocal(text, world);
  };

  // The saved team state, unless this paste couldn't be saved (then the paste is shown on its own).
  const farmState = shared && worldKey ? (farms[worldKey] ?? null) : null;
  const pasteRefused = saveNote?.tone === 'error' && saveNote.paste === paste && saveNote.key === worldKey && parsed !== null;
  const view = useMemo(() => {
    // The team's saved lists, or (no team room) the lists as this tab knows them from its pastes.
    const known = farmState && !pasteRefused ? farmState : roomId === null && parsed && parsed.villages.length > 0 && parsed.lists.length > 0 ? localState : null;
    if (known) {
      const v = viewFromFarm(known, parsed?.deactivated ?? []);
      // This paste's lists that couldn't be matched (so weren't saved) still count as taken.
      const unmatched = parsed ? viewFromPaste(parsed).lists.filter((l) => l.village === null) : [];
      return unmatched.length > 0 ? { ...v, lists: [...v.lists, ...unmatched] } : v;
    }
    // A paste on its own: its lists get the keys they would be saved under, so the next paste can be compared.
    return parsed ? keyedView(viewFromPaste(parsed)) : null;
  }, [farmState, pasteRefused, parsed, roomId, localState]);
  const result = useMemo(
    () => (world ? analyze(world, view, { radius: settings.radius, groups, allVillages: settings.allVillages, extraVillages: extra }) : null),
    [world, view, settings.radius, groups, settings.allVillages, extra],
  );
  // Shown alarms (red and amber) of this world; their oases get no step (the alarm says where they go).
  const openAlarms = useMemo(() => (worldKey ? (alarms[worldKey] ?? []).filter((a) => a.level !== 'quiet') : []), [alarms, worldKey]);
  const plan = useMemo(
    () => (world && view ? planMoves(view, world.bounds, { prefer, skip: alarmedKeys(openAlarms) }) : null),
    [world, view, prefer, openAlarms],
  );
  const check = moveCheck && moveCheck.key === worldKey ? moveCheck : null;
  // A paste not saved and checked yet (it is, 0.6 s after it last changed).
  const pastePending = shared && !!paste.trim() && !(handled?.paste === paste && handled?.key === worldKey);
  const pickList = (village: string, id: string) => {
    preferRef.current = { ...preferRef.current, [village]: id };
    setPrefer(preferRef.current);
  };
  const dismissAlarms = (keys: string[]) => {
    if (!worldKey) return;
    putAlarms({ ...alarmsRef.current, [worldKey]: (alarmsRef.current[worldKey] ?? []).filter((a) => !keys.includes(a.key)) });
  };
  // Not a link to "#moves": the hash is the page's route.
  const seeMoves = () => document.getElementById('moves')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  /** Ticks are shared for the team's saved villages; for a village typed in by hand they stay in this tab. */
  const sharesTicks = (v: PastedVillage) => !!farmState && !pasteRefused && farmState.villages.some((s) => s.x === v.x && s.y === v.y);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  const toggleDone = (k: string) =>
    setDone((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  /** The "Added" tick: shared with the team for a saved village, just this tab otherwise. */
  const onTick = async (x: number, y: number, village: PastedVillage | null, share: boolean) => {
    if (!share || !roomId || !worldKey) {
      toggleDone(`${x}|${y}`);
      return;
    }
    const key = worldKey;
    const others = (cur: FarmState) => cur.marks.filter((m) => m.x !== x || m.y !== y);
    setFarms((cur) => {
      const st = cur[key];
      if (!st) return cur;
      const marks = village ? [...others(st), { x, y, vx: village.x, vy: village.y, by: myName(), at: Date.now() }] : others(st);
      return { ...cur, [key]: { ...st, marks } };
    });
    try {
      await setMark(roomId, key, x, y, village, myName());
    } catch (e) {
      setFarmError((e as Error).message);
    }
    void reload(key);
  };

  const onRemoveList = async (lk: string) => {
    if (!roomId || !worldKey) return;
    try {
      await removeList(roomId, worldKey, lk);
    } catch (e) {
      setFarmError((e as Error).message);
    }
    void reload();
  };

  const onForget = async () => {
    if (!roomId || !worldKey || !farmState) return;
    try {
      await saveFarm(roomId, worldKey, forgetWrites(farmState, myName()));
      putTabBase(worldKey, null);
      setSaveNote(null);
      setPaste('');
    } catch (e) {
      setFarmError((e as Error).message);
    }
    void reload();
  };

  /** shared: the room's new entry (with who uploaded it) when the world was saved for the team. */
  const onUploaded = (w: OasisWorld, shared: WorldEntry | null) => {
    if (shared) setEntries((cur) => mergeWorlds([shared], cur ?? []));
    setUploaded((cur) => [...cur.filter((u) => metaOf(u).key !== metaOf(w).key), w]);
    setSelected(metaOf(w).key);
  };

  return (
    <main className="oasis-page">
      <header className="topbar">
        <a className="logo" href="#" title="Team Timer home (your timer keeps running in its own tab)">
          ⏳ Team Timer
        </a>
        <span className="muted">Oasis helper</span>
      </header>

      <section className="card">
        <h2>Oasis helper</h2>
        <p className="muted">
          For each of your villages: the free oases within {settings.radius} fields that aren’t in any of your farm lists yet. Open one
          in the game and click <b>Add to farm list</b>, or copy its <code>(x|y)</code> into the X field of a farm list’s <b>Add target</b>.
        </p>
        <WorldPicker
          entries={entries}
          options={options}
          selected={selected}
          onSelect={setSelected}
          world={world}
          error={listError || worldError}
          onRetry={worldError ? retry : undefined}
          roomId={roomId}
          onUploaded={onUploaded}
        />
      </section>

      <section className="card">
        <h2>1. Your farm lists</h2>
        {shared ? (
          <>
            <p className="muted small">
              In the game, open the Farm List page, press <b>Ctrl+A</b>, <b>Ctrl+C</b>, and paste it here. The first time, expand every
              list; after that, collapsed lists are fine: their saved oases are kept. Saved for your team in this room (like the timer):
              your villages’ names and coordinates, list names and counts, and the oases in them. No player names.
            </p>
            <FarmStatus
              state={farmState}
              error={farmError}
              saving={saving}
              note={saveNote && saveNote.key === worldKey ? saveNote : null}
              onRefresh={() => void reload()}
              onForget={() => void onForget()}
              onReplace={() => saveNote && saveFromPaste(saveNote.paste, saveNote.key, null, true)}
            />
          </>
        ) : (
          <p className="muted small">
            In the game, open the Farm List page with every list expanded, press <b>Ctrl+A</b>, <b>Ctrl+C</b>, and paste it here. It stays
            in this tab: it isn’t saved or sent anywhere. Open the helper from your team’s timer (the Oases button) to save the lists and the
            ticks for the team.
          </p>
        )}
        <textarea
          className="paste"
          value={paste}
          onChange={(e) => onPasteChange(e.target.value)}
          // A paste replaces the old text (pasted after it, every list would count twice).
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (!t) return;
            e.preventDefault();
            onPasteChange(t.replace(/\r\n?/g, '\n'));
          }}
          placeholder="Paste the whole Farm List page here"
          aria-label="Farm List page text"
          spellCheck={false}
        />
        <div className="row wrap">
          {paste && (
            <button className="btn small" onClick={() => onPasteChange('')}>
              Clear
            </button>
          )}
          {parsed && <PasteSummary parsed={parsed} />}
        </div>
        {openAlarms.length > 0 && <AlarmLine alarms={openAlarms} onSee={seeMoves} />}
        <ExtraVillages extra={extra} setExtra={setExtra} />
      </section>

      <section className="card">
        <h2>2. Oases to add</h2>
        <div className="row wrap oasis-filters">
          <label className="label" htmlFor="radius">
            Within
          </label>
          <input
            id="radius"
            className="short"
            type="number"
            min={1}
            max={50}
            step={1}
            value={radiusText}
            onChange={(e) => {
              setRadiusText(e.target.value);
              const r = Number(e.target.value);
              if (Number.isInteger(r) && r >= 1 && r <= 50) update({ radius: r });
            }}
            onBlur={() => setRadiusText(String(settings.radius))}
          />
          <span className="muted">fields</span>
          {GROUPS.map((g) => (
            <label key={g} className="check">
              <input
                type="checkbox"
                checked={settings.groups.includes(g)}
                onChange={(e) => {
                  const next = e.target.checked ? [...settings.groups, g] : settings.groups.filter((x) => x !== g);
                  if (next.length > 0) update({ groups: GROUPS.filter((x) => next.includes(x)) });
                }}
              />
              {GROUP_LABEL[g]}
            </label>
          ))}
          <label className="check" title="Also villages that have no oasis in their farm lists yet">
            <input type="checkbox" checked={settings.allVillages} onChange={(e) => update({ allVillages: e.target.checked })} />
            All my villages
          </label>
        </div>

        {!world && !worldError && (entries === null || options.length > 0) && <p className="muted">Loading the oasis data…</p>}
        {entries !== null && options.length === 0 && <p className="muted">No oasis data for any server yet: upload a scan above.</p>}
        {world && result && result.villages.length === 0 && (
          <p className="muted">
            {view && view.villages.length > 0
              ? 'None of your villages has an oasis in a farm list yet. Tick “All my villages”.'
              : 'Paste your farm lists, or add a village by its coordinates.'}
          </p>
        )}
        {world && result && <Warnings result={result} moveCount={plan?.covered.size ?? 0} covered={plan?.covered ?? null} onSeeMoves={seeMoves} />}
        {world &&
          result?.villages.map((v) => (
            <VillageCard
              key={`${v.village.name}|${v.village.x}|${v.village.y}`}
              v={v}
              world={world}
              radius={settings.radius}
              sharedTicks={sharesTicks(v.village)}
              done={done}
              onTick={(x, y, village, share) => void onTick(x, y, village, share)}
              onRemoveList={farmState && !pasteRefused ? (lk) => void onRemoveList(lk) : undefined}
            />
          ))}
        {world && (
          <p className="muted small">
            Oasis data: scan of {dateText(world.scannedAt)}. Animals and owners can have changed since; the game shows the current ones.
          </p>
        )}
      </section>

      {world && (plan || openAlarms.length > 0) && (
        <MovesSection
          world={world}
          plan={plan ?? EMPTY_PLAN}
          hasLists={!!view}
          local={roomId === null}
          pointer={pointer}
          setPointer={setPointer}
          onPick={pickList}
          check={check}
          checking={saving || pastePending}
          alarms={openAlarms}
          onDismiss={dismissAlarms}
          paste={paste}
          onPaste={onPasteChange}
        />
      )}
    </main>
  );
}

const ordinal = (n: number) => `${n}${n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : n % 10 === 1 && n % 100 !== 11 ? 'st' : 'th'}`;
/** “Oases”, or “Oases” (the 2nd of that name). */
const listText = (name: string, twin: number) => `“${name}”${twin > 1 ? ` (the ${ordinal(twin)} of that name)` : ''}`;
/** R07 “Oases”, or just R07 when the list isn't known. */
const spotText = (s: Spot) => (s.list === null ? s.village : `${s.village} ${listText(s.list, s.twin)}`);
/** The entry to pick in the game's “Select farm list”: “R01 - Oases”. */
const pickText = (s: Spot) => (s.list === null ? `the new list of ${s.village}` : `${s.village} - ${s.list}`);
const itThem = (n: number) => (n === 1 ? 'it' : 'them');
const EMPTY_PLAN: MovePlan = { steps: [], count: 0, incoming: new Map(), covered: new Set(), leftFar: 0 };
/** Oases with a shown alarm: the plan gives them no step. */
const alarmedKeys = (alarms: Alarm[]) => new Set(alarms.filter((a) => a.level !== 'quiet').map((a) => a.key));

/** Card 1's short line about open alarms, with a link to card 3. */
function AlarmLine({ alarms, onSee }: { alarms: Alarm[]; onSee: () => void }) {
  const red = alarms.filter((a) => a.level === 'red').length;
  const amber = alarms.length - red;
  return (
    <div className={`banner ${red ? 'red' : 'amber'} move-alarm-line`} role="alert">
      <span>
        {red > 0 && (
          <b>
            ⚠ {red} {red === 1 ? 'oasis is' : 'oases are'} raided from farther away, or not where {red === 1 ? 'it' : 'they'} should be.{' '}
          </b>
        )}
        {amber > 0 && (
          <span>
            {amber} moved {amber === 1 ? 'oasis isn’t' : 'oases aren’t'} confirmed yet.
          </span>
        )}{' '}
        Check before the next raid round.
      </span>
      <button className="btn small" onClick={onSee}>
        See 3. Oases to move
      </button>
    </div>
  );
}

function MovesSection(props: {
  world: OasisWorld;
  plan: MovePlan;
  /** There are farm lists to plan from (saved or pasted). */
  hasLists: boolean;
  /** No team room: pastes are checked against the previous paste in this tab. */
  local: boolean;
  pointer: { key: string | null; index: number };
  setPointer: (p: { key: string | null; index: number }) => void;
  onPick: (village: string, listId: string) => void;
  check: CheckState | null;
  checking: boolean;
  alarms: Alarm[];
  onDismiss: (keys: string[]) => void;
  paste: string;
  onPaste: (text: string) => void;
}) {
  const { world, plan, hasLists, local, pointer, setPointer, onPick, check, checking, alarms, onDismiss, paste, onPaste } = props;
  const steps = plan.steps;
  const n = steps.length;
  const found = steps.findIndex((s) => s.key === pointer.key);
  // After a step is done, the next one takes its place.
  const cur = n === 0 ? -1 : found >= 0 ? found : Math.min(pointer.index, n - 1);
  const go = (i: number) => {
    const j = (i + n) % n;
    setPointer({ key: steps[j].key, index: j });
  };
  const step = cur >= 0 ? steps[cur] : null;
  const oases = plan.covered.size;
  return (
    <section className="card" id="moves">
      <h2>3. Oases to move</h2>
      <p className="muted small">
        Oases in the farm list of one village while another village that farms oases is at least {MIN_GAIN} field nearer, and within {FAR}{' '}
        fields. From there every raid arrives sooner, so the oasis gets its next hit earlier, never later. The filters above don’t change this
        list.
      </p>
      <AlarmBanner level="red" alarms={alarms} onDismiss={onDismiss} />
      <AlarmBanner level="amber" alarms={alarms} onDismiss={onDismiss} />
      {step ? (
        <>
          <p className="small">
            <b>{oases}</b> {oases === 1 ? 'oasis' : 'oases'} to move in <b>{n}</b> {n === 1 ? 'step' : 'steps'}.
          </p>
          <div className="row wrap move-steps">
            {steps.map((s, i) => (
              <button key={s.key} className={`btn small${i === cur ? ' selected' : ''}`} onClick={() => go(i)}>
                {s.fromVillage.name} {listText(s.from.name, s.fromTwin)} → {s.to.name} · {s.rows.length}
                {s.kind === 'extra' ? ' · copy' : ''}
              </button>
            ))}
          </div>
          <StepCard
            key={step.key}
            world={world}
            step={step}
            index={cur}
            count={n}
            onBack={() => go(cur - 1)}
            onNext={() => go(cur + 1)}
            onPickList={(id) => {
              onPick(`${step.to.x}|${step.to.y}`, id);
              // Stay on this list's step, now going to the picked list.
              setPointer({ key: `move:${step.from.id}>${id}`, index: cur });
            }}
            check={check}
            checking={checking}
            alarms={alarms}
            paste={paste}
            onPaste={onPaste}
          />
        </>
      ) : (
        <>
          {alarms.length > 0 && (
            <PasteBox paste={paste} onPaste={onPaste} checking={checking} placeholder="After fixing it: paste the Farm List page here (Ctrl+V)" />
          )}
          <CheckView check={check} checking={checking} alarms={alarms} />
          {hasLists && (
            <p className="muted">{alarms.length > 0 ? 'No other moves to do.' : 'Nothing to move: every listed oasis is with the nearest village that farms oases.'}</p>
          )}
        </>
      )}
      {plan.leftFar > 0 && (
        <p className="muted small">
          Left out: {plan.leftFar} {plan.leftFar === 1 ? 'oasis' : 'oases'} whose nearer village is over {FAR} fields away too. A Tournament
          Square can make the village {plan.leftFar === 1 ? 'it is' : 'they are'} with faster.
        </p>
      )}
      {local && step && (
        <p className="muted small">
          Without the team’s saved lists, each paste is checked against your previous paste in this tab. Open the helper from your team’s timer
          to save the lists for the team.
        </p>
      )}
    </section>
  );
}

function StepCard(props: {
  world: OasisWorld;
  step: MoveStep;
  index: number;
  count: number;
  onBack: () => void;
  onNext: () => void;
  onPickList: (listId: string) => void;
  check: CheckState | null;
  checking: boolean;
  alarms: Alarm[];
  paste: string;
  onPaste: (text: string) => void;
}) {
  const { world, step: s, index, count, onBack, onNext, onPickList, check, checking, alarms, paste, onPaste } = props;
  const k = s.rows.length;
  const H = s.fromVillage.name;
  const K = s.to.name;
  const from = listText(s.from.name, s.fromTwin);
  const pick = s.toList ? `${K} - ${s.toList.name}` : `the new list of ${K}`;
  const one = s.rows[0];
  // The game greys out a full list in “Select farm list” (except the target's own list).
  const holderFull = s.kind === 'extra' && !!s.toList && s.toList.total >= LIST_MAX;
  const game = (
    <a href={farmListUrl(world)} target="_blank" rel="noopener noreferrer">
      Farm List ↗
    </a>
  );
  return (
    <article className="move-card">
      <header className="village-head">
        <h3>
          Step {index + 1} of {count}
        </h3>
        {count > 1 && (
          <div className="row">
            <button className="btn small" onClick={onBack}>
              Back
            </button>
            <button className="btn small" onClick={onNext}>
              Next
            </button>
          </div>
        )}
      </header>
      {s.kind === 'move' ? (
        <p className="small">
          From <b>{H}</b> {from} ({s.from.total}/{LIST_MAX}) to <b>{K}</b>{' '}
          {s.toList && s.options.length >= 2 ? (
            <select value={s.toList.id} onChange={(e) => onPickList(e.target.value)} aria-label={`List of ${K}`}>
              {s.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.total}/{LIST_MAX})
                </option>
              ))}
            </select>
          ) : s.toList ? (
            listText(s.toList.name, s.toTwin)
          ) : (
            'in a new list'
          )}
          {s.after !== null && ` (${s.after}/${LIST_MAX} after)`}
        </p>
      ) : (
        <p className="small">
          From <b>{H}</b> {from}: {K} has {k === 1 ? 'this oasis' : 'these oases'} too{s.toList ? `, in ${listText(s.toList.name, s.toTwin)}` : ''}, and is
          nearer. Delete {k === 1 ? 'the copy' : 'the copies'} in {H}’s list.
        </p>
      )}
      <p className="small move-when">
        <b>Do this right after a raid round is sent.</b> Then paste the page here before the next round: the helper checks that every oasis went
        to the right list.
      </p>
      {s.stale && (
        <p className="small note">{from} changed since it was last expanded: some of these may be gone. Expand it and paste the page here first.</p>
      )}
      {s.kind === 'move' && !s.toList && (
        <p className="small note">
          No list of {K} has room. First click <b>Create farm list</b> at the bottom of the Farm List page and make one for {K}.
        </p>
      )}
      <ol className="small move-howto">
        <li>
          In the game’s {game}, expand {from} under {H}.
        </li>
        {s.kind === 'move' && k > 1 && (
          <>
            <li>
              Tick the {k} oases in the table below. The footer must say “{k} selected”: with nothing ticked, the menu acts on the whole list.
            </li>
            <li>
              Click ☰ left of <b>Start</b>. It must say <b>Edit ({k})</b>: click it.
            </li>
            <li>
              In <b>Select farm list</b>, pick <b>{pick}</b>. Leave the troops. Click <b>Save</b>.
            </li>
          </>
        )}
        {s.kind === 'move' && k === 1 && (
          <>
            <li>
              Find <b>{coordText(one.x, one.y)}</b> at {one.fromDist.toFixed(1)}. Click ☰ at the end of its row, then <b>Edit</b>.
            </li>
            <li>
              In <b>Select farm list</b>, pick <b>{pick}</b>. Click <b>Save</b>.
            </li>
          </>
        )}
        {s.kind === 'extra' && holderFull && (
          <>
            <li>
              Expand {listText(s.toList!.name, s.toTwin)} under {K} and check that {k === 1 ? <b>{coordText(one.x, one.y)}</b> : `the ${k} oases below`}{' '}
              {k === 1 ? 'is' : 'are'} there. (It is full, so the game won’t offer it in Select farm list.)
            </li>
            <li>
              Back in {from} under {H}: for {k === 1 ? 'that oasis' : 'each of them'}, click ☰ at the end of its row, then <b>Delete</b>, <b>Delete</b>.
            </li>
          </>
        )}
        {s.kind === 'extra' && !holderFull && (
          <>
            <li>
              For {k === 1 ? <b>{coordText(one.x, one.y)}</b> : `each of the ${k} oases below`}: click ☰ at the end of its row, then <b>Edit</b>.
            </li>
            <li>
              In <b>Select farm list</b>, pick <b>{pick}</b> and click <b>Save</b>. The game asks “Override existing farm list target?” because {K}{' '}
              has it: click <b>Cancel</b>, close the Edit target window, then click ☰ at the end of the row, <b>Delete</b>, <b>Delete</b>. (No
              question? Then it just moved to {K}: fine too.)
            </li>
          </>
        )}
        {s.kind === 'move' ? (
          <li>
            Expand {s.toList ? <>{listText(s.toList.name, s.toTwin)} under {K}</> : <>the new list of {K}</>} too, so the helper can see{' '}
            {k === 1 ? 'it' : 'them'} there. Then copy the Farm List page (<b>Ctrl+A</b>, <b>Ctrl+C</b>) and paste it in the box below.
          </li>
        ) : (
          <li>
            {s.toList ? (
              <>
                Expand {listText(s.toList.name, s.toTwin)} under {K} too, so the helper can see that {K} still has {k === 1 ? 'it' : 'them'}. Then
                copy the Farm List page (<b>Ctrl+A</b>, <b>Ctrl+C</b>) and paste it in the box below.
              </>
            ) : (
              <>
                Copy the Farm List page (<b>Ctrl+A</b>, <b>Ctrl+C</b>) and paste it in the box below.
              </>
            )}
          </li>
        )}
      </ol>
      <PasteBox paste={paste} onPaste={onPaste} checking={checking} placeholder="After the move: paste the Farm List page here (Ctrl+V)" />
      <CheckView check={check} checking={checking} alarms={alarms} />
      <div className="table-scroll">
        <table className="oasis-table move-table">
          <thead>
            <tr>
              <th title="As the game’s list shows it">Dist.</th>
              <th>Oasis</th>
              <th>Nearer by</th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.key}>
                <td className="num">{r.fromDist.toFixed(1)}</td>
                <td>
                  <a href={tileUrl(world, r.x, r.y)} target="_blank" rel="noopener noreferrer" title="Open this oasis in the game">
                    {coordText(r.x, r.y)} ↗
                  </a>
                </td>
                <td className="num">{r.gain.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.kind === 'move' && (
        <p className="muted small">
          The troop settings move with the targets, so {K} needs those troops at home for {k} more {k === 1 ? 'target' : 'targets'}. A target
          without troops is skipped, and that oasis isn’t hit.
        </p>
      )}
      {s.kind === 'move' && k > 1 && (
        <p className="muted small">
          While rows are ticked, that list’s <b>Start</b> raids only the ticked ones: finish the move before you start it. Some distances
          repeat: check the (x|y) of each.
        </p>
      )}
      {s.kind === 'extra' && (
        <p className="muted small">
          {k === 1
            ? `Make sure ${K}’s copy is active (raided): once this one is deleted, ${K} is the only village raiding it.`
            : `Make sure ${K}’s copies are active (raided): once these are deleted, ${K} is the only village raiding them.`}
        </p>
      )}
    </article>
  );
}

/**
 * A box that only takes a paste of the Farm List page: it replaces the page text in card 1 and is checked
 * right away. Line ends as the page's text box keeps them (the clipboard has CRLF).
 */
function PasteBox({ paste, onPaste, checking, placeholder }: { paste: string; onPaste: (text: string) => void; checking: boolean; placeholder: string }) {
  const [hint, setHint] = useState<'same' | 'other' | null>(null);
  const take = (raw: string) => {
    const text = raw.replace(/\r\n?/g, '\n');
    if (!/being raided/.test(text)) {
      setHint('other');
      return;
    }
    setHint(text === paste.replace(/\r\n?/g, '\n') ? 'same' : null);
    onPaste(text);
  };
  return (
    <>
      <textarea
        className="paste move-paste"
        value=""
        rows={2}
        onPaste={(e) => {
          e.preventDefault();
          take(e.clipboardData.getData('text'));
        }}
        onChange={(e) => {
          if (/being raided/.test(e.target.value)) take(e.target.value);
        }}
        placeholder={placeholder}
        aria-label="Paste the Farm List page to check the move"
        spellCheck={false}
      />
      {hint === 'same' && !checking && (
        <p className="small note">That’s the same text as the last paste. After the move, copy the Farm List page again (Ctrl+A, Ctrl+C).</p>
      )}
      {hint === 'other' && <p className="small note">That isn’t the Farm List page. Open it in the game, press Ctrl+A, Ctrl+C, then paste here.</p>}
    </>
  );
}

/** What the last paste showed: steps done, oases confirmed, oases fine elsewhere, lists collapsed. */
function CheckView({ check, checking, alarms }: { check: CheckState | null; checking: boolean; alarms: Alarm[] }) {
  if (checking) return <p className="small muted move-check">Checking the paste…</p>;
  if (!check) return null;
  if (!check.result) {
    return (
      <p className="small error move-check">
        ⚠ This paste couldn’t be saved, so it wasn’t checked: {check.error} Fix that and paste again.
      </p>
    );
  }
  const { done, confirmed, notes, unchecked, waiting } = check.result;
  const lines: ReactNode[] = [];
  const what = (rows: { x: number; y: number }[]) => (rows.length === 1 ? coordText(rows[0].x, rows[0].y) : `${rows.length} oases`);
  for (const d of done) {
    lines.push(
      <li key={`d${d.key}`} className="ok">
        ✓{' '}
        {d.kind === 'extra'
          ? `${d.moved} ${d.moved === 1 ? 'copy' : 'copies'} deleted from ${spotText(d.from)}`
          : `${d.moved} moved from ${spotText(d.from)} to ${spotText(d.to)}`}
        {d.left > 0 ? `; ${d.left} still to do` : ''}.
      </li>,
    );
  }
  for (const c of confirmed) {
    lines.push(
      <li key={`c${spotText(c.at)}`} className="ok">
        ✓ {what(c.rows)} {c.rows.length === 1 ? 'is' : 'are'} in {spotText(c.at)} now.
      </li>,
    );
  }
  notes.forEach((nt, i) => {
    const n = nt.rows.length;
    lines.push(
      <li key={`n${i}`} className="note">
        {nt.kind === 'went'
          ? `${what(nt.rows)} went to ${nt.at ? spotText(nt.at) : 'another list'} instead of ${nt.expected.village}: nearer than before, so no harm.`
          : `${what(nt.rows)} left ${spotText(nt.from)}, and ${nt.at ? nt.at.village : 'a village that raided it before'} still raids ${itThem(n)}: no gap.`}
      </li>,
    );
  });
  for (const u of unchecked) {
    lines.push(
      <li key={`u${spotText(u.from)}`} className="note">
        {spotText(u.from)} has {u.drop} {u.drop === 1 ? 'target' : 'targets'} fewer, but it was collapsed: expand it and paste again to see which
        oases moved.
      </li>,
    );
  }
  const red = alarms.filter((a) => a.level === 'red').length;
  const amber = alarms.filter((a) => a.level === 'amber').length;
  if (red > 0) {
    lines.push(
      <li key="red" className="error">
        ⚠ {red} {red === 1 ? 'oasis' : 'oases'} raided from farther away, or not where {red === 1 ? 'it' : 'they'} should be: see the red box above.
      </li>,
    );
  }
  if (amber > 0) {
    lines.push(
      <li key="amber" className="note">
        {amber} {amber === 1 ? 'oasis isn’t' : 'oases aren’t'} confirmed yet: see the box above.
      </li>,
    );
  }
  if (check.error) {
    lines.push(
      <li key="err" className="error">
        It couldn’t be saved for the team: {check.error} Paste again.
      </li>,
    );
  }
  if (lines.length === 0 && waiting > 0) lines.push(<li key="wait">Nothing moved yet.</li>);
  if (lines.length === 0) return null;
  return (
    <div className="small move-check">
      <span className="muted">Paste of {timeText(check.at)}:</span>
      <ul>{lines}</ul>
    </div>
  );
}

/** Lists that grew in that paste: where oases that left may be. */
function grownText(g: Grown[], fixVillage: string): string {
  if (g.length === 0) return 'No list copied collapsed grew.';
  return `Lists that grew: ${g.map((x) => `${spotText(x.spot)} +${x.by}${x.farther ? ' (farther away than before)' : x.spot.village === fixVillage ? '' : ' (not farther)'}`).join(', ')}.`;
}

/** Red: raided from farther away, or not where it should be. Amber: not seen since it left its list. */
function AlarmBanner({ level, alarms, onDismiss }: { level: 'red' | 'amber'; alarms: Alarm[]; onDismiss: (keys: string[]) => void }) {
  const mine = alarms.filter((a) => a.level === level);
  if (mine.length === 0) return null;
  const groups = new Map<string, Alarm[]>();
  for (const a of mine) {
    const gk = `${a.why}|${a.at ? spotText(a.at) : ''}|${spotText(a.from)}|${pickText(a.fix)}|${a.holder ? spotText(a.holder) : ''}`;
    groups.set(gk, [...(groups.get(gk) ?? []), a]);
  }
  const n = mine.length;
  return (
    <div className={`banner ${level} move-alarm`} role="alert">
      <span>
        {level === 'red' ? (
          <>
            <b>⚠ Raided from farther away, or not where {n === 1 ? 'it' : 'they'} should be.</b> {n === 1 ? 'This oasis' : `These ${n} oases`} can go
            more than 4 minutes without a hit, and the animals come back. Fix it before the next raid round. If a round already went from
            there, send a clear too.
          </>
        ) : (
          <>
            <b>Not confirmed yet.</b> Check before the next raid round: a paste has to show {n === 1 ? 'it' : 'them'} in a list as near as
            before.
          </>
        )}
        <ul>
          {[...groups.entries()].map(([gk, g]) => {
            const a = g[0];
            const k = g.length;
            const coords = g.map((x) => coordText(x.x, x.y)).join(', ');
            const dists = g.map((x) => `${coordText(x.x, x.y)} ${x.wasDist.toFixed(1)} → ${x.nowDist.toFixed(1)}`).join(', ');
            const fix =
              k === 1 ? (
                <>
                  click ☰ at the end of its row, then <b>Edit</b>, pick <b>{pickText(a.fix)}</b> and click <b>Save</b>
                </>
              ) : (
                <>
                  tick these {k}, click ☰ left of <b>Start</b>, then <b>Edit ({k})</b>, pick <b>{pickText(a.fix)}</b> and click <b>Save</b>
                </>
              );
            const hint = grownText(a.grown, a.fix.village);
            // After the fix, the paste must show the list they went to, or the helper can't see them there.
            const then = a.fix.list ? <>Then expand {spotText(a.fix)} too and paste the page here again.</> : <>Then paste the page here again.</>;
            const holder = a.holder ? spotText(a.holder) : '?';
            const body =
              a.why === 'farther' ? (
                <>
                  In <b>{a.at ? spotText(a.at) : '?'}</b>, fields before → now: {dists}. Expand that list, {fix}. {then}
                </>
              ) : a.why === 'twice' ? (
                <>
                  In <b>{a.at ? spotText(a.at) : '?'}</b> now, fields before → now: {dists}. Still in <b>{holder}</b> too? Expand {holder} and paste
                  the page here again. If {k === 1 ? 'it isn’t' : 'they aren’t'} there any more, {k === 1 ? 'it’s' : 'they’re'} raided from
                  farther away: expand {a.at ? spotText(a.at) : 'that list'}, {fix}. {then}
                </>
              ) : a.why === 'check' ? (
                <>
                  {coords} left {spotText(a.from)}. Still in <b>{holder}</b>? Expand {holder} and paste the page here again. {hint}
                </>
              ) : a.why === 'missing' ? (
                <>
                  Not in <b>{spotText(a.fix)}</b>: the paste shows that list in full, without {coords}. {hint} Find {itThem(k)}: in a list
                  farther than {a.wasDist.toFixed(1)} fields, {fix}. {then}
                </>
              ) : a.why === 'lost' ? (
                <>
                  Not in <b>{a.at ? spotText(a.at) : '?'}</b> any more, and no list the paste shows has {coords}. {hint} Expand the list{' '}
                  {k === 1 ? 'it' : 'they'} went to and paste again. In a list farther than {a.wasDist.toFixed(1)} fields: {fix}. {then}
                </>
              ) : a.why === 'unconfirmed' ? (
                <>
                  {coords} left {spotText(a.from)}. Expand <b>{spotText(a.fix)}</b> and paste the page here again, so the helper can see{' '}
                  {itThem(k)} there. {hint}
                </>
              ) : (
                <>
                  {coords} also left {spotText(a.from)}, but {k === 1 ? 'isn’t' : 'aren’t'} part of the step. Moved by mistake? Then find{' '}
                  {itThem(k)}: in a list farther than {a.wasDist.toFixed(1)} fields, {fix}. Deleted on purpose? Then dismiss this. {hint}
                </>
              );
            return (
              <li key={gk}>
                {body}{' '}
                <button type="button" className="link small" onClick={() => onDismiss(g.map((x) => x.key))}>
                  Dismiss
                </button>
              </li>
            );
          })}
        </ul>
        {level === 'red' && <span className="muted">On purpose? Then send a clear, and dismiss it.</span>}
      </span>
    </div>
  );
}

function WorldPicker(props: {
  entries: WorldEntry[] | null;
  options: WorldEntry[];
  selected: string;
  onSelect: (key: string) => void;
  world: OasisWorld | null;
  error: string;
  onRetry?: () => void;
  roomId: string | null;
  onUploaded: (w: OasisWorld, shared: WorldEntry | null) => void;
}) {
  const { entries, options, selected, onSelect, error, onRetry, roomId, onUploaded } = props;
  const [pending, setPending] = useState<OasisWorld | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const canShare = roomId !== null && teamStorageAvailable;
  // An older scan than the one in use would be ignored (the newest scan of a server wins).
  const current = pending ? options.find((o) => o.key === metaOf(pending).key) : undefined;
  const older = !!pending && !!current && current.scannedAt > pending.scannedAt;

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMsg('');
    setPending(null);
    try {
      setPending(compactScan(JSON.parse(await file.text())));
    } catch (err) {
      setMsg(err instanceof SyntaxError ? 'That file is not valid JSON.' : (err as Error).message);
    }
  };

  const share = async () => {
    if (!pending || !roomId || older) return;
    setBusy(true);
    setMsg('');
    try {
      const saved = await saveTeam(roomId, pending, loadPrefs().name);
      onUploaded(pending, saved);
      setMsg(`Saved for the team: everyone with the room link now gets ${pending.world}.`);
      setPending(null);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="world">
      <div className="row wrap">
        <label className="label" htmlFor="world">
          Server
        </label>
        {entries === null ? (
          <span className="muted">Loading…</span>
        ) : options.length === 0 ? (
          <span className="muted">No oasis data yet: upload a scan.</span>
        ) : (
          <select id="world" value={selected} onChange={(e) => onSelect(e.target.value)}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.world} · {o.count.toLocaleString()} oases · {dateText(o.scannedAt)}
                {o.source === 'team' ? ` · uploaded${o.by ? ` by ${o.by}` : ''}` : o.source === 'this tab' ? ' · this tab only' : ''}
              </option>
            ))}
          </select>
        )}
        <label className="btn small upload">
          Upload scan JSON
          <input type="file" className="sr-only" accept=".json,application/json" onChange={(e) => void pick(e)} />
        </label>
      </div>
      {pending && (
        <div className="banner info">
          <span>
            <b>{pending.world}</b> · {pending.oases.length.toLocaleString()} oases · scan of {dateText(pending.scannedAt)}. Only oasis
            positions, types and animals are kept, no player names.
            {older && current && <b className="error"> A newer scan of this server ({dateText(current.scannedAt)}) is already in use.</b>}
          </span>
          {canShare && !older ? (
            <button className="btn small primary" disabled={busy} onClick={() => void share()}>
              {busy ? 'Saving…' : 'Save for the team'}
            </button>
          ) : null}
          {!older && (
            <button
              className="btn small"
              onClick={() => {
                onUploaded(pending, null);
                setPending(null);
              }}
            >
              Use in this tab
            </button>
          )}
          <button className="btn small" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      {!canShare && pending && <p className="muted small">Open the helper from your team’s timer (the Oases button) to share uploads with the team.</p>}
      {msg && <p className="small note">{msg}</p>}
      {error && (
        <p className="small error">
          {error}{' '}
          {onRetry && (
            <button className="btn small" onClick={onRetry}>
              Try again
            </button>
          )}
        </p>
      )}
    </div>
  );
}

function PasteSummary({ parsed }: { parsed: NonNullable<ReturnType<typeof parsePaste>> }) {
  const targets = parsed.lists.reduce((n, l) => n + l.targets.length, 0);
  const oases = parsed.lists.reduce((n, l) => n + l.targets.filter((t) => t.oasis).length, 0);
  if (parsed.villages.length === 0) {
    return (
      <span className="small error">
        No villages found. Copy the whole Farm List page (Ctrl+A first): the village list at the side is needed.
      </span>
    );
  }
  if (parsed.lists.length === 0) return <span className="small error">No farm lists found. Is this the Farm List page?</span>;
  const unmatched = parsed.lists.filter((l) => !l.village).length;
  return (
    <span className="small muted">
      Found {parsed.villages.length} villages, {parsed.lists.length} farm lists, {targets} targets ({oases} oases).
      {unmatched > 0 && <span className="error"> {unmatched} lists couldn’t be matched to a village.</span>}
    </span>
  );
}

function ExtraVillages({ extra, setExtra }: { extra: PastedVillage[]; setExtra: (v: PastedVillage[]) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const add = (e: FormEvent) => {
    e.preventDefault();
    const c = parseCoords(text);
    if (!c) {
      setError('Type coordinates like 12|-34.');
      return;
    }
    if (!extra.some((v) => v.x === c.x && v.y === c.y)) setExtra([...extra, { name: coordText(c.x, c.y), ...c }]);
    setText('');
    setError('');
  };
  return (
    <form className="row wrap extra" onSubmit={add}>
      <label className="label" htmlFor="extra-village">
        Or a village at
      </label>
      <input
        id="extra-village"
        className="short"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError('');
        }}
        placeholder="12|-34"
      />
      <button className="btn small">Add</button>
      {extra.map((v) => (
        <span key={v.name} className="chip">
          {v.name}
          <button type="button" className="link" aria-label={`Remove ${v.name}`} onClick={() => setExtra(extra.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      {error && <span className="small error">{error}</span>}
    </form>
  );
}

function Warnings(props: {
  result: NonNullable<ReturnType<typeof analyze>>;
  /** Oases in the farm list of a farther village (card 3), and the ones card 3 covers. */
  moveCount: number;
  covered: Set<string> | null;
  onSeeMoves: () => void;
}) {
  const { result, moveCount, covered, onSeeMoves } = props;
  const { fullLists, deactivated, neverExpanded, grownLists, unmatchedLists } = result.warnings;
  // Copies that card 3 already has a step for are left out here.
  const inSeveralVillages = result.warnings.inSeveralVillages.filter((o) => !covered?.has(`${o.x}|${o.y}`));
  const n = moveCount + fullLists.length + deactivated.length + inSeveralVillages.length + neverExpanded.length + grownLists.length + unmatchedLists.length;
  if (n === 0) return null;
  return (
    <div className="banners">
      {moveCount > 0 && (
        <div className="banner info">
          <span>
            {moveCount} {moveCount === 1 ? 'oasis is' : 'oases are'} in the farm list of a farther village.
          </span>
          <button className="btn small" onClick={onSeeMoves}>
            See 3. Oases to move
          </button>
        </div>
      )}
      {neverExpanded.length > 0 && (
        <div className="banner amber">
          <span>
            Never seen expanded: {neverExpanded.map((l) => `${l.list}${l.village ? ` (${l.village})` : ''}`).join(', ')}. Free oases near
            {neverExpanded.length === 1 ? ' its village are' : ' their villages are'} held back until you expand{' '}
            {neverExpanded.length === 1 ? 'it' : 'them'} once and paste again.
          </span>
        </div>
      )}
      {grownLists.length > 0 && (
        <div className="banner info">
          <span>
            More targets than when last expanded: {grownLists.map((l) => `${l.list} (${l.known} → ${l.total})`).join(', ')}. Expand{' '}
            {grownLists.length === 1 ? 'it' : 'them'} next time you paste, so an oasis added there isn’t suggested again.
          </span>
        </div>
      )}
      {unmatchedLists.length > 0 && (
        <div className="banner amber">
          <span>
            Not matched to one of your villages: {unmatchedLists.join(', ')}. Its oases still count as taken. (Two villages with the same
            name, or a village missing from the village list.)
          </span>
        </div>
      )}
      {fullLists.map((l, i) => (
        <div key={i} className="banner amber">
          <span>
            <b>{l.list}</b> is full ({LIST_MAX}/{LIST_MAX}): add new oases to another list of {l.village ?? 'this village'}.
          </span>
        </div>
      ))}
      {deactivated.length > 0 && (
        <div className="banner amber">
          <span>
            The game deactivated {deactivated.length === 1 ? 'a target' : `${deactivated.length} targets`} after an owner change:{' '}
            {deactivated.map((d) => coordText(d.x, d.y)).join(', ')}. Remove {deactivated.length === 1 ? 'it' : 'them'} from the list.
          </span>
        </div>
      )}
      {inSeveralVillages.length > 0 && (
        <div className="banner info">
          <span>
            In the lists of two villages:{' '}
            {inSeveralVillages.map((o) => `${coordText(o.x, o.y)} (${o.villages.join(' + ')})`).join(', ')}.
          </span>
        </div>
      )}
    </div>
  );
}

function VillageCard(props: {
  v: VillageResult;
  world: OasisWorld;
  radius: number;
  /** Ticks are saved for the team (room mode) instead of just this tab. */
  sharedTicks: boolean;
  done: Set<string>;
  onTick: (x: number, y: number, village: PastedVillage | null, share: boolean) => void;
  /** Removes a saved list (team state); undefined when nothing is saved. */
  onRemoveList?: (lk: string) => void;
}) {
  const { v, world, radius, sharedTicks, done, onTick, onRemoveList } = props;
  const isDone = (m: MissingOasis) => !sharedTicks && done.has(`${m.x}|${m.y}`);
  const left = v.missing.filter((m) => !isDone(m)).length;
  const tickedCount = sharedTicks ? v.ticked.length : v.missing.length - left;
  return (
    <article className="village">
      <header className="village-head">
        <h3>
          {v.village.name} <span className="muted">{coordText(v.village.x, v.village.y)}</span>
        </h3>
        <a className="btn small" href={farmListUrl(world)} target="_blank" rel="noopener noreferrer">
          Farm lists in the game ↗
        </a>
      </header>
      {v.lists.length > 0 && (
        <p className="small muted lists">
          {v.lists.map((l, i) => (
            <span key={i} className={`chip ${l.total >= LIST_MAX ? 'full' : ''}`} title={l.known === undefined ? 'Never seen expanded' : undefined}>
              {l.name} {l.total}/{LIST_MAX}
              {l.known === undefined && l.total > 0 ? ' ?' : ''}
              {onRemoveList && l.id && (
                <button
                  type="button"
                  className="link"
                  title="Remove this saved list (only if it no longer exists in the game)"
                  aria-label={`Remove the saved list ${l.name}`}
                  onClick={() => {
                    if (confirm(`Remove the saved list “${l.name}” of ${v.village.name}? Do this only if it no longer exists in the game.`)) onRemoveList(l.id!);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </p>
      )}
      <p className="small">
        {left === 0 ? (
          <span className="muted">Nothing to add within {radius} fields.</span>
        ) : (
          <>
            <b>{left}</b> {left === 1 ? 'oasis' : 'oases'} to add within {radius} fields
          </>
        )}
        {tickedCount > 0 && <span className="muted"> · {tickedCount} ticked as added</span>}
        {v.heldBack > 0 && <span className="note"> · {v.heldBack} held back until a never-expanded list is expanded</span>}
      </p>
      {(v.missing.length > 0 || (sharedTicks && v.ticked.length > 0)) && (
        <div className="table-scroll">
        <table className="oasis-table">
          <thead>
            <tr>
              <th>Dist.</th>
              <th>Oasis</th>
              <th>Type</th>
              <th>Animals at scan</th>
              <th aria-label="Copy" />
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {v.missing.map((m) => (
              <OasisRowView key={`${m.x}|${m.y}`} m={m} world={world} done={isDone(m)} toggle={() => onTick(m.x, m.y, isDone(m) ? null : v.village, sharedTicks)} />
            ))}
            {sharedTicks &&
              v.ticked.map((m) => <OasisRowView key={`t${m.x}|${m.y}`} m={m} world={world} done added={m} toggle={() => onTick(m.x, m.y, null, true)} />)}
          </tbody>
        </table>
        </div>
      )}
    </article>
  );
}

function OasisRowView(props: { m: MissingOasis; world: OasisWorld; done: boolean; added?: TickedOasis; toggle: () => void }) {
  const { m, world, done, added, toggle } = props;
  const [now] = useState(Date.now);
  const [copied, setCopied] = useState(false);
  const text = coordText(m.x, m.y);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt('Copy the coordinates:', text);
    }
  };
  return (
    <tr className={done ? 'done' : ''}>
      <td className="num">{m.dist.toFixed(1)}</td>
      <td>
        <a href={tileUrl(world, m.x, m.y)} target="_blank" rel="noopener noreferrer" title="Open this oasis in the game">
          {text} ↗
        </a>
      </td>
      <td>
        <span className={`grp ${m.group}`}>{m.bonus.replace(/; /g, ' + ')}</span>
      </td>
      <td className="small">{animalsLabel(m.animals) || <span className="muted">none</span>}</td>
      <td>
        <button className="btn small" onClick={() => void copy()} title="Copy (x|y) for the farm list’s Add target">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </td>
      <td>
        <input type="checkbox" checked={done} onChange={toggle} aria-label={`Added ${text}`} />
        {added && (
          <span className="small muted added-by">
            {' '}
            {added.by} · {formatAgo(Math.max(0, now - added.at))}
          </span>
        )}
      </td>
    </tr>
  );
}

function FarmStatus(props: {
  state: FarmState | null;
  error: string;
  saving: boolean;
  note: SaveNote | null;
  onRefresh: () => void;
  onForget: () => void;
  onReplace: () => void;
}) {
  const { state, error, saving, note, onRefresh, onForget, onReplace } = props;
  // After "Forget" the village list is still there (empty), but nothing is saved.
  const last = state && state.lists.length > 0 ? lastSaved(state) : null;
  return (
    <div className="farm-status small">
      <div className="row wrap">
        {state === null ? (
          <span className="muted">{error ? '' : 'Loading the team’s saved farm lists…'}</span>
        ) : last ? (
          <span>
            Saved for the team: <b>{state.lists.length}</b> farm {state.lists.length === 1 ? 'list' : 'lists'}, {state.marks.length}{' '}
            {state.marks.length === 1 ? 'tick' : 'ticks'} · last paste {dateText(last.at)} {timeText(last.at)} by {last.by}
          </span>
        ) : (
          <span className="muted">Nothing saved yet: paste the Farm List page once with every list expanded.</span>
        )}
        <button className="btn small" onClick={onRefresh} disabled={saving}>
          Refresh
        </button>
        {state && last && (
          <button
            className="link small"
            disabled={saving}
            onClick={() => {
              if (confirm('Forget the saved farm lists and ticks for this server, for the whole team? The next paste (every list expanded) saves them again.')) onForget();
            }}
          >
            Forget saved lists
          </button>
        )}
        {saving && <span className="muted">Saving…</span>}
      </div>
      {note && (
        <p className={note.tone === 'error' ? 'error' : 'note'}>
          {note.text}{' '}
          {note.canReplace && (
            <button
              className="btn small"
              disabled={saving}
              onClick={() => {
                if (confirm('Replace the team’s saved farm lists for this server with this paste?')) onReplace();
              }}
            >
              Replace the saved lists with this paste
            </button>
          )}
        </p>
      )}
      {error && <p className="error">Team farm lists: {error}</p>}
    </div>
  );
}
