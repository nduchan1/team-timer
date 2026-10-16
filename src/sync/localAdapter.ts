// Local mode, used when no Firebase config is present: the timer lives in localStorage and syncs between
// tabs of this browser through a BroadcastChannel. The PC clock stands in for the server clock.

import { CHAT_LIMIT, type ChatMessage } from '../lib/chat.ts';
import { parseReminder, type Reminder } from '../lib/reminders.ts';
import type { TimerState } from '../lib/timerMath.ts';
import { clean, type PresenceEntry, type RoomSync } from './SyncAdapter.ts';

export function createLocalSync(roomId: string, clientId: string): RoomSync {
  const key = `tt.local.${roomId}`;
  const chatKey = `tt.localchat.${roomId}`;
  const remKey = `tt.localrem.${roomId}`;
  const chatListeners = new Set<(msgs: ChatMessage[]) => void>();
  const remListeners = new Set<(list: Reminder[]) => void>();
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
  const readChat = (): ChatMessage[] => {
    try {
      const list = JSON.parse(localStorage.getItem(chatKey) ?? '[]') as ChatMessage[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const emitChat = () => {
    const list = readChat().slice(-CHAT_LIMIT);
    for (const cb of chatListeners) cb(list);
  };
  const emitPresence = () => {
    for (const cb of presenceListeners) cb(me ? [me] : []);
  };
  const readRem = (): Record<string, Record<string, unknown>> => {
    try {
      const v = JSON.parse(localStorage.getItem(remKey) ?? '{}') as unknown;
      return v && typeof v === 'object' ? (v as Record<string, Record<string, unknown>>) : {};
    } catch {
      return {};
    }
  };
  const emitRem = () => {
    const list = Object.entries(readRem())
      .map(([id, v]) => parseReminder(id, v))
      .filter((r): r is Reminder => r !== null);
    for (const cb of remListeners) cb(list);
  };
  const onMessage = (e: MessageEvent) => (e.data === 'chat' ? emitChat() : e.data === 'reminders' ? emitRem() : emitTimer());
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) emitTimer();
    if (e.key === chatKey) emitChat();
    if (e.key === remKey) emitRem();
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

    subscribeChat(cb, _onError) {
      chatListeners.add(cb);
      queueMicrotask(emitChat);
      return () => chatListeners.delete(cb);
    },

    async sendChat(m) {
      const list = readChat();
      list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, ...m, at: Date.now() });
      try {
        localStorage.setItem(chatKey, JSON.stringify(list.slice(-200)));
      } catch {
        return { ok: false, error: 'Message not sent: browser storage is unavailable.' };
      }
      channel?.postMessage('chat');
      emitChat();
      return { ok: true };
    },

    subscribePresence(cb) {
      presenceListeners.add(cb);
      queueMicrotask(emitPresence);
      return () => presenceListeners.delete(cb);
    },

    subscribeReminders(cb, _onError) {
      remListeners.add(cb);
      queueMicrotask(emitRem);
      return () => remListeners.delete(cb);
    },

    async writeReminder(id, p) {
      const all = readRem();
      const next: Record<string, unknown> = { ...all[id], label: p.label, restartMs: p.restartMs, by: p.by, at: Date.now() };
      if (p.dueAt === null) delete next.dueAt;
      else if (p.dueAt !== undefined) next.dueAt = p.dueAt;
      if (p.used) {
        next.usedAt = Date.now();
        next.usedBy = p.by;
      }
      if (p.clearUsed) {
        delete next.usedAt;
        delete next.usedBy;
      }
      all[id] = next;
      try {
        localStorage.setItem(remKey, JSON.stringify(all));
      } catch {
        return { ok: false, error: 'Not saved: browser storage is unavailable.' };
      }
      channel?.postMessage('reminders');
      emitRem();
      return { ok: true };
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
      chatListeners.clear();
      remListeners.clear();
    },
  };
}
