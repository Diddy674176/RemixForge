import { useCallback, useMemo, useRef, useState } from 'react';
import { engine } from '../../audio/engine.ts';
import { STEM_META } from '../../audio/separation/types.ts';
import { actions } from '../../state/store.ts';
import { snapTime } from '../../remix/sync.ts';
import type { Clip, Project, Track } from '../../state/types.ts';
import { Waveform } from '../components/Waveform.tsx';
import { formatBars, formatTime } from '../components/primitives.tsx';
import { useTransport } from '../hooks.ts';

const HEAD_WIDTH = 168;
const MIN_ZOOM = 4;
const MAX_ZOOM = 400;

interface Props {
  project: Project;
  selection: string[];
  onSelect: (ids: string[]) => void;
  selectedTrackId: string | null;
  onSelectTrack: (id: string | null) => void;
}

export function Timeline({ project, selection, onSelect, selectedTrackId, onSelectTrack }: Props) {
  const [zoom, setZoom] = useState(28);
  const transport = useTransport();
  const scrollerRef = useRef<HTMLDivElement>(null);

  const duration = Math.max(
    32,
    ...project.clips.map((c) => c.start + c.duration + 8),
    transport.position + 8,
  );
  const width = duration * zoom;
  const selectionSet = useMemo(() => new Set(selection), [selection]);

  const seekFromEvent = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const time = Math.max(0, (e.clientX - rect.left) / zoom);
      engine.seek(time);
    },
    [zoom],
  );

  const splitAtPlayhead = useCallback(() => {
    const at = transport.position;
    const hits = project.clips.filter((c) => at > c.start + 0.02 && at < c.start + c.duration - 0.02);
    for (const clip of hits) actions.splitClip(clip.id, at);
  }, [project.clips, transport.position]);

  return (
    <div className="timeline">
      <div className="toolbar">
        <button
          className="ghost"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}
          title="Zoom out"
        >
          –
        </button>
        <button
          className="ghost"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}
          title="Zoom in"
        >
          +
        </button>
        <span className="hint mono">{zoom.toFixed(0)} px/s</span>

        <span style={{ width: 12 }} />
        <span className="hint">Snap</span>
        <select
          value={project.snap}
          onChange={(e) => actions.setSnap(e.target.value as Project['snap'])}
          aria-label="Snap mode"
        >
          <option value="bar">Bar</option>
          <option value="beat">Beat</option>
          <option value="off">Off</option>
        </select>

        <span style={{ width: 12 }} />
        <button onClick={splitAtPlayhead} disabled={project.clips.length === 0} title="Split every clip under the playhead (S)">
          Split
        </button>
        <button
          onClick={() => selection.forEach((id) => actions.duplicateClip(id))}
          disabled={selection.length === 0}
        >
          Duplicate
        </button>
        <button
          className="danger"
          onClick={() => {
            actions.removeClips(selection);
            onSelect([]);
          }}
          disabled={selection.length === 0}
        >
          Delete
        </button>

        <span className="grow" />
        <button onClick={() => actions.addTrack({ name: `Track ${project.tracks.length + 1}` })}>
          Add track
        </button>
      </div>

      <div className="scroller" ref={scrollerRef}>
        <div className="grid" style={{ width: HEAD_WIDTH + width }}>
          <Ruler
            project={project}
            zoom={zoom}
            width={width}
            duration={duration}
            onSeek={seekFromEvent}
          />

          {project.tracks.length === 0 && (
            <div style={{ padding: 28 }}>
              <div className="empty">
                No tracks yet. Import a song, separate it, then press <strong>Use</strong> on a stem —
                or open Quick Remix for the guided route.
              </div>
            </div>
          )}

          {project.tracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              project={project}
              zoom={zoom}
              width={width}
              selection={selectionSet}
              onSelect={onSelect}
              selected={selectedTrackId === track.id}
              onSelectTrack={onSelectTrack}
            />
          ))}

          <div
            className="playhead"
            style={{ left: HEAD_WIDTH + transport.position * zoom, top: 0 }}
          />
        </div>
      </div>
    </div>
  );
}

function Ruler({
  project,
  zoom,
  width,
  duration,
  onSeek,
}: {
  project: Project;
  zoom: number;
  width: number;
  duration: number;
  onSeek: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const beat = 60 / project.bpm;
  const bar = beat * project.meter;
  // Thin the grid out as we zoom away so labels never collide.
  const barStep = Math.max(1, Math.pow(2, Math.ceil(Math.log2(70 / (bar * zoom)))));
  const marks: { time: number; label: string; major: boolean }[] = [];
  for (let i = 0; i * bar < duration; i += barStep) {
    marks.push({ time: i * bar, label: `${i + 1}`, major: true });
  }
  const showBeats = bar * zoom > 90;
  if (showBeats) {
    for (let i = 0; i * beat < duration; i++) {
      if (i % project.meter !== 0) marks.push({ time: i * beat, label: '', major: false });
    }
  }

  const sectionClip = project.clips.find((c) => {
    const source = project.sources.find((s) => s.id === c.sourceId);
    return (source?.analysis?.sections.length ?? 0) > 0;
  });
  const source = project.sources.find((s) => s.id === sectionClip?.sourceId);

  return (
    <div className="ruler">
      <div className="spacer" />
      <div className="scale" style={{ width }} onPointerDown={onSeek}>
        {marks.map((m) => (
          <div
            key={`${m.time}-${m.label}`}
            style={{
              position: 'absolute',
              left: m.time * zoom,
              top: m.major ? 0 : 16,
              bottom: 0,
              borderLeft: `1px solid var(${m.major ? '--line-strong' : '--line'})`,
              paddingLeft: 3,
              fontSize: 10,
              color: 'var(--text-faint)',
              pointerEvents: 'none',
            }}
          >
            {m.label}
          </div>
        ))}

        {project.loop.enabled && (
          <div
            className="loop-region"
            style={{
              left: project.loop.start * zoom,
              width: Math.max(2, (project.loop.end - project.loop.start) * zoom),
            }}
          />
        )}

        {sectionClip &&
          source?.analysis?.sections.map((section) => {
            const left = (sectionClip.start + (section.startTime - sectionClip.offset) * sectionClip.stretch) * zoom;
            const w = (section.endTime - section.startTime) * sectionClip.stretch * zoom;
            if (left + w < 0 || left > width) return null;
            return (
              <div
                key={section.id}
                title={`${section.label} · ${section.bars} bars · energy ${Math.round(section.energy * 100)}%`}
                style={{
                  position: 'absolute',
                  left: Math.max(0, left),
                  width: Math.max(8, w),
                  bottom: 0,
                  height: 12,
                  fontSize: 9,
                  paddingLeft: 3,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  color: 'var(--text-dim)',
                  background: `hsl(${source.hue} 50% 30% / 0.55)`,
                  borderLeft: `1px solid hsl(${source.hue} 60% 55%)`,
                  pointerEvents: 'none',
                }}
              >
                {section.label}
              </div>
            );
          })}
      </div>
    </div>
  );
}

function TrackRow({
  track,
  project,
  zoom,
  width,
  selection,
  onSelect,
  selected,
  onSelectTrack,
}: {
  track: Track;
  project: Project;
  zoom: number;
  width: number;
  selection: Set<string>;
  onSelect: (ids: string[]) => void;
  selected: boolean;
  onSelectTrack: (id: string | null) => void;
}) {
  const clips = project.clips.filter((c) => c.trackId === track.id);

  return (
    <div className="tl-row" style={{ height: track.height }}>
      <div
        className="tl-head"
        style={selected ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
        onPointerDown={() => onSelectTrack(track.id)}
      >
        <div className="title">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: `hsl(${track.hue} 70% 55%)`,
              flex: 'none',
            }}
          />
          <span className="truncate">{track.name}</span>
        </div>
        <div className="mini">
          <button
            className={track.mute ? 'active' : ''}
            onClick={(e) => {
              e.stopPropagation();
              actions.toggleMute(track.id);
            }}
            title="Mute"
          >
            M
          </button>
          <button
            className={track.solo ? 'active' : ''}
            onClick={(e) => {
              e.stopPropagation();
              actions.toggleSolo(track.id);
            }}
            title="Solo"
          >
            S
          </button>
          <span className="grow" />
          <button
            className="ghost"
            onClick={(e) => {
              e.stopPropagation();
              actions.removeTrack(track.id);
            }}
            title="Remove track"
          >
            ✕
          </button>
        </div>
      </div>

      <div
        className="tl-lane"
        style={{ width }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect([]);
        }}
      >
        {clips.map((clip) => (
          <ClipView
            key={clip.id}
            clip={clip}
            track={track}
            project={project}
            zoom={zoom}
            selected={selection.has(clip.id)}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function ClipView({
  clip,
  track,
  project,
  zoom,
  selected,
  onSelect,
}: {
  clip: Clip;
  track: Track;
  project: Project;
  zoom: number;
  selected: boolean;
  onSelect: (ids: string[]) => void;
}) {
  const hue = clip.hue ?? (clip.stem !== 'full' ? STEM_META[clip.stem].hue : track.hue);
  const [drag, setDrag] = useState<{ start: number; duration: number; offset: number } | null>(null);

  const start = drag?.start ?? clip.start;
  const duration = drag?.duration ?? clip.duration;
  const offset = drag?.offset ?? clip.offset;

  /** Move the clip, snapped, committing one history entry on release. */
  const beginMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect([clip.id]);
    const originX = e.clientX;
    const originStart = clip.start;
    let latest = originStart;

    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - originX) / zoom;
      latest = snapTime(project, Math.max(0, originStart + delta));
      setDrag({ start: latest, duration: clip.duration, offset: clip.offset });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (Math.abs(latest - originStart) > 1e-6) actions.updateClip(clip.id, { start: latest });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * Trim. Dragging the left edge moves the source offset with the edge so the
   * audio stays put on the timeline instead of sliding.
   */
  const beginTrim = (side: 'l' | 'r') => (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect([clip.id]);
    const originX = e.clientX;
    const o = { start: clip.start, duration: clip.duration, offset: clip.offset };
    let next = { ...o };

    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - originX) / zoom;
      if (side === 'r') {
        const duration = Math.max(0.05, o.duration + delta);
        next = { ...o, duration };
      } else {
        const rawStart = Math.max(0, Math.min(o.start + o.duration - 0.05, o.start + delta));
        const snapped = snapTime(project, rawStart);
        const shift = snapped - o.start;
        next = {
          start: snapped,
          duration: Math.max(0.05, o.duration - shift),
          offset: Math.max(0, o.offset + shift / clip.stretch),
        };
      }
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      actions.updateClip(clip.id, next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const warped = clip.stretch !== 1 || clip.pitch !== 0;

  return (
    <div
      className={`clip ${selected ? 'selected' : ''}`}
      style={
        {
          left: start * zoom,
          width: Math.max(6, duration * zoom),
          '--h': hue,
        } as React.CSSProperties
      }
      onPointerDown={beginMove}
      onDoubleClick={() => actions.splitClip(clip.id, start + duration / 2)}
      title={`${clip.name}\n${formatTime(duration)} · bar ${formatBars(start, project.bpm, project.meter)}${
        warped ? `\nstretch ${(1 / clip.stretch).toFixed(3)}× · pitch ${clip.pitch > 0 ? '+' : ''}${clip.pitch} st` : ''
      }`}
    >
      <div style={{ position: 'absolute', inset: '14px 0 0' }}>
        <Waveform
          assetId={clip.assetId}
          offset={offset}
          duration={duration / clip.stretch}
          pxPerSecond={zoom * clip.stretch}
          height={Math.max(8, track.height - 20)}
          hue={hue}
        />
      </div>
      <div className="label">
        {clip.name}
        {warped ? ' ·  ⟲' : ''}
      </div>
      <div className="handle l" onPointerDown={beginTrim('l')} />
      <div className="handle r" onPointerDown={beginTrim('r')} />
    </div>
  );
}
