// Local mode, used when no Firebase config is present: the timer lives in localStorage and syncs between
// tabs of this browser through a BroadcastChannel. The PC clock stands in for the server clock.

import type { TimerState } from '../lib/timerMath.ts';
import { clean, type PresenceEntry, type RoomSync } from './SyncAdapter.ts';

export function createLocalSync(roomId: string, clientId: string): RoomSync {
  const key = `tt.local.${roomId}`;
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`tt-${roomId}`);
  const timerListeners = new Set<(t: TimerState | null) => void>();
  const presenceListeners = new Set<(list: PresenceEntry[]) => void>();
  let me: PresenceEntry | null = null;

  const read = (): TimerState | null => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as TimerState) : null;
    } catch {
      return null;
    }
  };
  const emitTimer = () => {
    const t = read();
    for (const cb of timerListeners) cb(t);
  };
  const emitPresence = () => {
    for (const cb of presenceListeners) cb(me ? [me] : []);
  };
  const onMessage = () => emitTimer();
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) emitTimer();
  };
  channel?.addEventListener('message', onMessage);
  window.addEventListener('storage', onStorage); // second channel, in case a message is missed

  return {
    mode: 'local',

    subscribeTimer(cb) {
      timerListeners.add(cb);
      queueMicrotask(() => cb(read()));
      return () => timerListeners.delete(cb);
    },

    async write(build, meta, clickNow) {
      const cur = read();
      const next = build(cur, clickNow);
      if (!next) return { ok: false };
      const state: TimerState = clean({ ...next, v: (cur?.v ?? 0) + 1, updatedAt: Date.now(), updatedBy: meta.by, action: meta.action });
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch {
        return { ok: false, error: 'Not saved: browser storage is unavailable.' };
      }
      channel?.postMessage('changed');
      emitTimer();
      return { ok: true };
    },

    subscribeConnection(cb) {
      cb(true);
      return () => {};
    },

    subscribeRoughOffset(cb) {
      cb(0);
      return () => {};
    },

    async sampleClock() {
      const t0 = performance.now();
      return { t0, t3: t0, serverMs: Date.now() };
    },

    subscribePresence(cb) {
      presenceListeners.add(cb);
      queueMicrotask(emitPresence);
      return () => presenceListeners.delete(cb);
    },

    setPresence(p) {
      me = p ? { cid: clientId, name: p.name, onDuty: p.onDuty } : null;
      emitPresence();
    },

    kick() {},

    dispose() {
      channel?.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
      channel?.close();
      timerListeners.clear();
      presenceListeners.clear();
    },
  };
}
