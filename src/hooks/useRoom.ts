import { useEffect, useSyncExternalStore } from 'react';
import { getController, releaseController, retainController, type Snapshot, type TimerController } from '../engine/controller.ts';

/** The room's controller and its latest snapshot (re-renders at most about once a second). */
export function useRoom(roomId: string): [Snapshot, TimerController] {
  const ctrl = getController(roomId);
  useEffect(() => {
    retainController(roomId);
    return () => releaseController(roomId);
  }, [roomId]);
  const snap = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot);
  return [snap, ctrl];
}

function subscribeHash(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => location.hash);
}
