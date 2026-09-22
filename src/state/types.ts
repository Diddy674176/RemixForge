import type { StemId } from '../audio/separation/types.ts';
import type { AnalysisResult } from '../audio/workers/protocol.ts';
import type { Mode } from '../audio/analysis/key.ts';

export type AssetId = string;

/** A clip can play a source's full mix as well as any separated stem. */
export type ClipStem = StemId | 'full';

export type JobState = 'idle' | 'running' | 'done' | 'error';

export interface StemState {
  stemId: StemId;
  assetId: AssetId;
  ready: boolean;
}

export interface Source {
  id: string;
  name: string;
  fileName: string;
  /** Asset holding the untouched imported audio. Never modified. */
  assetId: AssetId;
  duration: number;
  sampleRate: number;
  channelCount: number;
  hue: number;
  analysis: AnalysisResult | null;
  analysisState: JobState;
  analysisProgress: number;
  analysisStage: string;
  analysisError?: string;
  separationState: JobState;
  separationProgress: number;
  separationStage: string;
  separationError?: string;
  separationEngine?: string;
  stems: Partial<Record<StemId, StemState>>;
}

export interface Clip {
  id: string;
  trackId: string;
  sourceId: string;
  stem: ClipStem;
  assetId: AssetId;
  name: string;
  /** Position on the timeline, in seconds. */
  start: number;
  /** Seconds into the source asset where this clip begins. */
  offset: number;
  /** Length on the timeline, in seconds (after any stretch). */
  duration: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  /** Semitones of pitch shift, independent of tempo. */
  pitch: number;
  /** Timeline duration / source duration. 1 = original tempo. */
  stretch: number;
  reverse: boolean;
  /**
   * Seconds of tape-stop at the end of the clip: playback rate ramps to a
   * standstill over this long. 0 disables it.
   */
  tapeStop?: number;
  /** Hue override; falls back to the stem colour. */
  hue?: number;
}

export type EffectType =
  | 'eq'
  | 'highpass'
  | 'lowpass'
  | 'compressor'
  | 'limiter'
  | 'gate'
  | 'reverb'
  | 'delay'
  | 'chorus'
  | 'flanger'
  | 'phaser'
  | 'distortion'
  | 'saturation'
  | 'bitcrush'
  | 'lofi'
  | 'widener'
  | 'deesser';

export interface EffectSettings {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
}

export type AutomationTarget =
  | 'volume'
  | 'pan'
  | 'lowGain'
  | 'midGain'
  | 'highGain'
  | 'filterCutoff'
  | 'reverbMix'
  | 'delayMix'
  | 'pitch';

export interface AutomationPoint {
  time: number;
  value: number;
}

export interface AutomationLane {
  id: string;
  target: AutomationTarget;
  enabled: boolean;
  points: AutomationPoint[];
}

export interface Track {
  id: string;
  name: string;
  hue: number;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Fixed 3-band tone control, always present ahead of the effect chain. */
  lowGain: number;
  midGain: number;
  highGain: number;
  effects: EffectSettings[];
  automation: AutomationLane[];
  height: number;
  /** Set when the track was created to hold one kind of stem. */
  stem?: ClipStem;
}

export type MasteringPreset =
  | 'off'
  | 'balanced'
  | 'loud'
  | 'warm'
  | 'clean'
  | 'bass-heavy'
  | 'bright'
  | 'club'
  | 'headphones'
  | 'streaming';

export interface MasterState {
  volume: number;
  preset: MasteringPreset;
  /** True peak ceiling in dBFS. */
  ceiling: number;
  /** Target integrated loudness in LUFS. */
  targetLufs: number;
  effects: EffectSettings[];
}

export interface LoopRegion {
  enabled: boolean;
  start: number;
  end: number;
}

export type SnapMode = 'off' | 'beat' | 'bar';

/** A saved stem combination the user can flip between instantly. */
export interface Version {
  id: string;
  name: string;
  createdAt: number;
  tracks: Track[];
  clips: Clip[];
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  bpm: number;
  meter: number;
  keyTonic: number;
  keyMode: Mode;
  /** Pitch-shift compatible stems into the project key on import. */
  autoHarmonicMatch: boolean;
  snap: SnapMode;
  sources: Source[];
  tracks: Track[];
  clips: Clip[];
  master: MasterState;
  loop: LoopRegion;
  versions: Version[];
  activeVersionId: string | null;
}

export const DEFAULT_MASTER: MasterState = {
  volume: 1,
  preset: 'off',
  ceiling: -1,
  targetLufs: -14,
  effects: [],
};

export function createProject(name = 'Untitled remix'): Project {
  const now = Date.now();
  return {
    id: `proj-${now.toString(36)}`,
    name,
    createdAt: now,
    updatedAt: now,
    bpm: 120,
    meter: 4,
    keyTonic: 0,
    keyMode: 'minor' as Mode,
    autoHarmonicMatch: true,
    snap: 'bar',
    sources: [],
    tracks: [],
    clips: [],
    master: { ...DEFAULT_MASTER },
    loop: { enabled: false, start: 0, end: 8 },
    versions: [],
    activeVersionId: null,
  };
}
