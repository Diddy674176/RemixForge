import { useMemo, useState } from 'react';
import { STEM_META, type StemId } from '../../audio/separation/types.ts';
import { actions, newId, store, trackForStem } from '../../state/store.ts';
import {
  DEFAULT_SLOT_LABELS,
  SLOT_BARS,
  buildArrangement,
  sectionFor,
  smoothTransitions,
  type ArrangementSlot,
} from '../../remix/arrange.ts';
import { barDuration } from '../../remix/sync.ts';
import type { SectionLabel } from '../../audio/analysis/structure.ts';
import type { Project } from '../../state/types.ts';
import { Panel, formatTime, notify } from '../components/primitives.tsx';
import { Icon } from '../components/Icon.tsx';

/** Roles an arrangement slot can fill, in mixer order. */
const ROLES: StemId[] = ['lead-vocals', 'drums', 'bass', 'melody', 'instrumental'];

const LABELS: SectionLabel[] = [
  'intro',
  'verse',
  'pre-chorus',
  'chorus',
  'drop',
  'bridge',
  'breakdown',
  'instrumental',
  'outro',
];

interface SlotDraft {
  id: string;
  label: SectionLabel;
  bars: number;
  /** Role → source id, or '' for silence in this slot. */
  parts: Partial<Record<StemId, string>>;
}

function defaultSlots(defaultSourceId: string): SlotDraft[] {
  return DEFAULT_SLOT_LABELS.map((label) => ({
    id: newId('slot'),
    label,
    bars: SLOT_BARS[label],
    parts: {
      'lead-vocals': label === 'intro' || label === 'outro' ? '' : defaultSourceId,
      drums: label === 'intro' ? '' : defaultSourceId,
      bass: label === 'intro' ? '' : defaultSourceId,
      melody: defaultSourceId,
    },
  }));
}

/**
 * Arrangement mode: lay out a song section by section, taking each part from
 * whichever source you like.
 *
 * Slots are bar counts at the project tempo, so sections from songs recorded
 * at different tempos line up bar for bar once each is warped.
 */
export function Arrangement({ project }: { project: Project }) {
  const usable = useMemo(
    () => project.sources.filter((s) => s.analysis && Object.keys(s.stems).length > 0),
    [project.sources],
  );
  const [slots, setSlots] = useState<SlotDraft[]>([]);

  const seeded = slots.length > 0 ? slots : usable[0] ? defaultSlots(usable[0].id) : [];
  const totalBars = seeded.reduce((a, s) => a + s.bars, 0);
  const totalSeconds = totalBars * barDuration(project.bpm, project.meter);

  const update = (id: string, patch: Partial<SlotDraft>) =>
    setSlots(seeded.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const setPart = (id: string, role: StemId, sourceId: string) =>
    setSlots(seeded.map((s) => (s.id === id ? { ...s, parts: { ...s.parts, [role]: sourceId } } : s)));

  const build = () => {
    const sourcesById = new Map(project.sources.map((s) => [s.id, s]));

    // Make sure every role in use has a track before laying out the clips.
    const trackIds = new Map<StemId, string>();
    for (const role of ROLES) {
      const used = seeded.some((s) => s.parts[role]);
      if (!used) continue;
      trackIds.set(role, trackForStem(store.getState().project, role).id);
    }

    const arrangement: ArrangementSlot[] = seeded.map((slot) => ({
      id: slot.id,
      label: slot.label,
      bars: slot.bars,
      parts: ROLES.filter((role) => slot.parts[role] && trackIds.has(role)).map((role) => ({
        stem: role,
        sourceId: slot.parts[role]!,
        trackId: trackIds.get(role)!,
        sectionId: sectionFor(sourcesById.get(slot.parts[role]!)!, slot.label)?.id,
      })),
    }));

    const latest = store.getState().project;
    const clips = smoothTransitions(buildArrangement(latest, arrangement, sourcesById));

    const existing = latest.clips.map((c) => c.id);
    if (existing.length) actions.removeClips(existing);
    if (clips.length === 0) {
      notify('Nothing could be placed — check the chosen sources have those stems separated.', 'error');
      return;
    }
    actions.addClips(clips, 'Build arrangement');
    notify(
      `Built ${seeded.length} sections (${totalBars} bars, ${formatTime(totalSeconds)}) from ${clips.length} clips.`,
      'ok',
    );
  };

  return (
    <Panel title="Arrangement" count={seeded.length || undefined} defaultOpen={false}>
      {usable.length === 0 ? (
        <div className="hint">
          Import and separate at least one song, then build a section-by-section arrangement here.
        </div>
      ) : (
        <>
          <div className="hint" style={{ marginBottom: 8 }}>
            Each slot is a number of bars at {project.bpm} BPM. Pick where every part comes from — the
            matching section of that song is pulled in, warped to the project tempo and trimmed to the
            slot.
          </div>

          {seeded.map((slot) => (
            <div className="fx" key={slot.id} style={{ marginBottom: 6 }}>
              <header style={{ cursor: 'default' }}>
                <select
                  value={slot.label}
                  onChange={(e) => {
                    const label = e.target.value as SectionLabel;
                    update(slot.id, { label, bars: SLOT_BARS[label] });
                  }}
                  aria-label="Section type"
                  style={{ width: 118 }}
                >
                  {LABELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={slot.bars}
                  onChange={(e) => update(slot.id, { bars: Math.max(1, Number(e.target.value)) })}
                  style={{ width: 58 }}
                  aria-label="Bars"
                />
                <span className="hint">bars</span>
                <span className="grow" />
                <button
                  className="ghost icon"
                  style={{ width: 20, height: 20 }}
                  onClick={() => setSlots(seeded.filter((s) => s.id !== slot.id))}
                  aria-label="Remove section"
                >
                  <Icon name="close" size={12} />
                </button>
              </header>
              <div className="body">
                {ROLES.map((role) => (
                  <label className="row" key={role} style={{ gap: 6, margin: '3px 0' }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: `hsl(${STEM_META[role].hue} 70% 55%)`,
                        flex: 'none',
                      }}
                    />
                    <span className="hint" style={{ width: 92 }}>
                      {STEM_META[role].label}
                    </span>
                    <select
                      className="grow"
                      value={slot.parts[role] ?? ''}
                      onChange={(e) => setPart(slot.id, role, e.target.value)}
                    >
                      <option value="">—</option>
                      {usable
                        .filter((s) => s.stems[role]?.ready)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="row" style={{ marginTop: 8 }}>
            <button
              onClick={() =>
                setSlots([
                  ...seeded,
                  {
                    id: newId('slot'),
                    label: 'chorus',
                    bars: SLOT_BARS.chorus,
                    parts: { 'lead-vocals': usable[0]!.id, drums: usable[0]!.id },
                  },
                ])
              }
            >
              <Icon name="plus" size={13} />
              Add section
            </button>
            <button className="ghost" onClick={() => setSlots(defaultSlots(usable[0]!.id))}>
              Reset
            </button>
          </div>

          <button
            className="primary"
            style={{ width: '100%', marginTop: 8 }}
            onClick={build}
            disabled={seeded.length === 0}
          >
            Build arrangement — {totalBars} bars, {formatTime(totalSeconds)}
          </button>
          <div className="hint" style={{ marginTop: 6 }}>
            Replaces what is on the timeline. Transitions between different songs get a longer
            crossfade automatically. Undo restores the previous arrangement.
          </div>
        </>
      )}
    </Panel>
  );
}
