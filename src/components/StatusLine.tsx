import type { Snapshot } from '../engine/controller.ts';
import type { TimerAction } from '../lib/timerMath.ts';

const ACTION_TEXT: Record<TimerAction, string> = {
  create: 'Created',
  start: 'Started',
  stop: 'Stopped',
  resume: 'Resumed',
  raided: 'Re-synced',
  nudge: 'Nudged',
  interval: 'Interval changed',
};

export default function StatusLine({ snap }: { snap: Snapshot }) {
  const sync =
    snap.mode === 'local'
      ? 'local clock'
      : snap.clockQuality === 'precise'
        ? `synced ±${Math.max(1, Math.round(snap.clockErrorMs))} ms`
        : snap.clockQuality === 'rough'
          ? 'rough sync'
          : 'syncing clock…';
  return (
    <div className="status">
      <span>
        <i className={`dot ${snap.connected ? 'on' : 'off'}`} aria-hidden />
        {snap.connected ? 'Live' : 'Offline'} · {sync}
      </span>
      {snap.changedBy && snap.changedAction && (
        <span>
          {ACTION_TEXT[snap.changedAction]} by <b>{snap.changedBy}</b> · {snap.changedAgo}
        </span>
      )}
      {snap.session && <span>Running for {snap.session}</span>}
      {snap.pcClockNote && <span className="note">{snap.pcClockNote}</span>}
    </div>
  );
}
