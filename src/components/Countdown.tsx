import type { Snapshot } from '../engine/controller.ts';
import { formatClock, formatDuration } from '../lib/format.ts';
import { formatServerTime, sameAsServerTime } from '../lib/serverTime.ts';

export default function Countdown({ snap, compact = false }: { snap: Snapshot; compact?: boolean }) {
  const tone = snap.phase === 'stopped' ? 'stopped' : snap.flash ? 'raid' : snap.warn ? 'warn' : 'running';
  const next = snap.nextRaidMs;
  return (
    <div className={`countdown ${compact ? 'compact' : ''}`}>
      <div className={`digits ${tone}`} aria-live="off">
        {snap.flash ? 'RAID!' : snap.countdown}
      </div>
      <div className="facts">
        <span>
          Loop <b>{snap.loops}</b>
        </span>
        {next !== null ? (
          <span title="ST = server time (UK time), what Travian and the team plan in">
            {compact ? 'Next' : 'Next raid'} <b>{formatServerTime(next)}</b> ST
            {!compact && !sameAsServerTime(next) && <span className="muted"> · {formatClock(next)} yours</span>}
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
