import { describe, expect, it } from 'vitest';
import {
  ARTWORK,
  discordText,
  formatHours,
  MAX_READY_IN_MS,
  parseHours,
  parseReminder,
  phaseOf,
  ReminderTracker,
  withPresets,
  type Reminder,
} from './reminders.ts';

const H = 3_600_000;
const rem = (dueAt?: number, id = 'artwork'): Reminder => ({ id, label: 'Artwork', restartMs: 12 * H, by: 'dys', at: 0, ...(dueAt === undefined ? {} : { dueAt }) });

describe('reminder data', () => {
  it('parses stored data and rejects junk', () => {
    expect(parseReminder('artwork', { label: 'Artwork', restartMs: 43_200_000, by: 'dys', at: 5, dueAt: 9, usedAt: 4, usedBy: 'dys' })).toEqual({
      id: 'artwork',
      label: 'Artwork',
      restartMs: 43_200_000,
      by: 'dys',
      at: 5,
      dueAt: 9,
      usedAt: 4,
      usedBy: 'dys',
    });
    expect(parseReminder('x', { label: 3, by: 'a', at: 1 })).toBeNull();
    expect(parseReminder('x', null)).toBeNull();
  });

  it('always offers the artwork row', () => {
    expect(withPresets([]).map((r) => r.id)).toEqual(['artwork']);
    expect(withPresets([rem(5)])).toEqual([rem(5)]);
    expect(withPresets([])[0].restartMs).toBe(ARTWORK.restartMs);
  });

  it('knows its phase', () => {
    expect(phaseOf(rem(), 10)).toBe('idle');
    expect(phaseOf(rem(20), 10)).toBe('running');
    expect(phaseOf(rem(20), 20)).toBe('due');
  });

  it('reads time left the way the game shows it', () => {
    expect(parseHours('7:41', MAX_READY_IN_MS)).toBe((7 * 60 + 41) * 60_000);
    expect(parseHours('7:41:10', MAX_READY_IN_MS)).toBe(((7 * 60 + 41) * 60 + 10) * 1000);
    expect(parseHours('45', MAX_READY_IN_MS)).toBe(45 * 60_000);
    expect(parseHours('12:00:00', 48 * H)).toBe(12 * H);
    expect(parseHours('0:00:30', MAX_READY_IN_MS)).toBeNull(); // under a minute
    expect(parseHours('7:61', MAX_READY_IN_MS)).toBeNull();
    expect(parseHours('200:00', MAX_READY_IN_MS)).toBeNull(); // over 7 days
    expect(parseHours('soon', MAX_READY_IN_MS)).toBeNull();
  });

  it('writes reminder times with hours, the way they are typed', () => {
    expect(formatHours(12 * H)).toBe('12:00:00');
    expect(formatHours(41 * 60_000 + 10_000)).toBe('0:41:10');
    expect(formatHours(999)).toBe('0:00:01'); // rounds up, like the countdown
    expect(parseHours(formatHours(41 * 60_000), MAX_READY_IN_MS)).toBe(41 * 60_000);
  });

  it('writes a Discord relative timestamp', () => {
    expect(discordText(rem(1_792_166_954_000))).toBe('⏰ Artwork ready <t:1792166954:R>');
  });
});

describe('ReminderTracker: rings each due moment once, only if it saw it coming', () => {
  it('rings once when an armed reminder comes due', () => {
    const t = new ReminderTracker();
    expect(t.update([rem(100)], 50)).toEqual([]);
    expect(t.update([rem(100)], 99)).toEqual([]);
    expect(t.update([rem(100)], 100)).toEqual([rem(100)]);
    expect(t.update([rem(100)], 101)).toEqual([]);
  });

  it('stays silent in a tab that first sees it already due', () => {
    const t = new ReminderTracker();
    expect(t.update([rem(100)], 150)).toEqual([]);
    expect(t.update([rem(100)], 151)).toEqual([]);
  });

  it('stays silent when noticed more than 10 min late (the device slept)', () => {
    const t = new ReminderTracker();
    t.update([rem(1_000)], 0);
    expect(t.update([rem(1_000)], 1_000 + 11 * 60_000)).toEqual([]);
  });

  it('treats a new due time as a new instance', () => {
    const t = new ReminderTracker();
    t.update([rem(100)], 50);
    t.update([rem(100)], 100); // fired
    expect(t.update([rem(700)], 120)).toEqual([]); // snoozed: armed again
    expect(t.update([rem(700)], 700)).toEqual([rem(700)]);
  });

  it('does not ring twice after a backward clock step or a list that blinks empty', () => {
    const t = new ReminderTracker();
    t.update([rem(100)], 50);
    expect(t.update([rem(100)], 100)).toHaveLength(1);
    expect(t.update([rem(100)], 90)).toEqual([]); // clock stepped back
    expect(t.update([rem(100)], 105)).toEqual([]);
    t.update([], 106); // reconnect: empty for a moment
    expect(t.update([rem(100)], 107)).toEqual([]);
  });

  it('still rings an armed reminder that blinked away and came back', () => {
    const t = new ReminderTracker();
    t.update([rem(100)], 50);
    t.update([], 60);
    expect(t.update([rem(100)], 101)).toEqual([rem(100)]);
  });
});
