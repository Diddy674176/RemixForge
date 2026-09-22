import { stft, type Spectrogram } from '../dsp/stft.ts';

export const FEATURE_FFT = 2048;
export const FEATURE_HOP = 512;
/**
 * Chroma needs far more frequency resolution than onset detection does: at
 * 44.1 kHz a 2048-point FFT has 21.5 Hz bins, but C4 and C#4 are only 15.6 Hz
 * apart, so neighbouring semitones would land in the same bin. An 8192-point
 * window resolves them, and the coarser hop keeps the extra cost reasonable.
 */
export const CHROMA_FFT = 8192;
export const CHROMA_HOP = 2048;

export interface Features {
  sampleRate: number;
  hop: number;
  /** Seconds per feature frame. */
  frameDur: number;
  frames: number;
  /** Half-wave-rectified spectral flux, normalised to roughly 0..1. */
  onset: Float32Array;
  /** 12 pitch-class energies per frame, frame-major. */
  chroma: Float32Array;
  /** 16 log-spaced band energies per frame — a cheap timbre fingerprint. */
  timbre: Float32Array;
  /** Per-frame RMS in linear amplitude. */
  rms: Float32Array;
  spec: Spectrogram;
}

const CHROMA_BINS = 12;
const TIMBRE_BANDS = 16;

/** Pitch range used for chroma: C2 to C7. */
const CHROMA_MIN_MIDI = 36;
const CHROMA_MAX_MIDI = 96;

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface PitchBand {
  pitchClass: number;
  from: number;
  to: number;
  /** Per-bin triangular weights across [from, to). */
  weights: Float32Array;
  /** Octave emphasis — the middle of the range carries the key. */
  gain: number;
}

/**
 * Precompute one band per semitone, spanning a quarter-tone either side of the
 * note's centre frequency. Summing these is a cheap constant-Q: every semitone
 * gets its own band regardless of the linear bin spacing.
 */
function pitchBands(bins: number, sampleRate: number, fftSize: number): PitchBand[] {
  const binHz = sampleRate / fftSize;
  const nyquist = sampleRate / 2;
  const bands: PitchBand[] = [];

  for (let midi = CHROMA_MIN_MIDI; midi < CHROMA_MAX_MIDI; midi++) {
    const lowHz = midiToHz(midi - 0.5);
    const highHz = midiToHz(midi + 0.5);
    if (highHz >= nyquist) break;
    const from = Math.max(1, Math.floor(lowHz / binHz));
    const to = Math.min(bins - 1, Math.ceil(highHz / binHz));
    if (to <= from) continue;

    const centerHz = midiToHz(midi);
    const weights = new Float32Array(to - from);
    let sum = 0;
    for (let b = from; b < to; b++) {
      const hz = b * binHz;
      // Triangular window in log-frequency, peaking at the note.
      const d = Math.abs(Math.log2(hz / centerHz)) / (0.5 / 12);
      const w = Math.max(0, 1 - d);
      weights[b - from] = w;
      sum += w;
    }
    if (sum <= 0) continue;
    for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! / sum;

    bands.push({
      pitchClass: ((midi % 12) + 12) % 12,
      from,
      to,
      weights,
      // Gaussian emphasis around the octave above middle C.
      gain: Math.exp(-0.5 * Math.pow((midi - 66) / 18, 2)),
    });
  }
  return bands;
}

/** Median of a copy of `v` — used for adaptive thresholds. */
function median(v: Float32Array): number {
  const c = Float32Array.from(v);
  c.sort();
  const n = c.length;
  if (n === 0) return 0;
  return n % 2 ? c[(n - 1) >> 1]! : (c[n / 2 - 1]! + c[n / 2]!) / 2;
}

export function computeFeatures(mono: Float32Array, sampleRate: number): Features {
  const spec = stft(mono, FEATURE_FFT, FEATURE_HOP, sampleRate);
  const { frames, bins, mag } = spec;
  const binHz = sampleRate / FEATURE_FFT;

  const onset = new Float32Array(frames);
  const chroma = new Float32Array(frames * CHROMA_BINS);
  const timbre = new Float32Array(frames * TIMBRE_BANDS);
  const rms = new Float32Array(frames);

  // Band index per bin is frequency-only, so it's computed once.
  const bandIndex = new Int8Array(bins);
  for (let b = 0; b < bins; b++) {
    const hz = b * binHz;
    if (hz < 20) bandIndex[b] = -1;
    else {
      const t = Math.log2(Math.min(hz, sampleRate / 2) / 20) / Math.log2(sampleRate / 2 / 20);
      bandIndex[b] = Math.min(TIMBRE_BANDS - 1, Math.max(0, Math.floor(t * TIMBRE_BANDS)));
    }
  }

  computeChroma(mono, sampleRate, frames, chroma);

  let prev = new Float32Array(bins);
  for (let f = 0; f < frames; f++) {
    const off = f * bins;
    let flux = 0;
    let energy = 0;
    const tOff = f * TIMBRE_BANDS;

    for (let b = 0; b < bins; b++) {
      const m = mag[off + b]!;
      // Log compression keeps quiet onsets visible next to loud ones.
      const lm = Math.log1p(1000 * m);
      const d = lm - prev[b]!;
      if (d > 0) flux += d;
      prev[b] = lm;

      energy += m * m;

      const bi = bandIndex[b]!;
      if (bi >= 0) timbre[tOff + bi] = timbre[tOff + bi]! + m * m;
    }

    onset[f] = flux;
    rms[f] = Math.sqrt(energy / bins);

    let tn = 0;
    for (let k = 0; k < TIMBRE_BANDS; k++) {
      timbre[tOff + k] = Math.log1p(1000 * timbre[tOff + k]!);
      tn += timbre[tOff + k]! * timbre[tOff + k]!;
    }
    tn = Math.sqrt(tn);
    if (tn > 1e-9) for (let k = 0; k < TIMBRE_BANDS; k++) timbre[tOff + k] = timbre[tOff + k]! / tn;
  }

  // Subtract a moving median and rectify — removes slow loudness drift so the
  // tempo stage sees beats rather than arrangement dynamics.
  const win = 16;
  const smoothed = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const from = Math.max(0, f - win);
    const to = Math.min(frames, f + win + 1);
    const m = median(onset.subarray(from, to));
    smoothed[f] = Math.max(0, onset[f]! - m);
  }
  let peak = 0;
  for (let f = 0; f < frames; f++) if (smoothed[f]! > peak) peak = smoothed[f]!;
  if (peak > 1e-9) for (let f = 0; f < frames; f++) smoothed[f] = smoothed[f]! / peak;

  return {
    sampleRate,
    hop: FEATURE_HOP,
    frameDur: FEATURE_HOP / sampleRate,
    frames,
    onset: smoothed,
    chroma,
    timbre,
    rms,
    spec,
  };
}

/** Average a frame-major feature matrix over a frame range. */
export function averageFrames(
  data: Float32Array,
  dims: number,
  fromFrame: number,
  toFrame: number,
): Float32Array {
  const out = new Float32Array(dims);
  const from = Math.max(0, fromFrame);
  const to = Math.max(from + 1, toFrame);
  let n = 0;
  for (let f = from; f < to && (f + 1) * dims <= data.length; f++) {
    for (let d = 0; d < dims; d++) out[d] = out[d]! + data[f * dims + d]!;
    n++;
  }
  if (n > 0) for (let d = 0; d < dims; d++) out[d] = out[d]! / n;
  return out;
}

/** Downmix an AudioBuffer's channels to a single mono Float32Array. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = channels[0]!.length;
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] = out[i]! + ch[i]!;
  }
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] = out[i]! * g;
  return out;
}

/**
 * Chroma from a high-resolution STFT, written into the main feature grid.
 *
 * Analysis runs on its own coarser hop with a much longer window, then each
 * feature frame reads the nearest chroma frame — so the rest of the pipeline
 * keeps one frame rate while chroma gets the resolution it needs.
 */
function computeChroma(
  mono: Float32Array,
  sampleRate: number,
  frames: number,
  out: Float32Array,
): void {
  const spec = stft(mono, CHROMA_FFT, CHROMA_HOP, sampleRate);
  const bands = pitchBands(spec.bins, sampleRate, CHROMA_FFT);
  const coarse = new Float32Array(spec.frames * CHROMA_BINS);

  for (let f = 0; f < spec.frames; f++) {
    const specOff = f * spec.bins;
    const off = f * CHROMA_BINS;
    for (const band of bands) {
      let acc = 0;
      for (let b = band.from; b < band.to; b++) {
        acc += spec.mag[specOff + b]! * band.weights[b - band.from]!;
      }
      // Log compression stops one loud note from swamping the profile.
      coarse[off + band.pitchClass] = coarse[off + band.pitchClass]! + Math.log1p(600 * acc) * band.gain;
    }

    let norm = 0;
    for (let k = 0; k < CHROMA_BINS; k++) norm += coarse[off + k]! * coarse[off + k]!;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) {
      for (let k = 0; k < CHROMA_BINS; k++) coarse[off + k] = coarse[off + k]! / norm;
    }
  }

  const ratio = FEATURE_HOP / CHROMA_HOP;
  for (let f = 0; f < frames; f++) {
    const src = Math.min(spec.frames - 1, Math.max(0, Math.round(f * ratio)));
    out.set(coarse.subarray(src * CHROMA_BINS, (src + 1) * CHROMA_BINS), f * CHROMA_BINS);
  }
}
