import type { EffectSettings, EffectType } from '../../state/types.ts';
import { defaultParams } from './definitions.ts';
import { hasWorklets } from './worklets.ts';
import { asPcm } from '../../lib/pcm.ts';

export interface EffectContext {
  /** Project tempo, so tempo-synced parameters resolve to seconds. */
  bpm: number;
}

export interface BuiltEffect {
  input: AudioNode;
  output: AudioNode;
  /** Named AudioParams automation lanes can write to. */
  automatable: Record<string, AudioParam>;
  update(params: Record<string, number>, ctx: EffectContext): void;
  dispose(): void;
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

/**
 * Generate a decaying-noise impulse response.
 *
 * Cheap, and close enough to a plate that it sits behind a vocal convincingly.
 * `damping` rolls the tail's high end off over time, as a real room does.
 */
function makeImpulse(ctx: BaseAudioContext, seconds: number, damping: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * rate));
  const buffer = ctx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const decay = Math.pow(1 - t, 2 + damping * 4);
      const noise = Math.random() * 2 - 1;
      // One-pole low-pass that closes as the tail decays.
      const coef = 0.2 + 0.75 * damping * t;
      lp = noise * (1 - coef) + lp * coef;
      data[i] = lp * decay;
    }
  }
  return buffer;
}

/** Waveshaper curve: `k` sets how hard the transfer function bends. */
function makeCurve(k: number, soft: boolean): Float32Array {
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = soft
      ? Math.tanh(k * x) / Math.tanh(k)
      : ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function dryWet(ctx: BaseAudioContext, wetChain: { input: AudioNode; output: AudioNode }) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(wetChain.input);
  wetChain.output.connect(wet).connect(output);
  return { input, output, dry, wet };
}

function setMix(dry: GainNode, wet: GainNode, mix: number): void {
  // Equal-power so the total level stays put as the blend moves.
  dry.gain.value = Math.cos((mix * Math.PI) / 2);
  wet.gain.value = Math.sin((mix * Math.PI) / 2);
}

export function buildEffect(
  ctx: BaseAudioContext,
  type: EffectType,
  initial: Record<string, number>,
  effectCtx: EffectContext,
): BuiltEffect {
  const params = { ...defaultParams(type), ...initial };
  const disposers: (() => void)[] = [];

  switch (type) {
    case 'eq': {
      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      const high = ctx.createBiquadFilter();
      high.type = 'highshelf';
      low.connect(mid).connect(high);
      const update = (p: Record<string, number>) => {
        low.frequency.value = p.lowFreq!;
        low.gain.value = p.lowGain!;
        mid.frequency.value = p.midFreq!;
        mid.gain.value = p.midGain!;
        mid.Q.value = p.midQ!;
        high.frequency.value = p.highFreq!;
        high.gain.value = p.highGain!;
      };
      update(params);
      return {
        input: low,
        output: high,
        automatable: {
          lowGain: low.gain,
          midGain: mid.gain,
          highGain: high.gain,
        },
        update,
        dispose: () => {},
      };
    }

    case 'highpass':
    case 'lowpass': {
      const filter = ctx.createBiquadFilter();
      filter.type = type === 'highpass' ? 'highpass' : 'lowpass';
      const update = (p: Record<string, number>) => {
        filter.frequency.value = p.cutoff!;
        filter.Q.value = p.q!;
      };
      update(params);
      return {
        input: filter,
        output: filter,
        automatable: { filterCutoff: filter.frequency },
        update,
        dispose: () => {},
      };
    }

    case 'compressor': {
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      comp.connect(makeup);
      const update = (p: Record<string, number>) => {
        comp.threshold.value = p.threshold!;
        comp.ratio.value = p.ratio!;
        comp.attack.value = p.attack!;
        comp.release.value = p.release!;
        comp.knee.value = p.knee!;
        makeup.gain.value = dbToGain(p.makeup!);
      };
      update(params);
      return { input: comp, output: makeup, automatable: {}, update, dispose: () => {} };
    }

    case 'limiter': {
      // A compressor with a 20:1 ratio, no knee and a fast attack is a
      // serviceable brickwall; the ceiling is applied as make-up trim.
      const comp = ctx.createDynamicsCompressor();
      comp.ratio.value = 20;
      comp.knee.value = 0;
      comp.attack.value = 0.001;
      const trim = ctx.createGain();
      comp.connect(trim);
      const update = (p: Record<string, number>) => {
        comp.threshold.value = p.ceiling!;
        comp.release.value = p.release!;
        trim.gain.value = dbToGain(-p.ceiling! * 0.15);
      };
      update(params);
      return { input: comp, output: trim, automatable: {}, update, dispose: () => {} };
    }

    case 'gate': {
      if (hasWorklets(ctx)) {
        const node = new AudioWorkletNode(ctx, 'rf-gate', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        const update = (p: Record<string, number>) => {
          node.parameters.get('threshold')!.value = p.threshold!;
          node.parameters.get('attack')!.value = p.attack!;
          node.parameters.get('release')!.value = p.release!;
        };
        update(params);
        return { input: node, output: node, automatable: {}, update, dispose: () => node.disconnect() };
      }
      const pass = ctx.createGain();
      return { input: pass, output: pass, automatable: {}, update: () => {}, dispose: () => {} };
    }

    case 'reverb': {
      const predelay = ctx.createDelay(0.5);
      const convolver = ctx.createConvolver();
      predelay.connect(convolver);
      const chain = dryWet(ctx, { input: predelay, output: convolver });
      let lastSize = -1;
      let lastDamp = -1;
      const update = (p: Record<string, number>) => {
        predelay.delayTime.value = p.predelay!;
        if (p.size !== lastSize || p.damping !== lastDamp) {
          convolver.buffer = makeImpulse(ctx, p.size!, p.damping!);
          lastSize = p.size!;
          lastDamp = p.damping!;
        }
        setMix(chain.dry, chain.wet, p.mix!);
      };
      update(params);
      return {
        input: chain.input,
        output: chain.output,
        automatable: { reverbMix: chain.wet.gain },
        update,
        dispose: () => {},
      };
    }

    case 'delay': {
      const delay = ctx.createDelay(8);
      const feedback = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      delay.connect(tone).connect(feedback).connect(delay);
      const chain = dryWet(ctx, { input: delay, output: tone });
      const update = (p: Record<string, number>, c: EffectContext) => {
        delay.delayTime.value = Math.min(8, (60 / Math.max(20, c.bpm)) * p.beats!);
        feedback.gain.value = p.feedback!;
        tone.frequency.value = p.tone!;
        setMix(chain.dry, chain.wet, p.mix!);
      };
      update(params, effectCtx);
      return {
        input: chain.input,
        output: chain.output,
        automatable: { delayMix: chain.wet.gain },
        update,
        dispose: () => {},
      };
    }

    case 'chorus':
    case 'flanger': {
      const isFlanger = type === 'flanger';
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = isFlanger ? 0.004 : 0.022;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      const lfoGain = ctx.createGain();
      lfo.connect(lfoGain).connect(delay.delayTime);
      lfo.start();
      const feedback = ctx.createGain();
      if (isFlanger) delay.connect(feedback).connect(delay);
      const chain = dryWet(ctx, { input: delay, output: delay });
      const update = (p: Record<string, number>) => {
        lfo.frequency.value = p.rate!;
        lfoGain.gain.value = p.depth!;
        if (isFlanger) feedback.gain.value = p.feedback ?? 0;
        setMix(chain.dry, chain.wet, p.mix!);
      };
      update(params);
      disposers.push(() => {
        try {
          lfo.stop();
        } catch {
          // Already stopped when the context was torn down.
        }
      });
      return {
        input: chain.input,
        output: chain.output,
        automatable: {},
        update,
        dispose: () => disposers.forEach((d) => d()),
      };
    }

    case 'phaser': {
      const stages = [0, 1, 2, 3].map(() => {
        const f = ctx.createBiquadFilter();
        f.type = 'allpass';
        return f;
      });
      for (let i = 0; i + 1 < stages.length; i++) stages[i]!.connect(stages[i + 1]!);
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.connect(lfoGain);
      for (const s of stages) lfoGain.connect(s.frequency);
      lfo.start();
      const chain = dryWet(ctx, { input: stages[0]!, output: stages[stages.length - 1]! });
      const update = (p: Record<string, number>) => {
        lfo.frequency.value = p.rate!;
        lfoGain.gain.value = p.spread!;
        stages.forEach((s, i) => {
          s.frequency.value = p.base! * (1 + i * 0.6);
        });
        setMix(chain.dry, chain.wet, p.mix!);
      };
      update(params);
      disposers.push(() => {
        try {
          lfo.stop();
        } catch {
          // Already stopped.
        }
      });
      return {
        input: chain.input,
        output: chain.output,
        automatable: {},
        update,
        dispose: () => disposers.forEach((d) => d()),
      };
    }

    case 'distortion':
    case 'saturation': {
      const soft = type === 'saturation';
      const pre = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 18000;
      const post = ctx.createGain();
      pre.connect(shaper).connect(tone).connect(post);
      const chain = dryWet(ctx, { input: pre, output: post });
      let lastDrive = -1;
      const update = (p: Record<string, number>) => {
        if (p.drive !== lastDrive) {
          shaper.curve = asPcm(makeCurve(p.drive!, soft));
          lastDrive = p.drive!;
        }
        if (!soft) tone.frequency.value = p.tone ?? 18000;
        post.gain.value = dbToGain(p.output ?? 0);
        setMix(chain.dry, chain.wet, p.mix!);
      };
      update(params);
      return { input: chain.input, output: chain.output, automatable: {}, update, dispose: () => {} };
    }

    case 'bitcrush': {
      if (hasWorklets(ctx)) {
        const node = new AudioWorkletNode(ctx, 'rf-crusher', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        const update = (p: Record<string, number>) => {
          node.parameters.get('bits')!.value = p.bits!;
          node.parameters.get('reduction')!.value = p.reduction!;
          node.parameters.get('mix')!.value = p.mix!;
        };
        update(params);
        return { input: node, output: node, automatable: {}, update, dispose: () => node.disconnect() };
      }
      const pass = ctx.createGain();
      return { input: pass, output: pass, automatable: {}, update: () => {}, dispose: () => {} };
    }

    case 'lofi': {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      hp.connect(lp);
      let tail: AudioNode = lp;
      let crusher: AudioWorkletNode | null = null;
      if (hasWorklets(ctx)) {
        crusher = new AudioWorkletNode(ctx, 'rf-crusher', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        lp.connect(crusher);
        tail = crusher;
      }
      const chain = dryWet(ctx, { input: hp, output: tail });
      const update = (p: Record<string, number>) => {
        hp.frequency.value = p.lowcut!;
        lp.frequency.value = p.highcut!;
        if (crusher) {
          crusher.parameters.get('bits')!.value = p.bits!;
          crusher.parameters.get('reduction')!.value = 2;
          crusher.parameters.get('mix')!.value = 1;
        }
        setMix(chain.dry, chain.wet, p.mix!);
      };
      update(params);
      return {
        input: chain.input,
        output: chain.output,
        automatable: {},
        update,
        dispose: () => crusher?.disconnect(),
      };
    }

    case 'widener': {
      // Mid/side via a channel splitter: M = (L+R)/2, S = (L-R)/2, then
      // rebuild with S scaled by the width control.
      const input = ctx.createGain();
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const output = ctx.createGain();
      input.connect(splitter);

      const midL = ctx.createGain();
      const midR = ctx.createGain();
      const sideL = ctx.createGain();
      const sideR = ctx.createGain();
      midL.gain.value = 0.5;
      midR.gain.value = 0.5;
      sideL.gain.value = 0.5;
      sideR.gain.value = -0.5;

      splitter.connect(midL, 0);
      splitter.connect(midR, 1);
      splitter.connect(sideL, 0);
      splitter.connect(sideR, 1);

      const mid = ctx.createGain();
      const side = ctx.createGain();
      midL.connect(mid);
      midR.connect(mid);
      sideL.connect(side);
      sideR.connect(side);

      const sideOutPos = ctx.createGain();
      const sideOutNeg = ctx.createGain();
      sideOutPos.gain.value = 1;
      sideOutNeg.gain.value = -1;
      side.connect(sideOutPos);
      side.connect(sideOutNeg);

      mid.connect(merger, 0, 0);
      sideOutPos.connect(merger, 0, 0);
      mid.connect(merger, 0, 1);
      sideOutNeg.connect(merger, 0, 1);
      merger.connect(output);

      const update = (p: Record<string, number>) => {
        side.gain.value = p.width!;
      };
      update(params);
      return { input, output, automatable: {}, update, dispose: () => {} };
    }

    case 'deesser': {
      // Split off the sibilance band, compress only that, sum it back.
      const input = ctx.createGain();
      const output = ctx.createGain();
      const band = ctx.createBiquadFilter();
      band.type = 'highpass';
      const comp = ctx.createDynamicsCompressor();
      comp.knee.value = 6;
      comp.attack.value = 0.001;
      comp.release.value = 0.05;
      const rest = ctx.createBiquadFilter();
      rest.type = 'lowpass';

      input.connect(band).connect(comp).connect(output);
      input.connect(rest).connect(output);

      const update = (p: Record<string, number>) => {
        band.frequency.value = p.frequency!;
        rest.frequency.value = p.frequency!;
        comp.threshold.value = p.threshold!;
        comp.ratio.value = p.amount!;
      };
      update(params);
      return { input, output, automatable: {}, update, dispose: () => {} };
    }

    default: {
      const pass = ctx.createGain();
      return { input: pass, output: pass, automatable: {}, update: () => {}, dispose: () => {} };
    }
  }
}

export interface BuiltChain {
  input: AudioNode;
  output: AudioNode;
  effects: Map<string, BuiltEffect>;
  dispose(): void;
}

/** Wire a list of effect settings into a serial chain. */
export function buildChain(
  ctx: BaseAudioContext,
  settings: EffectSettings[],
  effectCtx: EffectContext,
): BuiltChain {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const effects = new Map<string, BuiltEffect>();

  let tail: AudioNode = input;
  for (const s of settings) {
    if (!s.enabled) continue;
    const built = buildEffect(ctx, s.type, s.params, effectCtx);
    tail.connect(built.input);
    tail = built.output;
    effects.set(s.id, built);
  }
  tail.connect(output);

  return {
    input,
    output,
    effects,
    dispose: () => {
      for (const e of effects.values()) e.dispose();
    },
  };
}
