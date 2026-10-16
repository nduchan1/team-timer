import type { BannerAction, Snapshot, TimerController } from '../engine/controller.ts';
import { openPip } from '../engine/pip.ts';

export default function Banners({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  if (snap.banners.length === 0) return null;

  const run = (a: BannerAction) => {
    switch (a.id) {
      case 'sound':
        return void ctrl.enableSound();
      case 'pip':
        return void openPip().catch(() => {});
      case 'reload':
        return location.reload();
      case 'off-duty':
        return void ctrl.handoff('off');
      case 'duty-yes':
        return ctrl.answerDutyRestore(true);
      case 'duty-no':
        return ctrl.answerDutyRestore(false);
    }
  };

  return (
    <div className="banners">
      {snap.banners.map((b) => (
        <div key={b.id} className={`banner ${b.tone}`} role={b.tone === 'red' ? 'alert' : 'status'}>
          <span>{b.text}</span>
          {b.actions?.map((a) => (
            <button key={a.id} className="btn small" onClick={() => run(a)}>
              {a.label}
            </button>
          ))}
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
