/**
 * Minimal in-place radix-2 complex FFT.
 *
 * Instances cache their twiddle factors and bit-reversal table, so the same
 * `FFT` object should be reused across every frame of an STFT pass.
 */
export class FFT {
  readonly size: number;
  private readonly levels: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.levels = Math.log2(size) | 0;

    const half = size / 2;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }

    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < this.levels; b++) r |= ((i >>> b) & 1) << (this.levels - 1 - b);
      this.reverse[i] = r;
    }
  }

  /** Forward transform. `re`/`im` are modified in place. */
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverse[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }

    for (let span = 2; span <= n; span *= 2) {
      const half = span / 2;
      const step = n / span;
      for (let i = 0; i < n; i += span) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const cos = this.cosTable[k]!;
          const sin = this.sinTable[k]!;
          const tre = re[l]! * cos + im[l]! * sin;
          const tim = -re[l]! * sin + im[l]! * cos;
          re[l] = re[j]! - tre;
          im[l] = im[j]! - tim;
          re[j] = re[j]! + tre;
          im[j] = im[j]! + tim;
        }
      }
    }
  }

  /** Inverse transform, normalised by 1/N. `re`/`im` are modified in place. */
  inverse(re: Float64Array, im: Float64Array): void {
    // conj -> forward -> conj -> scale
    this.forward(im, re);
    const n = this.size;
    const scale = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! * scale;
      im[i] = im[i]! * scale;
    }
  }
}

/** Periodic Hann window — the right choice for STFT analysis/resynthesis. */
export function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

/** Square-root Hann — used when both analysis and synthesis are windowed. */
export function sqrtHann(size: number): Float64Array {
  const w = hann(size);
  for (let i = 0; i < size; i++) w[i] = Math.sqrt(w[i]!);
  return w;
}
