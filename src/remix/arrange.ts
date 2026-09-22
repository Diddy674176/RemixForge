import type { Section, SectionLabel } from '../audio/analysis/structure.ts';
import type { Clip, ClipStem, Project, Source } from '../state/types.ts';
import { buildClip } from './build.ts';
import { barDuration } from './sync.ts';

export interface ArrangementPart {
  stem: ClipStem;
  sourceId: string;
  /** Section to take from that source; falls back to the best match. */
  sectionId?: string;
  trackId: string;
}

export interface ArrangementSlot {
  id: string;
  label: SectionLabel;
  /** Length in bars at the project tempo. */
  bars: number;
  parts: ArrangementPart[];
}

/** Pick the section that best matches a label, preferring longer ones. */
export function sectionFor(source: Source, label: SectionLabel): Section | null {
  const sections = source.analysis?.sections ?? [];
  if (sections.length === 0) return null;
  const exact = sections.filter((s) => s.label === label);
  const pool = exact.length ? exact : sections;
  return pool.reduce((best, s) =>
    s.endTime - s.startTime > best.endTime - best.startTime ? s : best,
  );
}

/**
 * Turn an arrangement plan into clips.
 *
 * Every slot starts on a bar line, and each part is pulled from its source's
 * matching section, trimmed to the slot length, and warped to the project
 * tempo — so sections from different songs line up bar for bar.
 */
export function buildArrangement(
  project: Project,
  slots: ArrangementSlot[],
  sourcesById: Map<string, Source>,
): Clip[] {
  const bar = barDuration(project.bpm, project.meter);
  const clips: Clip[] = [];
  let cursor = 0;

  for (const slot of slots) {
    const slotDuration = slot.bars * bar;
    for (const part of slot.parts) {
      const source = sourcesById.get(part.sourceId);
      if (!source) continue;

      const section = part.sectionId
        ? (source.analysis?.sections.find((s) => s.id === part.sectionId) ?? null)
        : sectionFor(source, slot.label);
      const from = section?.startTime ?? 0;
      // Take slot-length worth of material in the *source's* own time.
      const sourceSpan = slotDuration / Math.max(0.01, stretchOf(project, source));
      const to = Math.min(source.duration, from + sourceSpan);

      const clip = buildClip(project, source, part.stem, part.trackId, { from, to, at: cursor });
      if (!clip) continue;
      // Trim to exactly the slot so sections stay locked to the bar grid.
      clip.duration = Math.min(clip.duration, slotDuration);
      clip.fadeIn = Math.min(0.02, clip.duration / 4);
      clip.fadeOut = Math.min(0.05, clip.duration / 4);
      clips.push(clip);
    }
    cursor += slotDuration;
  }
  return clips;
}

function stretchOf(project: Project, source: Source): number {
  const bpm = source.analysis?.bpm;
  if (!bpm) return 1;
  let src = bpm;
  while (src / project.bpm > 1.45) src /= 2;
  while (project.bpm / src > 1.45) src *= 2;
  return src / project.bpm;
}

export const DEFAULT_SLOT_LABELS: SectionLabel[] = [
  'intro',
  'verse',
  'chorus',
  'verse',
  'chorus',
  'bridge',
  'chorus',
  'outro',
];

export const SLOT_BARS: Record<SectionLabel, number> = {
  intro: 8,
  verse: 16,
  'pre-chorus': 8,
  chorus: 16,
  bridge: 8,
  drop: 16,
  instrumental: 8,
  breakdown: 8,
  outro: 8,
};

/**
 * Add a short crossfade wherever two clips on the same track butt together,
 * and lengthen the fade when the two sides come from different songs.
 */
export function smoothTransitions(clips: Clip[]): Clip[] {
  const byTrack = new Map<string, Clip[]>();
  for (const c of clips) {
    const list = byTrack.get(c.trackId) ?? [];
    list.push(c);
    byTrack.set(c.trackId, list);
  }

  const out = [...clips];
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      const gap = cur.start - (prev.start + prev.duration);
      if (Math.abs(gap) > 0.05) continue;
      const differentSource = prev.sourceId !== cur.sourceId;
      const fade = Math.min(differentSource ? 0.28 : 0.08, prev.duration / 3, cur.duration / 3);
      prev.fadeOut = Math.max(prev.fadeOut, fade);
      cur.fadeIn = Math.max(cur.fadeIn, fade);
      // Overlap by the fade length so the crossfade is genuine rather than a
      // dip to silence and back.
      cur.start = Math.max(0, cur.start - fade);
    }
  }
  return out;
}
