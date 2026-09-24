import type { Snapshot } from '../engine/controller.ts';
import { formatDuration } from '../lib/format.ts';

export default function Countdown({ snap, compact = false }: { snap: Snapshot; compact?: boolean }) {
  const tone = snap.phase === 'stopped' ? 'stopped' : snap.flash ? 'raid' : snap.warn ? 'warn' : 'running';
  return (
    <div className={`countdown ${compact ? 'compact' : ''}`}>
      <div className={`digits ${tone}`} aria-live="off">
        {snap.flash ? 'RAID!' : snap.countdown}
      </div>
      <div className="facts">
        <span>
          Loop <b>{snap.loops}</b>
        </span>
        {snap.nextRaidAt ? (
          <span>
            Next raid <b>{snap.nextRaidAt}</b>
          </span>
        ) : (
          <span>{snap.canResume ? 'Paused' : 'Stopped'}</span>
        )}
        {!compact && (
          <span>
            Every <b>{formatDuration(snap.intervalMs)}</b>
          </span>
        )}
      </div>
    </div>
  );
}
