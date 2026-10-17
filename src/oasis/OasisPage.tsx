import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { formatAgo } from '../lib/format.ts';
import { loadPrefs } from '../lib/prefs.ts';
import { analyze, coordText, GROUP_LABEL, parseCoords, viewFromPaste, type MissingOasis, type OasisGroup, type TickedOasis, type VillageResult } from './analyze.ts';
import { forgetWrites, lastSaved, mergePaste, viewFromFarm, type FarmState, type MergeReport } from './farmState.ts';
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
import { LIST_MAX, parsePaste, type PastedVillage } from './parsePaste.ts';
import { animalsLabel, compactScan, metaOf, type OasisWorld } from './scanFormat.ts';

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

/** One line about what a paste changed in the team's saved lists. */
function reportText(r: MergeReport): string {
  const parts: string[] = [];
  if (r.replaced) parts.push(`${r.replaced} updated`);
  if (r.merged) parts.push(`${r.merged} merged`);
  if (r.kept + r.recounted) parts.push(`${r.kept + r.recounted} kept from before (collapsed)`);
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
  }, [shared, roomId, worldKey]);

  /** Merges a paste into the team's saved lists. Saves run one at a time, each on a fresh read. */
  const saveFromPaste = useCallback(
    (text: string, key: string, replace = false) => {
      const put = (state: FarmState) => setFarms((cur) => ({ ...cur, [key]: state }));
      saveChain.current = saveChain.current.then(async () => {
        if (!roomId) return;
        const p = parsePaste(text);
        if (p.villages.length === 0 || p.lists.length === 0) return; // the paste summary says what is wrong
        setSaving(true);
        try {
          const fresh = await loadFarm(roomId, key);
          const r = mergePaste(fresh, p, loadPrefs().name.trim() || 'Someone', Date.now(), { replace });
          if (!r.ok) {
            put(fresh);
            setSaveNote({ tone: 'error', text: r.error, paste: text, key, canReplace: r.reason === 'no-overlap' });
            return;
          }
          await saveFarm(roomId, key, r.writes);
          put(r.next);
          setSaveNote({ tone: 'ok', text: reportText(r.report), paste: text, key });
          // Read back, so the records carry the server's times.
          put(await loadFarm(roomId, key));
          lastLoad.current = Date.now();
        } catch (e) {
          setSaveNote({ tone: 'error', text: (e as Error).message, paste: text, key });
        } finally {
          setSaving(false);
        }
      });
    },
    [roomId],
  );

  // A paste is saved 0.6 s after it last changed (also one made before the server data finished loading).
  useEffect(() => {
    if (!shared || !roomId || !worldKey || !paste.trim()) return;
    if (handled && handled.paste === paste && handled.key === worldKey) return;
    const key = worldKey;
    const text = paste;
    const t = setTimeout(() => {
      setHandled({ paste: text, key });
      saveFromPaste(text, key);
    }, 600);
    return () => clearTimeout(t);
  }, [shared, roomId, worldKey, paste, handled, saveFromPaste]);

  const onPasteChange = (text: string) => {
    setPaste(text);
    setSaveNote(null);
  };

  // The saved team state, unless this paste couldn't be saved (then the paste is shown on its own).
  const farmState = shared && worldKey ? (farms[worldKey] ?? null) : null;
  const pasteRefused = saveNote?.tone === 'error' && saveNote.paste === paste && saveNote.key === worldKey && parsed !== null;
  const view = useMemo(() => {
    if (farmState && !pasteRefused) {
      const v = viewFromFarm(farmState, parsed?.deactivated ?? []);
      // This paste's lists that couldn't be matched (so weren't saved) still count as taken.
      const unmatched = parsed ? viewFromPaste(parsed).lists.filter((l) => l.village === null) : [];
      return unmatched.length > 0 ? { ...v, lists: [...v.lists, ...unmatched] } : v;
    }
    return parsed ? viewFromPaste(parsed) : null;
  }, [farmState, pasteRefused, parsed]);
  const result = useMemo(
    () => (world ? analyze(world, view, { radius: settings.radius, groups, allVillages: settings.allVillages, extraVillages: extra }) : null),
    [world, view, settings.radius, groups, settings.allVillages, extra],
  );
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
      setSaveNote(null);
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
              onReplace={() => saveNote && saveFromPaste(saveNote.paste, saveNote.key, true)}
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
        {world && result && <Warnings result={result} />}
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
              onRemoveList={farmState ? (lk) => void onRemoveList(lk) : undefined}
            />
          ))}
        {world && (
          <p className="muted small">
            Oasis data: scan of {dateText(world.scannedAt)}. Animals and owners can have changed since; the game shows the current ones.
          </p>
        )}
      </section>
    </main>
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

function Warnings({ result }: { result: NonNullable<ReturnType<typeof analyze>> }) {
  const { fullLists, deactivated, inSeveralVillages, neverExpanded, grownLists, unmatchedLists } = result.warnings;
  const n = fullLists.length + deactivated.length + inSeveralVillages.length + neverExpanded.length + grownLists.length + unmatchedLists.length;
  if (n === 0) return null;
  return (
    <div className="banners">
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
  const last = state ? lastSaved(state) : null;
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
