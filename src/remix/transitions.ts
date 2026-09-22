import { audioAssets } from '../audio/assets.ts';
import { defaultParams } from '../audio/effects/definitions.ts';
import { actions, newId, store } from '../state/store.ts';
import type { AutomationTarget, Clip, EffectType, Project, Track } from '../state/types.ts';

export type TransitionKind = 'filter-sweep' | 'delay-throw' | 'reverb-tail' | 'riser' | 'stutter';

export interface TransitionSpec {
  kind: TransitionKind;
  label: string;
  description: string;
}

export const TRANSITIONS: TransitionSpec[] = [
  {
    kind: 'filter-sweep',
    label: 'Filter sweep',
    description: 'Closes a low-pass across the bars before the edit, then snaps it open.',
  },
  {
    kind: 'delay-throw',
    label: 'Delay throw',
    description: 'Spikes a tempo-synced delay send on the last beat so the tail carries over.',
  },
  {
    kind: 'reverb-tail',
    label: 'Reverb tail',
    description: 'Swells the reverb send into the edit and pulls it back after.',
  },
  {
    kind: 'riser',
    label: 'Riser',
    description: 'Adds a synthesised noise sweep that builds into the edit.',
  },
  {
    kind: 'stutter',
    label: 'Stutter',
    description: 'Repeats a short slice of the clip over its final beat.',
  },
];

function beatDuration(project: Project): number {
  return 60 / project.bpm;
}

/** Find an effect of `type` on the track, adding one if it isn't there. */
function ensureEffect(track: Track, type: EffectType, params: Record<string, number>): string {
  const existing = track.effects.find((e) => e.type === type);
  if (existing) {
    actions.updateEffect(track.id, existing.id, { enabled: true, params });
    return existing.id;
  }
  const settings = actions.addEffect(track.id, type);
  actions.updateEffect(track.id, settings.id, { params: { ...defaultParams(type), ...params } });
  return settings.id;
}

/** Add points to a lane, creating it if needed, keeping everything sorted. */
function writeAutomation(
  trackId: string,
  target: AutomationTarget,
  points: { time: number; value: number }[],
): void {
  const project = store.getState().project;
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return;

  let lane = track.automation.find((l) => l.target === target);
  if (!lane) {
    actions.addAutomationLane(trackId, target);
    const updated = store.getState().project.tracks.find((t) => t.id === trackId);
    lane = updated?.automation.find((l) => l.target === target);
  }
  if (!lane) return;

  const merged = [...lane.points, ...points].sort((a, b) => a.time - b.time);
  actions.updateAutomationLane(trackId, lane.id, { points: merged, enabled: true });
}

/**
 * A synthesised riser: filtered noise whose band centre and level climb, with
 * a short drop-out right at the end so the downbeat lands in a gap.
 */
function renderRiser(seconds: number, sampleRate: number): Float32Array[] {
  const n = Math.round(seconds * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  // State-variable band-pass, one per channel.
  const state = [
    { low: 0, band: 0 },
    { low: 0, band: 0 },
  ];
  const q = 0.35;

  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Centre frequency climbs exponentially from 300 Hz to 9 kHz.
    const fc = 300 * Math.pow(30, t);
    const f = 2 * Math.sin((Math.PI * Math.min(fc, sampleRate * 0.45)) / sampleRate);
    // Level builds, then ducks over the final 6% into the edit.
    const env = Math.pow(t, 1.8) * (t > 0.94 ? (1 - t) / 0.06 : 1);

    for (let c = 0; c < 2; c++) {
      const s = state[c]!;
      const input = Math.random() * 2 - 1;
      const high = input - s.low - q * s.band;
      s.band += f * high;
      s.low += f * s.band;
      const value = s.band * env * 0.5;
      if (c === 0) left[i] = value;
      else right[i] = value;
    }
  }
  return [left, right];
}

export interface TransitionResult {
  applied: boolean;
  message: string;
}

/**
 * Apply a transition around a clip boundary.
 *
 * Everything written here is an ordinary effect, automation lane or clip, so a
 * transition can be edited or undone like any other change — there is no
 * hidden "transition object" in the project.
 */
export function applyTransition(
  project: Project,
  clip: Clip,
  kind: TransitionKind,
  opts: { bars?: number } = {},
): TransitionResult {
  const beat = beatDuration(project);
  const bars = opts.bars ?? 1;
  const length = bars * beat * project.meter;
  const edit = clip.start;
  const track = project.tracks.find((t) => t.id === clip.trackId);
  if (!track) return { applied: false, message: 'That clip has no track.' };

  switch (kind) {
    case 'filter-sweep': {
      ensureEffect(track, 'lowpass', { cutoff: 18000, q: 1.2 });
      writeAutomation(track.id, 'filterCutoff', [
        { time: Math.max(0, edit - length), value: 18000 },
        { time: Math.max(0, edit - length * 0.08), value: 320 },
        { time: edit, value: 18000 },
      ]);
      return {
        applied: true,
        message: `Filter sweep over the ${bars} bar${bars === 1 ? '' : 's'} before ${track.name}'s clip.`,
      };
    }

    case 'delay-throw': {
      ensureEffect(track, 'delay', { beats: 0.75, feedback: 0.55, tone: 5000, mix: 0 });
      writeAutomation(track.id, 'delayMix', [
        { time: Math.max(0, edit - beat * 1.2), value: 0 },
        { time: Math.max(0, edit - beat), value: 0.75 },
        { time: edit + beat * 1.5, value: 0 },
      ]);
      return { applied: true, message: `Delay throw on the beat before ${track.name}'s clip.` };
    }

    case 'reverb-tail': {
      ensureEffect(track, 'reverb', { size: 3.2, damping: 0.35, predelay: 0.02, mix: 0 });
      writeAutomation(track.id, 'reverbMix', [
        { time: Math.max(0, edit - length), value: 0.05 },
        { time: edit, value: 0.7 },
        { time: edit + beat * 2, value: 0.08 },
      ]);
      return { applied: true, message: `Reverb swell into ${track.name}'s clip.` };
    }

    case 'riser': {
      const sampleRate = audioAssets.get(clip.assetId)?.sampleRate ?? 48000;
      const asset = audioAssets.add(renderRiser(length, sampleRate), sampleRate);
      const fxTrack =
        store.getState().project.tracks.find((t) => t.name === 'FX') ??
        actions.addTrack({ name: 'FX', hue: 88, volume: 0.55 });

      actions.addClip({
        id: newId('clip'),
        trackId: fxTrack.id,
        sourceId: clip.sourceId,
        stem: 'fx',
        assetId: asset.id,
        name: `Riser — ${bars} bar${bars === 1 ? '' : 's'}`,
        start: Math.max(0, edit - length),
        offset: 0,
        duration: length,
        gain: 0.9,
        fadeIn: 0.05,
        fadeOut: 0.02,
        pitch: 0,
        stretch: 1,
        reverse: false,
        hue: 88,
      });
      return { applied: true, message: `Added a ${bars}-bar riser into the edit.` };
    }

    case 'stutter': {
      // Repeat the clip's first slice across its final beat.
      const sliceCount = 8;
      const region = beat;
      if (clip.duration <= region * 1.5) {
        return { applied: false, message: 'Clip is too short to stutter.' };
      }
      const regionStart = clip.start + clip.duration - region;
      const sliceDuration = region / sliceCount;
      const sourceOffset = clip.offset + (regionStart - clip.start) / clip.stretch;

      actions.updateClip(clip.id, { duration: clip.duration - region });

      const repeats: Clip[] = [];
      for (let i = 0; i < sliceCount; i++) {
        repeats.push({
          ...clip,
          id: newId('clip'),
          name: `${clip.name} (stutter)`,
          start: regionStart + i * sliceDuration,
          offset: sourceOffset,
          duration: sliceDuration,
          fadeIn: Math.min(0.004, sliceDuration / 4),
          fadeOut: Math.min(0.006, sliceDuration / 4),
          tapeStop: 0,
        });
      }
      actions.addClips(repeats, 'Stutter');
      return { applied: true, message: `Stuttered the last beat into ${sliceCount} slices.` };
    }

    default:
      return { applied: false, message: 'Unknown transition.' };
  }
}
