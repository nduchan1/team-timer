// Pure chat helpers: message shape, text cleanup, grouping for display, unread counting.

export const CHAT_LIMIT = 50;
export const CHAT_MAX_LEN = 300;
/** Consecutive messages from one person within this gap share one header. */
const GROUP_GAP_MS = 5 * 60_000;

export interface ChatMessage {
  id: string;
  /** Stable per-browser id of the sender (not the per-tab presence id). */
  uid: string;
  name: string;
  text: string;
  /** Server epoch ms. */
  at: number;
}

/**
 * One rendered message. Items are keyed by message id (never re-keyed as old messages scroll out of
 * the window); only the first message of a run from one person shows the name/time header.
 */
export interface ChatItem {
  id: string;
  name: string;
  text: string;
  mine: boolean;
  showHeader: boolean;
  time: string;
}

/** Trims and collapses whitespace; null when nothing is left to send. */
export function normalizeChatText(text: string): string | null {
  const s = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
  return s.length > 0 ? s : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "14:05" today, "Mon 14:05" within a week, "12 Sep 14:05" before that (local time zone). */
export function formatChatTime(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hm;
  if (now - at < 6 * 86_400_000) return `${DAYS[d.getDay()]} ${hm}`;
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${hm}`;
}

export function layoutMessages(msgs: ChatMessage[], myUid: string, now: number): ChatItem[] {
  let last: ChatMessage | null = null;
  return msgs.map((m) => {
    const continues = last !== null && last.uid === m.uid && last.name === m.name && m.at - last.at < GROUP_GAP_MS;
    last = m;
    return { id: m.id, name: m.name, text: m.text, mine: m.uid === myUid, showHeader: !continues, time: formatChatTime(m.at, now) };
  });
}

/** Messages from others newer than seenAt. */
export function countUnread(msgs: ChatMessage[], seenAt: number, myUid: string): number {
  let n = 0;
  for (const m of msgs) if (m.uid !== myUid && m.at > seenAt) n++;
  return n;
}

export function latestAt(msgs: ChatMessage[]): number {
  let max = -Infinity;
  for (const m of msgs) if (m.at > max) max = m.at;
  return max;
}
