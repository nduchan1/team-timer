import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import Landing from './components/Landing.tsx';
import Room from './components/Room.tsx';
import { closePip } from './engine/pip.ts';
import { useHash } from './hooks/useRoom.ts';
import { parseRoute } from './lib/roomId.ts';

// Its own chunk: the timer page never loads the oasis helper's code.
const OasisPage = lazy(() => import('./oasis/OasisPage.tsx'));

/** A chunk from an older deploy is gone after an update: offer a reload instead of a blank page. */
class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="landing">
        <section className="card">
          <h2>This page couldn’t load</h2>
          <p className="muted">Team Timer was probably updated in the meantime.</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}

function App() {
  const hash = useHash();
  const route = parseRoute(hash);

  useEffect(() => {
    if (route.page === 'room') return;
    // Left the room: no empty pop-out over the game. The oasis helper sets its own title.
    closePip();
    if (route.page === 'landing') document.title = 'Team Timer';
  }, [route.page]);

  if (route.page === 'room') return <Room key={route.roomId} roomId={route.roomId} />;
  if (route.page === 'oases') {
    return (
      <ChunkBoundary>
        <Suspense fallback={<p className="muted center">Loading…</p>}>
          <OasisPage key={route.roomId ?? ''} roomId={route.roomId} />
        </Suspense>
      </ChunkBoundary>
    );
  }
  return <Landing badLink={route.bad} />;
}

export default App;
