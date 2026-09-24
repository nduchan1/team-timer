import { useState, type FormEvent } from 'react';
import { forgetRoom, loadRecent, type RecentRoom } from '../lib/prefs.ts';
import { parseRoomInput, randomId } from '../lib/roomId.ts';
import { formatAgo } from '../lib/format.ts';

export default function Landing({ badLink }: { badLink: boolean }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState(badLink ? 'That link is not a valid team timer link.' : '');
  const [recent, setRecent] = useState<RecentRoom[]>(loadRecent);
  const [now] = useState(Date.now);

  const join = (e: FormEvent) => {
    e.preventDefault();
    const id = parseRoomInput(code);
    if (!id) {
      setError('Paste the full team link (or its 22-character code).');
      return;
    }
    location.hash = id;
  };

  return (
    <main className="landing">
      <header className="brand">
        <h1>⏳ Team Timer</h1>
        <p className="lede">
          A looping raid timer for Travian teams. Everyone on the team link sees the same countdown and loop count, and
          the chime keeps ringing while you are tabbed into the game.
        </p>
      </header>

      <section className="card">
        <h2>New team timer</h2>
        <p className="muted">Creates a private link. Anyone with the link can see and control the timer.</p>
        <button className="btn primary big" onClick={() => (location.hash = randomId())}>
          Create team timer
        </button>
      </section>

      <section className="card">
        <h2>Join your team</h2>
        <form className="row" onSubmit={join}>
          <input
            className="grow"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError('');
            }}
            placeholder="Paste the team link"
            aria-label="Team link or code"
          />
          <button className="btn">Join</button>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      {recent.length > 0 && (
        <section className="card">
          <h2>Recent</h2>
          <ul className="recent">
            {recent.map((r) => (
              <li key={r.id}>
                <a href={`#${r.id}`}>{r.id.slice(0, 6)}…</a>
                <span className="muted"> opened {formatAgo(now - r.at)}</span>
                <button
                  className="link"
                  onClick={() => {
                    forgetRoom(r.id);
                    setRecent(loadRecent());
                  }}
                  aria-label="Forget this room"
                >
                  forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="foot muted">Fan-made tool for Travian: Legends players. Not affiliated with Travian Games GmbH.</footer>
    </main>
  );
}
