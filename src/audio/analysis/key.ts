import { averageFrames, type Features } from './features.ts';

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export type Mode = 'major' | 'minor';

export interface KeyEstimate {
  /** 0 = C, 1 = C#, … */
  tonic: number;
  mode: Mode;
  /** e.g. "F minor". */
  name: string;
  /** Camelot/Open-Key code, e.g. "4A" — the notation DJs mix by. */
  camelot: string;
  /** Correlation strength in [0,1]. */
  confidence: number;
  /** The runner-up, which is often the relative major/minor. */
  alternative: { name: string; camelot: string; confidence: number } | null;
}

export interface Chord {
  startTime: number;
  endTime: number;
  root: number;
  quality: 'maj' | 'min' | 'dim' | 'aug' | 'sus';
  name: string;
}

// Temperley's revision of the Krumhansl–Kessler profiles — noticeably more
// reliable on modern popular music than the originals.
const MAJOR_PROFILE = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const MINOR_PROFILE = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];

function correlate(a: readonly number[], b: Float32Array, rotation: number): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i]!;
    mb += b[(i + rotation) % 12]!;
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i]! - ma;
    const y = b[(i + rotation) % 12]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-9 ? num / den : 0;
}

/** Camelot code: 1A..12A for minor, 1B..12B for major. */
export function toCamelot(tonic: number, mode: Mode): string {
  // Camelot numbers walk the circle of fifths starting from A minor / C major.
  const fifths = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
  if (mode === 'major') {
    const n = fifths.indexOf(tonic);
    return `${((n + 11) % 12) + 1}B`;
  }
  const n = fifths.indexOf((tonic + 3) % 12);
  return `${((n + 11) % 12) + 1}A`;
}

export function keyName(tonic: number, mode: Mode): string {
  return `${PITCH_NAMES[tonic]} ${mode}`;
}

export function detectKey(features: Features): KeyEstimate {
  const avg = averageFrames(features.chroma, 12, 0, features.frames);

  const candidates: { tonic: number; mode: Mode; score: number }[] = [];
  for (let t = 0; t < 12; t++) {
    candidates.push({ tonic: t, mode: 'major', score: correlate(MAJOR_PROFILE, avg, t) });
    candidates.push({ tonic: t, mode: 'minor', score: correlate(MINOR_PROFILE, avg, t) });
  }
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0]!;
  const second = candidates[1]!;
  const norm = (s: number) => Math.max(0, Math.min(1, (s + 1) / 2));

  return {
    tonic: best.tonic,
    mode: best.mode,
    name: keyName(best.tonic, best.mode),
    camelot: toCamelot(best.tonic, best.mode),
    confidence: Math.round(norm(best.score) * 100) / 100,
    alternative: {
      name: keyName(second.tonic, second.mode),
      camelot: toCamelot(second.tonic, second.mode),
      confidence: Math.round(norm(second.score) * 100) / 100,
    },
  };
}

const CHORD_TEMPLATES: { quality: Chord['quality']; intervals: number[]; suffix: string }[] = [
  { quality: 'maj', intervals: [0, 4, 7], suffix: '' },
  { quality: 'min', intervals: [0, 3, 7], suffix: 'm' },
  { quality: 'dim', intervals: [0, 3, 6], suffix: 'dim' },
  { quality: 'aug', intervals: [0, 4, 8], suffix: 'aug' },
  { quality: 'sus', intervals: [0, 5, 7], suffix: 'sus4' },
];

/** Label one chord per beat-group (usually per bar) by template matching. */
export function detectChords(features: Features, boundaries: number[]): Chord[] {
  const out: Chord[] = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const startTime = boundaries[i]!;
    const endTime = boundaries[i + 1]!;
    const fromFrame = Math.floor(startTime / features.frameDur);
    const toFrame = Math.ceil(endTime / features.frameDur);
    const c = averageFrames(features.chroma, 12, fromFrame, toFrame);

    let bestScore = -Infinity;
    let bestRoot = 0;
    let bestTpl = CHORD_TEMPLATES[0]!;
    for (let root = 0; root < 12; root++) {
      for (const tpl of CHORD_TEMPLATES) {
        let inSum = 0;
        let outSum = 0;
        for (let k = 0; k < 12; k++) {
          const isChordTone = tpl.intervals.includes((k - root + 12) % 12);
          if (isChordTone) inSum += c[k]!;
          else outSum += c[k]!;
        }
        // Reward chord tones, penalise everything else, normalise by size.
        const score = inSum / tpl.intervals.length - outSum / (12 - tpl.intervals.length);
        if (score > bestScore) {
          bestScore = score;
          bestRoot = root;
          bestTpl = tpl;
        }
      }
    }
    out.push({
      startTime,
      endTime,
      root: bestRoot,
      quality: bestTpl.quality,
      name: `${PITCH_NAMES[bestRoot]}${bestTpl.suffix}`,
    });
  }

  // Collapse repeats so the progression reads as chords, not as a grid.
  const merged: Chord[] = [];
  for (const ch of out) {
    const last = merged[merged.length - 1];
    if (last && last.name === ch.name) last.endTime = ch.endTime;
    else merged.push({ ...ch });
  }
  return merged;
}

/**
 * Harmonic distance in [0,1] between two keys, 0 being the same key.
 *
 * Follows how mixes actually work: relative major/minor and a step around the
 * circle of fifths are near-free, a tritone apart is maximally awkward.
 */
export function keyDistance(a: KeyEstimate, b: KeyEstimate): number {
  if (a.tonic === b.tonic && a.mode === b.mode) return 0;

  // Relative major/minor share a key signature.
  const relative =
    (a.mode === 'major' && b.mode === 'minor' && (a.tonic + 9) % 12 === b.tonic) ||
    (a.mode === 'minor' && b.mode === 'major' && (a.tonic + 3) % 12 === b.tonic);
  if (relative) return 0.08;

  const fifths = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
  const posA = fifths.indexOf(a.mode === 'minor' ? (a.tonic + 3) % 12 : a.tonic);
  const posB = fifths.indexOf(b.mode === 'minor' ? (b.tonic + 3) % 12 : b.tonic);
  let steps = Math.abs(posA - posB);
  if (steps > 6) steps = 12 - steps;

  const modePenalty = a.mode === b.mode ? 0 : 0.12;
  return Math.min(1, steps / 6 + modePenalty);
}

/** Semitones to shift `from` so it sits in `to` — the shortest way round. */
export function semitonesTo(from: KeyEstimate, to: KeyEstimate): number {
  let d = (to.tonic - from.tonic + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}
