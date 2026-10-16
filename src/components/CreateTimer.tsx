import { useState, type FormEvent } from 'react';
import type { Snapshot, TimerController } from '../engine/controller.ts';
import { durationError, formatDuration, parseDuration, suggestDuration } from '../lib/format.ts';
import { DEFAULT_INTERVAL_MS } from '../lib/timerMath.ts';
import DurationHint from './DurationHint.tsx';

export default function CreateTimer({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const [text, setText] = useState(formatDuration(DEFAULT_INTERVAL_MS));
  const [error, setError] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ms = parseDuration(text);
    if (ms === null) {
      // A near miss keeps its one-click fix (DurationHint) instead of turning into a plain error.
      setError(suggestDuration(text) ? '' : durationError(text));
      return;
    }
    void ctrl.create(ms);
  };

  return (
    <section className="card">
      <h2>Set up this team timer</h2>
      <p className="muted">
        No timer exists at this link yet. If you expected your team’s timer, check the link. Otherwise pick the raid
        interval and create it, then share the link with your team.
      </p>
      <form className="row" onSubmit={submit}>
        <label className="label" htmlFor="create-interval">
          Raid every
        </label>
        <input
          id="create-interval"
          className="short"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError('');
          }}
        />
        <button className="btn primary" disabled={!snap.canControl}>
          Create timer
        </button>
        {!error && (
          <DurationHint
            text={text}
            onUse={(fixed) => {
              setText(fixed);
              setError('');
            }}
          />
        )}
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
