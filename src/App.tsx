import { useEffect } from 'react';
import Landing from './components/Landing.tsx';
import Room from './components/Room.tsx';
import { closePip } from './engine/pip.ts';
import { useHash } from './hooks/useRoom.ts';
import { parseHash } from './lib/roomId.ts';

function App() {
  const hash = useHash();
  const roomId = parseHash(hash);

  useEffect(() => {
    if (roomId) return;
    // Left the room: no stale countdown in the tab title, no empty pop-out over the game.
    document.title = 'Team Timer';
    closePip();
  }, [roomId]);

  return roomId ? <Room key={roomId} roomId={roomId} /> : <Landing badLink={hash.length > 1} />;
}

export default App;
