import { audioAssets } from '../audio/assets.ts';
import { STEM_META } from '../audio/separation/types.ts';
import type { ClipStem, EffectSettings, Project, Track } from '../state/types.ts';
import { defaultParams } from '../audio/effects/definitions.ts';
import { newId } from '../state/store.ts';

export interface MixDecision {
  trackId: string;
  trackName: string;
  /** What changed, in plain language, so every move can be reviewed. */
  notes: string[];
}

export interface AutoMixResult {
  tracks: Track[];
  decisions: MixDecision[];
  masterGain: number;
}

/** Target level per stem role, relative to the loudest element. */
const TARGET_DB: Partial<Record<ClipStem, number>> = {
  'lead-vocals': 0,
  'backing-vocals': -6,
  drums: -2,
  kick: -2,
  snare: -4,
  hihat: -10,
  percussion: -9,
  bass: -3.5,
  melody: -6,
  instrumental: -4,
  other: -7,
  full: -4,
};

const dbToGain = (db: number) => Math.pow(10, db / 20);
const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-6, g));

/** Loudness estimate for a track's material: RMS over everything it plays. */
function trackLoudness(project: Project, track: Track): number {
  const clips = project.clips.filter((c) => c.trackId === track.id);
  if (clips.length === 0) return 0;
  let sumSq = 0;
  let samples = 0;
  for (const clip of clips) {
    const asset = audioAssets.get(clip.assetId);
    if (!asset) continue;
    const from = Math.floor(clip.offset * asset.sampleRate);
    const to = Math.min(
      asset.channels[0]!.length,
      from + Math.floor((clip.duration / clip.stretch) * asset.sampleRate),
    );
    // Sample every 32nd frame: plenty for a level estimate, far cheaper.
    for (const ch of asset.channels) {
      for (let i = from; i < to; i += 32) {
        const v = ch[i]!;
        sumSq += v * v;
        samples++;
      }
    }
  }
  return samples ? Math.sqrt(sumSq / samples) : 0;
}

function withoutAutoEffects(effects: EffectSettings[]): EffectSettings[] {
  return effects.filter((e) => !e.id.startsWith('auto-'));
}

function autoEffect(type: EffectSettings['type'], params: Record<string, number>): EffectSettings {
  return {
    id: `auto-${newId(type)}`,
    type,
    enabled: true,
    params: { ...defaultParams(type), ...params },
  };
}

/**
 * Produce a balanced starting mix.
 *
 * Every decision is an ordinary track setting the user can undo or override —
 * nothing here is hidden processing. The moves are the ones an engineer makes
 * first: set relative levels, carve space for the vocal, keep the low end in
 * one place, spread the supporting parts, and leave headroom.
 */
export function autoMix(project: Project): AutoMixResult {
  const decisions: MixDecision[] = [];
  const loudness = new Map<string, number>();
  for (const track of project.tracks) loudness.set(track.id, trackLoudness(project, track));

  let reference = 0;
  for (const track of project.tracks) {
    const stem = track.stem ?? 'full';
    if (stem === 'lead-vocals' || stem === 'full' || stem === 'instrumental') {
      reference = Math.max(reference, loudness.get(track.id) ?? 0);
    }
  }
  if (reference <= 0) {
    for (const l of loudness.values()) reference = Math.max(reference, l);
  }
  if (reference <= 0) return { tracks: project.tracks, decisions, masterGain: project.master.volume };

  const hasVocal = project.tracks.some(
    (t) => t.stem === 'lead-vocals' || t.stem === 'backing-vocals',
  );
  const bassHolders = project.tracks.filter((t) => t.stem === 'bass' || t.stem === 'kick');

  const tracks = project.tracks.map((track): Track => {
    const stem = (track.stem ?? 'full') as ClipStem;
    const notes: string[] = [];
    const level = loudness.get(track.id) ?? 0;
    if (level <= 0) return track;

    // 1. Level: aim each role at its target relative to the reference.
    const targetDb = TARGET_DB[stem] ?? -6;
    const currentDb = gainToDb(level / reference);
    const correction = targetDb - currentDb;
    const clamped = Math.max(-18, Math.min(12, correction));
    const volume = Math.max(0.02, Math.min(1.6, dbToGain(clamped)));
    notes.push(`Level set to ${clamped >= 0 ? '+' : ''}${clamped.toFixed(1)} dB for a ${targetDb} dB target.`);

    // 2. Low end: only bass and kick keep their bottom octaves.
    const effects = withoutAutoEffects(track.effects);
    const keepsLows = stem === 'bass' || stem === 'kick' || stem === 'full' || stem === 'instrumental';
    if (!keepsLows && bassHolders.length > 0) {
      effects.unshift(autoEffect('highpass', { cutoff: stem === 'lead-vocals' ? 95 : 120, q: 0.7 }));
      notes.push('High-passed so the bass and kick own the low end.');
    }

    // 3. Masking: dip the vocal's frequency range on everything behind it.
    let midGain = 0;
    if (hasVocal && (stem === 'melody' || stem === 'instrumental' || stem === 'other')) {
      midGain = -2.2;
      notes.push('Mids dipped ~2 dB to clear space for the vocal.');
    }
    if (stem === 'lead-vocals') {
      effects.push(autoEffect('deesser', { frequency: 6800, threshold: -26, amount: 5 }));
      effects.push(
        autoEffect('compressor', {
          threshold: -20,
          ratio: 3,
          attack: 0.006,
          release: 0.14,
          knee: 8,
          makeup: 2,
        }),
      );
      notes.push('De-esser and a gentle compressor added for vocal clarity and consistency.');
    }

    // 4. Stereo placement: keep the centre for lead, bass and kick.
    let pan = track.pan;
    if (stem === 'backing-vocals') {
      pan = 0.22;
      notes.push('Backing vocals nudged off centre.');
    } else if (stem === 'hihat' || stem === 'percussion') {
      pan = -0.18;
      notes.push('Percussion nudged off centre.');
    } else if (stem === 'lead-vocals' || stem === 'bass' || stem === 'kick') {
      pan = 0;
    }

    decisions.push({ trackId: track.id, trackName: track.name, notes });
    return { ...track, volume, pan, midGain, effects };
  });

  // 5. Headroom: scale the master so the summed peak leaves room to master.
  const summedPeak = tracks.reduce((acc, t) => acc + (loudness.get(t.id) ?? 0) * t.volume, 0);
  const masterGain = summedPeak > 0 ? Math.min(1, 0.32 / summedPeak) : project.master.volume;

  return { tracks, decisions, masterGain: Math.max(0.15, Math.min(1, masterGain)) };
}

export function stemLabel(stem: ClipStem): string {
  return stem === 'full' ? 'Full mix' : STEM_META[stem].label;
}
