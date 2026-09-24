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
 * Parses "3:30", "03:30", "1:05:00" or a plain number of minutes ("4", "3.5").
 * Returns ms, or null if the text is not a valid interval.
 */
export function parseDuration(text: string): number | null {
  const s = text.trim();
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(s)) {
    ms = Math.round(Number(s) * 60) * 1000;
  } else {
    const m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2})$/.exec(s);
    if (!m) return null;
    const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
    if (sec >= 60 || (m[1] !== undefined && min >= 60)) return null;
    ms = ((h * 60 + min) * 60 + sec) * 1000;
  }
  return ms >= MIN_INTERVAL_MS && ms <= MAX_INTERVAL_MS ? ms : null;
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
