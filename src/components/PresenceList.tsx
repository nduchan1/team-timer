import { useState, type FormEvent } from 'react';
import type { Snapshot, TimerController } from '../engine/controller.ts';

export default function PresenceList({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const onDuty = snap.presence.filter((p) => p.onDuty);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(snap.me.name);

  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    ctrl.setPrefs({ name: name.trim().slice(0, 24) });
    setEditing(false);
  };

  return (
    <section className="card team">
      <h2>Team</h2>
      <p className="duty">
        {onDuty.length > 0 ? (
          <>
            On raid duty: <b>{onDuty.map((p) => p.name).join(', ')}</b>
          </>
        ) : (
          <span className="muted">Nobody is on raid duty.</span>
        )}
      </p>
      <label className="check">
        <input type="checkbox" checked={snap.me.onDuty} disabled={!snap.joined} onChange={(e) => ctrl.setOnDuty(e.target.checked)} />
        I’m on raid duty
      </label>
      <ul className="people">
        {snap.presence.map((p) => (
          <li key={p.cid}>
            <i className="dot on" aria-hidden />
            {p.name}
            {p.cid === snap.me.cid && <span className="muted"> (you)</span>}
            {p.onDuty && <span className="badge">on duty</span>}
          </li>
        ))}
        {snap.presence.length === 0 && <li className="muted">Nobody else has this timer open.</li>}
      </ul>
      {editing ? (
        <form className="row" onSubmit={rename}>
          <input className="grow" value={name} maxLength={24} autoFocus onChange={(e) => setName(e.target.value)} aria-label="Your name" />
          <button className="btn small" disabled={!name.trim()}>
            Save
          </button>
        </form>
      ) : (
        <p className="muted small">
          You appear as <b>{snap.me.name || '—'}</b>{' '}
          <button
            className="link"
            onClick={() => {
              setName(snap.me.name);
              setEditing(true);
            }}
          >
            change
          </button>
        </p>
      )}
    </section>
  );
}
