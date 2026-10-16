import { MAX_INTERVAL_MS, MIN_INTERVAL_MS } from './timerMath.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** Countdown text: rounds up, so it reads 3:30 right after a chime and 0:01 in the last second. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Interval text, e.g. 3:30 or 1:05:00. */
export function formatDuration(ms: number): string {
  return formatCountdown(ms);
}

/**
 * Parses "3:30", "03:30", "1:05:00" or whole minutes from 1 to 60 ("4"). Returns ms, or null if the
 * text is not a valid interval. Decimals ("3.20") are refused: they are usually m.ss, not minutes,
 * and reading them either way silently would set the wrong loop for the whole team.
 */
export function parseDuration(text: string): number | null {
  const s = ascii(text);
  let ms: number;
  if (/^\d{1,2}$/.test(s)) {
    const min = Number(s);
    if (min < 1 || min > 60) return null;
    ms = min * 60_000;
  } else {
    const m = /^(?:(\d+):)?(\d{1,3}):(\d{2})$/.exec(s);
    if (!m) return null;
    const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
    if (sec >= 60 || (m[1] !== undefined && min >= 60)) return null;
    ms = ((h * 60 + min) * 60 + sec) * 1000;
  }
  return ms >= MIN_INTERVAL_MS && ms <= MAX_INTERVAL_MS ? ms : null;
}

/** Full-width digits and punctuation (other keyboards) as ASCII, trimmed. */
function ascii(text: string): string {
  return text.normalize('NFKC').trim();
}

const valid = (fix: string): string | null => (parseDuration(fix) !== null ? fix : null);

/** "3:5" or "3.2": one digit of seconds can mean :0d or :d0; the readings that are valid intervals. */
function oneDigitReadings(s: string): string[] {
  const m = /^((?:\d+:)?\d{1,3})[:.,](\d)$/.exec(s);
  if (!m) return [];
  const [, head, d] = m;
  return [...new Set([`${head}:0${d}`, `${head}:${d}0`])].filter((x) => valid(x) !== null);
}

/**
 * The interval a near miss most likely means, as m:ss:
 * - "3.20", "3,20" or "3 20" → "3:20";
 * - "3.5" or "3,5" (minutes) → "3:30", and "3.0" → "3:00" (only halves and wholes are read as minutes);
 * - "3:0" → "3:00", when only one reading of a single seconds digit is valid.
 * Null when there is no confident guess ("3.2" could be 3:02 or 3:20).
 */
export function suggestDuration(text: string): string | null {
  const s = ascii(text);
  const mss = /^(\d{1,3})[.,\s](\d{2})$/.exec(s);
  if (mss) return valid(`${Number(mss[1])}:${mss[2]}`);
  const half = /^(\d{1,3})[.,]([05])$/.exec(s);
  if (half) return valid(formatCountdown((Number(half[1]) * 60 + Number(half[2]) * 6) * 1000));
  const readings = oneDigitReadings(s);
  return readings.length === 1 ? readings[0] : null;
}

/** Why a typed interval was refused, phrased as what to type instead. */
export function durationError(text: string): string {
  const fix = suggestDuration(text);
  if (fix) return `Did you mean ${fix}?`;
  const readings = oneDigitReadings(ascii(text));
  if (readings.length === 2) return `Use two digits for the seconds: ${readings[0]} or ${readings[1]}.`;
  return 'Use m:ss, e.g. 3:20 (10 s to 24 h).';
}

/** A duration in words, e.g. "3 min 20 s" or "1 h 5 min". */
export function formatHuman(ms: number): string {
  const total = Math.round(ms / 1000);
  const parts = [
    [Math.floor(total / 3600), 'h'],
    [Math.floor((total % 3600) / 60), 'min'],
    [total % 60, 's'],
  ] as const;
  return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}`).join(' ') || '0 s';
}

/** Local wall-clock time of a server-epoch instant (uses the PC's time zone, never its clock). */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} d ago`;
}

/** Span such as "2 h 14 m", "4 m 10 s" or "12 s". */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} m`;
  if (m > 0) return `${m} m ${s % 60} s`;
  return `${s} s`;
}
