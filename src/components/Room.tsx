import { useState } from 'react';
import { useRoom } from '../hooks/useRoom.ts';
import { roomLink } from '../lib/roomId.ts';
import Banners from './Banners.tsx';
import Chat from './Chat.tsx';
import Controls from './Controls.tsx';
import Countdown from './Countdown.tsx';
import CreateTimer from './CreateTimer.tsx';
import DebugPanel from './DebugPanel.tsx';
import PopOut from './PopOut.tsx';
import PresenceList from './PresenceList.tsx';
import Reminders from './Reminders.tsx';
import SetupChecklist from './SetupChecklist.tsx';
import SoundGate from './SoundGate.tsx';
import SoundPanel from './SoundPanel.tsx';
import StatusLine from './StatusLine.tsx';

export default function Room({ roomId }: { roomId: string }) {
  const [snap, ctrl] = useRoom(roomId);
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(roomLink(roomId));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt('Copy the team link:', roomLink(roomId));
    }
  };

  const ready = snap.status === 'ready' && snap.exists;

  return (
    <main className="room">
      <header className="topbar">
        <a className="logo" href="#" title="All timers">
          ⏳ Team Timer
        </a>
        <div className="row">
          <button className="btn" onClick={copyLink}>
            {copied ? 'Link copied' : 'Copy team link'}
          </button>
          {snap.exists && <PopOut snap={snap} ctrl={ctrl} />}
        </div>
      </header>

      <Banners snap={snap} ctrl={ctrl} />
      {snap.toast && <div className="toast">{snap.toast}</div>}

      {snap.status === 'loading' && <p className="muted center">Connecting…</p>}
      {snap.status === 'error' && (
        <section className="card">
          <h2>Can’t open this timer</h2>
          <p className="error">{snap.error}</p>
        </section>
      )}

      {snap.status === 'ready' && !snap.exists && <CreateTimer snap={snap} ctrl={ctrl} />}

      {ready ? (
        // One grid, so the cards can re-flow: a side column (team + chat) on wide screens,
        // one column in this order on narrow ones.
        <div className="room-grid">
          <section className={`card timer ${snap.flash ? 'flash' : ''}`}>
            <Countdown snap={snap} />
            <StatusLine snap={snap} />
          </section>
          <Controls snap={snap} ctrl={ctrl} />
          <Reminders snap={snap} ctrl={ctrl} />
          <div className="side">
            <PresenceList snap={snap} ctrl={ctrl} />
            <Chat snap={snap} ctrl={ctrl} />
          </div>
          <SoundPanel snap={snap} ctrl={ctrl} />
          <SetupChecklist snap={snap} ctrl={ctrl} />
          <DebugPanel snap={snap} ctrl={ctrl} />
        </div>
      ) : (
        <>
          <SetupChecklist snap={snap} ctrl={ctrl} />
          <DebugPanel snap={snap} ctrl={ctrl} />
        </>
      )}

      {!snap.joined && snap.status !== 'error' && <SoundGate snap={snap} ctrl={ctrl} />}
    </main>
  );
}
