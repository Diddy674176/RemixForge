import { newId } from '../state/store.ts';
import { STEM_META } from '../audio/separation/types.ts';
import type { Clip, ClipStem, Project, Source } from '../state/types.ts';
import { syncRegion } from './sync.ts';

/** Asset a clip should read for a given source/stem pair. */
export function assetForStem(source: Source, stem: ClipStem): string | null {
  if (stem === 'full') return source.assetId;
  const state = source.stems[stem];
  return state?.ready ? state.assetId : null;
}

export interface RegionSpec {
  from: number;
  to: number;
  /** Where it lands on the timeline. */
  at: number;
}

/**
 * Build a clip that plays `stem` of `source` over `region`, warped to sit in
 * the project's tempo and key.
 */
export function buildClip(
  project: Project,
  source: Source,
  stem: ClipStem,
  trackId: string,
  region: RegionSpec,
  opts: { alignToDownbeat?: boolean; name?: string } = {},
): Clip | null {
  const assetId = assetForStem(source, stem);
  if (!assetId) return null;

  const synced = syncRegion(source, project, region.from, region.to, {
    alignToDownbeat: opts.alignToDownbeat,
  });
  if (synced.timelineDuration <= 0.05) return null;

  const meta = stem !== 'full' ? STEM_META[stem] : undefined;
  return {
    id: newId('clip'),
    trackId,
    sourceId: source.id,
    stem,
    assetId,
    name: opts.name ?? `${source.name} — ${meta?.label ?? 'Full mix'}`,
    start: Math.max(0, region.at),
    offset: synced.offset,
    duration: synced.timelineDuration,
    gain: 1,
    fadeIn: 0.012,
    fadeOut: 0.03,
    pitch: synced.pitch,
    stretch: synced.stretch,
    reverse: false,
    hue: meta?.hue,
  };
}

/** Whole-source clip, aligned to the start of the timeline. */
export function buildFullClip(
  project: Project,
  source: Source,
  stem: ClipStem,
  trackId: string,
  at = 0,
): Clip | null {
  return buildClip(project, source, stem, trackId, { from: 0, to: source.duration, at });
}
