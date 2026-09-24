import type { Snapshot, TimerController } from '../engine/controller.ts';
import { openPip } from '../engine/pip.ts';

export default function Banners({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  if (snap.banners.length === 0) return null;
  return (
    <div className="banners">
      {snap.banners.map((b) => (
        <div key={b.id} className={`banner ${b.tone}`} role={b.tone === 'red' ? 'alert' : 'status'}>
          <span>{b.text}</span>
          {b.action === 'sound' && (
            <button className="btn small" onClick={() => void ctrl.enableSound()}>
              Turn sound on
            </button>
          )}
          {b.action === 'pip' && (
            <button className="btn small" onClick={() => void openPip().catch(() => {})}>
              Re-open pop-out
            </button>
          )}
          {b.dismissable && (
            <button className="link" onClick={() => ctrl.dismissBanner(b.id)} aria-label="Dismiss">
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
