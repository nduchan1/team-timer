import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ReminderView, Snapshot, TimerController } from '../engine/controller.ts';
import { formatClock, formatHuman } from '../lib/format.ts';
import { discordText, formatHours, MAX_READY_IN_MS, MAX_RESTART_MS, parseHours } from '../lib/reminders.ts';
import { formatServerTime, sameAsServerTime } from '../lib/serverTime.ts';

/** "18:22 ST (20:22 yours)". */
function when(ms: number): string {
  return `${formatServerTime(ms, false)} ST${sameAsServerTime(ms) ? '' : ` (${formatClock(ms, false)} yours)`}`;
}

export default function Reminders({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  return (
    <section className="card reminders">
      <h2>Reminders</h2>
      {snap.remindersError ? (
        <p className="error small">Reminders unavailable: {snap.remindersError}</p>
      ) : !snap.remindersLoaded ? (
        <p className="muted">Loading…</p>
      ) : (
        snap.reminders.map((r) => <ReminderRow key={r.id} r={r} snap={snap} ctrl={ctrl} />)
      )}
    </section>
  );
}

function ReminderRow({ r, snap, ctrl }: { r: ReminderView; snap: Snapshot; ctrl: TimerController }) {
  const off = !snap.canRemind;
  const [confirm, setConfirm] = useState<'used' | 'clear' | null>(null);
  const [edit, setEdit] = useState<'ready' | 'cooldown' | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const armedAt = useRef(0);

  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(null), 3000);
    return () => clearTimeout(id);
  }, [confirm]);

  // A stray click hours before it is ready would restart or wipe the team's cooldown: ask once more.
  // The second click must be a separate one: a double-click or a repeating key doesn't confirm.
  const guarded = (kind: 'used' | 'clear', run: () => Promise<boolean>) => {
    if (r.phase === 'running' && confirm !== kind) {
      armedAt.current = performance.now();
      return setConfirm(kind);
    }
    if (r.phase === 'running' && performance.now() - armedAt.current < 400) return;
    setConfirm(null);
    void run();
  };

  const openEdit = (kind: 'ready' | 'cooldown') => {
    setEdit(edit === kind ? null : kind);
    setText('');
    setError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // A bare number is ambiguous (12 h or 12 min?) and the change is the whole team's: ask for h:mm.
    const bare = /^\d+$/.test(text.normalize('NFKC').trim());
    const ms = bare ? null : parseHours(text, edit === 'ready' ? MAX_READY_IN_MS : MAX_RESTART_MS);
    if (ms === null) {
      setError(
        edit === 'ready' ? 'Type the time left as the game shows it, e.g. 7:41, or 0:45 for 45 min.' : 'Use h:mm:ss, e.g. 12:00:00 (up to 48 h).',
      );
      return;
    }
    // Keep the typed time if the save fails, so it can be tried again.
    const ok = await (edit === 'ready' ? ctrl.remindReadyIn(r.id, ms) : ctrl.remindSetCooldown(r.id, ms));
    if (ok) {
      setEdit(null);
      setText('');
    }
  };

  const copy = () => {
    navigator.clipboard
      .writeText(discordText(r))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className={`reminder ${r.phase}`}>
      <p className="reminder-head">
        <b>{r.label}</b>{' '}
        <span className="muted small">
          · restarts {formatHuman(r.restartMs)}{' '}
          <button className="link" onClick={() => openEdit('cooldown')} disabled={off}>
            change
          </button>
        </span>
      </p>
      <p className="reminder-status">
        {r.phase === 'idle' && <span className="muted">Not running. Tap “Used now” right after using one.</span>}
        {r.phase === 'running' && r.dueAt !== undefined && (
          <>
            Ready in <b>{formatHours(r.remainingMs)}</b> · {when(r.dueAt)}
          </>
        )}
        {r.phase === 'due' && r.dueAt !== undefined && (
          <>
            <b className="ready">Ready</b> since {when(r.dueAt)}
          </>
        )}
        {r.usedBy && r.usedAgo && r.phase !== 'idle' && (
          <span className="muted">
            {' '}
            · used by {r.usedBy} {r.usedAgo}
          </span>
        )}
      </p>
      <div className="row wrap">
        <button
          className={`btn small ${confirm === 'used' ? 'danger' : 'primary'}`}
          disabled={off}
          onClick={() => guarded('used', () => ctrl.remindUsedNow(r.id))}
          title="You just used one: start the cooldown now"
        >
          {confirm === 'used' ? 'Click again to restart' : 'Used now ↻'}
        </button>
        <button className="btn small" disabled={off} onClick={() => openEdit('ready')} title="Copy the cooldown the game shows">
          Ready in…
        </button>
        {r.phase !== 'idle' && (
          <>
            <button className="btn small" disabled={off} onClick={() => void ctrl.remindSnooze(r.id)}>
              +10 min
            </button>
            <button className={`btn small ${confirm === 'clear' ? 'danger' : ''}`} disabled={off} onClick={() => guarded('clear', () => ctrl.remindClear(r.id))}>
              {confirm === 'clear' ? 'Click again to clear' : 'Clear'}
            </button>
            <button className="link small" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy for Discord'}
            </button>
          </>
        )}
      </div>
      {edit && (
        <form className="row reminder-edit" onSubmit={submit}>
          <label className="label" htmlFor={`rem-${r.id}`}>
            {edit === 'ready' ? 'Ready in (h:mm)' : 'Restarts after (h:mm:ss)'}
          </label>
          <input
            id={`rem-${r.id}`}
            className="short"
            autoFocus
            value={text}
            placeholder={edit === 'ready' ? '7:41' : formatHours(r.restartMs)}
            onChange={(e) => {
              setText(e.target.value);
              setError('');
            }}
          />
          <button className="btn small" disabled={off || !text.trim()}>
            Set
          </button>
          {error && <span className="error small">{error}</span>}
        </form>
      )}
    </div>
  );
}
