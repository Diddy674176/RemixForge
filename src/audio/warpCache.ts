import { audioAssets, type AudioAsset } from './assets.ts';
import type { WarpRequest, WarpResponse } from './workers/warp.worker.ts';
import type { AssetId } from '../state/types.ts';

interface Entry {
  asset: AudioAsset | null;
  pending: boolean;
}

const EPSILON = 1e-4;

function keyOf(assetId: AssetId, stretch: number, pitch: number, reverse: boolean): string {
  return `${assetId}|${stretch.toFixed(5)}|${pitch.toFixed(3)}|${reverse ? 'r' : 'f'}`;
}

/** True when the clip plays its source untouched. */
function isIdentity(stretch: number, pitch: number, reverse: boolean): boolean {
  return Math.abs(stretch - 1) < EPSILON && Math.abs(pitch) < EPSILON && !reverse;
}

/**
 * Renders and caches time-stretched / pitch-shifted copies of assets.
 *
 * Playback asks for a warped asset every time it schedules a clip. If one
 * isn't ready the engine falls back to varispeed so the edit is audible at
 * once, and a background render replaces it a moment later — which is how the
 * app stays responsive without giving up phase-vocoder quality.
 */
class WarpCache {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private counter = 0;

  /** Non-blocking lookup. Returns null when the original asset should be used. */
  getSync(assetId: AssetId, stretch: number, pitch: number, reverse: boolean): AudioAsset | null {
    if (isIdentity(stretch, pitch, reverse)) return null;
    const key = keyOf(assetId, stretch, pitch, reverse);
    const entry = this.entries.get(key);
    if (entry?.asset) return entry.asset;
    if (!entry) void this.request(assetId, stretch, pitch, reverse);
    return null;
  }

  isPending(assetId: AssetId, stretch: number, pitch: number, reverse: boolean): boolean {
    if (isIdentity(stretch, pitch, reverse)) return false;
    return this.entries.get(keyOf(assetId, stretch, pitch, reverse))?.pending ?? false;
  }

  /** Render (or await) a warped copy. */
  async request(
    assetId: AssetId,
    stretch: number,
    pitch: number,
    reverse: boolean,
  ): Promise<AudioAsset | null> {
    if (isIdentity(stretch, pitch, reverse)) return null;
    const key = keyOf(assetId, stretch, pitch, reverse);
    const existing = this.entries.get(key);
    if (existing?.asset) return existing.asset;
    if (existing?.pending) return null;

    const source = audioAssets.get(assetId);
    if (!source) return null;

    this.entries.set(key, { asset: null, pending: true });
    this.emit();

    try {
      const channels = await renderWarp(source.channels, stretch, pitch, reverse);
      const asset = audioAssets.add(channels, source.sampleRate, `${key}#warp`);
      this.entries.set(key, { asset, pending: false });
      this.emit();
      return asset;
    } catch {
      this.entries.set(key, { asset: null, pending: false });
      this.emit();
      return null;
    }
  }

  /** Drop cached renders for an asset — used when its clip settings change. */
  invalidate(assetId: AssetId): void {
    // Deleting from a Map during iteration is well defined, so no copy needed.
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${assetId}|`)) {
        const entry = this.entries.get(key);
        if (entry?.asset) audioAssets.delete(entry.asset.id);
        this.entries.delete(key);
      }
    }
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  nextId(): string {
    return `warp-${++this.counter}`;
  }
}

function renderWarp(
  channels: Float32Array[],
  stretch: number,
  semitones: number,
  reverse: boolean,
): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workers/warp.worker.ts', import.meta.url), {
      type: 'module',
    });
    const id = warpCache.nextId();
    worker.onmessage = (e: MessageEvent<WarpResponse>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      worker.terminate();
      if (msg.kind === 'done') resolve(msg.channels.map((c) => new Float32Array(c)));
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Warp worker failed'));
    };

    const copies = channels.map((c) => {
      const copy = new Float32Array(c.length);
      copy.set(c);
      return copy.buffer;
    });
    const payload: WarpRequest = { id, channels: copies, stretch, semitones, reverse };
    worker.postMessage(payload, copies);
  });
}

export const warpCache = new WarpCache();
