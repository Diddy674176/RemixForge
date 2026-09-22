/**
 * AudioWorklet processors that can't be built from native nodes.
 *
 * Shipped as a source string and registered from a blob URL so the same code
 * loads into both the live AudioContext and every OfflineAudioContext used for
 * export, with no extra build configuration.
 */
const WORKLET_SOURCE = `
class CrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 16, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'reduction', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.hold = [];
    this.counter = [];
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const bits = Math.max(1, params.bits[0]);
    const reduction = Math.max(1, Math.floor(params.reduction[0]));
    const mix = params.mix[0];
    const levels = Math.pow(2, bits) - 1;

    for (let c = 0; c < output.length; c++) {
      const inCh = input[Math.min(c, input.length - 1)];
      const outCh = output[c];
      if (!inCh) continue;
      if (this.hold[c] === undefined) { this.hold[c] = 0; this.counter[c] = 0; }
      for (let i = 0; i < outCh.length; i++) {
        if (this.counter[c] <= 0) {
          // Sample-and-hold gives real sample-rate reduction, aliasing included.
          const q = Math.round(((inCh[i] + 1) / 2) * levels) / levels;
          this.hold[c] = q * 2 - 1;
          this.counter[c] = reduction;
        }
        this.counter[c]--;
        outCh[i] = inCh[i] * (1 - mix) + this.hold[c] * mix;
      }
    }
    return true;
  }
}

class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.002, minValue: 0.0001, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.08, minValue: 0.005, maxValue: 2, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.env = 0;
    this.gain = 0;
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const thresh = Math.pow(10, params.threshold[0] / 20);
    const aCoef = Math.exp(-1 / (params.attack[0] * sampleRate));
    const rCoef = Math.exp(-1 / (params.release[0] * sampleRate));
    const n = output[0] ? output[0].length : 0;

    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) {
        const v = Math.abs(input[c][i]);
        if (v > peak) peak = v;
      }
      this.env = peak > this.env ? peak : this.env * 0.999;
      const target = this.env >= thresh ? 1 : 0;
      const coef = target > this.gain ? aCoef : rCoef;
      this.gain = target + (this.gain - target) * coef;
      for (let c = 0; c < output.length; c++) {
        const inCh = input[Math.min(c, input.length - 1)];
        output[c][i] = inCh[i] * this.gain;
      }
    }
    return true;
  }
}

registerProcessor('rf-crusher', CrusherProcessor);
registerProcessor('rf-gate', GateProcessor);
`;

let blobUrl: string | null = null;
const loaded = new WeakSet<BaseAudioContext>();

function moduleUrl(): string {
  if (!blobUrl) {
    blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  }
  return blobUrl;
}

/** Idempotently register the worklet processors on a context. */
export async function ensureWorklets(ctx: BaseAudioContext): Promise<boolean> {
  if (loaded.has(ctx)) return true;
  if (!ctx.audioWorklet) return false;
  try {
    await ctx.audioWorklet.addModule(moduleUrl());
    loaded.add(ctx);
    return true;
  } catch {
    return false;
  }
}

export function hasWorklets(ctx: BaseAudioContext): boolean {
  return loaded.has(ctx);
}
