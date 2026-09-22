import { audioAssets } from '../audio/assets.ts';
import { alignAudio } from '../audio/workers/client.ts';
import type { AlignPlan } from '../audio/dsp/vocalAlign.ts';
import type { Clip, Project } from '../state/types.ts';

export interface ClipAlignResult {
  plan: AlignPlan;
  /** Patch to apply to the clip. */
  patch: Partial<Clip>;
}

/**
 * Align a clip's phrasing to the project's beat grid.
 *
 * The clip's own slice of audio is extracted first, so the grid can be
 * expressed in that slice's time base: a project beat at time `b` sits at
 * `(b - clip.start) / clip.stretch` seconds into the slice. Aligning there
 * means that once the clip is played back with its existing offset and
 * stretch, the syllables land on the beat.
 *
 * The result is written to a new asset. The original is untouched, so undo
 * restores the unaligned take exactly.
 */
export async function alignClipToGrid(
  project: Project,
  clip: Clip,
  opts: { divisions?: number; tolerance?: number } = {},
): Promise<ClipAlignResult> {
  const asset = audioAssets.get(clip.assetId);
  if (!asset) throw new Error('That clip has no audio loaded.');

  const rate = asset.sampleRate;
  const from = Math.max(0, Math.round(clip.offset * rate));
  const length = Math.round((clip.duration / clip.stretch) * rate);
  const to = Math.min(asset.channels[0]!.length, from + length);
  if (to - from < rate * 0.5) throw new Error('Clip is too short to align.');

  const slice = asset.channels.map((c) => c.subarray(from, to).slice());

  const beatDur = 60 / project.bpm;
  const beats: number[] = [];
  const firstBeat = Math.ceil(clip.start / beatDur);
  for (let b = firstBeat; b * beatDur <= clip.start + clip.duration; b++) {
    beats.push((b * beatDur - clip.start) / clip.stretch);
  }
  if (beats.length < 2) throw new Error('Clip does not span enough beats to align.');

  const { channels, plan } = await alignAudio(slice, rate, beats, opts);
  if (plan.moved === 0) return { plan, patch: {} };

  const aligned = audioAssets.add(channels, rate);
  return {
    plan,
    patch: {
      assetId: aligned.id,
      offset: 0,
      duration: aligned.duration * clip.stretch,
    },
  };
}

/** One-line summary of what an alignment pass did. */
export function describeAlignment(plan: AlignPlan): string {
  if (plan.moved === 0) {
    return `Nothing moved — all ${plan.kept} detected syllables were already close enough to the beat.`;
  }
  return `Moved ${plan.moved} syllable${plan.moved === 1 ? '' : 's'} by ${plan.meanShiftMs} ms on average (largest ${plan.maxShiftMs} ms). ${plan.kept} left alone.`;
}
