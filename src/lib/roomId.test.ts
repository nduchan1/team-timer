import { describe, expect, it } from 'vitest';
import { durationError, formatCountdown, formatHuman, parseDuration, suggestDuration } from './format.ts';
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
    expect(parseDuration('60')).toBe(3_600_000);
    expect(parseDuration('1:05:00')).toBe(3_900_000);
    expect(parseDuration('3:75')).toBeNull();
    expect(parseDuration('0:05')).toBeNull(); // under 10 s
    expect(parseDuration('abc')).toBeNull();
  });

  it('refuses ambiguous intervals instead of guessing', () => {
    expect(parseDuration('3.20')).toBeNull(); // was read as 3.2 min = 3:12
    expect(parseDuration('3.5')).toBeNull();
    expect(parseDuration('3:5')).toBeNull(); // 3:05 or 3:50?
    expect(parseDuration('200')).toBeNull(); // was 200 min
    expect(parseDuration('0')).toBeNull();
  });

  it('suggests what a near miss most likely means', () => {
    expect(suggestDuration('3.20')).toBe('3:20');
    expect(suggestDuration('3,20')).toBe('3:20');
    expect(suggestDuration(' 3 20 ')).toBe('3:20');
    expect(suggestDuration('3.5')).toBe('3:30');
    expect(suggestDuration('3,5')).toBe('3:30');
    expect(suggestDuration('3.0')).toBe('3:00');
    expect(suggestDuration('3.75')).toBeNull(); // 75 s is not m:ss
    expect(suggestDuration('3.2')).toBeNull(); // 3:02 or 3:20, never 3:12
    expect(suggestDuration('3:5')).toBeNull(); // 3:05 or 3:50
    expect(suggestDuration('3:0')).toBe('3:00'); // the only valid reading
    expect(suggestDuration('3:7')).toBe('3:07'); // 3:70 is not valid
    expect(suggestDuration('abc')).toBeNull();
    expect(durationError('3.20')).toBe('Did you mean 3:20?');
    expect(durationError('3:5')).toBe('Use two digits for the seconds: 3:05 or 3:50.');
    expect(durationError('3.2')).toBe('Use two digits for the seconds: 3:02 or 3:20.');
    expect(durationError('1:30:5')).toBe('Use two digits for the seconds: 1:30:05 or 1:30:50.');
    expect(durationError('abc')).toMatch(/^Use m:ss/);
  });

  it('reads full-width digits like ASCII', () => {
    expect(parseDuration('３:２０')).toBe(200_000);
    expect(suggestDuration('３．２０')).toBe('3:20');
  });

  it('writes durations in words', () => {
    expect(formatHuman(200_000)).toBe('3 min 20 s');
    expect(formatHuman(180_000)).toBe('3 min');
    expect(formatHuman(3_900_000)).toBe('1 h 5 min');
    expect(formatHuman(43_200_000)).toBe('12 h');
    expect(formatHuman(45_000)).toBe('45 s');
  });
});
