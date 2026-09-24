import { useEffect, useState } from 'react';
import type { Snapshot, TimerController } from '../engine/controller.ts';
import IntervalEditor from './IntervalEditor.tsx';

const NUDGES = [-5, -1, 1, 5];

export default function Controls({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const [confirmStop, setConfirmStop] = useState(false);
  const off = !snap.canControl;
  const running = snap.phase !== 'stopped';

  useEffect(() => {
    if (!confirmStop) return;
    const id = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(id);
  }, [confirmStop]);

  return (
    <section className="card controls">
      <div className="row wrap">
        {running ? (
          <button
            className="btn primary big"
            disabled={off}
            onClick={() => void ctrl.act({ kind: 'raided' })}
            title="Click right after starting the farm lists: the next raid is one interval from now"
          >
            Raided now
          </button>
        ) : (
          <>
            <button
              className="btn primary big"
              disabled={off}
              onClick={() => void ctrl.act({ kind: 'start' })}
              title="Click right after starting the farm lists: loop 0 starts now"
            >
              Start (I just raided)
            </button>
            {snap.canResume && (
              <button className="btn big" disabled={off} onClick={() => void ctrl.act({ kind: 'resume' })}>
                Resume
              </button>
            )}
          </>
        )}
        <div className="nudges" role="group" aria-label="Move the next raid">
          {NUDGES.map((s) => (
            <button
              key={s}
              className="btn small"
              disabled={off}
              onClick={() => void ctrl.act({ kind: 'nudge', deltaMs: s * 1000 })}
              title={s > 0 ? `Next raid ${s} s later` : `Next raid ${-s} s sooner`}
            >
              {s > 0 ? `+${s}` : s} s
            </button>
          ))}
        </div>
        {running && (
          <button
            className={`btn ${confirmStop ? 'danger' : ''}`}
            disabled={off}
            onClick={() => {
              if (!confirmStop) return setConfirmStop(true);
              setConfirmStop(false);
              void ctrl.act({ kind: 'stop' });
            }}
          >
            {confirmStop ? 'Click again to stop' : 'Stop'}
          </button>
        )}
      </div>
      <IntervalEditor snap={snap} ctrl={ctrl} />
      {off && snap.joined && snap.status === 'ready' && !snap.busy && (
        <p className="muted small">
          {snap.mode === 'firebase' && !snap.connected
            ? 'Offline: controls come back when the connection does.'
            : 'Controls unlock once the clock has synced.'}
        </p>
      )}
    </section>
  );
}
