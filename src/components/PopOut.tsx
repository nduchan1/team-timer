import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Snapshot, TimerController } from '../engine/controller.ts';
import { closePip, openPip, pipSupported, pipWindow, subscribePip } from '../engine/pip.ts';
import { popLine } from '../engine/popLine.ts';
import Countdown from './Countdown.tsx';

/** "Pop out" button, plus the mini timer rendered into the always-on-top picture-in-picture window. */
export default function PopOut({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const win = useSyncExternalStore(subscribePip, pipWindow);
  const [error, setError] = useState('');
  if (!pipSupported) return null;

  const open = async () => {
    try {
      setError('');
      await openPip();
    } catch {
      setError('Pop-out blocked');
    }
  };

  return (
    <>
      <button
        className="btn"
        onClick={win ? closePip : open}
        title="A small always-on-top timer window. While it is open, the browser keeps this tab fully awake."
      >
        {win ? 'Close pop-out' : error || 'Pop out'}
      </button>
      {win && createPortal(<MiniTimer snap={snap} ctrl={ctrl} />, win.document.body)}
    </>
  );
}

function MiniTimer({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const off = !snap.canControl;
  const running = snap.phase !== 'stopped';
  const line = popLine({
    joined: snap.joined,
    sound: snap.sound,
    mode: snap.mode,
    connected: snap.connected,
    clockQuality: snap.clockQuality,
    missedShown: snap.missedShown,
    silencedBy: snap.silencedBy,
    updateReady: snap.updateReady,
    chatUnread: snap.chatUnread,
    onDutyNames: snap.people.filter((p) => p.onDuty).map((p) => p.name),
  });
  return (
    <div className={`mini ${snap.flash ? 'flash' : ''}`}>
      <Countdown snap={snap} compact />
      <div className="row">
        {running ? (
          <button className="btn primary" disabled={off} onClick={() => void ctrl.act({ kind: 'raided' })}>
            Raided now
          </button>
        ) : snap.canResume ? (
          // A fresh Start would reset the team's loop count; the main tab still offers it.
          <button className="btn primary" disabled={off} onClick={() => void ctrl.act({ kind: 'resume' })}>
            Resume
          </button>
        ) : (
          <button className="btn primary" disabled={off} onClick={() => void ctrl.act({ kind: 'start' })}>
            Start
          </button>
        )}
        <button className="btn small" disabled={off} onClick={() => void ctrl.act({ kind: 'nudge', deltaMs: -1000 })}>
          −1 s
        </button>
        <button className="btn small" disabled={off} onClick={() => void ctrl.act({ kind: 'nudge', deltaMs: 1000 })}>
          +1 s
        </button>
      </div>
      {/* One line only: the window is 300×190 and Chrome may reopen it at the player's last size. */}
      <div className={`mini-line ${line.tone}`} role="status">
        <span>{line.text}</span>
        {line.action === 'on-duty' && (
          <button className="link" onClick={() => ctrl.setOnDuty(true)} title="Mark this device on raid duty, so it chimes">
            I’m raiding
          </button>
        )}
      </div>
    </div>
  );
}
