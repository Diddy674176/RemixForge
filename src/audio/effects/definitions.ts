import type { EffectType } from '../../state/types.ts';

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  /** Slider response — frequencies and times read better logarithmically. */
  curve?: 'linear' | 'log';
}

export interface EffectSpec {
  type: EffectType;
  label: string;
  group: 'eq' | 'dynamics' | 'effects' | 'creative';
  description: string;
  params: ParamSpec[];
}

const freq = (key: string, label: string, def: number, min = 20, max = 20000): ParamSpec => ({
  key,
  label,
  min,
  max,
  step: 1,
  default: def,
  unit: 'Hz',
  curve: 'log',
});

const db = (key: string, label: string, def: number, min = -24, max = 24): ParamSpec => ({
  key,
  label,
  min,
  max,
  step: 0.1,
  default: def,
  unit: 'dB',
});

const mix = (def = 0.3): ParamSpec => ({
  key: 'mix',
  label: 'Mix',
  min: 0,
  max: 1,
  step: 0.01,
  default: def,
});

export const EFFECT_SPECS: Record<EffectType, EffectSpec> = {
  eq: {
    type: 'eq',
    label: 'Parametric EQ',
    group: 'eq',
    description: 'Three sweepable peaking bands with adjustable Q.',
    params: [
      freq('lowFreq', 'Low freq', 120, 20, 800),
      db('lowGain', 'Low gain', 0),
      freq('midFreq', 'Mid freq', 1200, 200, 8000),
      db('midGain', 'Mid gain', 0),
      { key: 'midQ', label: 'Mid Q', min: 0.2, max: 8, step: 0.05, default: 1 },
      freq('highFreq', 'High freq', 6000, 1500, 18000),
      db('highGain', 'High gain', 0),
    ],
  },
  highpass: {
    type: 'highpass',
    label: 'High-pass',
    group: 'eq',
    description: 'Removes low end — the fastest way to stop stems fighting.',
    params: [
      freq('cutoff', 'Cutoff', 80, 20, 2000),
      { key: 'q', label: 'Resonance', min: 0.1, max: 12, step: 0.1, default: 0.7 },
    ],
  },
  lowpass: {
    type: 'lowpass',
    label: 'Low-pass',
    group: 'eq',
    description: 'Removes high end. Automate the cutoff for filter sweeps.',
    params: [
      freq('cutoff', 'Cutoff', 12000, 200, 20000),
      { key: 'q', label: 'Resonance', min: 0.1, max: 12, step: 0.1, default: 0.7 },
    ],
  },
  compressor: {
    type: 'compressor',
    label: 'Compressor',
    group: 'dynamics',
    description: 'Evens out level. Lower the threshold until the meter moves.',
    params: [
      db('threshold', 'Threshold', -18, -60, 0),
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, default: 3 },
      { key: 'attack', label: 'Attack', min: 0.001, max: 0.5, step: 0.001, default: 0.01, unit: 's', curve: 'log' },
      { key: 'release', label: 'Release', min: 0.01, max: 2, step: 0.01, default: 0.18, unit: 's', curve: 'log' },
      { key: 'knee', label: 'Knee', min: 0, max: 40, step: 0.5, default: 8, unit: 'dB' },
      db('makeup', 'Make-up', 0, 0, 24),
    ],
  },
  limiter: {
    type: 'limiter',
    label: 'Limiter',
    group: 'dynamics',
    description: 'Hard ceiling. Catches peaks without touching the body.',
    params: [
      db('ceiling', 'Ceiling', -1, -12, 0),
      { key: 'release', label: 'Release', min: 0.01, max: 1, step: 0.01, default: 0.12, unit: 's' },
    ],
  },
  gate: {
    type: 'gate',
    label: 'Noise gate',
    group: 'dynamics',
    description: 'Mutes below the threshold — cleans separation bleed between phrases.',
    params: [
      db('threshold', 'Threshold', -50, -90, 0),
      { key: 'attack', label: 'Attack', min: 0.0005, max: 0.2, step: 0.0005, default: 0.002, unit: 's' },
      { key: 'release', label: 'Release', min: 0.01, max: 1, step: 0.01, default: 0.08, unit: 's' },
    ],
  },
  reverb: {
    type: 'reverb',
    label: 'Reverb',
    group: 'effects',
    description: 'Convolution reverb with a generated tail.',
    params: [
      { key: 'size', label: 'Size', min: 0.2, max: 8, step: 0.1, default: 2, unit: 's' },
      { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: 'predelay', label: 'Pre-delay', min: 0, max: 0.2, step: 0.001, default: 0.02, unit: 's' },
      mix(0.22),
    ],
  },
  delay: {
    type: 'delay',
    label: 'Delay',
    group: 'effects',
    description: 'Feedback delay. Set time in beats to keep it in tempo.',
    params: [
      { key: 'beats', label: 'Time', min: 0.0625, max: 4, step: 0.0625, default: 0.5, unit: 'beats' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, default: 0.35 },
      freq('tone', 'Tone', 6000, 500, 18000),
      mix(0.2),
    ],
  },
  chorus: {
    type: 'chorus',
    label: 'Chorus',
    group: 'effects',
    description: 'Detuned doubling. Widens thin vocals and synths.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 8, step: 0.01, default: 0.8, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0, max: 0.02, step: 0.0005, default: 0.004, unit: 's' },
      mix(0.35),
    ],
  },
  flanger: {
    type: 'flanger',
    label: 'Flanger',
    group: 'effects',
    description: 'Short modulated delay with feedback.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 5, step: 0.01, default: 0.3, unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0, max: 0.006, step: 0.0001, default: 0.002, unit: 's' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, default: 0.5 },
      mix(0.4),
    ],
  },
  phaser: {
    type: 'phaser',
    label: 'Phaser',
    group: 'effects',
    description: 'Sweeping all-pass notches.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 5, step: 0.01, default: 0.4, unit: 'Hz' },
      freq('base', 'Centre', 700, 100, 4000),
      { key: 'spread', label: 'Spread', min: 100, max: 4000, step: 10, default: 1200, unit: 'Hz' },
      mix(0.4),
    ],
  },
  distortion: {
    type: 'distortion',
    label: 'Distortion',
    group: 'effects',
    description: 'Hard drive with tone control.',
    params: [
      { key: 'drive', label: 'Drive', min: 1, max: 100, step: 0.5, default: 20 },
      freq('tone', 'Tone', 4000, 500, 16000),
      mix(1),
    ],
  },
  saturation: {
    type: 'saturation',
    label: 'Saturation',
    group: 'effects',
    description: 'Gentle tape-style warmth and soft clipping.',
    params: [
      { key: 'drive', label: 'Drive', min: 1, max: 20, step: 0.1, default: 3 },
      db('output', 'Output', 0, -12, 12),
      mix(1),
    ],
  },
  bitcrush: {
    type: 'bitcrush',
    label: 'Bitcrush',
    group: 'creative',
    description: 'Bit-depth and sample-rate reduction, aliasing and all.',
    params: [
      { key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, default: 8 },
      { key: 'reduction', label: 'Downsample', min: 1, max: 64, step: 1, default: 4, unit: '×' },
      mix(1),
    ],
  },
  lofi: {
    type: 'lofi',
    label: 'Lo-fi',
    group: 'creative',
    description: 'Band-limited, wobbly and slightly crushed.',
    params: [
      freq('lowcut', 'Low cut', 200, 20, 1000),
      freq('highcut', 'High cut', 5000, 1000, 16000),
      { key: 'bits', label: 'Bits', min: 4, max: 16, step: 1, default: 12 },
      mix(1),
    ],
  },
  widener: {
    type: 'widener',
    label: 'Stereo widener',
    group: 'effects',
    description: 'Mid/side width. Above 1 widens, below 1 narrows toward mono.',
    params: [{ key: 'width', label: 'Width', min: 0, max: 2, step: 0.01, default: 1.3 }],
  },
  deesser: {
    type: 'deesser',
    label: 'De-esser',
    group: 'dynamics',
    description: 'Compresses just the sibilance band.',
    params: [
      freq('frequency', 'Frequency', 6500, 3000, 12000),
      db('threshold', 'Threshold', -28, -60, 0),
      { key: 'amount', label: 'Amount', min: 1, max: 20, step: 0.1, default: 6 },
    ],
  },
};

export function defaultParams(type: EffectType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of EFFECT_SPECS[type].params) out[p.key] = p.default;
  return out;
}

export const EFFECT_GROUPS: { id: EffectSpec['group']; label: string }[] = [
  { id: 'eq', label: 'EQ' },
  { id: 'dynamics', label: 'Dynamics' },
  { id: 'effects', label: 'Effects' },
  { id: 'creative', label: 'Creative' },
];
