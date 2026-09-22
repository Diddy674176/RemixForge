import { audioAssets, toAudioBuffer } from './assets.ts';
import { buildChain } from './effects/rack.ts';
import { ensureWorklets } from './effects/worklets.ts';
import { masterChainFor } from './effects/mastering.ts';
import { warpCache } from './warpCache.ts';
import { projectDuration } from './engine.ts';
import type { Clip, Project, Track } from '../state/types.ts';

export interface RenderOptions {
  /** Restrict the render to these tracks — how stem export works. */
  trackIds?: string[];
  /** Apply the master chain and limiter. Off for stem exports. */
  applyMaster?: boolean;
  sampleRate?: number;
  /** Extra silence appended so reverb and delay tails aren't chopped. */
  tailSeconds?: number;
  onProgress?: (p: { value: number; stage: string }) => void;
}

export interface RenderResult {
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
}

/** Ensure every quality-warped asset a render needs actually exists. */
async function prepareWarps(
  clips: Clip[],
  onProgress?: RenderOptions['onProgress'],
): Promise<void> {
  const needed = clips.filter((c) => c.stretch !== 1 || c.pitch !== 0 || c.reverse);
  if (needed.length === 0) return;
  let done = 0;
  for (const clip of needed) {
    await warpCache.request(clip.assetId, clip.stretch, clip.pitch, clip.reverse);
    done++;
    onProgress?.({
      value: (done / needed.length) * 0.4,
      stage: `Rendering time-stretch ${done} of ${needed.length}`,
    });
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
 * Render the project to samples with an OfflineAudioContext.
 *
 * Uses the same effect builders as live playback, so what is exported is what
 * was heard — including the quality time-stretch, which is rendered up front
 * rather than approximated with varispeed.
 */
export async function renderProject(
  project: Project,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const sampleRate = opts.sampleRate ?? 48000;
  const tail = opts.tailSeconds ?? 2;
  const applyMaster = opts.applyMaster ?? true;

  const trackFilter = opts.trackIds ? new Set(opts.trackIds) : null;
  const tracks = project.tracks.filter((t) => !trackFilter || trackFilter.has(t.id));
  const trackIds = new Set(tracks.map((t) => t.id));
  const clips = project.clips.filter((c) => trackIds.has(c.trackId));

  await prepareWarps(clips, opts.onProgress);

  const duration = Math.max(0.1, projectDuration({ ...project, clips }) + tail);
  const frames = Math.ceil(duration * sampleRate);
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  await ensureWorklets(ctx);

  opts.onProgress?.({ value: 0.45, stage: 'Building the mix graph' });

  const effectCtx = { bpm: project.bpm };
  const masterIn = ctx.createGain();
  masterIn.gain.value = applyMaster ? project.master.volume : 1;

  if (applyMaster) {
    const chain = buildChain(ctx, masterChainFor(project.master), effectCtx);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = project.master.ceiling;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    masterIn.connect(chain.input);
    chain.output.connect(limiter).connect(ctx.destination);
  } else {
    masterIn.connect(ctx.destination);
  }

  const anySolo = tracks.some((t) => t.solo);
  const trackInputs = new Map<string, GainNode>();

  for (const track of tracks) {
    const input = ctx.createGain();
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 180;
    low.gain.value = track.lowGain;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1400;
    mid.Q.value = 0.9;
    mid.gain.value = track.midGain;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 5200;
    high.gain.value = track.highGain;

    const chain = buildChain(ctx, track.effects, effectCtx);
    const volume = ctx.createGain();
    const audible = track.mute ? 0 : anySolo && !track.solo ? 0 : 1;
    volume.gain.value = track.volume * audible;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, track.pan));

    input.connect(low).connect(mid).connect(high).connect(chain.input);
    chain.output.connect(volume).connect(panner).connect(masterIn);

    trackInputs.set(track.id, input);
    applyTrackAutomation(track, { volume, panner, low, mid, high }, chain);
  }

  for (const clip of clips) {
    const input = trackInputs.get(clip.trackId);
    if (!input) continue;
    const warped = warpCache.getSync(clip.assetId, clip.stretch, clip.pitch, clip.reverse);
    const asset = warped ?? audioAssets.get(clip.assetId);
    if (!asset) continue;

    const node = ctx.createBufferSource();
    node.buffer = toAudioBuffer(ctx, asset);
    if (!warped && (clip.stretch !== 1 || clip.pitch !== 0)) {
      node.playbackRate.value = (1 / clip.stretch) * Math.pow(2, clip.pitch / 12);
    }
    const rate = node.playbackRate.value;

    const gain = ctx.createGain();
    node.connect(gain).connect(input);

    const start = clip.start;
    const end = clip.start + clip.duration;
    const fadeIn = Math.max(0.003, clip.fadeIn);
    const fadeOut = Math.max(0.003, clip.fadeOut);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(clip.gain, start + Math.min(fadeIn, clip.duration / 2));
    if (clip.duration > fadeOut) {
      gain.gain.setValueAtTime(clip.gain, end - fadeOut);
    }
    gain.gain.linearRampToValueAtTime(0, end);

    node.start(start, clip.offset, clip.duration * rate);
  }

  opts.onProgress?.({ value: 0.55, stage: 'Rendering audio' });
  const rendered = await ctx.startRendering();
  opts.onProgress?.({ value: 1, stage: 'Done' });

  return {
    channels: Array.from({ length: rendered.numberOfChannels }, (_, c) =>
      rendered.getChannelData(c).slice(),
    ),
    sampleRate,
    duration: rendered.duration,
  };
}

function applyTrackAutomation(
  track: Track,
  nodes: {
    volume: GainNode;
    panner: StereoPannerNode;
    low: BiquadFilterNode;
    mid: BiquadFilterNode;
    high: BiquadFilterNode;
  },
  chain: ReturnType<typeof buildChain>,
): void {
  for (const lane of track.automation) {
    if (!lane.enabled || lane.points.length === 0) continue;
    let param: AudioParam | null = null;
    switch (lane.target) {
      case 'volume':
        param = nodes.volume.gain;
        break;
      case 'pan':
        param = nodes.panner.pan;
        break;
      case 'lowGain':
        param = nodes.low.gain;
        break;
      case 'midGain':
        param = nodes.mid.gain;
        break;
      case 'highGain':
        param = nodes.high.gain;
        break;
      default:
        for (const effect of chain.effects.values()) {
          const p = effect.automatable[lane.target];
          if (p) {
            param = p;
            break;
          }
        }
    }
    if (!param) continue;
    const points = [...lane.points].sort((a, b) => a.time - b.time);
    param.setValueAtTime(valueAt(points, 0), 0);
    for (const p of points) param.linearRampToValueAtTime(p.value, Math.max(0, p.time));
  }
}
