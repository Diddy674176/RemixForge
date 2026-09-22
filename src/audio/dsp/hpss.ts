import { medianFilterAxis } from './medianFilter.ts';

export interface HpssMasks {
  /** Harmonic soft mask, frame-major, same layout as the spectrogram. */
  harmonic: Float32Array;
  /** Percussive soft mask. `harmonic + percussive === 1` everywhere. */
  percussive: Float32Array;
}

export interface HpssOptions {
  /** Median window along time, in frames. Larger = stricter harmonic test. */
  timeWindow?: number;
  /** Median window along frequency, in bins. */
  freqWindow?: number;
  /**
   * Mask exponent. 1 gives soft (Wiener-like) masks that sum cleanly; 2 is
   * sharper but leaves more musical noise.
   */
  power?: number;
}

/**
 * Harmonic/percussive source separation by median filtering.
 *
 * Harmonic content is steady in time, so a median along the time axis
 * survives it. Percussive content is broadband within a frame, so a median
 * along frequency survives that. Comparing the two enhanced spectrograms
 * gives a soft mask per bin.
 */
export function hpss(
  mag: Float32Array,
  frames: number,
  bins: number,
  opts: HpssOptions = {},
): HpssMasks {
  const timeWindow = opts.timeWindow ?? 17;
  const freqWindow = opts.freqWindow ?? 17;
  const power = opts.power ?? 1;

  const harmEnh = new Float32Array(mag.length);
  const percEnh = new Float32Array(mag.length);

  // `mag` is frame-major: rows = frames, cols = bins.
  medianFilterAxis(mag, harmEnh, frames, bins, 'cols', timeWindow);
  medianFilterAxis(mag, percEnh, frames, bins, 'rows', freqWindow);

  const harmonic = harmEnh;
  const percussive = percEnh;
  for (let i = 0; i < mag.length; i++) {
    const h = Math.pow(harmEnh[i]!, power);
    const p = Math.pow(percEnh[i]!, power);
    const sum = h + p;
    if (sum > 1e-12) {
      harmonic[i] = h / sum;
      percussive[i] = p / sum;
    } else {
      harmonic[i] = 0.5;
      percussive[i] = 0.5;
    }
  }
  return { harmonic, percussive };
}
