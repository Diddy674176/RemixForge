import type { EffectSettings, MasterState, MasteringPreset } from '../../state/types.ts';
import { defaultParams } from './definitions.ts';

export interface MasteringPresetSpec {
  id: MasteringPreset;
  label: string;
  description: string;
}

export const MASTERING_PRESETS: MasteringPresetSpec[] = [
  { id: 'off', label: 'Off', description: 'No mastering processing — just the master fader and safety limiter.' },
  { id: 'balanced', label: 'Balanced', description: 'Light glue compression and a gentle tilt. The safe default.' },
  { id: 'loud', label: 'Loud', description: 'Pushes level hard while keeping the ceiling. Costs some dynamics.' },
  { id: 'warm', label: 'Warm', description: 'Softens the top, thickens the low mids, adds a little saturation.' },
  { id: 'clean', label: 'Clean', description: 'Transparent: light limiting, no colour.' },
  { id: 'bass-heavy', label: 'Bass-heavy', description: 'Extra weight below 100 Hz with the mids held back.' },
  { id: 'bright', label: 'Bright', description: 'Opens the top end and tightens the bottom.' },
  { id: 'club', label: 'Club', description: 'Tight lows, forward mids, loud — built for a big system.' },
  { id: 'headphones', label: 'Headphones', description: 'Narrower sides and controlled sibilance for close listening.' },
  { id: 'streaming', label: 'Streaming', description: 'Aims at roughly -14 LUFS so platforms do not turn it down.' },
];

function effect(
  id: string,
  type: EffectSettings['type'],
  params: Record<string, number>,
): EffectSettings {
  return { id: `master-${id}`, type, enabled: true, params: { ...defaultParams(type), ...params } };
}

/**
 * Turn a mastering preset into a concrete effect chain.
 *
 * Every preset is an ordinary chain of the same effects available on tracks,
 * so nothing here is a black box — the user can read what it does, and
 * override it by editing the master chain directly.
 */
export function masterChainFor(master: MasterState): EffectSettings[] {
  const custom = master.effects;
  const preset: EffectSettings[] = [];

  switch (master.preset) {
    case 'balanced':
      preset.push(
        effect('eq', 'eq', { lowFreq: 90, lowGain: 0.8, midFreq: 900, midGain: -0.6, midQ: 0.8, highFreq: 8000, highGain: 1 }),
        effect('glue', 'compressor', { threshold: -14, ratio: 2, attack: 0.02, release: 0.25, knee: 10, makeup: 1.5 }),
      );
      break;
    case 'loud':
      preset.push(
        effect('eq', 'eq', { lowFreq: 80, lowGain: 1, midFreq: 2500, midGain: 1, midQ: 0.7, highFreq: 9000, highGain: 1.5 }),
        effect('glue', 'compressor', { threshold: -20, ratio: 4, attack: 0.005, release: 0.12, knee: 4, makeup: 5 }),
        effect('sat', 'saturation', { drive: 2, output: 0, mix: 0.35 }),
      );
      break;
    case 'warm':
      preset.push(
        effect('eq', 'eq', { lowFreq: 160, lowGain: 1.6, midFreq: 500, midGain: 0.8, midQ: 0.6, highFreq: 7000, highGain: -1.4 }),
        effect('sat', 'saturation', { drive: 3.5, output: -0.5, mix: 0.5 }),
        effect('glue', 'compressor', { threshold: -16, ratio: 2, attack: 0.03, release: 0.3, knee: 12, makeup: 2 }),
      );
      break;
    case 'clean':
      preset.push(effect('glue', 'compressor', { threshold: -10, ratio: 1.6, attack: 0.03, release: 0.3, knee: 14, makeup: 0.8 }));
      break;
    case 'bass-heavy':
      preset.push(
        effect('eq', 'eq', { lowFreq: 70, lowGain: 3.5, midFreq: 700, midGain: -1.5, midQ: 0.7, highFreq: 8000, highGain: 0.5 }),
        effect('glue', 'compressor', { threshold: -15, ratio: 2.5, attack: 0.02, release: 0.2, knee: 8, makeup: 2 }),
      );
      break;
    case 'bright':
      preset.push(
        effect('hp', 'highpass', { cutoff: 32, q: 0.7 }),
        effect('eq', 'eq', { lowFreq: 90, lowGain: -0.5, midFreq: 3000, midGain: 1, midQ: 0.8, highFreq: 10000, highGain: 3 }),
        effect('deess', 'deesser', { frequency: 7500, threshold: -24, amount: 4 }),
      );
      break;
    case 'club':
      preset.push(
        effect('hp', 'highpass', { cutoff: 28, q: 0.7 }),
        effect('eq', 'eq', { lowFreq: 75, lowGain: 2.5, midFreq: 1800, midGain: 1.2, midQ: 0.7, highFreq: 9000, highGain: 1.5 }),
        effect('glue', 'compressor', { threshold: -18, ratio: 3.5, attack: 0.008, release: 0.15, knee: 6, makeup: 4 }),
      );
      break;
    case 'headphones':
      preset.push(
        effect('width', 'widener', { width: 0.85 }),
        effect('deess', 'deesser', { frequency: 6800, threshold: -26, amount: 6 }),
        effect('glue', 'compressor', { threshold: -13, ratio: 2, attack: 0.025, release: 0.25, knee: 12, makeup: 1.5 }),
      );
      break;
    case 'streaming':
      preset.push(
        effect('eq', 'eq', { lowFreq: 90, lowGain: 0.5, midFreq: 1000, midGain: 0, midQ: 0.8, highFreq: 8000, highGain: 0.8 }),
        effect('glue', 'compressor', { threshold: -16, ratio: 2.5, attack: 0.02, release: 0.22, knee: 10, makeup: 2.5 }),
      );
      break;
    case 'off':
    default:
      break;
  }

  return [...preset, ...custom];
}
