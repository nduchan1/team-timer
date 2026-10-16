import { describe, expect, it } from 'vitest';
import { formatServerTime } from './serverTime.ts';

const at = (iso: string) => Date.parse(iso);

describe('server time (UK time)', () => {
  it('is UTC+1 in summer and UTC+0 in winter', () => {
    expect(formatServerTime(at('2026-10-16T13:09:08Z'))).toBe('14:09:08');
    expect(formatServerTime(at('2026-11-16T13:09:08Z'))).toBe('13:09:08');
  });

  it('follows the 25 Oct 2026 clock change (both 00:30Z and 01:30Z read 01:30)', () => {
    expect(formatServerTime(at('2026-10-24T23:30:00Z'), false)).toBe('00:30');
    expect(formatServerTime(at('2026-10-25T00:30:00Z'), false)).toBe('01:30');
    expect(formatServerTime(at('2026-10-25T01:30:00Z'), false)).toBe('01:30');
  });

  it('writes midnight as 00, never 24', () => {
    expect(formatServerTime(at('2026-12-01T00:00:05Z'))).toBe('00:00:05');
  });
});
