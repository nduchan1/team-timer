// Firebase Realtime Database implementation of RoomSync.
//   rooms/{room}/timer            the shared TimerState (see database.rules.json)
//   rooms/{room}/presence/{cid}   who has the room open; removed by onDisconnect
//   clock/{cid}                   scratch cell for clock samples; never listened to, so get() reads the server

import {
  get,
  goOffline,
  goOnline,
  onDisconnect,
  onValue,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  type Database,
} from 'firebase/database';
import type { TimerState } from '../lib/timerMath.ts';
import { clean, STALE_WRITE_MS, withTimeout, type PresenceEntry, type RoomSync } from './SyncAdapter.ts';

const RECONNECT_AFTER_MS = 10_000;
const KICK_GAP_MS = 30_000;

function message(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  if (/permission_denied/i.test(s)) return 'Not saved: the server refused it (too fast, or invalid). Try again.';
  // The write may or may not have reached the server before the connection dropped.
  if (/disconnect/i.test(s)) return 'Connection lost: check the timer before trying again.';
  return `Not saved: ${s}`;
}

export function createFirebaseSync(db: Database, roomId: string, clientId: string): RoomSync {
  const timerRef = ref(db, `rooms/${roomId}/timer`);
  const presenceListRef = ref(db, `rooms/${roomId}/presence`);
  const presenceRef = ref(db, `rooms/${roomId}/presence/${clientId}`);
  const clockRef = ref(db, `clock/${clientId}`);

  let connected = false;
  let disconnectedSince = performance.now();
  let lastKick = -Infinity;
  let presence: { name: string; onDuty: boolean } | null = null;
  const connListeners = new Set<(c: boolean) => void>();

  const writePresence = () => {
    if (!presence || !connected) return;
    const p = presence;
    onDisconnect(presenceRef)
      .remove()
      .then(() => set(presenceRef, { name: p.name, onDuty: p.onDuty, since: serverTimestamp() }))
      .catch(() => {
        // retried on the next reconnect
      });
  };

  const unsubConnected = onValue(ref(db, '.info/connected'), (snap) => {
    connected = snap.val() === true;
    if (connected) {
      // onDisconnect handlers are consumed when they fire, so re-arm them on every connect.
      onDisconnect(clockRef).remove().catch(() => {});
      writePresence();
    } else {
      disconnectedSince = performance.now();
    }
    for (const cb of connListeners) cb(connected);
  });

  return {
    mode: 'firebase',

    subscribeTimer(cb, onError) {
      return onValue(
        timerRef,
        (snap) => cb((snap.val() as TimerState | null) ?? null),
        (err) => onError(message(err)),
      );
    },

    async write(build, meta, clickNow, serverNow) {
      // Offline, the SDK buffers the write and replays it at reconnect, possibly minutes later.
      if (!connected) return { ok: false, error: 'Offline: not saved.' };
      let stale = false;
      try {
        const res = await runTransaction(
          timerRef,
          (cur: TimerState | null) => {
            // The SDK re-runs this when the stored value changed underneath us (possibly much later,
            // after a reconnect). Applying "Raided now" at that later moment would shift the timer.
            if (serverNow() - clickNow > STALE_WRITE_MS) {
              stale = true;
              return undefined;
            }
            const next = build(cur, clickNow);
            if (!next) return undefined; // abort
            return clean({ ...next, v: (cur?.v ?? 0) + 1, updatedAt: serverTimestamp(), updatedBy: meta.by, action: meta.action });
          },
          { applyLocally: true },
        );
        if (!res.committed && stale) return { ok: false, error: 'Not saved: the connection was too slow. Check the timer and try again.' };
        return { ok: res.committed };
      } catch (e) {
        return { ok: false, error: message(e) };
      }
    },

    subscribeConnection(cb) {
      connListeners.add(cb);
      cb(connected);
      return () => connListeners.delete(cb);
    },

    subscribeRoughOffset(cb) {
      return onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
        const v = snap.val();
        if (typeof v === 'number') cb(v);
      });
    },

    async sampleClock() {
      // Never queue a clock write while offline: the SDK would replay it at reconnect, stale.
      if (!connected) throw new Error('offline');
      const t0 = performance.now();
      await withTimeout(set(clockRef, serverTimestamp()), 5000, 'clock write');
      const t3 = performance.now();
      const snap = await withTimeout(get(clockRef), 5000, 'clock read');
      const serverMs = snap.val();
      if (typeof serverMs !== 'number') throw new Error('clock read returned no value');
      return { t0, t3, serverMs };
    },

    subscribePresence(cb) {
      return onValue(presenceListRef, (snap) => {
        const val = (snap.val() ?? {}) as Record<string, { name?: unknown; onDuty?: unknown }>;
        const list: PresenceEntry[] = Object.entries(val)
          .filter(([, p]) => p && typeof p.name === 'string')
          .map(([cid, p]) => ({ cid, name: p.name as string, onDuty: p.onDuty === true }));
        cb(list);
      });
    },

    setPresence(p) {
      presence = p;
      if (p) writePresence();
      else {
        onDisconnect(presenceRef).cancel().catch(() => {});
        remove(presenceRef).catch(() => {});
      }
    },

    kick() {
      // In a hidden tab the SDK waits a random 0–5 min before reconnecting; don't wait that long.
      const now = performance.now();
      if (connected || !navigator.onLine) return;
      if (now - disconnectedSince < RECONNECT_AFTER_MS || now - lastKick < KICK_GAP_MS) return;
      lastKick = now;
      goOffline(db);
      goOnline(db);
    },

    dispose() {
      unsubConnected();
      connListeners.clear();
      if (presence) {
        presence = null;
        remove(presenceRef).catch(() => {});
      }
    },
  };
}
