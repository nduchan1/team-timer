import { describe, expect, it } from 'vitest';
import { countUnread, formatChatTime, latestAt, layoutMessages, normalizeChatText, type ChatMessage } from './chat.ts';

const T = new Date(2026, 8, 25, 14, 5).getTime(); // Fri 25 Sep 2026 14:05 local
const msg = (id: string, uid: string, name: string, at: number, text = id): ChatMessage => ({ id, uid, name, text, at });

describe('normalizeChatText', () => {
  it('trims, collapses whitespace and caps the length', () => {
    expect(normalizeChatText('  going   afk \n back soon ')).toBe('going afk back soon');
    expect(normalizeChatText('   ')).toBeNull();
    expect(normalizeChatText('x'.repeat(400))).toHaveLength(300);
  });
});

describe('formatChatTime', () => {
  it('shows only the time today, the weekday this week, the date before that', () => {
    expect(formatChatTime(T, T + 60_000)).toBe('14:05');
    expect(formatChatTime(T - 86_400_000, T)).toBe('Thu 14:05');
    expect(formatChatTime(T - 10 * 86_400_000, T)).toBe('15 Sep 14:05');
  });
});

describe('layoutMessages', () => {
  it('shows one header per run of messages from one person within 5 minutes', () => {
    const g = layoutMessages(
      [
        msg('a', 'u1', 'Nick', T),
        msg('b', 'u1', 'Nick', T + 60_000),
        msg('c', 'u2', 'Dana', T + 70_000),
        msg('d', 'u1', 'Nick', T + 80_000),
        msg('e', 'u1', 'Nick', T + 80_000 + 5 * 60_000),
      ],
      'u2',
      T + 400_000,
    );
    expect(g.map((x) => x.showHeader)).toEqual([true, false, true, true, true]);
    expect(g.map((x) => x.mine)).toEqual([false, false, true, false, false]);
    expect(g[0].time).toBe('14:05');
  });

  it('starts a new run when the same browser changes name', () => {
    const g = layoutMessages([msg('a', 'u1', 'Nick', T), msg('b', 'u1', 'Nicky', T + 1000)], 'x', T);
    expect(g.map((x) => x.showHeader)).toEqual([true, true]);
  });

  it('keeps item keys stable when the oldest message leaves the window', () => {
    const all = Array.from({ length: 52 }, (_, i) => msg(`m${i}`, i % 4 < 2 ? 'u1' : 'u2', i % 4 < 2 ? 'Nick' : 'Dana', T + i * 1000));
    const before = new Set(layoutMessages(all.slice(0, 50), 'x', T).map((x) => x.id));
    const after = layoutMessages(all.slice(1, 51), 'x', T).map((x) => x.id);
    expect(after.filter((id) => !before.has(id))).toEqual(['m50']);
  });
});

describe('unread', () => {
  it('counts only others’ messages newer than what was seen', () => {
    const list = [msg('a', 'u1', 'Nick', T), msg('b', 'me', 'Me', T + 10), msg('c', 'u1', 'Nick', T + 20)];
    expect(countUnread(list, T, 'me')).toBe(1);
    expect(countUnread(list, -Infinity, 'me')).toBe(2);
    expect(latestAt(list)).toBe(T + 20);
    expect(latestAt([])).toBe(-Infinity);
  });
});
