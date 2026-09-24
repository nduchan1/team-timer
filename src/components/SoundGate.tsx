import { useState, type FormEvent } from 'react';
import type { Snapshot, TimerController } from '../engine/controller.ts';

/** Browsers only allow sound after a click, so joining a room starts with this one. */
export default function SoundGate({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const [name, setName] = useState(snap.prefs.name);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void ctrl.join(name);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <form className="card gate" onSubmit={submit}>
        <h2 id="gate-title">Join the team timer</h2>
        <label className="label" htmlFor="gate-name">
          Your name (shown to your team)
        </label>
        <input
          id="gate-name"
          value={name}
          maxLength={24}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Nick"
        />
        <button className="btn primary big" disabled={!name.trim()}>
          🔔 Enable sound &amp; join
        </button>
        <p className="muted small">Browsers only allow sound after a click. You can change the volume inside the app.</p>
      </form>
    </div>
  );
}
