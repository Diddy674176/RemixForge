export type StemId =
  | 'lead-vocals'
  | 'backing-vocals'
  | 'drums'
  | 'kick'
  | 'snare'
  | 'hihat'
  | 'percussion'
  | 'bass'
  | 'melody'
  | 'guitar'
  | 'piano'
  | 'synth'
  | 'strings'
  | 'brass'
  | 'pads'
  | 'fx'
  | 'other'
  | 'instrumental';

export interface StemMeta {
  id: StemId;
  label: string;
  /** Hue used for waveform + mixer colouring, so stems stay distinguishable. */
  hue: number;
  group: 'vocals' | 'drums' | 'bass' | 'harmony' | 'mix';
}

export const STEM_META: Record<StemId, StemMeta> = {
  'lead-vocals': { id: 'lead-vocals', label: 'Lead vocals', hue: 341, group: 'vocals' },
  'backing-vocals': { id: 'backing-vocals', label: 'Backing vocals', hue: 318, group: 'vocals' },
  drums: { id: 'drums', label: 'Drums', hue: 28, group: 'drums' },
  kick: { id: 'kick', label: 'Kick', hue: 16, group: 'drums' },
  snare: { id: 'snare', label: 'Snare', hue: 40, group: 'drums' },
  hihat: { id: 'hihat', label: 'Hi-hats', hue: 52, group: 'drums' },
  percussion: { id: 'percussion', label: 'Percussion', hue: 8, group: 'drums' },
  bass: { id: 'bass', label: 'Bass', hue: 266, group: 'bass' },
  melody: { id: 'melody', label: 'Melody', hue: 192, group: 'harmony' },
  guitar: { id: 'guitar', label: 'Guitar', hue: 150, group: 'harmony' },
  piano: { id: 'piano', label: 'Piano / keys', hue: 210, group: 'harmony' },
  synth: { id: 'synth', label: 'Synth', hue: 288, group: 'harmony' },
  strings: { id: 'strings', label: 'Strings', hue: 172, group: 'harmony' },
  brass: { id: 'brass', label: 'Brass', hue: 44, group: 'harmony' },
  pads: { id: 'pads', label: 'Pads', hue: 232, group: 'harmony' },
  fx: { id: 'fx', label: 'FX', hue: 88, group: 'harmony' },
  other: { id: 'other', label: 'Other', hue: 120, group: 'harmony' },
  instrumental: { id: 'instrumental', label: 'Instrumental', hue: 204, group: 'mix' },
};

export const DEFAULT_TARGETS: StemId[] = ['lead-vocals', 'drums', 'bass', 'melody'];

export interface SeparationRequest {
  /** One Float32Array per channel, all the same length. */
  channels: Float32Array[];
  sampleRate: number;
  targets: StemId[];
}

export interface SeparatedStem {
  id: StemId;
  channels: Float32Array[];
}

export interface SeparationProgress {
  /** 0..1 */
  value: number;
  stage: string;
}

export interface SeparationEngine {
  id: string;
  name: string;
  description: string;
  /** Stems this engine can actually produce. */
  supports: StemId[];
  /** Resolve false when the engine's backend isn't reachable/configured. */
  available(): Promise<boolean>;
  separate(
    request: SeparationRequest,
    onProgress?: (p: SeparationProgress) => void,
  ): Promise<SeparatedStem[]>;
}

/** Stems the built-in DSP engine cannot produce — these need a model backend. */
export const MODEL_ONLY_STEMS: StemId[] = [
  'guitar',
  'piano',
  'synth',
  'strings',
  'brass',
  'pads',
  'fx',
];
