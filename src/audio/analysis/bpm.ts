import type { Features } from './features.ts';

export interface TempoSection {
  startTime: number;
  endTime: number;
  bpm: number;
}

export interface BeatGrid {
  bpm: number;
  /** Confidence in [0,1] — how peaked the tempo autocorrelation was. */
  confidence: number;
  /** Beat times in seconds. */
  beats: number[];
  /** Subset of `beats` that start a bar. */
  downbeats: number[];
  /** Beats per bar (3 or 4 in practice). */
  meter: number;
  /** Piecewise tempo, for tracks that drift or change. */
  sections: TempoSection[];
}

const MIN_BPM = 60;
const MAX_BPM = 200;
/** Tempo prior centre — listeners perceive tempo around here. */
const PRIOR_BPM = 122;
const PRIOR_WIDTH = 1.0;

/** Log-Gaussian tempo prior, so 128 beats 64 and 256 for the same evidence. */
function tempoPrior(bpm: number): number {
  const d = Math.log2(bpm / PRIOR_BPM) / PRIOR_WIDTH;
  return Math.exp(-0.5 * d * d);
}

/**
 * Autocorrelate the onset envelope over the plausible beat-period range and
 * return a score for each candidate period, in frames.
 */
function periodScores(onset: Float32Array, fps: number): { periods: number[]; scores: number[] } {
  const minLag = Math.max(2, Math.floor((60 / MAX_BPM) * fps));
  const maxLag = Math.min(onset.length - 1, Math.ceil((60 / MIN_BPM) * fps));
  const periods: number[] = [];
  const scores: number[] = [];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let n = lag; n < onset.length; n++) acc += onset[n]! * onset[n - lag]!;
    acc /= onset.length - lag;
    const bpm = (60 * fps) / lag;
    // Reinforce with the half/double/triple lags: a real beat period also
    // shows correlation at its multiples, a spurious one usually doesn't.
    let harm = 0;
    for (const mult of [2, 3, 4]) {
      const l = lag * mult;
      if (l >= onset.length) break;
      let a = 0;
      for (let n = l; n < onset.length; n++) a += onset[n]! * onset[n - l]!;
      harm += a / (onset.length - l) / mult;
    }
    periods.push(lag);
    scores.push((acc + 0.5 * harm) * tempoPrior(bpm));
  }
  return { periods, scores };
}

/**
 * Ellis-style dynamic-programming beat tracker: find the beat sequence that
 * maximises onset strength while staying close to the target period.
 */
function trackBeats(onset: Float32Array, period: number, tightness = 120): number[] {
  const n = onset.length;
  if (n === 0 || period < 2) return [];
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);

  const searchFrom = Math.max(1, Math.round(period * 0.5));
  const searchTo = Math.max(searchFrom + 1, Math.round(period * 2));
  const penalty = new Float32Array(searchTo - searchFrom + 1);
  for (let i = 0; i < penalty.length; i++) {
    const tau = searchFrom + i;
    const d = Math.log(tau / period);
    penalty[i] = -tightness * d * d;
  }

  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < penalty.length; i++) {
      const prev = t - (searchFrom + i);
      if (prev < 0) break;
      const v = score[prev]! + penalty[i]!;
      if (v > best) {
        best = v;
        bestIdx = prev;
      }
    }
    if (bestIdx < 0) {
      score[t] = onset[t]!;
      back[t] = -1;
    } else {
      score[t] = onset[t]! + best;
      back[t] = bestIdx;
    }
  }

  // Start the backtrace near the end, but not on a straggling tail peak.
  let end = n - 1;
  let bestEnd = -Infinity;
  const tailFrom = Math.max(0, n - Math.round(period * 2));
  for (let t = tailFrom; t < n; t++) {
    if (score[t]! > bestEnd) {
      bestEnd = score[t]!;
      end = t;
    }
  }

  const beats: number[] = [];
  let t = end;
  while (t >= 0) {
    beats.push(t);
    t = back[t]!;
  }
  beats.reverse();
  return beats;
}

/** Sample an envelope at a frame index with linear interpolation. */
function envAt(env: Float32Array, pos: number): number {
  if (pos <= 0) return env[0] ?? 0;
  if (pos >= env.length - 1) return env[env.length - 1] ?? 0;
  const i = Math.floor(pos);
  const f = pos - i;
  return env[i]! * (1 - f) + env[i + 1]! * f;
}

/**
 * Choose the meter and the bar phase by looking for the beat positions that
 * carry the most onset weight and the most harmonic change.
 */
function findDownbeats(
  beatFrames: number[],
  features: Features,
): { meter: number; phase: number } {
  const { onset, chroma } = features;
  if (beatFrames.length < 8) return { meter: 4, phase: 0 };

  // Harmonic change between consecutive beats: big changes land on downbeats.
  const change = new Float32Array(beatFrames.length);
  for (let i = 1; i < beatFrames.length; i++) {
    const a = Math.min(features.frames - 1, Math.max(0, beatFrames[i - 1]!));
    const b = Math.min(features.frames - 1, Math.max(0, beatFrames[i]!));
    let d = 0;
    for (let k = 0; k < 12; k++) {
      const diff = chroma[b * 12 + k]! - chroma[a * 12 + k]!;
      d += diff * diff;
    }
    change[i] = Math.sqrt(d);
  }

  let best = { meter: 4, phase: 0, score: -Infinity };
  for (const meter of [4, 3]) {
    for (let phase = 0; phase < meter; phase++) {
      let acc = 0;
      let count = 0;
      for (let i = phase; i < beatFrames.length; i += meter) {
        acc += envAt(onset, beatFrames[i]!) + 1.5 * change[i]!;
        count++;
      }
      if (count === 0) continue;
      // Slight preference for 4/4 — it is overwhelmingly the common case.
      const score = acc / count + (meter === 4 ? 0.02 : 0);
      if (score > best.score) best = { meter, phase, score };
    }
  }
  return { meter: best.meter, phase: best.phase };
}

/** Estimate tempo in overlapping windows so drift and changes show up. */
function tempoSections(features: Features, globalBpm: number): TempoSection[] {
  const fps = 1 / features.frameDur;
  const windowSec = 12;
  const hopSec = 6;
  const winFrames = Math.round(windowSec * fps);
  const hopFrames = Math.round(hopSec * fps);
  const out: TempoSection[] = [];
  if (features.frames < winFrames * 1.5) {
    return [{ startTime: 0, endTime: features.frames * features.frameDur, bpm: globalBpm }];
  }

  for (let start = 0; start + winFrames <= features.frames; start += hopFrames) {
    const slice = features.onset.subarray(start, start + winFrames);
    const { periods, scores } = periodScores(slice, fps);
    let bi = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[bi]!) bi = i;
    let bpm = (60 * fps) / periods[bi]!;
    // Snap to the nearest octave of the global tempo to avoid half/double flapping.
    while (bpm < globalBpm / 1.4) bpm *= 2;
    while (bpm > globalBpm * 1.4) bpm /= 2;
    out.push({
      startTime: start * features.frameDur,
      endTime: (start + winFrames) * features.frameDur,
      bpm: Math.round(bpm * 10) / 10,
    });
  }

  // Merge neighbouring windows that agree to within 1 BPM.
  const merged: TempoSection[] = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.bpm - s.bpm) < 1) last.endTime = s.endTime;
    else merged.push({ ...s });
  }
  return merged;
}

export function detectBeatGrid(features: Features): BeatGrid {
  const fps = 1 / features.frameDur;
  const { periods, scores } = periodScores(features.onset, fps);

  let bestIdx = 0;
  let total = 0;
  for (let i = 0; i < scores.length; i++) {
    total += Math.max(0, scores[i]!);
    if (scores[i]! > scores[bestIdx]!) bestIdx = i;
  }
  const period = periods[bestIdx]!;
  const rawBpm = (60 * fps) / period;
  const confidence = total > 0 ? Math.min(1, (scores[bestIdx]! / (total / scores.length)) / 12) : 0;

  const beatFrames = trackBeats(features.onset, period);
  const beats = beatFrames.map((f) => f * features.frameDur);

  // Re-derive BPM from the median inter-beat interval: the tracked grid is a
  // better tempo estimate than the raw autocorrelation peak.
  let bpm = rawBpm;
  if (beats.length > 4) {
    const ibis = [];
    for (let i = 1; i < beats.length; i++) ibis.push(beats[i]! - beats[i - 1]!);
    ibis.sort((a, b) => a - b);
    const med = ibis[ibis.length >> 1]!;
    if (med > 0.05) bpm = 60 / med;
  }

  const { meter, phase } = findDownbeats(beatFrames, features);
  const downbeats: number[] = [];
  for (let i = phase; i < beats.length; i += meter) downbeats.push(beats[i]!);

  return {
    bpm: Math.round(bpm * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    beats,
    downbeats,
    meter,
    sections: tempoSections(features, bpm),
  };
}

/** Fold a tempo into the 70–140 range, the way a DJ would read it. */
export function normaliseBpm(bpm: number): number {
  let b = bpm;
  while (b > 140) b /= 2;
  while (b < 70) b *= 2;
  return Math.round(b * 100) / 100;
}
