import { stft, istft } from '../dsp/stft.ts';
import { hpss } from '../dsp/hpss.ts';
import {
  DEFAULT_TARGETS,
  type SeparatedStem,
  type SeparationEngine,
  type SeparationProgress,
  type SeparationRequest,
  type StemId,
} from './types.ts';

const FFT_SIZE = 2048;
const HOP = 512;
/** Audio is separated in blocks so peak memory stays bounded on long tracks. */
const BLOCK_SECONDS = 20;
const OVERLAP_SECONDS = 1;

const SUPPORTED: StemId[] = [
  'lead-vocals',
  'backing-vocals',
  'drums',
  'kick',
  'snare',
  'hihat',
  'percussion',
  'bass',
  'melody',
  'other',
  'instrumental',
];

/** Smooth 0→1 ramp, for band edges that shouldn't ring. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

interface BandWeights {
  low: Float32Array;
  vocal: Float32Array;
  kick: Float32Array;
  snare: Float32Array;
  hihat: Float32Array;
}

function bandWeights(bins: number, sampleRate: number, fftSize: number): BandWeights {
  const low = new Float32Array(bins);
  const vocal = new Float32Array(bins);
  const kick = new Float32Array(bins);
  const snare = new Float32Array(bins);
  const hihat = new Float32Array(bins);
  const binHz = sampleRate / fftSize;

  for (let b = 0; b < bins; b++) {
    const hz = b * binHz;
    // Bass region: flat to 120 Hz, gone by 280.
    low[b] = 1 - smoothstep(120, 280, hz);
    // Vocal region: in by 180 Hz, out by 9 kHz — wide enough to keep sibilance.
    vocal[b] = smoothstep(150, 220, hz) * (1 - smoothstep(7000, 9500, hz));
    kick[b] = 1 - smoothstep(90, 180, hz);
    snare[b] = smoothstep(120, 200, hz) * (1 - smoothstep(1200, 2600, hz));
    hihat[b] = smoothstep(4500, 7000, hz);
  }
  return { low, vocal, kick, snare, hihat };
}

/** Three-frame mean along time — takes the grit off a mask without smearing it. */
function smoothMask(mask: Float32Array, frames: number, bins: number): void {
  const prev = new Float32Array(bins);
  const cur = new Float32Array(bins);
  for (let f = 0; f < frames; f++) {
    const off = f * bins;
    cur.set(mask.subarray(off, off + bins));
    if (f > 0) {
      const nextOff = f + 1 < frames ? (f + 1) * bins : off;
      for (let b = 0; b < bins; b++) {
        mask[off + b] = (prev[b]! + cur[b]! * 2 + mask[nextOff + b]!) / 4;
      }
    }
    prev.set(cur);
  }
}

interface BlockMasks {
  frames: number;
  bins: number;
  masks: Map<StemId, Float32Array>;
}

/**
 * Build a set of soft masks for one block.
 *
 * The masks form a partition: the primary stems (bass, lead, backing, melody,
 * drums) sum to 1 in every bin, so summing every stem reconstructs the input
 * and no energy is invented or lost.
 */
function buildMasks(
  magMid: Float32Array,
  centerness: Float32Array | null,
  frames: number,
  bins: number,
  sampleRate: number,
  targets: Set<StemId>,
): BlockMasks {
  const { harmonic, percussive } = hpss(magMid, frames, bins, { timeWindow: 17, freqWindow: 17 });
  const bands = bandWeights(bins, sampleRate, FFT_SIZE);
  const n = frames * bins;

  const bass = new Float32Array(n);
  const lead = new Float32Array(n);
  const backing = new Float32Array(n);
  const melody = new Float32Array(n);

  for (let f = 0; f < frames; f++) {
    const off = f * bins;
    for (let b = 0; b < bins; b++) {
      const i = off + b;
      const h = harmonic[i]!;
      const lw = bands.low[b]!;
      const vw = bands.vocal[b]!;

      const bassPart = h * lw;
      let leadPart = 0;
      let backPart = 0;
      if (centerness) {
        const c = centerness[i]!;
        // A lead vocal sits centred and coherent; doubles and harmonies spread
        // wide. Raising the contrast keeps the lead from dragging pads along.
        leadPart = h * (1 - lw) * vw * Math.pow(c, 1.6);
        backPart = h * (1 - lw) * vw * Math.pow(1 - c, 2.2) * 0.75;
      } else {
        // Mono input: no panning information exists, so this degrades to a
        // band-limited harmonic estimate. Documented as such in the UI.
        leadPart = h * (1 - lw) * vw * 0.55;
      }

      const sum = bassPart + leadPart + backPart;
      const scale = sum > h && sum > 1e-9 ? h / sum : 1;
      const bp = bassPart * scale;
      const lp = leadPart * scale;
      const kp = backPart * scale;

      bass[i] = bp;
      lead[i] = lp;
      backing[i] = kp;
      melody[i] = Math.max(0, h - bp - lp - kp);
    }
  }

  smoothMask(lead, frames, bins);
  smoothMask(backing, frames, bins);
  smoothMask(bass, frames, bins);

  const masks = new Map<StemId, Float32Array>();
  const want = (id: StemId) => targets.has(id);

  if (want('lead-vocals')) masks.set('lead-vocals', lead);
  if (want('backing-vocals')) masks.set('backing-vocals', backing);
  if (want('bass')) masks.set('bass', bass);
  if (want('melody') || want('other')) {
    if (want('melody')) masks.set('melody', melody);
    if (want('other')) masks.set('other', melody);
  }
  if (want('drums')) masks.set('drums', percussive);

  if (want('kick') || want('snare') || want('hihat') || want('percussion')) {
    const kick = new Float32Array(n);
    const snare = new Float32Array(n);
    const hat = new Float32Array(n);
    const perc = new Float32Array(n);
    for (let f = 0; f < frames; f++) {
      const off = f * bins;
      for (let b = 0; b < bins; b++) {
        const i = off + b;
        const p = percussive[i]!;
        const k = p * bands.kick[b]!;
        const s = p * bands.snare[b]!;
        const hh = p * bands.hihat[b]!;
        const sum = k + s + hh;
        const scale = sum > p && sum > 1e-9 ? p / sum : 1;
        kick[i] = k * scale;
        snare[i] = s * scale;
        hat[i] = hh * scale;
        perc[i] = Math.max(0, p - k * scale - s * scale - hh * scale);
      }
    }
    if (want('kick')) masks.set('kick', kick);
    if (want('snare')) masks.set('snare', snare);
    if (want('hihat')) masks.set('hihat', hat);
    if (want('percussion')) masks.set('percussion', perc);
  }

  if (want('instrumental')) {
    const inst = new Float32Array(n);
    for (let i = 0; i < n; i++) inst[i] = Math.max(0, 1 - lead[i]! - backing[i]!);
    masks.set('instrumental', inst);
  }

  return { frames, bins, masks };
}

/**
 * Per-bin "centredness" in [0,1]: 1 when left and right carry the same thing
 * in phase (a centred source), 0 when they are uncorrelated or out of phase.
 */
function centrednessOf(
  magL: Float32Array,
  phaseL: Float32Array,
  magR: Float32Array,
  phaseR: Float32Array,
): Float32Array {
  const c = new Float32Array(magL.length);
  for (let i = 0; i < magL.length; i++) {
    const ml = magL[i]!;
    const mr = magR[i]!;
    const denom = ml * ml + mr * mr;
    if (denom < 1e-14) {
      c[i] = 0;
      continue;
    }
    const v = (2 * ml * mr * Math.cos(phaseL[i]! - phaseR[i]!)) / denom;
    c[i] = Math.min(1, Math.max(0, v));
  }
  return c;
}

/** Equal-power crossfade ramp used to stitch neighbouring blocks. */
function fadeIn(i: number, n: number): number {
  return Math.sin((Math.PI / 2) * (i / n));
}

export class DspSeparationEngine implements SeparationEngine {
  readonly id = 'builtin-dsp';
  readonly name = 'Built-in DSP';
  readonly description =
    'Runs entirely on your machine with no download. Harmonic/percussive median filtering plus stereo centre extraction. Strong on drums, bass and instrumental; vocals are good on wide stereo mixes and weak on mono ones.';
  readonly supports = SUPPORTED;

  async available(): Promise<boolean> {
    return true;
  }

  async separate(
    request: SeparationRequest,
    onProgress?: (p: SeparationProgress) => void,
  ): Promise<SeparatedStem[]> {
    const { channels, sampleRate } = request;
    const targets = new Set<StemId>(
      (request.targets.length ? request.targets : DEFAULT_TARGETS).filter((t) =>
        SUPPORTED.includes(t),
      ),
    );
    if (targets.size === 0) return [];

    const length = channels[0]?.length ?? 0;
    const numCh = channels.length;
    const stereo = numCh >= 2;

    const out = new Map<StemId, Float32Array[]>();
    for (const id of targets) {
      out.set(
        id,
        Array.from({ length: numCh }, () => new Float32Array(length)),
      );
    }

    const blockLen = Math.round(BLOCK_SECONDS * sampleRate);
    const overlap = Math.round(OVERLAP_SECONDS * sampleRate);
    const step = Math.max(1, blockLen - overlap);
    const blocks = Math.max(1, Math.ceil(length / step));

    for (let bi = 0; bi < blocks; bi++) {
      const start = bi * step;
      if (start >= length) break;
      const end = Math.min(length, start + blockLen);
      const blockSize = end - start;

      onProgress?.({ value: bi / blocks, stage: `Separating block ${bi + 1} of ${blocks}` });

      const slices = channels.map((ch) => ch.subarray(start, end));
      const specs = slices.map((s) => stft(s, FFT_SIZE, HOP, sampleRate));
      const frames = specs[0]!.frames;
      const bins = specs[0]!.bins;

      // Mid signal drives the mask estimation; the masks are then applied to
      // every channel, which preserves the original stereo image.
      const midMag = new Float32Array(frames * bins);
      if (stereo) {
        for (let i = 0; i < midMag.length; i++) {
          midMag[i] = (specs[0]!.mag[i]! + specs[1]!.mag[i]!) / 2;
        }
      } else {
        midMag.set(specs[0]!.mag);
      }

      const centerness = stereo
        ? centrednessOf(specs[0]!.mag, specs[0]!.phase, specs[1]!.mag, specs[1]!.phase)
        : null;

      const { masks } = buildMasks(midMag, centerness, frames, bins, sampleRate, targets);

      for (const [id, mask] of masks) {
        const dest = out.get(id)!;
        for (let c = 0; c < numCh; c++) {
          const spec = specs[Math.min(c, specs.length - 1)]!;
          const masked = new Float32Array(spec.mag.length);
          for (let i = 0; i < masked.length; i++) masked[i] = spec.mag[i]! * mask[i]!;
          const audio = istft({ ...spec, mag: masked }, blockSize);

          const target = dest[c]!;
          const fadeLen = bi === 0 ? 0 : Math.min(overlap, blockSize);
          for (let i = 0; i < blockSize; i++) {
            const gi = start + i;
            if (gi >= length) break;
            if (i < fadeLen) {
              // Crossfade against what the previous block already wrote.
              const g = fadeIn(i, fadeLen);
              target[gi] = target[gi]! * Math.sqrt(1 - g * g) + audio[i]! * g;
            } else {
              target[gi] = audio[i]!;
            }
          }
        }
      }

      // Yield to the event loop so a worker stays responsive to cancellation.
      await Promise.resolve();
    }

    onProgress?.({ value: 1, stage: 'Done' });
    return [...out.entries()].map(([id, chans]) => ({ id, channels: chans }));
  }
}
