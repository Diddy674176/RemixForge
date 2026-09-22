import { engine, projectDuration } from '../../audio/engine.ts';
import { PITCH_NAMES } from '../../audio/analysis/key.ts';
import { actions } from '../../state/store.ts';
import type { Project } from '../../state/types.ts';
import { formatBars, formatTime } from '../components/primitives.tsx';
import { Icon } from '../components/Icon.tsx';
import { useTransport } from '../hooks.ts';

interface Props {
  project: Project;
  metronome: boolean;
  onToggleMetronome: () => void;
}

export function Transport({ project, metronome, onToggleMetronome }: Props) {
  const transport = useTransport();
  const total = projectDuration(project);

  return (
    <div className="transport">
      <div className="row" style={{ gap: 5 }}>
        <button
          className="primary icon lg"
          onClick={() => (transport.playing ? engine.pause() : void engine.play())}
          title={transport.playing ? 'Pause — space' : 'Play — space'}
          aria-label={transport.playing ? 'Pause' : 'Play'}
        >
          <Icon name={transport.playing ? 'pause' : 'play'} size={16} weight={2} />
        </button>
        <button className="icon lg" onClick={() => engine.stop()} title="Stop and return to the start" aria-label="Stop">
          <Icon name="stop" size={13} />
        </button>
        <button
          className={`icon lg ${project.loop.enabled ? 'active' : ''}`}
          onClick={() => actions.setLoop({ enabled: !project.loop.enabled })}
          title="Loop the region — L"
          aria-label="Loop"
        >
          <Icon name="loop" size={15} />
        </button>
        <button
          className={`icon lg ${metronome ? 'active' : ''}`}
          onClick={onToggleMetronome}
          title="Metronome — M"
          aria-label="Metronome"
        >
          <Icon name="metronome" size={15} />
        </button>
      </div>

      {/* Primary readout: elapsed large, total and bar secondary. */}
      <div className="row" style={{ gap: 10, marginLeft: 4 }}>
        <span
          className="mono"
          style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.04em', minWidth: 92 }}
        >
          {formatTime(transport.position, true)}
        </span>
        <span className="col" style={{ gap: 0, lineHeight: 1.25 }}>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
            {formatTime(total)}
          </span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
            bar {formatBars(transport.position, project.bpm, project.meter)}
          </span>
        </span>
      </div>

      <span className="divider" style={{ width: 1, height: 26, background: 'var(--line-2)' }} />

      <label className="row" style={{ gap: 6 }}>
        <span className="eyebrow">BPM</span>
        <input
          type="number"
          className="mono"
          min={20}
          max={300}
          step={0.5}
          value={project.bpm}
          onChange={(e) => actions.setTempo(Number(e.target.value))}
          style={{ width: 68 }}
        />
      </label>

      <label className="row" style={{ gap: 6 }}>
        <span className="eyebrow">Key</span>
        <select
          value={project.keyTonic}
          onChange={(e) => actions.setKey(Number(e.target.value), project.keyMode)}
          aria-label="Project key"
        >
          {PITCH_NAMES.map((name, i) => (
            <option key={name} value={i}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={project.keyMode}
          onChange={(e) => actions.setKey(project.keyTonic, e.target.value as 'major' | 'minor')}
          aria-label="Project mode"
        >
          <option value="minor">minor</option>
          <option value="major">major</option>
        </select>
      </label>

      <label className="row" style={{ gap: 6 }}>
        <span className="eyebrow">Metre</span>
        <select
          value={project.meter}
          onChange={(e) => actions.setMeter(Number(e.target.value))}
          aria-label="Time signature"
        >
          <option value={4}>4/4</option>
          <option value={3}>3/4</option>
          <option value={6}>6/8</option>
        </select>
      </label>

      <span className="grow" />

      <label className="row" style={{ gap: 6 }} title="Pitch-shift stems into the project key when placing them">
        <input
          type="checkbox"
          checked={project.autoHarmonicMatch}
          onChange={(e) => actions.setAutoHarmonicMatch(e.target.checked)}
        />
        <span className="hint">Harmonic match</span>
      </label>

      <div className="row" style={{ gap: 6 }}>
        <span className="eyebrow">Loop</span>
        <input
          type="number"
          className="mono"
          step={0.5}
          min={0}
          value={project.loop.start}
          onChange={(e) => actions.setLoop({ start: Number(e.target.value) })}
          style={{ width: 64 }}
          aria-label="Loop start"
        />
        <input
          type="number"
          className="mono"
          step={0.5}
          min={0}
          value={project.loop.end}
          onChange={(e) => actions.setLoop({ end: Number(e.target.value) })}
          style={{ width: 64 }}
          aria-label="Loop end"
        />
      </div>
    </div>
  );
}
