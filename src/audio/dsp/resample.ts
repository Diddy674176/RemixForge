/** Modified Bessel function of the first kind, order 0 — for the Kaiser window. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 32; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

const TAPS = 16;
const KAISER_BETA = 8.6;
const TABLE_RES = 512;

/**
 * Precomputed Kaiser-windowed sinc, sampled at `TABLE_RES` sub-sample
 * positions so interpolation is a table lookup rather than a transcendental.
 */
const sincTable = (() => {
  const half = TAPS / 2;
  const table = new Float32Array((TABLE_RES + 1) * TAPS);
  const i0beta = besselI0(KAISER_BETA);
  for (let p = 0; p <= TABLE_RES; p++) {
    const frac = p / TABLE_RES;
    for (let t = 0; t < TAPS; t++) {
      const x = t - half + 1 - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const r = x / half;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0beta;
      table[p * TAPS + t] = sinc * w;
    }
  }
  return table;
})();

/** Read `x` at a fractional sample index using the windowed-sinc kernel. */
export function sampleAt(x: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const frac = pos - i;
  const p = (frac * TABLE_RES) | 0;
  const off = p * TAPS;
  const base = i - TAPS / 2 + 1;
  let acc = 0;
  for (let t = 0; t < TAPS; t++) {
    const s = base + t;
    if (s < 0 || s >= x.length) continue;
    acc += x[s]! * sincTable[off + t]!;
  }
  return acc;
}

/**
 * Resample by an arbitrary ratio (output length = input length / `ratio`).
 *
 * When downsampling the kernel is stretched to act as an anti-alias filter,
 * which is what keeps pitch-shifted material free of the metallic aliasing
 * a naive linear resampler produces.
 */
export function resample(x: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-9) return x.slice();
  const outLen = Math.max(1, Math.round(x.length / ratio));
  const out = new Float32Array(outLen);

  if (ratio <= 1) {
    for (let i = 0; i < outLen; i++) out[i] = sampleAt(x, i * ratio);
    return out;
  }

  // Downsampling: widen the kernel by `ratio` and renormalise.
  const half = TAPS / 2;
  const width = half * ratio;
  const i0beta = besselI0(KAISER_BETA);
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    const from = Math.max(0, Math.ceil(center - width));
    const to = Math.min(x.length - 1, Math.floor(center + width));
    let acc = 0;
    let norm = 0;
    for (let s = from; s <= to; s++) {
      const d = (s - center) / ratio;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const r = d / half;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0beta;
      const k = sinc * w;
      acc += x[s]! * k;
      norm += k;
    }
    out[i] = norm > 1e-9 ? acc / norm : 0;
  }
  return out;
}

/** Resample from one sample rate to another. */
export function resampleTo(x: Float32Array, fromRate: number, toRate: number): Float32Array {
  return resample(x, fromRate / toRate);
}
