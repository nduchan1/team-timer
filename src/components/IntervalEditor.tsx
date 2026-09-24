import { useState, type FormEvent } from 'react';
import type { Snapshot, TimerController } from '../engine/controller.ts';
import { formatDuration, parseDuration } from '../lib/format.ts';

const PRESETS = [180_000, 210_000, 240_000, 300_000];

export default function IntervalEditor({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const off = !snap.canControl;
  const running = snap.phase !== 'stopped';

  const apply = (ms: number) => {
    if (ms === snap.intervalMs) return;
    void ctrl.act({ kind: 'interval', intervalMs: ms });
    setText('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ms = parseDuration(text);
    if (ms === null) {
      setError('Use m:ss, e.g. 3:30 (10 s to 24 h).');
      return;
    }
    setError('');
    apply(ms);
  };

  return (
    <form className="interval" onSubmit={submit}>
      <span className="label">Interval</span>
      {PRESETS.map((ms) => (
        <button
          key={ms}
          type="button"
          className={`btn small ${ms === snap.intervalMs ? 'selected' : ''}`}
          disabled={off}
          onClick={() => apply(ms)}
        >
          {formatDuration(ms)}
        </button>
      ))}
      <input
        className="short"
        value={text}
        placeholder={formatDuration(snap.intervalMs)}
        onChange={(e) => {
          setText(e.target.value);
          setError('');
        }}
        disabled={off}
        aria-label="Custom interval (m:ss)"
      />
      <button className="btn small" disabled={off || !text}>
        Set
      </button>
      {running && <span className="muted small">A new interval starts after the next raid.</span>}
      {error && <span className="error small">{error}</span>}
    </form>
  );
}
