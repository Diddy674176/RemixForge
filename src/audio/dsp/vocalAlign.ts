import { stft } from './stft.ts';
import { timeStretch } from './timestretch.ts';

const ONSET_FFT = 1024;
const ONSET_HOP = 256;

/**
 * Onset strength curve tuned for speech and singing.
 *
 * Deliberately lighter than the full feature pass: syllable detection only
 * needs the flux curve, and a 1024-point window gives the ~6 ms time
 * resolution that syllable boundaries need.
 */
export function onsetEnvelope(
  mono: Float32Array,
  sampleRate: number,
): { values: Float32Array; frameDur: number } {
  const spec = stft(mono, ONSET_FFT, ONSET_HOP, sampleRate);
  const { frames, bins, mag } = spec;
  const binHz = sampleRate / ONSET_FFT;

  // Restrict to the band where vocal energy lives, so the curve isn't driven
  // by bleed from a kick drum or a hi-hat left over from separation.
  const from = Math.max(1, Math.floor(200 / binHz));
  const to = Math.min(bins, Math.ceil(6000 / binHz));

  const raw = new Float32Array(frames);
  const prev = new Float32Array(bins);
  for (let f = 0; f < frames; f++) {
    const off = f * bins;
    let flux = 0;
    for (let b = from; b < to; b++) {
      const m = Math.log1p(1000 * mag[off + b]!);
      const d = m - prev[b]!;
      if (d > 0) flux += d;
      prev[b] = m;
    }
    raw[f] = flux;
  }

  // Subtract a local mean and rectify — leaves peaks where energy rises
  // against its own recent background.
  const win = 12;
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const lo = Math.max(0, f - win);
    const hi = Math.min(frames, f + win + 1);
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += raw[i]!;
    out[f] = Math.max(0, raw[f]! - sum / (hi - lo));
  }
  let peak = 0;
  for (let f = 0; f < frames; f++) if (out[f]! > peak) peak = out[f]!;
  if (peak > 1e-9) for (let f = 0; f < frames; f++) out[f] = out[f]! / peak;

  return { values: out, frameDur: ONSET_HOP / sampleRate };
}

export interface OnsetOptions {
  /** Shortest gap between onsets, in seconds. Syllables rarely beat ~80 ms. */
  minSpacing?: number;
  /** Fraction of the envelope peak an onset must reach. */
  threshold?: number;
  /**
   * How far the envelope must dip before a peak for it to count as a new
   * syllable. Without this, the flux ripple inside a sustained vowel reads as
   * a string of extra onsets, and those become anchors that fight the real
   * ones.
   */
  prominence?: number;
}

/** Peak-pick the onset envelope into candidate syllable start times. */
export function detectOnsets(
  mono: Float32Array,
  sampleRate: number,
  opts: OnsetOptions = {},
): number[] {
  const minSpacing = opts.minSpacing ?? 0.08;
  const threshold = opts.threshold ?? 0.12;
  const prominence = opts.prominence ?? 0.55;
  const { values, frameDur } = onsetEnvelope(mono, sampleRate);
  const minFrames = Math.max(1, Math.round(minSpacing / frameDur));
  const lookBack = Math.max(2, Math.round(0.05 / frameDur));

  const onsets: number[] = [];
  let lastFrame = -minFrames;
  for (let f = 1; f < values.length - 1; f++) {
    const v = values[f]!;
    if (v < threshold) continue;
    if (v < values[f - 1]! || v < values[f + 1]!) continue;

    // The envelope has to have come back down before this peak counts.
    let floorBefore = v;
    for (let i = Math.max(0, f - lookBack); i < f; i++) {
      if (values[i]! < floorBefore) floorBefore = values[i]!;
    }
    if (v - floorBefore < v * prominence) continue;

    if (f - lastFrame < minFrames) {
      // Keep the stronger of two peaks that are too close together.
      if (onsets.length && v > values[lastFrame]!) {
        onsets[onsets.length - 1] = f * frameDur;
        lastFrame = f;
      }
      continue;
    }
    onsets.push(f * frameDur);
    lastFrame = f;
  }
  return onsets;
}

export interface Anchor {
  /** Time in the source audio, in seconds. */
  from: number;
  /** Where that moment should land, in seconds. */
  to: number;
}

export interface AlignPlan {
  anchors: Anchor[];
  /** Onsets that were actually moved. */
  moved: number;
  /** Onsets left alone because they were already close, or too far to trust. */
  kept: number;
  maxShiftMs: number;
  meanShiftMs: number;
}

export interface AlignOptions {
  /**
   * Grid divisions per beat to consider. 4 lets syllables land on sixteenths.
   */
  divisions?: number;
  /**
   * How far an onset may be from a grid point and still be pulled to it, as a
   * fraction of the grid spacing. Above this it is left alone — a syllable
   * that is a long way off is usually phrasing, not an error.
   */
  tolerance?: number;
  /** Shifts smaller than this are not worth the processing. */
  minShift?: number;
  /**
   * Largest local speed change allowed over a long span, as a fraction.
   * Short spans are allowed more: a few percent of extra stretch across 200 ms
   * of transient-led audio is inaudible, while the same change across a
   * sustained note warbles.
   */
  maxSlack?: number;
  /** Minimum spacing between anchors so segments stay long enough to stretch. */
  minSegment?: number;
}

/**
 * Work out where each syllable should move to.
 *
 * The result is a sparse warp map, not a hard quantise: onsets already close
 * to the grid are left alone, and anything far from it is assumed to be
 * intentional phrasing rather than a mistake. That restraint is what stops
 * the result sounding robotic.
 */
export function planAlignment(
  onsets: number[],
  beats: number[],
  duration: number,
  opts: AlignOptions = {},
): AlignPlan {
  const divisions = opts.divisions ?? 4;
  const tolerance = opts.tolerance ?? 0.35;
  const minShift = opts.minShift ?? 0.008;
  const maxSlack = opts.maxSlack ?? 0.10;
  const minSegment = opts.minSegment ?? 0.12;

  if (beats.length < 2 || onsets.length === 0) {
    return { anchors: [], moved: 0, kept: onsets.length, maxShiftMs: 0, meanShiftMs: 0 };
  }

  // Expand the beat list into the subdivision grid.
  const grid: number[] = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const step = (beats[i + 1]! - beats[i]!) / divisions;
    for (let d = 0; d < divisions; d++) grid.push(beats[i]! + d * step);
  }
  grid.push(beats[beats.length - 1]!);
  const spacing = (beats[1]! - beats[0]!) / divisions;

  const candidates: Anchor[] = [];
  let kept = 0;
  let shiftSum = 0;
  let maxShift = 0;

  for (const onset of onsets) {
    // Nearest grid point by binary search.
    let lo = 0;
    let hi = grid.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (grid[mid]! < onset) lo = mid + 1;
      else hi = mid;
    }
    const near = [grid[lo - 1], grid[lo]].filter((g): g is number => g !== undefined);
    if (near.length === 0) {
      kept++;
      continue;
    }
    const target = near.reduce((a, b) => (Math.abs(b - onset) < Math.abs(a - onset) ? b : a));
    const shift = target - onset;

    if (Math.abs(shift) > spacing * tolerance || Math.abs(shift) < minShift) {
      kept++;
      continue;
    }
    candidates.push({ from: onset, to: target });
    shiftSum += Math.abs(shift);
    maxShift = Math.max(maxShift, Math.abs(shift));
  }

  // Keep the map monotonic and the local rate sane.
  //
  // When a move needs more stretch than the span allows, the anchor is moved
  // as far as the limit permits rather than dropped. Dropping is actively
  // worse than partial correction: an onset with no anchor of its own is
  // dragged along by whatever stretch its segment gets, which can push it
  // further from the beat than it started.
  const anchors: Anchor[] = [{ from: 0, to: 0 }];
  for (const candidate of candidates) {
    const prev = anchors[anchors.length - 1]!;
    const srcSpan = candidate.from - prev.from;
    if (srcSpan < minSegment) continue;

    const slack = srcSpan < 0.3 ? maxSlack * 2.5 : srcSpan < 0.8 ? maxSlack * 1.6 : maxSlack;
    const lo = prev.to + srcSpan * (1 - slack);
    const hi = prev.to + srcSpan * (1 + slack);
    const to = Math.min(hi, Math.max(lo, candidate.to));
    if (to - prev.to < minSegment) continue;
    anchors.push({ from: candidate.from, to });
  }

  const last = anchors[anchors.length - 1]!;
  if (duration - last.from > minSegment) {
    // Let the tail run at its original speed rather than stretching to fit.
    anchors.push({ from: duration, to: last.to + (duration - last.from) });
  }

  const moved = anchors.length - (duration - last.from > minSegment ? 2 : 1);
  return {
    anchors,
    moved: Math.max(0, moved),
    kept,
    maxShiftMs: Math.round(maxShift * 1000),
    meanShiftMs: candidates.length ? Math.round((shiftSum / candidates.length) * 1000) : 0,
  };
}

/** Equal-power crossfade length used to join warped segments. */
const JOIN = 0.006;
/** Window for the per-segment stretch. Short, because segments are short. */
const STRETCH_FFT = 1024;

/**
 * Apply a sparse warp map by stretching each segment between anchors
 * independently, then crossfading the joins.
 *
 * Each segment gets its own (small) rate, so the audio speeds up and slows
 * down by a few percent to place syllables, rather than being resampled
 * uniformly.
 */
export function applyWarp(
  channels: Float32Array[],
  sampleRate: number,
  anchors: Anchor[],
): Float32Array[] {
  if (anchors.length < 2) return channels.map((c) => c.slice());

  const outLength = Math.ceil(anchors[anchors.length - 1]!.to * sampleRate) + sampleRate;
  const out = channels.map(() => new Float32Array(outLength));
  const joinSamples = Math.round(JOIN * sampleRate);

  for (let c = 0; c < channels.length; c++) {
    const src = channels[c]!;
    const dst = out[c]!;

    for (let i = 0; i + 1 < anchors.length; i++) {
      const a = anchors[i]!;
      const b = anchors[i + 1]!;
      const srcFrom = Math.max(0, Math.round(a.from * sampleRate));
      const srcTo = Math.min(src.length, Math.round(b.from * sampleRate));
      if (srcTo <= srcFrom) continue;

      const dstFrom = Math.max(0, Math.round(a.to * sampleRate));
      const targetLen = Math.max(1, Math.round((b.to - a.to) * sampleRate));
      const factor = targetLen / (srcTo - srcFrom);

      // Stretch with real audio either side of the segment, then cut the
      // interior out. Without that context the phase vocoder's first and last
      // window would be half-empty, and every segment join would carry a
      // transient of its own.
      const context = Math.min(STRETCH_FFT, srcFrom, Math.max(0, src.length - srcTo));
      const padded = src.subarray(srcFrom - context, Math.min(src.length, srcTo + context));
      const stretchedPad = Math.round(context * factor);

      let warped: Float32Array;
      if (Math.abs(factor - 1) < 1e-4) {
        warped = src.subarray(srcFrom, srcTo).slice();
      } else {
        const full = timeStretch(padded, factor, { fftSize: STRETCH_FFT });
        warped = full.subarray(stretchedPad, Math.min(full.length, stretchedPad + targetLen)).slice();
      }

      for (let n = 0; n < warped.length; n++) {
        const idx = dstFrom + n;
        if (idx >= dst.length) break;
        let gain = 1;
        // Fade the first samples in, so the join against the previous segment
        // is a crossfade rather than a discontinuity.
        if (i > 0 && n < joinSamples) gain = Math.sin((Math.PI / 2) * (n / joinSamples));
        dst[idx] = dst[idx]! * (gain < 1 ? Math.sqrt(1 - gain * gain) : 1) + warped[n]! * gain;
      }
    }
  }

  const used = Math.min(outLength, Math.ceil(anchors[anchors.length - 1]!.to * sampleRate));
  return out.map((c) => c.subarray(0, used).slice());
}

export interface AlignResult {
  channels: Float32Array[];
  plan: AlignPlan;
}

/** Detect syllables, plan the moves and render the aligned audio. */
export function smartVocalAlign(
  channels: Float32Array[],
  sampleRate: number,
  beats: number[],
  opts: AlignOptions & OnsetOptions = {},
): AlignResult {
  const mono =
    channels.length === 1
      ? channels[0]!
      : (() => {
          const n = channels[0]!.length;
          const m = new Float32Array(n);
          for (const ch of channels) for (let i = 0; i < n; i++) m[i] = m[i]! + ch[i]! / channels.length;
          return m;
        })();

  const onsets = detectOnsets(mono, sampleRate, opts);
  const duration = mono.length / sampleRate;
  const plan = planAlignment(onsets, beats, duration, opts);
  if (plan.anchors.length < 2 || plan.moved === 0) {
    return { channels: channels.map((c) => c.slice()), plan };
  }
  return { channels: applyWarp(channels, sampleRate, plan.anchors), plan };
}
