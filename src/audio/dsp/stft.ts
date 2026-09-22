import { FFT, hann } from './fft.ts';

export interface Spectrogram {
  /** Number of analysis frames. */
  frames: number;
  /** Bins per frame — `fftSize / 2 + 1`. */
  bins: number;
  hop: number;
  fftSize: number;
  sampleRate: number;
  /** Magnitudes, laid out frame-major: `mag[f * bins + b]`. */
  mag: Float32Array;
  /** Phases in radians, same layout as `mag`. */
  phase: Float32Array;
  /** Samples in the signal this was analysed from. */
  length: number;
}

/**
 * Short-time Fourier transform with a Hann window.
 *
 * Frames are centred: the signal is conceptually zero-padded by `fftSize / 2`
 * on both sides, so frame `f` is centred on sample `f * hop`.
 */
export function stft(x: Float32Array, fftSize: number, hop: number, sampleRate: number): Spectrogram {
  const fft = new FFT(fftSize);
  const win = hann(fftSize);
  const half = fftSize >> 1;
  const bins = half + 1;
  const frames = Math.max(1, Math.ceil(x.length / hop));

  const mag = new Float32Array(frames * bins);
  const phase = new Float32Array(frames * bins);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let f = 0; f < frames; f++) {
    const start = f * hop - half;
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < x.length ? x[s]! * win[i]! : 0;
      im[i] = 0;
    }
    fft.forward(re, im);
    const off = f * bins;
    for (let b = 0; b < bins; b++) {
      const r = re[b]!;
      const i2 = im[b]!;
      mag[off + b] = Math.hypot(r, i2);
      phase[off + b] = Math.atan2(i2, r);
    }
  }

  return { frames, bins, hop, fftSize, sampleRate, mag, phase, length: x.length };
}

/**
 * Inverse STFT by weighted overlap-add.
 *
 * Divides out the summed squared window so that an unmodified round trip is
 * (near) lossless regardless of the hop size.
 */
export function istft(spec: Spectrogram, length = spec.length): Float32Array {
  const { fftSize, hop, bins, frames, mag, phase } = spec;
  const fft = new FFT(fftSize);
  const win = hann(fftSize);
  const half = fftSize >> 1;

  const out = new Float32Array(length);
  const norm = new Float32Array(length);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let f = 0; f < frames; f++) {
    const off = f * bins;
    for (let b = 0; b < bins; b++) {
      const m = mag[off + b]!;
      const p = phase[off + b]!;
      re[b] = m * Math.cos(p);
      im[b] = m * Math.sin(p);
    }
    // Rebuild the negative-frequency half as the conjugate mirror.
    for (let b = 1; b < half; b++) {
      re[fftSize - b] = re[b]!;
      im[fftSize - b] = -im[b]!;
    }
    im[0] = 0;
    im[half] = 0;

    fft.inverse(re, im);

    const start = f * hop - half;
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      if (s < 0 || s >= length) continue;
      const w = win[i]!;
      out[s] = out[s]! + re[i]! * w;
      norm[s] = norm[s]! + w * w;
    }
  }

  for (let i = 0; i < length; i++) {
    const n = norm[i]!;
    if (n > 1e-8) out[i] = out[i]! / n;
  }
  return out;
}

/** Resynthesise a spectrogram after its magnitudes were replaced by `mag`. */
export function istftWithMagnitude(spec: Spectrogram, mag: Float32Array, length = spec.length): Float32Array {
  return istft({ ...spec, mag }, length);
}
