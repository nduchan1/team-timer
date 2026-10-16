import { describe, expect, it } from 'vitest';
import { popLine, type PopLineInput } from './popLine.ts';

const calm: PopLineInput = {
  joined: true,
  sound: 'running',
  mode: 'firebase',
  connected: true,
  clockQuality: 'precise',
  missedShown: 0,
  silencedBy: [],
  updateReady: false,
  chatUnread: 0,
  onDutyNames: [],
};

describe('pop-out status line', () => {
  it('shows the most important problem first', () => {
    const all: PopLineInput = { ...calm, sound: 'suspended', connected: false, missedShown: 2, silencedBy: ['kvislion'], updateReady: true, chatUnread: 3 };
    expect(popLine(all).text).toMatch(/Sound is off/);
    expect(popLine({ ...all, sound: 'running' }).text).toMatch(/Offline/);
    expect(popLine({ ...all, sound: 'running', connected: true }).text).toMatch(/2 chimes missed/);
    expect(popLine({ ...all, sound: 'running', connected: true, missedShown: 0 }).text).toBe('💬 3 new messages');
    expect(popLine({ ...all, sound: 'running', connected: true, missedShown: 0, chatUnread: 0 })).toEqual({
      tone: 'amber',
      text: '🔕 Silent: kvislion on duty',
      action: 'on-duty',
    });
    expect(popLine({ ...calm, updateReady: true }).text).toMatch(/Update ready/);
    expect(popLine({ ...calm, updateReady: true, chatUnread: 1 }).text).toBe('💬 1 new message');
  });

  it('otherwise says who is on duty', () => {
    expect(popLine({ ...calm, onDutyNames: ['dysclosure'] }).text).toBe('On duty: dysclosure');
    expect(popLine(calm).text).toBe('Nobody is on raid duty');
  });

  it('ignores connection and clock in local mode', () => {
    expect(popLine({ ...calm, mode: 'local', connected: false, clockQuality: 'none' }).text).toBe('Nobody is on raid duty');
  });
});
