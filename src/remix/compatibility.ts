import type { Source } from '../state/types.ts';
import { keyDistance } from '../audio/analysis/key.ts';
import { stretchFor, stretchStrain } from './sync.ts';

export interface CompatibilityFactor {
  label: string;
  /** 0..1, where 1 is a perfect match. */
  score: number;
  detail: string;
}

export interface Compatibility {
  /** 0..100. */
  score: number;
  factors: CompatibilityFactor[];
  /** Plain-language conflicts. Never used to hide a combination. */
  conflicts: string[];
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Score how well two sources will sit together.
 *
 * Deliberately advisory: a low score is reported with the reason, and the
 * combination is still offered. Plenty of good mashups score badly here.
 */
export function compatibilityOf(a: Source, b: Source): Compatibility {
  const factors: CompatibilityFactor[] = [];
  const conflicts: string[] = [];

  const aa = a.analysis;
  const ba = b.analysis;
  if (!aa || !ba) {
    return {
      score: 0,
      factors: [],
      conflicts: ['One or both tracks have not been analysed yet.'],
    };
  }

  // Tempo
  const stretch = stretchFor(aa.bpm, ba.bpm);
  const strain = stretchStrain(stretch);
  const tempoScore = clamp01(1 - strain / Math.log2(1.35));
  factors.push({
    label: 'Tempo',
    score: tempoScore,
    detail: `${aa.displayBpm} vs ${ba.displayBpm} BPM — ${Math.abs(Math.round((stretch - 1) * 100))}% change`,
  });
  if (tempoScore < 0.45) {
    conflicts.push(
      `Vocals may require significant tempo adjustment (${aa.displayBpm} → ${ba.displayBpm} BPM).`,
    );
  }

  // Key
  const kd = keyDistance(aa.key, ba.key);
  const keyScore = clamp01(1 - kd);
  factors.push({
    label: 'Key',
    score: keyScore,
    detail: `${aa.key.name} (${aa.key.camelot}) vs ${ba.key.name} (${ba.key.camelot})`,
  });
  if (keyScore < 0.5) {
    conflicts.push(
      `${aa.key.name} and ${ba.key.name} are harmonically distant — pitch shifting will be noticeable on vocals.`,
    );
  }

  // Meter
  const meterScore = aa.meter === ba.meter ? 1 : 0.35;
  factors.push({
    label: 'Metre',
    score: meterScore,
    detail: `${aa.meter}/4 vs ${ba.meter}/4`,
  });
  if (meterScore < 1) conflicts.push('Different time signatures — bars will not line up cleanly.');

  // Rhythmic stability: a confident grid on both sides means alignment holds.
  const gridScore = clamp01(Math.min(aa.bpmConfidence, ba.bpmConfidence) / 0.6);
  factors.push({
    label: 'Beat stability',
    score: gridScore,
    detail: `Confidence ${Math.round(aa.bpmConfidence * 100)}% / ${Math.round(ba.bpmConfidence * 100)}%`,
  });
  if (gridScore < 0.4) conflicts.push('Beat detection was shaky — the grid may drift over long sections.');

  // Energy shape: compare mean section energy.
  const energyOf = (sections: typeof aa.sections) =>
    sections.length ? sections.reduce((s, x) => s + x.energy, 0) / sections.length : 0.5;
  const ea = energyOf(aa.sections);
  const eb = energyOf(ba.sections);
  const energyScore = clamp01(1 - Math.abs(ea - eb) * 1.4);
  factors.push({
    label: 'Energy',
    score: energyScore,
    detail: `${Math.round(ea * 100)}% vs ${Math.round(eb * 100)}% average section energy`,
  });

  // Structure: do both have recognisable repeating sections to cut between?
  const structScore = clamp01(Math.min(aa.sections.length, ba.sections.length) / 6);
  factors.push({
    label: 'Structure',
    score: structScore,
    detail: `${aa.sections.length} vs ${ba.sections.length} detected sections`,
  });

  const weights = [0.32, 0.26, 0.08, 0.12, 0.1, 0.12];
  const score = factors.reduce((acc, f, i) => acc + f.score * weights[i]!, 0);

  return { score: Math.round(score * 100), factors, conflicts };
}

export function scoreLabel(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 65) return 'Good';
  if (score >= 45) return 'Workable';
  if (score >= 25) return 'Challenging';
  return 'Difficult';
}
