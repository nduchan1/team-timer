import type { Snapshot, TimerController } from '../engine/controller.ts';
import type { ChimePreset } from '../lib/prefs.ts';

const PRESETS: { value: ChimePreset; label: string }[] = [
  { value: 'bell', label: 'Bell' },
  { value: 'double', label: 'Double beep' },
  { value: 'soft', label: 'Soft tone' },
];

const WARNINGS = [0, 5, 10, 15, 30];

export default function SoundPanel({ snap, ctrl }: { snap: Snapshot; ctrl: TimerController }) {
  const p = snap.prefs;
  return (
    <section className="card sound">
      <h2>Sound (just for you)</h2>
      <div className="row">
        <label className="label" htmlFor="volume">
          Volume
        </label>
        <input
          id="volume"
          type="range"
          min={0}
          max={100}
          value={p.volume}
          className="grow"
          onChange={(e) => ctrl.setPrefs({ volume: Number(e.target.value) })}
        />
        <span className="num">{p.volume}</span>
      </div>
      <div className="row wrap">
        <label className="label" htmlFor="preset">
          Chime
        </label>
        <select id="preset" value={p.preset} onChange={(e) => ctrl.setPrefs({ preset: e.target.value as ChimePreset })}>
          {PRESETS.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={() => ctrl.testSound()}>
          Test
        </button>
      </div>
      <div className="row wrap">
        <label className="label" htmlFor="prewarn">
          Warning
        </label>
        <select id="prewarn" value={p.preWarnSec} onChange={(e) => ctrl.setPrefs({ preWarnSec: Number(e.target.value) })}>
          {WARNINGS.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? 'Off' : `${s} s before`}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={() => ctrl.testWarning()}>
          Test
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={p.muted} onChange={(e) => ctrl.setPrefs({ muted: e.target.checked })} />
        Mute me
      </label>
      <label className="check">
        <input type="checkbox" checked={p.dutyOnly} onChange={(e) => ctrl.setPrefs({ dutyOnly: e.target.checked })} />
        Chime only while I’m on duty (or nobody is)
      </label>
      {!snap.soundWanted && snap.joined && <p className="muted small">Your chime is silent right now.</p>}
      <p className="muted small">Use this volume, not the tab’s mute: a muted tab can’t chime.</p>
    </section>
  );
}
