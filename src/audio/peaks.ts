export interface PeakData {
  /** Minimum sample in each bucket, in [-1,1]. */
  min: Float32Array;
  /** Maximum sample in each bucket. */
  max: Float32Array;
  /** RMS per bucket — drawn behind the peaks so quiet detail stays visible. */
  rms: Float32Array;
  samplesPerBucket: number;
  buckets: number;
}

/**
 * Multi-resolution peaks.
 *
 * Each level halves the resolution of the one before, so zooming picks the
 * level closest to one bucket per pixel and redraws are O(pixels) rather than
 * O(samples) — which is what keeps the timeline smooth on long tracks.
 */
export interface PeakPyramid {
  levels: PeakData[];
  duration: number;
  sampleRate: number;
}

const BASE_BUCKET = 256;
const LEVELS = 9;

function computeLevel(channels: Float32Array[], samplesPerBucket: number): PeakData {
  const length = channels[0]?.length ?? 0;
  const buckets = Math.max(1, Math.ceil(length / samplesPerBucket));
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const rms = new Float32Array(buckets);

  for (let b = 0; b < buckets; b++) {
    const from = b * samplesPerBucket;
    const to = Math.min(length, from + samplesPerBucket);
    let lo = 0;
    let hi = 0;
    let sq = 0;
    let n = 0;
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c]!;
      for (let i = from; i < to; i++) {
        const v = data[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sq += v * v;
        n++;
      }
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = n ? Math.sqrt(sq / n) : 0;
  }
  return { min, max, rms, samplesPerBucket, buckets };
}

/** Halve a level's resolution by folding neighbouring buckets together. */
function decimate(level: PeakData): PeakData {
  const buckets = Math.max(1, Math.ceil(level.buckets / 2));
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const a = b * 2;
    const c = Math.min(level.buckets - 1, a + 1);
    min[b] = Math.min(level.min[a]!, level.min[c]!);
    max[b] = Math.max(level.max[a]!, level.max[c]!);
    rms[b] = Math.sqrt((level.rms[a]! * level.rms[a]! + level.rms[c]! * level.rms[c]!) / 2);
  }
  return { min, max, rms, samplesPerBucket: level.samplesPerBucket * 2, buckets };
}

export function buildPeaks(
  channels: Float32Array[],
  sampleRate: number,
): PeakPyramid {
  const base = computeLevel(channels, BASE_BUCKET);
  const levels = [base];
  for (let i = 1; i < LEVELS; i++) {
    const prev = levels[i - 1]!;
    if (prev.buckets <= 2) break;
    levels.push(decimate(prev));
  }
  return {
    levels,
    duration: (channels[0]?.length ?? 0) / sampleRate,
    sampleRate,
  };
}

/** Pick the level whose buckets are closest to (but not finer than) one pixel. */
export function levelFor(pyramid: PeakPyramid, samplesPerPixel: number): PeakData {
  let best = pyramid.levels[0]!;
  for (const level of pyramid.levels) {
    if (level.samplesPerBucket <= samplesPerPixel) best = level;
    else break;
  }
  return best;
}
