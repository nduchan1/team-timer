import { useState, type FormEvent } from 'react';
import type { Snapshot, TimerController } from '../engine/controller.ts';
import { durationError, formatDuration, parseDuration, suggestDuration } from '../lib/format.ts';
import DurationHint from './DurationHint.tsx';

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
      // A near miss keeps its one-click fix (DurationHint) instead of turning into a plain error.
      setError(suggestDuration(text) ? '' : durationError(text));
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
      {error ? (
        <span className="error small">{error}</span>
      ) : (
        <DurationHint
          text={text}
          onUse={(fixed) => {
            setText(fixed);
            setError('');
          }}
        />
      )}
      {running && <span className="muted small">A new interval starts after the next raid.</span>}
    </form>
  );
}
