import { describe, expect, it } from 'vitest';
import { formatCountdown, parseDuration } from './format.ts';
import { isRoomId, parseHash, parseRoomInput, randomId } from './roomId.ts';

describe('room ids', () => {
  it('are 22 base64url characters and unique', () => {
    const ids = new Set(Array.from({ length: 500 }, randomId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isRoomId(id)).toBe(true);
  });

  it('parse from a hash, a pasted link or a bare code', () => {
    const id = randomId();
    expect(parseHash(`#${id}`)).toBe(id);
    expect(parseHash(`#/${id}`)).toBe(id);
    expect(parseHash('#nope')).toBeNull();
    expect(parseRoomInput(`https://team-timer.vercel.app/#${id}`)).toBe(id);
    expect(parseRoomInput(`  ${id} `)).toBe(id);
    expect(parseRoomInput('https://example.com/')).toBeNull();
  });
});

describe('format', () => {
  it('rounds the countdown up', () => {
    expect(formatCountdown(210_000)).toBe('3:30');
    expect(formatCountdown(209_001)).toBe('3:30');
    expect(formatCountdown(209_000)).toBe('3:29');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(3_600_000)).toBe('1:00:00');
  });

  it('parses intervals', () => {
    expect(parseDuration('3:30')).toBe(210_000);
    expect(parseDuration('03:30')).toBe(210_000);
    expect(parseDuration('4')).toBe(240_000);
    expect(parseDuration('3.5')).toBe(210_000);
    expect(parseDuration('1:05:00')).toBe(3_900_000);
    expect(parseDuration('3:75')).toBeNull();
    expect(parseDuration('0:05')).toBeNull(); // under 10 s
    expect(parseDuration('abc')).toBeNull();
  });
});
