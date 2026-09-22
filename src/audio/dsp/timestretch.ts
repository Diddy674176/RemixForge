import { FFT, hann } from './fft.ts';
import { resample } from './resample.ts';

const TWO_PI = Math.PI * 2;

function princarg(x: number): number {
  return x - TWO_PI * Math.round(x / TWO_PI);
}

export interface StretchOptions {
  fftSize?: number;
  /** Analysis hop. Smaller = better quality, slower. */
  hop?: number;
  /**
   * Lock the phases of bins around each spectral peak to the peak itself.
   * This is what stops stretched material from turning watery/phasey.
   */
  phaseLocking?: boolean;
  /**
   * Keep transients crisp by resetting phase accumulation on frames whose
   * spectral flux spikes. Without this, drums smear when stretched.
   */
  transientPreservation?: boolean;
}

/**
 * Phase-vocoder time stretch.
 *
 * `factor` is the output/input duration ratio: 2 makes it twice as long
 * (half speed), 0.5 half as long. Pitch is unchanged.
 */
export function timeStretch(x: Float32Array, factor: number, opts: StretchOptions = {}): Float32Array {
  if (Math.abs(factor - 1) < 1e-6 || x.length === 0) return x.slice();

  const fftSize = opts.fftSize ?? 2048;
  const Ha = opts.hop ?? fftSize / 4;
  const Hs = Math.max(1, Math.round(Ha * factor));
  const phaseLocking = opts.phaseLocking ?? true;
  const transients = opts.transientPreservation ?? true;

  const fft = new FFT(fftSize);
  const win = hann(fftSize);
  const half = fftSize >> 1;
  const bins = half + 1;

  const frames = Math.max(1, Math.floor((x.length - fftSize) / Ha) + 1);
  const outLen = Math.max(1, (frames - 1) * Hs + fftSize);
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const mag = new Float64Array(bins);
  const phase = new Float64Array(bins);
  const prevPhase = new Float64Array(bins);
  const sumPhase = new Float64Array(bins);
  const prevMag = new Float64Array(bins);
  const omega = new Float64Array(bins);
  for (let b = 0; b < bins; b++) omega[b] = (TWO_PI * Ha * b) / fftSize;

  const peakOf = new Int32Array(bins);

  for (let f = 0; f < frames; f++) {
    const start = f * Ha;
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      re[i] = s < x.length ? x[s]! * win[i]! : 0;
      im[i] = 0;
    }
    fft.forward(re, im);

    let flux = 0;
    for (let b = 0; b < bins; b++) {
      const r = re[b]!;
      const i2 = im[b]!;
      const m = Math.hypot(r, i2);
      mag[b] = m;
      phase[b] = Math.atan2(i2, r);
      const d = m - prevMag[b]!;
      if (d > 0) flux += d;
    }

    let energy = 0;
    for (let b = 0; b < bins; b++) energy += mag[b]!;
    const isTransient = transients && f > 0 && flux > 0.55 * energy;

    if (f === 0 || isTransient) {
      // Reset: copy analysis phase straight through so the attack stays sharp.
      for (let b = 0; b < bins; b++) sumPhase[b] = phase[b]!;
    } else if (phaseLocking) {
      // Identify peaks, then rotate each peak's neighbourhood coherently.
      peakOf.fill(-1);
      for (let b = 2; b < bins - 2; b++) {
        const m = mag[b]!;
        if (m > mag[b - 1]! && m > mag[b - 2]! && m > mag[b + 1]! && m > mag[b + 2]!) {
          peakOf[b] = b;
        }
      }
      let last = -1;
      for (let b = 0; b < bins; b++) {
        if (peakOf[b]! >= 0) last = b;
        peakOf[b] = last;
      }
      let next = -1;
      for (let b = bins - 1; b >= 0; b--) {
        if (peakOf[b] === b) next = b;
        const prev = peakOf[b]!;
        if (prev < 0) peakOf[b] = next;
        else if (next >= 0 && next - b < b - prev) peakOf[b] = next;
      }

      const advance = new Float64Array(bins);
      for (let b = 0; b < bins; b++) {
        const delta = princarg(phase[b]! - prevPhase[b]! - omega[b]!);
        advance[b] = (omega[b]! + delta) * factor;
      }
      for (let b = 0; b < bins; b++) {
        const p = peakOf[b]!;
        if (p < 0 || p === b) {
          sumPhase[b] = sumPhase[b]! + advance[b]!;
        } else {
          // Locked bin: follow the peak's new phase, keeping the original
          // phase offset between this bin and its peak.
          sumPhase[b] = sumPhase[p]! + advance[p]! + (phase[b]! - phase[p]!);
        }
      }
    } else {
      for (let b = 0; b < bins; b++) {
        const delta = princarg(phase[b]! - prevPhase[b]! - omega[b]!);
        sumPhase[b] = sumPhase[b]! + (omega[b]! + delta) * factor;
      }
    }

    for (let b = 0; b < bins; b++) {
      prevPhase[b] = phase[b]!;
      prevMag[b] = mag[b]!;
    }

    for (let b = 0; b < bins; b++) {
      const m = mag[b]!;
      const p = sumPhase[b]!;
      re[b] = m * Math.cos(p);
      im[b] = m * Math.sin(p);
    }
    for (let b = 1; b < half; b++) {
      re[fftSize - b] = re[b]!;
      im[fftSize - b] = -im[b]!;
    }
    im[0] = 0;
    im[half] = 0;
    fft.inverse(re, im);

    const outStart = f * Hs;
    for (let i = 0; i < fftSize; i++) {
      const s = outStart + i;
      if (s >= outLen) break;
      const w = win[i]!;
      out[s] = out[s]! + re[i]! * w;
      norm[s] = norm[s]! + w * w;
    }
  }

  for (let i = 0; i < outLen; i++) {
    const n = norm[i]!;
    if (n > 1e-8) out[i] = out[i]! / n;
  }

  const target = Math.round(x.length * factor);
  return out.length === target ? out : out.subarray(0, Math.min(out.length, target)).slice();
}

/**
 * Pitch-shift by `semitones` without changing duration: stretch by the
 * inverse ratio, then resample back to the original length.
 */
export function pitchShift(x: Float32Array, semitones: number, opts: StretchOptions = {}): Float32Array {
  if (Math.abs(semitones) < 1e-6) return x.slice();
  const ratio = Math.pow(2, semitones / 12);
  const stretched = timeStretch(x, ratio, opts);
  const shifted = resample(stretched, ratio);
  if (shifted.length === x.length) return shifted;
  const out = new Float32Array(x.length);
  out.set(shifted.subarray(0, Math.min(shifted.length, x.length)));
  return out;
}

/** Stretch and shift in one pass — cheaper than doing them separately. */
export function warp(
  x: Float32Array,
  timeFactor: number,
  semitones: number,
  opts: StretchOptions = {},
): Float32Array {
  const pitchRatio = Math.pow(2, semitones / 12);
  if (Math.abs(pitchRatio - 1) < 1e-6) return timeStretch(x, timeFactor, opts);
  const stretched = timeStretch(x, timeFactor * pitchRatio, opts);
  return resample(stretched, pitchRatio);
}
