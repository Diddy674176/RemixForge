import { averageFrames, type Features } from './features.ts';
import type { BeatGrid } from './bpm.ts';

export type SectionLabel =
  | 'intro'
  | 'verse'
  | 'pre-chorus'
  | 'chorus'
  | 'bridge'
  | 'drop'
  | 'instrumental'
  | 'breakdown'
  | 'outro';

export interface Section {
  id: string;
  startTime: number;
  endTime: number;
  label: SectionLabel;
  /** Repetition group — sections sharing a letter are musically the same part. */
  letter: string;
  /** Mean loudness in [0,1], relative to the loudest section. */
  energy: number;
  /** Bars covered, when a beat grid was available. */
  bars: number;
}

const CHROMA_DIMS = 12;
const TIMBRE_DIMS = 16;

interface BeatFeature {
  time: number;
  endTime: number;
  vec: Float32Array;
  energy: number;
}

/** Average features between successive grid points — usually bars. */
function beatSynchronous(features: Features, grid: number[]): BeatFeature[] {
  const out: BeatFeature[] = [];
  for (let i = 0; i + 1 < grid.length; i++) {
    const from = Math.floor(grid[i]! / features.frameDur);
    const to = Math.ceil(grid[i + 1]! / features.frameDur);
    const c = averageFrames(features.chroma, CHROMA_DIMS, from, to);
    const t = averageFrames(features.timbre, TIMBRE_DIMS, from, to);
    const vec = new Float32Array(CHROMA_DIMS + TIMBRE_DIMS);
    vec.set(c, 0);
    vec.set(t, CHROMA_DIMS);
    let n = 0;
    for (let k = 0; k < vec.length; k++) n += vec[k]! * vec[k]!;
    n = Math.sqrt(n);
    if (n > 1e-9) for (let k = 0; k < vec.length; k++) vec[k] = vec[k]! / n;

    let e = 0;
    let count = 0;
    for (let f = Math.max(0, from); f < Math.min(features.frames, to); f++) {
      e += features.rms[f]!;
      count++;
    }
    out.push({ time: grid[i]!, endTime: grid[i + 1]!, vec, energy: count ? e / count : 0 });
  }
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
  return d;
}

/**
 * Novelty curve from a checkerboard kernel slid down the self-similarity
 * matrix diagonal: it peaks where the music before differs from the music
 * after, which is exactly where sections change.
 */
function noveltyCurve(items: BeatFeature[], kernelSize: number): Float32Array {
  const n = items.length;
  const novelty = new Float32Array(n);
  const k = kernelSize;
  if (n < k * 2) return novelty;

  // Gaussian-tapered checkerboard kernel.
  const kern = new Float32Array((2 * k) * (2 * k));
  for (let i = 0; i < 2 * k; i++) {
    for (let j = 0; j < 2 * k; j++) {
      const di = (i - k + 0.5) / k;
      const dj = (j - k + 0.5) / k;
      const taper = Math.exp(-4 * (di * di + dj * dj));
      const sign = (i < k) === (j < k) ? 1 : -1;
      kern[i * 2 * k + j] = sign * taper;
    }
  }

  for (let c = k; c < n - k; c++) {
    let acc = 0;
    for (let i = 0; i < 2 * k; i++) {
      const ii = c - k + i;
      for (let j = 0; j < 2 * k; j++) {
        const jj = c - k + j;
        acc += kern[i * 2 * k + j]! * cosine(items[ii]!.vec, items[jj]!.vec);
      }
    }
    novelty[c] = acc;
  }

  let max = 0;
  for (let i = 0; i < n; i++) if (novelty[i]! > max) max = novelty[i]!;
  if (max > 1e-9) for (let i = 0; i < n; i++) novelty[i] = Math.max(0, novelty[i]!) / max;
  return novelty;
}

/** Greedy grouping of segments into repetition classes A, B, C… */
function assignLetters(segVecs: Float32Array[], threshold = 0.86): string[] {
  const letters: string[] = [];
  const centroids: Float32Array[] = [];
  const counts: number[] = [];

  for (const v of segVecs) {
    let best = -1;
    let bestSim = threshold;
    for (let c = 0; c < centroids.length; c++) {
      const sim = cosine(v, centroids[c]!);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best < 0) {
      centroids.push(Float32Array.from(v));
      counts.push(1);
      best = centroids.length - 1;
    } else {
      // Running mean, renormalised so cosine stays meaningful.
      const c = centroids[best]!;
      const n = ++counts[best]!;
      let norm = 0;
      for (let i = 0; i < c.length; i++) {
        c[i] = c[i]! + (v[i]! - c[i]!) / n;
        norm += c[i]! * c[i]!;
      }
      norm = Math.sqrt(norm);
      if (norm > 1e-9) for (let i = 0; i < c.length; i++) c[i] = c[i]! / norm;
    }
    letters.push(String.fromCharCode(65 + Math.min(25, best)));
  }
  return letters;
}

/**
 * Turn repetition letters + energy + position into the section names a
 * producer would use. Heuristic by nature, and every label is editable in
 * the UI, but it gets the common song shapes right.
 */
function labelSections(
  segs: { start: number; end: number; letter: string; energy: number }[],
  duration: number,
): SectionLabel[] {
  const n = segs.length;
  if (n === 0) return [];

  const freq = new Map<string, number>();
  const meanEnergy = new Map<string, number>();
  for (const s of segs) {
    freq.set(s.letter, (freq.get(s.letter) ?? 0) + 1);
    meanEnergy.set(s.letter, (meanEnergy.get(s.letter) ?? 0) + s.energy);
  }
  for (const [k, v] of meanEnergy) meanEnergy.set(k, v / (freq.get(k) ?? 1));

  // The chorus is the part that repeats most; ties break on loudness.
  let chorusLetter = segs[0]!.letter;
  let bestScore = -Infinity;
  for (const [letter, count] of freq) {
    const score = count * 2 + (meanEnergy.get(letter) ?? 0) * 3;
    if (count >= 2 && score > bestScore) {
      bestScore = score;
      chorusLetter = letter;
    }
  }

  const labels: SectionLabel[] = [];
  for (let i = 0; i < n; i++) {
    const s = segs[i]!;
    const isFirst = i === 0;
    const isLast = i === n - 1;
    const next = segs[i + 1];
    const prev = segs[i - 1];
    const lateInSong = s.start > duration * 0.55;

    if (s.letter === chorusLetter) {
      // A chorus-class section that is much louder than its neighbour and
      // follows a quiet build reads as a drop in electronic music.
      const builds = prev !== undefined && s.energy > prev.energy * 1.5;
      labels.push(builds && s.energy > 0.75 ? 'drop' : 'chorus');
      continue;
    }
    if (isFirst && s.energy < 0.6) {
      labels.push('intro');
      continue;
    }
    if (isLast && s.energy < 0.7) {
      labels.push('outro');
      continue;
    }
    if (next && next.letter === chorusLetter && s.end - s.start < 16) {
      labels.push('pre-chorus');
      continue;
    }
    if (s.energy < 0.4) {
      labels.push('breakdown');
      continue;
    }
    if ((freq.get(s.letter) ?? 0) === 1 && lateInSong) {
      labels.push('bridge');
      continue;
    }
    if ((freq.get(s.letter) ?? 0) === 1 && s.energy > 0.6) {
      labels.push('instrumental');
      continue;
    }
    labels.push('verse');
  }
  return labels;
}

export interface StructureOptions {
  /** Shortest allowed section, in bars. */
  minBars?: number;
}

export function detectStructure(
  features: Features,
  grid: BeatGrid,
  duration: number,
  opts: StructureOptions = {},
): Section[] {
  const minBars = opts.minBars ?? 4;

  // Prefer a bar grid; fall back to beats, then to a fixed 2 s grid.
  let gridTimes = grid.downbeats.length >= 8 ? grid.downbeats : grid.beats;
  if (gridTimes.length < 8) {
    gridTimes = [];
    for (let t = 0; t < duration; t += 2) gridTimes.push(t);
  }
  if (gridTimes[gridTimes.length - 1]! < duration) gridTimes = [...gridTimes, duration];

  const items = beatSynchronous(features, gridTimes);
  if (items.length < 4) {
    return [
      {
        id: 'sec-0',
        startTime: 0,
        endTime: duration,
        label: 'instrumental',
        letter: 'A',
        energy: 1,
        bars: items.length,
      },
    ];
  }

  const kernel = Math.max(2, Math.min(8, Math.floor(items.length / 8)));
  const novelty = noveltyCurve(items, kernel);

  // Peak-pick with a minimum spacing, so sections can't be shorter than
  // `minBars` grid steps.
  const minGap = Math.max(2, minBars);
  const peaks: number[] = [];
  let mean = 0;
  for (let i = 0; i < novelty.length; i++) mean += novelty[i]!;
  mean /= novelty.length;
  const threshold = mean * 1.2;

  for (let i = 1; i < novelty.length - 1; i++) {
    if (novelty[i]! < threshold) continue;
    if (novelty[i]! <= novelty[i - 1]! || novelty[i]! < novelty[i + 1]!) continue;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && i - last < minGap) {
      if (novelty[i]! > novelty[last]!) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }

  const bounds = [0, ...peaks, items.length];
  const raw: { start: number; end: number; letter: string; energy: number; bars: number }[] = [];
  const segVecs: Float32Array[] = [];

  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i]!;
    const to = bounds[i + 1]!;
    if (to <= from) continue;
    const dims = CHROMA_DIMS + TIMBRE_DIMS;
    const vec = new Float32Array(dims);
    let energy = 0;
    for (let k = from; k < to; k++) {
      for (let d = 0; d < dims; d++) vec[d] = vec[d]! + items[k]!.vec[d]!;
      energy += items[k]!.energy;
    }
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += vec[d]! * vec[d]!;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let d = 0; d < dims; d++) vec[d] = vec[d]! / norm;
    segVecs.push(vec);
    raw.push({
      start: items[from]!.time,
      end: items[to - 1]!.endTime,
      letter: 'A',
      energy: energy / (to - from),
      bars: to - from,
    });
  }

  let maxEnergy = 0;
  for (const s of raw) if (s.energy > maxEnergy) maxEnergy = s.energy;
  if (maxEnergy > 1e-9) for (const s of raw) s.energy = s.energy / maxEnergy;

  const letters = assignLetters(segVecs);
  raw.forEach((s, i) => {
    s.letter = letters[i]!;
  });
  const labels = labelSections(raw, duration);

  return raw.map((s, i) => ({
    id: `sec-${i}`,
    startTime: s.start,
    endTime: s.end,
    label: labels[i]!,
    letter: s.letter,
    energy: Math.round(s.energy * 100) / 100,
    bars: s.bars,
  }));
}
