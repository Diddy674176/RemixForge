import { buildPeaks, type PeakPyramid } from './peaks.ts';
import { asPcm } from '../lib/pcm.ts';
import type { AssetId } from '../state/types.ts';

export interface AudioAsset {
  id: AssetId;
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  peaks: PeakPyramid;
}

/**
 * Decoded audio lives here, keyed by id, and never inside the project object.
 *
 * The project only ever refers to assets by id, which is what makes editing
 * non-destructive: an edit rewrites clip instructions, never samples.
 */
class AudioAssetStore {
  private assets = new Map<AssetId, AudioAsset>();
  private counter = 0;
  private listeners = new Set<() => void>();

  add(channels: Float32Array[], sampleRate: number, id?: AssetId): AudioAsset {
    const assetId = id ?? `asset-${++this.counter}-${Date.now().toString(36)}`;
    const asset: AudioAsset = {
      id: assetId,
      channels,
      sampleRate,
      duration: (channels[0]?.length ?? 0) / sampleRate,
      peaks: buildPeaks(channels, sampleRate),
    };
    this.assets.set(assetId, asset);
    this.emit();
    return asset;
  }

  get(id: AssetId | undefined): AudioAsset | undefined {
    return id ? this.assets.get(id) : undefined;
  }

  has(id: AssetId): boolean {
    return this.assets.has(id);
  }

  delete(id: AssetId): void {
    if (this.assets.delete(id)) this.emit();
  }

  /** Total decoded audio held in memory, in bytes. */
  bytes(): number {
    let total = 0;
    for (const a of this.assets.values()) {
      for (const c of a.channels) total += c.byteLength;
    }
    return total;
  }

  ids(): AssetId[] {
    return [...this.assets.keys()];
  }

  /** Drop every asset not referenced by `keep`. */
  prune(keep: Set<AssetId>): void {
    let changed = false;
    for (const id of this.assets.keys()) {
      if (!keep.has(id)) {
        this.assets.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const audioAssets = new AudioAssetStore();

/** Wrap an asset's channels in an AudioBuffer for playback or offline render. */
export function toAudioBuffer(ctx: BaseAudioContext, asset: AudioAsset): AudioBuffer {
  const buffer = ctx.createBuffer(
    asset.channels.length,
    asset.channels[0]?.length ?? 1,
    asset.sampleRate,
  );
  for (let c = 0; c < asset.channels.length; c++) buffer.copyToChannel(asPcm(asset.channels[c]!), c);
  return buffer;
}
