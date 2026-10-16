import { formatHuman, parseDuration, suggestDuration } from '../lib/format.ts';

/** Next to an interval box: "= 3 min 20 s" for a valid value, or a one-click fix for a near miss ("3.20"). */
export default function DurationHint({ text, onUse }: { text: string; onUse: (fixed: string) => void }) {
  if (!text.trim()) return null;
  const ms = parseDuration(text);
  if (ms !== null) return <span className="muted small">= {formatHuman(ms)}</span>;
  const fix = suggestDuration(text);
  if (!fix) return null;
  return (
    <span className="small note">
      Did you mean {fix}?{' '}
      <button type="button" className="btn small" onClick={() => onUse(fix)}>
        Use {fix}
      </button>
    </span>
  );
}
