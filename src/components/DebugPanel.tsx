import type { Snapshot, TimerController } from '../engine/controller.ts';

export default function DebugPanel({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  return (
    <details className="card debug">
      <summary>
        <h2>Debug log</h2>
      </summary>
      <p className="muted small">
        mode {snap.mode} · clock {snap.clockQuality} ±{Number.isFinite(snap.clockErrorMs) ? Math.round(snap.clockErrorMs) : '?'} ms ·
        audio {snap.sound} · worker {String(snap.usesWorker)} · web lock {String(snap.lockHeld)} · missed {snap.missedTotal}
      </p>
      <pre key={snap.debugVersion}>{ctrl.getDebug().join('\n')}</pre>
    </details>
  );
}
