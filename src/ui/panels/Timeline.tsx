import { useCallback, useMemo, useRef, useState } from 'react';
import { engine } from '../../audio/engine.ts';
import { STEM_META } from '../../audio/separation/types.ts';
import { actions } from '../../state/store.ts';
import { snapTime } from '../../remix/sync.ts';
import type { Clip, Project, Track } from '../../state/types.ts';
import { Waveform } from '../components/Waveform.tsx';
import { formatBars, formatTime } from '../components/primitives.tsx';
import { Icon } from '../components/Icon.tsx';
import { useTransport } from '../hooks.ts';

const HEAD_WIDTH = 176;
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
          className="ghost icon"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <Icon name="zoomOut" size={15} />
        </button>
        <button
          className="ghost icon"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <Icon name="zoomIn" size={15} />
        </button>
        <span className="hint mono" style={{ minWidth: 46 }}>
          {zoom.toFixed(0)} px/s
        </span>

        <span className="divider" />

        <Icon name="magnet" size={14} style={{ color: 'var(--text-3)' }} />
        <select
          value={project.snap}
          onChange={(e) => actions.setSnap(e.target.value as Project['snap'])}
          aria-label="Snap mode"
          title="Snap clips to the grid"
        >
          <option value="bar">Bar</option>
          <option value="beat">Beat</option>
          <option value="off">Free</option>
        </select>

        <span className="divider" />

        <button
          onClick={splitAtPlayhead}
          disabled={project.clips.length === 0}
          title="Split every clip under the playhead — S"
        >
          <Icon name="split" size={14} />
          Split
        </button>
        <button
          onClick={() => selection.forEach((id) => actions.duplicateClip(id))}
          disabled={selection.length === 0}
          title="Duplicate selection — ⌘D"
        >
          <Icon name="copy" size={14} />
          Duplicate
        </button>
        <button
          className="danger icon"
          onClick={() => {
            actions.removeClips(selection);
            onSelect([]);
          }}
          disabled={selection.length === 0}
          title="Delete selection"
          aria-label="Delete selection"
        >
          <Icon name="trash" size={14} />
        </button>

        <span className="grow" />
        {selection.length > 0 && (
          <span className="hint mono">
            {selection.length} selected
          </span>
        )}
        <button
          onClick={() => actions.addTrack({ name: `Track ${project.tracks.length + 1}` })}
          title="Add an empty track"
        >
          <Icon name="plus" size={14} />
          Track
        </button>
      </div>

      <div className="scroller" ref={scrollerRef}>
        <div className="grid" style={{ width: HEAD_WIDTH + width }}>
          <Ruler
            project={project}
            zoom={zoom}
            width={width}
            duration={duration}
            selection={selectionSet}
            onSeek={seekFromEvent}
          />

          {project.tracks.length === 0 && (
            <div style={{ padding: 40, maxWidth: 440 }}>
              <div className="empty" style={{ padding: '26px 20px' }}>
                <Icon
                  name="layers"
                  size={26}
                  weight={1.3}
                  style={{ color: 'var(--text-3)', margin: '0 auto 10px' }}
                />
                <div style={{ color: 'var(--text-2)', marginBottom: 4 }}>Nothing on the timeline</div>
                Import a song, separate it, then press <strong>Use</strong> on a stem — or open Quick
                Remix for the guided route.
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

          {/* No tracks means nothing to point at, and the line would otherwise
              cut straight through the empty state. */}
          {project.tracks.length > 0 && (
            <div className="playhead" style={{ left: HEAD_WIDTH + transport.position * zoom, top: 0 }} />
          )}
        </div>
      </div>
    </div>
  );
}

function hasSections(project: Project, sourceId: string): boolean {
  const source = project.sources.find((s) => s.id === sourceId);
  return (source?.analysis?.sections.length ?? 0) > 0;
}

function Ruler({
  project,
  zoom,
  width,
  duration,
  selection,
  onSeek,
}: {
  project: Project;
  zoom: number;
  width: number;
  duration: number;
  selection: Set<string>;
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

  // Show the section map of whichever clip is selected, so picking a clip
  // reveals where that song's verses and choruses fall on the timeline.
  const sectionClip =
    project.clips.find((c) => selection.has(c.id) && hasSections(project, c.sourceId)) ??
    project.clips.find((c) => hasSections(project, c.sourceId));
  const source = project.sources.find((s) => s.id === sectionClip?.sourceId);

  return (
    <div className="ruler">
      <div className="spacer" />
      <div className="scale" style={{ width }} onPointerDown={onSeek}>
        {marks.map((m) => (
          <div
            key={`${m.time}-${m.label}`}
            className={`tick ${m.major ? 'major' : ''}`}
            style={{ left: m.time * zoom, top: m.major ? 0 : 18 }}
          >
            {m.label && <span>{m.label}</span>}
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
                className="section"
                title={`${section.label} · ${section.bars} bars · energy ${Math.round(section.energy * 100)}%`}
                style={{
                  left: Math.max(0, left),
                  width: Math.max(8, w),
                  // Energy drives lightness, so the arrangement's shape is
                  // legible from the section strip alone.
                  background: `hsl(${source.hue} 42% ${16 + section.energy * 16}%)`,
                  borderLeftColor: `hsl(${source.hue} 62% 58%)`,
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
        className={`tl-head ${selected ? 'sel' : ''}`}
        onPointerDown={() => onSelectTrack(track.id)}
      >
        <div className="title">
          <span className="chip" style={{ background: `hsl(${track.hue} 68% 54%)` }} />
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
            className={`solo ${track.solo ? 'active' : ''}`}
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
            className="ghost icon"
            style={{ width: 18, height: 18 }}
            onClick={(e) => {
              e.stopPropagation();
              actions.removeTrack(track.id);
            }}
            title="Remove track"
            aria-label={`Remove ${track.name}`}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      </div>

      <div
        className="tl-lane"
        style={
          {
            width,
            '--bar-w': `${(60 / project.bpm) * project.meter * zoom}px`,
            '--beat-w': `${(60 / project.bpm) * zoom}px`,
          } as React.CSSProperties
        }
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
        {warped && <Icon name="align" size={9} weight={2.2} style={{ opacity: 0.8 }} />}
        {clip.tapeStop ? <Icon name="arrowDown" size={9} weight={2.2} style={{ opacity: 0.8 }} /> : null}
        <span className="truncate">{clip.name}</span>
      </div>
      <div className="handle l" onPointerDown={beginTrim('l')} />
      <div className="handle r" onPointerDown={beginTrim('r')} />
    </div>
  );
}
