import { audioAssets, toAudioBuffer } from './assets.ts';
import { buildChain, type BuiltChain } from './effects/rack.ts';
import { ensureWorklets } from './effects/worklets.ts';
import { masterChainFor } from './effects/mastering.ts';
import type { AutomationLane, Clip, Project } from '../state/types.ts';
import { warpCache } from './warpCache.ts';
import { asPcm } from '../lib/pcm.ts';

const LOOKAHEAD = 0.12;

interface TrackNodes {
  input: GainNode;
  volume: GainNode;
  panner: StereoPannerNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  chain: BuiltChain;
  analyser: AnalyserNode;
  output: GainNode;
}

export interface TransportState {
  playing: boolean;
  /** Playhead in seconds. */
  position: number;
  /** Project duration implied by the clips, in seconds. */
  duration: number;
}

export type TransportListener = (state: TransportState) => void;

/**
 * Owns the live AudioContext and everything hanging off it.
 *
 * The project object stays a plain serialisable value; this class is the only
 * thing that knows about Web Audio nodes, and it reconciles the graph against
 * the project whenever it changes.
 */
export class RemixEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterChain: BuiltChain | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private tracks = new Map<string, TrackNodes>();
  private sources: AudioBufferSourceNode[] = [];
  private project: Project | null = null;

  private playing = false;
  /** ctx.currentTime when playback started. */
  private startedAt = 0;
  /** Timeline position playback started from. */
  private startOffset = 0;
  private rafId: number | null = null;
  private listeners = new Set<TransportListener>();
  private metronomeOn = false;
  private metronomeTimer: number | null = null;
  private lastGraphKey = '';
  /**
   * Cached transport snapshot.
   *
   * `useSyncExternalStore` requires the same object back between emits, so the
   * snapshot is rebuilt only when a value actually changes — recomputing the
   * playhead on every read would hand React a new object each render and spin
   * forever.
   */
  private snapshot: TransportState = { playing: false, position: 0, duration: 0 };

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Create the context. Must be called from a user gesture on most browsers. */
  async init(): Promise<AudioContext> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ensureWorklets(ctx);

    const master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    master.connect(limiter).connect(analyser).connect(ctx.destination);

    this.ctx = ctx;
    this.master = master;
    this.limiter = limiter;
    this.masterAnalyser = analyser;
    return ctx;
  }

  subscribe(fn: TransportListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    if (!this.refreshSnapshot()) return;
    for (const fn of this.listeners) fn(this.snapshot);
  }

  /** Rebuild the snapshot if anything moved. Returns true when it changed. */
  private refreshSnapshot(): boolean {
    const playing = this.playing;
    const position = this.position();
    const duration = this.project ? projectDuration(this.project) : 0;
    const prev = this.snapshot;
    if (prev.playing === playing && prev.position === position && prev.duration === duration) {
      return false;
    }
    this.snapshot = { playing, position, duration };
    return true;
  }

  state(): TransportState {
    return this.snapshot;
  }

  position(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    const raw = this.startOffset + (this.ctx.currentTime - this.startedAt);
    const loop = this.project?.loop;
    if (loop?.enabled && loop.end > loop.start) {
      const span = loop.end - loop.start;
      if (raw >= loop.start) return loop.start + ((raw - loop.start) % span);
    }
    return raw;
  }

  /**
   * Reconcile the graph with `project`.
   *
   * Tracks and effect chains are rebuilt only when their shape changes; plain
   * value changes (volume, pan, effect params) are applied in place so moving
   * a fader never interrupts playback.
   */
  sync(project: Project): void {
    this.project = project;
    // The graph only exists once the context does, but the transport still
    // needs the new project length — the timeline shows it before first play.
    if (this.ctx && this.master) {
      const key = graphKey(project);
      if (key !== this.lastGraphKey) {
        this.rebuildGraph(project);
        this.lastGraphKey = key;
      }
      this.applyValues(project);
    }
    this.emit();
  }

  private rebuildGraph(project: Project): void {
    const ctx = this.ctx!;
    for (const nodes of this.tracks.values()) {
      nodes.chain.dispose();
      nodes.input.disconnect();
      nodes.output.disconnect();
    }
    this.tracks.clear();
    this.masterChain?.dispose();

    const effectCtx = { bpm: project.bpm };

    for (const track of project.tracks) {
      const input = ctx.createGain();
      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      low.frequency.value = 180;
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 1400;
      mid.Q.value = 0.9;
      const high = ctx.createBiquadFilter();
      high.type = 'highshelf';
      high.frequency.value = 5200;

      const chain = buildChain(ctx, track.effects, effectCtx);
      const volume = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const output = ctx.createGain();

      input
        .connect(low)
        .connect(mid)
        .connect(high)
        .connect(chain.input);
      chain.output.connect(volume).connect(panner).connect(analyser).connect(output);
      output.connect(this.master!);

      this.tracks.set(track.id, { input, volume, panner, low, mid, high, chain, analyser, output });
    }

    const masterSettings = masterChainFor(project.master);
    this.masterChain = buildChain(ctx, masterSettings, effectCtx);
    // Insert the master chain between the summed tracks and the limiter.
    this.master!.disconnect();
    this.master!.connect(this.masterChain.input);
    this.masterChain.output.connect(this.limiter!);
  }

  private applyValues(project: Project): void {
    const anySolo = project.tracks.some((t) => t.solo);
    for (const track of project.tracks) {
      const nodes = this.tracks.get(track.id);
      if (!nodes) continue;
      const audible = track.mute ? 0 : anySolo && !track.solo ? 0 : 1;
      nodes.volume.gain.value = track.volume * audible;
      nodes.panner.pan.value = Math.max(-1, Math.min(1, track.pan));
      nodes.low.gain.value = track.lowGain;
      nodes.mid.gain.value = track.midGain;
      nodes.high.gain.value = track.highGain;

      const effectCtx = { bpm: project.bpm };
      for (const s of track.effects) {
        nodes.chain.effects.get(s.id)?.update(s.params, effectCtx);
      }
    }

    if (this.master) this.master.gain.value = project.master.volume;
    if (this.limiter) this.limiter.threshold.value = project.master.ceiling;
    if (this.masterChain) {
      const settings = masterChainFor(project.master);
      for (const s of settings) this.masterChain.effects.get(s.id)?.update(s.params, { bpm: project.bpm });
    }
  }

  /** Schedule every clip that overlaps the window starting at `from`. */
  private scheduleClips(project: Project, from: number, when: number): void {
    const ctx = this.ctx!;
    const loop = project.loop;
    const looping = loop.enabled && loop.end > loop.start;
    const windowEnd = looping ? loop.end : Infinity;

    for (const clip of project.clips) {
      const nodes = this.tracks.get(clip.trackId);
      if (!nodes) continue;
      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= from || clip.start >= windowEnd) continue;

      const warped = warpCache.getSync(clip.assetId, clip.stretch, clip.pitch, clip.reverse);
      const asset = warped ?? audioAssets.get(clip.assetId);
      if (!asset) continue;

      const buffer = toAudioBuffer(ctx, asset);
      const node = ctx.createBufferSource();
      node.buffer = buffer;

      // If the quality-rendered warp isn't ready yet, fall back to varispeed so
      // the edit is still audible immediately.
      if (!warped && (clip.stretch !== 1 || clip.pitch !== 0)) {
        node.playbackRate.value = (1 / clip.stretch) * Math.pow(2, clip.pitch / 12);
      }
      const rate = node.playbackRate.value;

      const gain = ctx.createGain();
      node.connect(gain).connect(nodes.input);

      const startInTimeline = Math.max(clip.start, from);
      const skip = startInTimeline - clip.start;
      const playDuration = Math.min(clipEnd, windowEnd) - startInTimeline;
      if (playDuration <= 0) continue;

      const offsetSec = clip.offset + skip * rate;
      const startAt = when + (startInTimeline - from);

      applyClipGain(gain, clip, startAt, skip, playDuration);
      node.start(startAt, offsetSec, playDuration * rate);
      node.onended = () => {
        gain.disconnect();
        node.disconnect();
      };
      this.sources.push(node);
    }

    for (const track of project.tracks) {
      const nodes = this.tracks.get(track.id);
      if (!nodes) continue;
      for (const lane of track.automation) {
        if (lane.enabled) this.applyAutomation(nodes, lane, from, when);
      }
    }
  }

  private applyAutomation(
    nodes: TrackNodes,
    lane: AutomationLane,
    from: number,
    when: number,
  ): void {
    const param = automationParam(nodes, lane.target);
    if (!param || lane.points.length === 0) return;

    const points = [...lane.points].sort((a, b) => a.time - b.time);
    param.cancelScheduledValues(when);
    const first = points[0]!;
    param.setValueAtTime(valueAt(points, Math.max(from, first.time)), when);
    for (const p of points) {
      if (p.time < from) continue;
      param.linearRampToValueAtTime(p.value, when + (p.time - from));
    }
  }

  private stopSources(): void {
    for (const node of this.sources) {
      try {
        node.stop();
      } catch {
        // Already finished.
      }
      node.disconnect();
    }
    this.sources = [];
  }

  async play(from?: number): Promise<void> {
    const project = this.project;
    if (!project) return;
    await this.init();
    const ctx = this.ctx!;
    this.stopSources();

    const start = from ?? this.position();
    this.startOffset = start;
    this.startedAt = ctx.currentTime + LOOKAHEAD;
    this.playing = true;

    this.scheduleClips(project, start, this.startedAt);
    if (project.loop.enabled && project.loop.end > project.loop.start) {
      this.scheduleLoopRepeats(project, start);
    }
    this.startClock();
    this.emit();
  }

  /**
   * Pre-schedule several loop passes.
   *
   * Web Audio has no native "loop this arrangement", so repeats are laid out
   * ahead of time and topped up by the clock tick.
   */
  private scheduleLoopRepeats(project: Project, from: number): void {
    const { start, end } = project.loop;
    const span = end - start;
    if (span <= 0) return;
    const firstPassEnd = this.startedAt + (end - from);
    for (let i = 1; i <= 4; i++) {
      this.scheduleClips(project, start, firstPassEnd + (i - 1) * span);
    }
  }

  pause(): void {
    if (!this.playing) return;
    const pos = this.position();
    this.stopSources();
    this.playing = false;
    this.startOffset = pos;
    this.stopClock();
    this.emit();
  }

  stop(): void {
    this.stopSources();
    this.playing = false;
    this.startOffset = 0;
    this.stopClock();
    this.emit();
  }

  seek(time: number): void {
    const wasPlaying = this.playing;
    this.stopSources();
    this.startOffset = Math.max(0, time);
    if (wasPlaying) void this.play(this.startOffset);
    else this.emit();
  }

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
    if (!on && this.metronomeTimer !== null) {
      clearInterval(this.metronomeTimer);
      this.metronomeTimer = null;
    }
    if (on && this.playing) this.startMetronome();
  }

  private startMetronome(): void {
    if (this.metronomeTimer !== null || !this.ctx) return;
    let nextBeat = Math.ceil(this.position() / (60 / (this.project?.bpm ?? 120)));
    this.metronomeTimer = window.setInterval(() => {
      const project = this.project;
      if (!project || !this.ctx || !this.playing) return;
      const beatDur = 60 / project.bpm;
      const horizon = this.position() + 0.25;
      while (nextBeat * beatDur < horizon) {
        const t = this.ctx.currentTime + (nextBeat * beatDur - this.position());
        if (t > this.ctx.currentTime) {
          this.click(t, nextBeat % project.meter === 0);
        }
        nextBeat++;
      }
    }, 100);
  }

  private click(at: number, accent: boolean): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.35 : 0.2, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.06);
  }

  private startClock(): void {
    if (this.metronomeOn) this.startMetronome();
    const tick = () => {
      this.emit();
      const project = this.project;
      if (project && !project.loop.enabled && this.position() > projectDuration(project) + 0.2) {
        this.stop();
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopClock(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.metronomeTimer !== null) {
      clearInterval(this.metronomeTimer);
      this.metronomeTimer = null;
    }
  }

  /** Peak level in [0,1] for a track, for the mixer meters. */
  trackLevel(trackId: string): number {
    const nodes = this.tracks.get(trackId);
    if (!nodes) return 0;
    return peakOf(nodes.analyser);
  }

  masterLevel(): number {
    return this.masterAnalyser ? peakOf(this.masterAnalyser) : 0;
  }

  dispose(): void {
    this.stop();
    for (const nodes of this.tracks.values()) nodes.chain.dispose();
    this.tracks.clear();
    this.masterChain?.dispose();
    void this.ctx?.close();
    this.ctx = null;
  }
}

const levelBuffer = new Float32Array(512);

function peakOf(analyser: AnalyserNode): number {
  const n = Math.min(levelBuffer.length, analyser.fftSize);
  analyser.getFloatTimeDomainData(asPcm(levelBuffer.subarray(0, n)));
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(levelBuffer[i]!);
    if (v > peak) peak = v;
  }
  return peak;
}

function automationParam(
  nodes: TrackNodes,
  target: AutomationLane['target'],
): AudioParam | null {
  switch (target) {
    case 'volume':
      return nodes.volume.gain;
    case 'pan':
      return nodes.panner.pan;
    case 'lowGain':
      return nodes.low.gain;
    case 'midGain':
      return nodes.mid.gain;
    case 'highGain':
      return nodes.high.gain;
    default: {
      for (const effect of nodes.chain.effects.values()) {
        const param = effect.automatable[target];
        if (param) return param;
      }
      return null;
    }
  }
}

function valueAt(points: { time: number; value: number }[], time: number): number {
  if (points.length === 0) return 0;
  if (time <= points[0]!.time) return points[0]!.value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (time <= b.time) {
      const t = (time - a.time) / Math.max(1e-6, b.time - a.time);
      return a.value + (b.value - a.value) * t;
    }
  }
  return points[points.length - 1]!.value;
}

/**
 * Clip gain envelope, including fades.
 *
 * Every clip gets a 3 ms ramp at both ends even when no fade is set — that is
 * what stops edits from clicking.
 */
function applyClipGain(
  gain: GainNode,
  clip: Clip,
  startAt: number,
  skip: number,
  playDuration: number,
): void {
  const MIN_RAMP = 0.003;
  const g = clip.gain;
  const fadeIn = Math.max(MIN_RAMP, clip.fadeIn - skip);
  const fadeOut = Math.max(MIN_RAMP, clip.fadeOut);
  const end = startAt + playDuration;

  gain.gain.cancelScheduledValues(startAt);
  if (skip < clip.fadeIn) {
    gain.gain.setValueAtTime(g * (skip / Math.max(1e-6, clip.fadeIn)), startAt);
    gain.gain.linearRampToValueAtTime(g, startAt + Math.min(fadeIn, playDuration));
  } else {
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(g, startAt + Math.min(MIN_RAMP, playDuration));
  }
  if (playDuration > fadeOut) {
    gain.gain.setValueAtTime(g, end - fadeOut);
    gain.gain.linearRampToValueAtTime(0, end);
  }
}

export function projectDuration(project: Project): number {
  let max = 0;
  for (const clip of project.clips) max = Math.max(max, clip.start + clip.duration);
  return max;
}

export const engine = new RemixEngine();

/**
 * Fingerprint of everything that changes the *shape* of the graph.
 *
 * Values (gains, params) are deliberately excluded so that turning a knob
 * updates in place instead of tearing down and rebuilding nodes.
 */
function graphKey(project: Project): string {
  const tracks = project.tracks
    .map((t) => `${t.id}:${t.effects.filter((e) => e.enabled).map((e) => `${e.id}/${e.type}`).join(',')}`)
    .join('|');
  return `${tracks}#${project.master.preset}#${project.bpm.toFixed(2)}`;
}
