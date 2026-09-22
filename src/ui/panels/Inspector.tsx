import { useMemo, useState } from 'react';
import { engine, projectDuration } from '../../audio/engine.ts';
import { EFFECT_GROUPS, EFFECT_SPECS } from '../../audio/effects/definitions.ts';
import { MASTERING_PRESETS, masterChainFor } from '../../audio/effects/mastering.ts';
import { actions } from '../../state/store.ts';
import { autoMix } from '../../remix/autoMix.ts';
import { alignClipToGrid, describeAlignment } from '../../remix/align.ts';
import { TRANSITIONS, applyTransition, doubleClip } from '../../remix/transitions.ts';
import { resyncClip } from '../../remix/sync.ts';
import type {
  AutomationLane,
  AutomationTarget,
  Clip,
  EffectSettings,
  EffectType,
  MasteringPreset,
  Project,
  Track,
} from '../../state/types.ts';
import { Meter, MiniSlider, Slider, Spinner, gainToDb, notify } from '../components/primitives.tsx';
import { Icon } from '../components/Icon.tsx';

type Tab = 'mix' | 'clip' | 'fx' | 'auto' | 'master';

const AUTOMATION_TARGETS: { id: AutomationTarget; label: string; min: number; max: number }[] = [
  { id: 'volume', label: 'Volume', min: 0, max: 1.6 },
  { id: 'pan', label: 'Pan', min: -1, max: 1 },
  { id: 'lowGain', label: 'Low EQ', min: -18, max: 18 },
  { id: 'midGain', label: 'Mid EQ', min: -18, max: 18 },
  { id: 'highGain', label: 'High EQ', min: -18, max: 18 },
  { id: 'filterCutoff', label: 'Filter cutoff', min: 40, max: 18000 },
  { id: 'reverbMix', label: 'Reverb send', min: 0, max: 1 },
  { id: 'delayMix', label: 'Delay send', min: 0, max: 1 },
];

interface Props {
  project: Project;
  selectedTrackId: string | null;
  onSelectTrack: (id: string | null) => void;
  selection: string[];
}

export function Inspector({ project, selectedTrackId, onSelectTrack, selection }: Props) {
  const [tab, setTab] = useState<Tab>('mix');
  const track = project.tracks.find((t) => t.id === selectedTrackId) ?? project.tracks[0] ?? null;
  const clip = project.clips.find((c) => c.id === selection[0]) ?? null;

  return (
    <>
      <div className="tabs">
        {(
          [
            ['mix', 'Mix'],
            ['clip', 'Clip'],
            ['fx', 'FX'],
            ['auto', 'Auto'],
            ['master', 'Master'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ padding: 10 }}>
        {tab === 'mix' && (
          <MixTab project={project} selectedTrackId={track?.id ?? null} onSelectTrack={onSelectTrack} />
        )}
        {tab === 'clip' && <ClipTab project={project} clip={clip} />}
        {tab === 'fx' && <FxTab track={track} />}
        {tab === 'auto' && <AutoTab project={project} track={track} />}
        {tab === 'master' && <MasterTab project={project} />}
      </div>
    </>
  );
}

function MixTab({
  project,
  selectedTrackId,
  onSelectTrack,
}: {
  project: Project;
  selectedTrackId: string | null;
  onSelectTrack: (id: string) => void;
}) {
  if (project.tracks.length === 0) {
    return <div className="empty">No tracks yet.</div>;
  }
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <button
          className="primary grow"
          onClick={() => {
            const result = autoMix(project);
            for (const t of result.tracks) actions.updateTrack(t.id, t, { history: false });
            actions.setMaster({ volume: result.masterGain });
            notify(
              `AI mix balanced ${result.decisions.length} tracks. Undo reverts every change at once.`,
              'ok',
            );
          }}
          title="Set levels, carve space for the vocal and leave headroom"
        >
          <Icon name="sliders" size={14} />
          Auto-balance
        </button>
        <button onClick={() => actions.clearSolo()} disabled={!project.tracks.some((t) => t.solo)}>
          Clear solo
        </button>
      </div>

      {project.tracks.map((track) => (
        <TrackStrip
          key={track.id}
          track={track}
          selected={track.id === selectedTrackId}
          onSelect={() => onSelectTrack(track.id)}
        />
      ))}
    </>
  );
}

function TrackStrip({
  track,
  selected,
  onSelect,
}: {
  track: Track;
  selected: boolean;
  onSelect: () => void;
}) {
  const read = useMemo(() => () => engine.trackLevel(track.id), [track.id]);
  return (
    <div className={`strip ${selected ? 'selected' : ''}`} onPointerDown={onSelect}>
      <div className="head">
        <span
          style={{ width: 8, height: 8, borderRadius: 2, background: `hsl(${track.hue} 70% 55%)` }}
        />
        <input
          className="grow"
          value={track.name}
          onChange={(e) => actions.updateTrack(track.id, { name: e.target.value }, { history: false })}
          style={{ background: 'transparent', border: 'none', padding: 0, fontWeight: 600 }}
          aria-label="Track name"
        />
        <button className={track.mute ? 'active' : ''} onClick={() => actions.toggleMute(track.id)}>
          M
        </button>
        <button className={track.solo ? 'active' : ''} onClick={() => actions.toggleSolo(track.id)}>
          S
        </button>
      </div>

      <div className="fader">
        <Meter read={read} />
        <div className="grow">
          <MiniSlider
            label="Vol"
            value={track.volume}
            min={0}
            max={1.6}
            format={(v) => `${gainToDb(v)}`}
            onChange={(v) => actions.updateTrack(track.id, { volume: v }, { history: false })}
            onCommit={(v) => actions.updateTrack(track.id, { volume: v })}
          />
          <MiniSlider
            label="Pan"
            value={track.pan}
            min={-1}
            max={1}
            format={(v) =>
              Math.abs(v) < 0.01 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`
            }
            onChange={(v) => actions.updateTrack(track.id, { pan: v }, { history: false })}
            onCommit={(v) => actions.updateTrack(track.id, { pan: v })}
          />
        </div>
      </div>

      <div className="eq">
        <span className="eyebrow">EQ</span>
        {(['lowGain', 'midGain', 'highGain'] as const).map((key) => (
          <MiniSlider
            key={key}
            label={key === 'lowGain' ? 'Lo' : key === 'midGain' ? 'Mid' : 'Hi'}
            value={track[key]}
            min={-18}
            max={18}
            step={0.1}
            labelWidth={24}
            format={(v) => (Math.abs(v) < 0.05 ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`)}
            onChange={(v) => actions.updateTrack(track.id, { [key]: v }, { history: false })}
            onCommit={(v) => actions.updateTrack(track.id, { [key]: v })}
          />
        ))}
      </div>
    </div>
  );
}

function ClipTab({ project, clip }: { project: Project; clip: Clip | null }) {
  const [aligning, setAligning] = useState(false);
  if (!clip) return <div className="empty">Select a clip on the timeline.</div>;
  const source = project.sources.find((s) => s.id === clip.sourceId);
  const set = (patch: Partial<Clip>, commit = true) =>
    actions.updateClip(clip.id, patch, { history: commit });

  const runAlign = async () => {
    setAligning(true);
    try {
      const { plan, patch } = await alignClipToGrid(project, clip);
      if (Object.keys(patch).length > 0) actions.updateClip(clip.id, patch);
      notify(describeAlignment(plan), plan.moved > 0 ? 'ok' : 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Alignment failed.', 'error');
    } finally {
      setAligning(false);
    }
  };

  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{clip.name}</div>
      <div className="hint" style={{ marginBottom: 10 }}>
        {source?.name ?? 'Unknown source'} · starts at {clip.start.toFixed(2)} s · {clip.duration.toFixed(2)} s long
      </div>

      <Slider
        label="Clip gain"
        value={clip.gain}
        min={0}
        max={2}
        step={0.01}
        format={(v) => `${gainToDb(v)} dB`}
        onChange={(v) => set({ gain: v }, false)}
        onCommit={(v) => set({ gain: v })}
      />
      <Slider
        label="Fade in"
        value={clip.fadeIn}
        min={0}
        max={4}
        step={0.01}
        unit="s"
        onChange={(v) => set({ fadeIn: v }, false)}
        onCommit={(v) => set({ fadeIn: v })}
      />
      <Slider
        label="Fade out"
        value={clip.fadeOut}
        min={0}
        max={4}
        step={0.01}
        unit="s"
        onChange={(v) => set({ fadeOut: v }, false)}
        onCommit={(v) => set({ fadeOut: v })}
      />
      <Slider
        label="Pitch"
        value={clip.pitch}
        min={-12}
        max={12}
        step={1}
        unit="st"
        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`}
        onChange={(v) => set({ pitch: Math.round(v) }, false)}
        onCommit={(v) => set({ pitch: Math.round(v) })}
      />
      <Slider
        label="Speed"
        value={1 / clip.stretch}
        min={0.5}
        max={2}
        step={0.001}
        format={(v) => `${v.toFixed(3)}×`}
        onChange={(v) => set({ stretch: 1 / v, duration: (clip.duration * clip.stretch) / (1 / v) }, false)}
        onCommit={(v) => set({ stretch: 1 / v, duration: (clip.duration * clip.stretch) / (1 / v) })}
      />

      <div className="row wrap" style={{ marginTop: 10 }}>
        <button
          className="primary"
          onClick={() => void runAlign()}
          disabled={aligning}
          title="Nudge syllables onto the beat without quantising the phrasing"
        >
          {aligning ? (
            <span className="row">
              <Spinner /> Aligning…
            </span>
          ) : (
            <>
              <Icon name="align" size={14} />
              Vocal align
            </>
          )}
        </button>
        <button
          onClick={() => {
            const result = doubleClip(project, clip);
            notify(result.message, result.applied ? 'ok' : 'error');
          }}
          title="Add a detuned, slightly late second voice panned opposite"
        >
          Double
        </button>
        <button className={clip.reverse ? 'active' : ''} onClick={() => set({ reverse: !clip.reverse })}>
          Reverse
        </button>
        <button
          onClick={() => {
            if (!source) return;
            actions.updateClip(clip.id, resyncClip(clip, source, project));
            notify('Clip re-synced to the project tempo and key.', 'ok');
          }}
          disabled={!source?.analysis}
          title="Re-warp this clip to the current project tempo and key"
        >
          Re-sync
        </button>
        <button onClick={() => actions.duplicateClip(clip.id)}>Duplicate</button>
        <button className="danger" onClick={() => actions.removeClip(clip.id)}>
          Delete
        </button>
      </div>

      <div className="field-row">
        <span className="eyebrow">Loop</span>
        <div className="btn-group">
          {[2, 4, 8].map((n) => (
            <button key={n} onClick={() => actions.loopClip(clip.id, n)} title={`Repeat ${n} times back to back`}>
              ×{n}
            </button>
          ))}
        </div>
      </div>

      <div className="field-row">
        <span className="eyebrow">Speed</span>
        <div className="btn-group">
          <button onClick={() => actions.setClipSpeed(clip.id, 0.5)} title="Half-time">
            ½×
          </button>
          <button onClick={() => actions.setClipSpeed(clip.id, 1)} title="Back to original speed">
            1×
          </button>
          <button onClick={() => actions.setClipSpeed(clip.id, 2)} title="Double-time">
            2×
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <span className="eyebrow">Transition in</span>
        <div className="btn-grid" style={{ marginTop: 5 }}>
          {TRANSITIONS.map((t) => (
            <button
              key={t.kind}
              title={t.description}
              onClick={() => {
                const result = applyTransition(project, clip, t.kind);
                notify(result.message, result.applied ? 'ok' : 'error');
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <Slider
        label="Tape stop"
        value={clip.tapeStop ?? 0}
        min={0}
        max={Math.min(4, clip.duration)}
        step={0.05}
        unit="s"
        format={(v) => (v < 0.02 ? 'off' : v.toFixed(2))}
        onChange={(v) => set({ tapeStop: v }, false)}
        onCommit={(v) => set({ tapeStop: v })}
      />

      <div className="hint" style={{ marginTop: 10 }}>
        Vocal align nudges syllables onto the beat by stretching between them. Anything already close,
        or deliberately off-grid, is left alone — it is not a quantiser.
      </div>

      {(clip.stretch !== 1 || clip.pitch !== 0) && (
        <div className="notice info" style={{ marginTop: 10 }}>
          Warped clips preview at varispeed, then switch to the phase-vocoder render when it is ready.
          Export always uses the rendered version.
        </div>
      )}
    </>
  );
}

function FxTab({ track }: { track: Track | null }) {
  const [adding, setAdding] = useState<EffectType | ''>('');
  if (!track) return <div className="empty">Select a track.</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <select
          className="grow"
          value={adding}
          onChange={(e) => {
            const type = e.target.value as EffectType;
            if (type) {
              actions.addEffect(track.id, type);
              setAdding('');
            }
          }}
          aria-label="Add an effect"
        >
          <option value="">Add effect…</option>
          {EFFECT_GROUPS.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {Object.values(EFFECT_SPECS)
                .filter((spec) => spec.group === group.id)
                .map((spec) => (
                  <option key={spec.type} value={spec.type}>
                    {spec.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>

      {track.effects.length === 0 && <div className="empty">No effects on {track.name}.</div>}
      {track.effects.map((effect) => (
        <EffectCard key={effect.id} target={track.id} effect={effect} />
      ))}
    </>
  );
}

function EffectCard({ target, effect }: { target: string; effect: EffectSettings }) {
  const [open, setOpen] = useState(true);
  const spec = EFFECT_SPECS[effect.type];

  return (
    <div className={`fx ${effect.enabled ? '' : 'off'}`}>
      <header onClick={() => setOpen((o) => !o)}>
        <input
          type="checkbox"
          checked={effect.enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => actions.updateEffect(target, effect.id, { enabled: e.target.checked })}
          aria-label={`Enable ${spec.label}`}
          style={{ width: 13, height: 13 }}
        />
        <span className="grow">{spec.label}</span>
        <button
          className="ghost icon"
          style={{ width: 20, height: 20 }}
          onClick={(e) => {
            e.stopPropagation();
            actions.removeEffect(target, effect.id);
          }}
          aria-label={`Remove ${spec.label}`}
        >
          <Icon name="close" size={12} />
        </button>
      </header>
      {open && (
        <div className="body">
          <div className="hint" style={{ marginBottom: 4 }}>
            {spec.description}
          </div>
          {spec.params.map((param) => (
            <Slider
              key={param.key}
              label={param.label}
              value={effect.params[param.key] ?? param.default}
              min={param.min}
              max={param.max}
              step={param.step}
              unit={param.unit}
              log={param.curve === 'log'}
              format={(v) => (param.step >= 1 ? v.toFixed(0) : v.toFixed(param.step < 0.01 ? 4 : 2))}
              onChange={(v) =>
                actions.updateEffect(target, effect.id, { params: { [param.key]: v } }, { history: false })
              }
              onCommit={(v) =>
                actions.updateEffect(target, effect.id, { params: { [param.key]: v } })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AutoTab({ project, track }: { project: Project; track: Track | null }) {
  const [target, setTarget] = useState<AutomationTarget>('volume');
  if (!track) return <div className="empty">Select a track.</div>;
  const duration = Math.max(8, projectDuration(project));

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <select
          className="grow"
          value={target}
          onChange={(e) => setTarget(e.target.value as AutomationTarget)}
          aria-label="Automation parameter"
        >
          {AUTOMATION_TARGETS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => actions.addAutomationLane(track.id, target)}
          disabled={track.automation.some((l) => l.target === target)}
        >
          Add lane
        </button>
      </div>

      {track.automation.length === 0 && (
        <div className="empty">
          No automation on {track.name}. Add a lane, then click the graph to place points.
        </div>
      )}

      {track.automation.map((lane) => (
        <LaneEditor key={lane.id} trackId={track.id} lane={lane} duration={duration} />
      ))}
    </>
  );
}

function LaneEditor({
  trackId,
  lane,
  duration,
}: {
  trackId: string;
  lane: AutomationLane;
  duration: number;
}) {
  const spec = AUTOMATION_TARGETS.find((t) => t.id === lane.target)!;
  const W = 300;
  const H = 76;

  const toX = (time: number) => (time / duration) * W;
  const toY = (value: number) => H - ((value - spec.min) / (spec.max - spec.min)) * H;
  const points = [...lane.points].sort((a, b) => a.time - b.time);

  const path = points.length
    ? points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.time).toFixed(1)},${toY(p.value).toFixed(1)}`).join(' ')
    : '';

  const addPoint = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const time = ((e.clientX - rect.left) / rect.width) * duration;
    const value = spec.min + (1 - (e.clientY - rect.top) / rect.height) * (spec.max - spec.min);
    actions.updateAutomationLane(trackId, lane.id, {
      points: [...points, { time: Math.max(0, time), value }].sort((a, b) => a.time - b.time),
    });
  };

  const dragPoint = (index: number) => (e: React.PointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    const svg = e.currentTarget.ownerSVGElement!;
    const rect = svg.getBoundingClientRect();
    let next = points;

    const move = (ev: PointerEvent) => {
      const time = Math.max(0, ((ev.clientX - rect.left) / rect.width) * duration);
      const value = Math.max(
        spec.min,
        Math.min(spec.max, spec.min + (1 - (ev.clientY - rect.top) / rect.height) * (spec.max - spec.min)),
      );
      next = points.map((p, i) => (i === index ? { time, value } : p)).sort((a, b) => a.time - b.time);
      actions.updateAutomationLane(trackId, lane.id, { points: next }, { history: false });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      actions.updateAutomationLane(trackId, lane.id, { points: next });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="fx">
      <header>
        <input
          type="checkbox"
          checked={lane.enabled}
          onChange={(e) => actions.updateAutomationLane(trackId, lane.id, { enabled: e.target.checked })}
          aria-label={`Enable ${spec.label} automation`}
          style={{ width: 13, height: 13 }}
        />
        <span className="grow">{spec.label}</span>
        <span className="hint">{points.length} pts</span>
        <button
          className="ghost icon"
          style={{ width: 20, height: 20 }}
          onClick={() => actions.removeAutomationLane(trackId, lane.id)}
          aria-label="Remove lane"
        >
          <Icon name="close" size={12} />
        </button>
      </header>
      <div className="body">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: H, background: 'var(--bg-input)', borderRadius: 4, cursor: 'crosshair' }}
          onClick={addPoint}
        >
          <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--line)" strokeDasharray="3 3" />
          {path && <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />}
          {points.map((p, i) => (
            <circle
              key={`${p.time}-${i}`}
              cx={toX(p.time)}
              cy={toY(p.value)}
              r="4"
              fill="var(--accent)"
              style={{ cursor: 'grab' }}
              onPointerDown={dragPoint(i)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                actions.updateAutomationLane(trackId, lane.id, {
                  points: points.filter((_, j) => j !== i),
                });
              }}
            />
          ))}
        </svg>
        <div className="hint" style={{ marginTop: 4 }}>
          Click to add a point, drag to move, double-click a point to remove it.
        </div>
      </div>
    </div>
  );
}

function MasterTab({ project }: { project: Project }) {
  const read = useMemo(() => () => engine.masterLevel(), []);
  const chain = masterChainFor(project.master);
  const presetSpec = MASTERING_PRESETS.find((p) => p.id === project.master.preset)!;

  return (
    <>
      <div className="strip">
        <div className="head">
          <span className="grow" style={{ fontWeight: 600 }}>
            Master
          </span>
        </div>
        <div className="fader">
          <Meter read={read} />
          <div className="grow">
            <Slider
              label="Output"
              value={project.master.volume}
              min={0}
              max={1.5}
              step={0.01}
              format={(v) => `${gainToDb(v)} dB`}
              onChange={(v) => actions.setMaster({ volume: v }, { history: false })}
              onCommit={(v) => actions.setMaster({ volume: v })}
            />
            <Slider
              label="Ceiling"
              value={project.master.ceiling}
              min={-12}
              max={0}
              step={0.1}
              unit="dBFS"
              format={(v) => v.toFixed(1)}
              onChange={(v) => actions.setMaster({ ceiling: v }, { history: false })}
              onCommit={(v) => actions.setMaster({ ceiling: v })}
            />
          </div>
        </div>
      </div>

      <label className="hint">Mastering preset</label>
      <select
        style={{ width: '100%', marginTop: 4 }}
        value={project.master.preset}
        onChange={(e) => actions.setMaster({ preset: e.target.value as MasteringPreset })}
      >
        {MASTERING_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <div className="hint" style={{ margin: '6px 0 10px' }}>
        {presetSpec.description}
      </div>

      {chain.length > 0 && (
        <div className="notice info" style={{ marginBottom: 10 }}>
          This preset is just a chain of ordinary effects:{' '}
          {chain.map((e) => EFFECT_SPECS[e.type].label).join(' → ')}. Add your own below to extend it.
        </div>
      )}

      <select
        style={{ width: '100%', marginBottom: 8 }}
        value=""
        onChange={(e) => {
          const type = e.target.value as EffectType;
          if (type) actions.addEffect('master', type);
        }}
        aria-label="Add a master effect"
      >
        <option value="">Add master effect…</option>
        {Object.values(EFFECT_SPECS).map((spec) => (
          <option key={spec.type} value={spec.type}>
            {spec.label}
          </option>
        ))}
      </select>

      {project.master.effects.map((effect) => (
        <EffectCard key={effect.id} target="master" effect={effect} />
      ))}
    </>
  );
}
