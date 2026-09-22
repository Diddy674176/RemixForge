import type { AnalysisResult } from '../audio/workers/protocol.ts';
import type { Clip, Project, Source } from '../state/types.ts';

export const MAX_COMFORTABLE_STRETCH = 1.25;

/** Seconds per bar at a given tempo. */
export function barDuration(bpm: number, meter: number): number {
  return (60 / bpm) * meter;
}

/**
 * Stretch factor that takes `sourceBpm` to `targetBpm`.
 *
 * Returned as timeline-duration / source-duration, which is the convention
 * `Clip.stretch` uses. Tempos are octave-folded first so a 140 BPM track and a
 * 70 BPM one are treated as the same tempo rather than stretched 2:1.
 */
export function stretchFor(sourceBpm: number, targetBpm: number): number {
  if (!sourceBpm || !targetBpm) return 1;
  let src = sourceBpm;
  while (src / targetBpm > 1.45) src /= 2;
  while (targetBpm / src > 1.45) src *= 2;
  return src / targetBpm;
}

/** How far a stretch is from neutral, as a positive fraction. */
export function stretchStrain(factor: number): number {
  return Math.abs(Math.log2(factor));
}

/**
 * Nearest downbeat at or before `time`, falling back to beats then to a bar
 * grid derived from the detected tempo.
 */
export function snapToDownbeat(analysis: AnalysisResult | null, time: number): number {
  if (!analysis) return time;
  const grid = analysis.downbeats.length > 1 ? analysis.downbeats : analysis.beats;
  if (grid.length < 2) return time;
  let best = grid[0]!;
  for (const t of grid) {
    if (t <= time + 1e-6) best = t;
    else break;
  }
  return best;
}

/** Snap a timeline position to the project's beat or bar grid. */
export function snapTime(project: Project, time: number): number {
  if (project.snap === 'off') return Math.max(0, time);
  const beat = 60 / project.bpm;
  const step = project.snap === 'bar' ? beat * project.meter : beat;
  return Math.max(0, Math.round(time / step) * step);
}

export interface SyncedRegion {
  /** Seconds into the source where the region starts. */
  offset: number;
  /** Length in the source's own time. */
  sourceDuration: number;
  /** Length once placed on the timeline. */
  timelineDuration: number;
  stretch: number;
  pitch: number;
}

/**
 * Work out how a slice of a source should be warped to sit in the project.
 *
 * The region start is pulled back to the source's nearest downbeat so vocal
 * phrases never begin in the middle of a beat — the single biggest giveaway
 * of a sloppy mashup.
 */
export function syncRegion(
  source: Source,
  project: Project,
  from: number,
  to: number,
  options: { alignToDownbeat?: boolean; harmonicMatch?: boolean } = {},
): SyncedRegion {
  const analysis = source.analysis;
  const alignToDownbeat = options.alignToDownbeat ?? true;
  const harmonicMatch = options.harmonicMatch ?? project.autoHarmonicMatch;

  const offset = alignToDownbeat ? snapToDownbeat(analysis, from) : Math.max(0, from);
  const sourceDuration = Math.max(0.05, Math.min(source.duration, to) - offset);
  const stretch = analysis ? stretchFor(analysis.bpm, project.bpm) : 1;

  let pitch = 0;
  if (harmonicMatch && analysis) {
    // Stretching already moves pitch when the engine falls back to varispeed,
    // but the quality path preserves it, so the only shift needed is the
    // harmonic one: move the source's tonic onto the project's.
    let d = (project.keyTonic - analysis.key.tonic + 12) % 12;
    if (d > 6) d -= 12;
    pitch = d;
  }

  return {
    offset,
    sourceDuration,
    timelineDuration: sourceDuration * stretch,
    stretch,
    pitch,
  };
}

/** Warnings worth surfacing before a combination is committed. */
export function syncWarnings(source: Source, project: Project): string[] {
  const out: string[] = [];
  const analysis = source.analysis;
  if (!analysis) {
    out.push('Not analysed yet — tempo and key matching are unavailable.');
    return out;
  }
  const stretch = stretchFor(analysis.bpm, project.bpm);
  const strain = stretchStrain(stretch);
  if (strain > Math.log2(MAX_COMFORTABLE_STRETCH)) {
    out.push(
      `Tempo needs a ${Math.round((stretch - 1) * 100)}% change (${analysis.displayBpm} → ${project.bpm} BPM). Expect audible stretching artefacts.`,
    );
  }
  if (analysis.bpmConfidence < 0.35) {
    out.push('Tempo detection was uncertain on this track — check the beat grid before relying on it.');
  }
  let d = (project.keyTonic - analysis.key.tonic + 12) % 12;
  if (d > 6) d -= 12;
  if (project.autoHarmonicMatch && Math.abs(d) > 3) {
    out.push(`Key match needs a ${d > 0 ? '+' : ''}${d} semitone shift — vocals may sound unnatural.`);
  }
  return out;
}

/** Re-warp a clip so it lines up with the project's current tempo and key. */
export function resyncClip(clip: Clip, source: Source, project: Project): Clip {
  const analysis = source.analysis;
  const stretch = analysis ? stretchFor(analysis.bpm, project.bpm) : 1;
  const sourceDuration = clip.duration / (clip.stretch || 1);
  let pitch = clip.pitch;
  if (project.autoHarmonicMatch && analysis) {
    let d = (project.keyTonic - analysis.key.tonic + 12) % 12;
    if (d > 6) d -= 12;
    pitch = d;
  }
  return {
    ...clip,
    stretch,
    pitch,
    duration: sourceDuration * stretch,
    start: snapTime(project, clip.start),
  };
}
