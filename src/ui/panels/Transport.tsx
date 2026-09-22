import { engine, projectDuration } from '../../audio/engine.ts';
import { PITCH_NAMES } from '../../audio/analysis/key.ts';
import { actions } from '../../state/store.ts';
import type { Project } from '../../state/types.ts';
import { formatBars, formatTime } from '../components/primitives.tsx';
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
      <button
        className="primary"
        onClick={() => (transport.playing ? engine.pause() : void engine.play())}
        title={transport.playing ? 'Pause (space)' : 'Play (space)'}
        style={{ width: 48 }}
      >
        {transport.playing ? '❚❚' : '▶'}
      </button>
      <button onClick={() => engine.stop()} title="Stop (return to start)">
        ■
      </button>
      <button
        className={project.loop.enabled ? 'active' : ''}
        onClick={() => actions.setLoop({ enabled: !project.loop.enabled })}
        title="Loop the region set below"
      >
        ↻
      </button>
      <button className={metronome ? 'active' : ''} onClick={onToggleMetronome} title="Metronome">
        ♩
      </button>

      <div className="mono" style={{ minWidth: 148, fontSize: 15 }}>
        {formatTime(transport.position, true)}
        <span style={{ color: 'var(--text-faint)' }}> / {formatTime(total)}</span>
      </div>
      <div className="mono" style={{ minWidth: 62, color: 'var(--text-dim)' }}>
        bar {formatBars(transport.position, project.bpm, project.meter)}
      </div>

      <span style={{ width: 8 }} />

      <label className="row" style={{ gap: 5 }}>
        <span className="hint">BPM</span>
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

      <label className="row" style={{ gap: 5 }}>
        <span className="hint">Key</span>
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

      <label className="row" style={{ gap: 5 }}>
        <span className="hint">Metre</span>
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
        <span className="hint">Auto harmonic match</span>
      </label>

      <div className="row" style={{ gap: 5 }}>
        <span className="hint">Loop</span>
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
