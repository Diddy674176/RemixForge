import { useEffect, useRef } from 'react';
import { audioAssets } from '../../audio/assets.ts';
import { levelFor } from '../../audio/peaks.ts';

interface WaveformProps {
  assetId: string;
  /** Seconds into the asset where drawing starts. */
  offset: number;
  /** Seconds of source material to draw. */
  duration: number;
  /** Pixels per second of *source* time. */
  pxPerSecond: number;
  height: number;
  hue: number;
  className?: string;
}

/**
 * Canvas waveform backed by the multi-resolution peak pyramid.
 *
 * Drawing cost is proportional to the canvas width rather than the audio
 * length, which is what keeps long projects smooth while zooming.
 */
export function Waveform({
  assetId,
  offset,
  duration,
  pxPerSecond,
  height,
  hue,
  className,
}: WaveformProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = Math.max(1, Math.round(duration * pxPerSecond));

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const asset = audioAssets.get(assetId);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (!asset) {
      ctx.fillStyle = `hsl(${hue} 20% 40% / 0.5)`;
      ctx.fillRect(0, height / 2 - 0.5, width, 1);
      return;
    }

    const samplesPerPixel = (asset.sampleRate * duration) / Math.max(1, width);
    const level = levelFor(asset.peaks, samplesPerPixel);
    const startBucket = (offset * asset.sampleRate) / level.samplesPerBucket;
    const bucketsPerPixel = samplesPerPixel / level.samplesPerBucket;

    const mid = height / 2;
    const scale = mid - 1;

    // RMS body first, then the peak outline over it.
    ctx.fillStyle = `hsl(${hue} 65% 58% / 0.32)`;
    for (let x = 0; x < width; x++) {
      const from = Math.floor(startBucket + x * bucketsPerPixel);
      const to = Math.max(from + 1, Math.floor(startBucket + (x + 1) * bucketsPerPixel));
      let rms = 0;
      let n = 0;
      for (let b = from; b < to && b < level.buckets; b++) {
        if (b < 0) continue;
        rms += level.rms[b]!;
        n++;
      }
      if (!n) continue;
      const h = Math.min(scale, (rms / n) * scale * 1.6);
      ctx.fillRect(x, mid - h, 1, h * 2);
    }

    ctx.fillStyle = `hsl(${hue} 80% 72% / 0.9)`;
    for (let x = 0; x < width; x++) {
      const from = Math.floor(startBucket + x * bucketsPerPixel);
      const to = Math.max(from + 1, Math.floor(startBucket + (x + 1) * bucketsPerPixel));
      let lo = 0;
      let hi = 0;
      let seen = false;
      for (let b = from; b < to && b < level.buckets; b++) {
        if (b < 0) continue;
        lo = Math.min(lo, level.min[b]!);
        hi = Math.max(hi, level.max[b]!);
        seen = true;
      }
      if (!seen) continue;
      const top = mid - Math.min(scale, hi * scale);
      const bottom = mid - Math.max(-scale, lo * scale);
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [assetId, offset, duration, pxPerSecond, height, hue, width]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width, height, display: 'block' }}
      aria-hidden
    />
  );
}
