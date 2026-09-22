import { encodeWav, type BitDepth } from './dsp/wav.ts';
import { encodeFlac, type FlacBitDepth } from './dsp/flac.ts';
import { renderProject, type RenderResult } from './render.ts';
import { STEM_META } from './separation/types.ts';
import type { Project } from '../state/types.ts';

export type ExportFormat = 'wav' | 'flac' | 'mp3';

export interface ExportQuality {
  /** WAV/FLAC bit depth. */
  bitDepth: 16 | 24 | 32;
  /** MP3 bitrate in kbps. */
  mp3Bitrate: number;
  sampleRate: number;
}

export const DEFAULT_QUALITY: ExportQuality = { bitDepth: 24, mp3Bitrate: 320, sampleRate: 48000 };

export const FORMAT_INFO: Record<ExportFormat, { label: string; lossless: boolean; note: string }> = {
  wav: { label: 'WAV', lossless: true, note: 'Uncompressed. 32-bit keeps the mix bit-exact.' },
  flac: { label: 'FLAC', lossless: true, note: 'Lossless and compressed. 16 or 24-bit.' },
  mp3: { label: 'MP3', lossless: false, note: 'Lossy but universally playable.' },
};

function floatToInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i]!));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** Loaded on demand — the MP3 encoder is large and most exports are lossless. */
async function encodeMp3(
  channels: Float32Array[],
  sampleRate: number,
  bitrate: number,
): Promise<ArrayBuffer> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const numCh = Math.min(2, channels.length);
  const encoder = new Mp3Encoder(numCh, sampleRate, bitrate);
  const left = floatToInt16(channels[0]!);
  const right = numCh > 1 ? floatToInt16(channels[1]!) : null;

  const blockSize = 1152;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += blockSize) {
    const l = left.subarray(i, i + blockSize);
    const r = right ? right.subarray(i, i + blockSize) : undefined;
    const buf = r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (buf.length > 0) chunks.push(new Uint8Array(buf));
  }
  const last = encoder.flush();
  if (last.length > 0) chunks.push(new Uint8Array(last));

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out.buffer;
}

export async function encodeAudio(
  result: RenderResult,
  format: ExportFormat,
  quality: ExportQuality,
): Promise<{ data: ArrayBuffer; mime: string; extension: string }> {
  switch (format) {
    case 'flac':
      return {
        data: encodeFlac(
          result.channels,
          result.sampleRate,
          (quality.bitDepth === 32 ? 24 : quality.bitDepth) as FlacBitDepth,
        ),
        mime: 'audio/flac',
        extension: 'flac',
      };
    case 'mp3':
      return {
        data: await encodeMp3(result.channels, result.sampleRate, quality.mp3Bitrate),
        mime: 'audio/mpeg',
        extension: 'mp3',
      };
    case 'wav':
    default:
      return {
        data: encodeWav(result.channels, result.sampleRate, quality.bitDepth as BitDepth),
        mime: 'audio/wav',
        extension: 'wav',
      };
  }
}

function safeName(name: string): string {
  return name.replace(/[^\w\-. ]+/g, '_').trim() || 'remixforge';
}

export function downloadBlob(data: ArrayBuffer, mime: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a moment to start before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface ExportProgress {
  value: number;
  stage: string;
}

/** Render and download the full mix. */
export async function exportMix(
  project: Project,
  format: ExportFormat,
  quality: ExportQuality,
  onProgress?: (p: ExportProgress) => void,
): Promise<void> {
  const rendered = await renderProject(project, {
    sampleRate: quality.sampleRate,
    applyMaster: true,
    onProgress: (p) => onProgress?.({ value: p.value * 0.8, stage: p.stage }),
  });
  onProgress?.({ value: 0.85, stage: `Encoding ${FORMAT_INFO[format].label}` });
  const { data, mime, extension } = await encodeAudio(rendered, format, quality);
  downloadBlob(data, mime, `${safeName(project.name)}.${extension}`);
  onProgress?.({ value: 1, stage: 'Done' });
}

/**
 * Render and download one file per track.
 *
 * Stems are rendered without the master chain so they can be re-imported or
 * taken into another DAW and summed back to the same mix.
 */
export async function exportStems(
  project: Project,
  format: ExportFormat,
  quality: ExportQuality,
  onProgress?: (p: ExportProgress) => void,
): Promise<number> {
  const tracks = project.tracks.filter((t) => project.clips.some((c) => c.trackId === t.id));
  let done = 0;

  for (const track of tracks) {
    onProgress?.({ value: done / tracks.length, stage: `Rendering ${track.name}` });
    const rendered = await renderProject(project, {
      trackIds: [track.id],
      applyMaster: false,
      sampleRate: quality.sampleRate,
    });
    const { data, mime, extension } = await encodeAudio(rendered, format, quality);
    const stemLabel = track.stem && track.stem !== 'full' ? STEM_META[track.stem].label : track.name;
    downloadBlob(
      data,
      mime,
      `${safeName(project.name)} - ${safeName(stemLabel)}.${extension}`,
    );
    done++;
  }

  onProgress?.({ value: 1, stage: 'Done' });
  return done;
}

/** Download a single separated stem straight from the source panel. */
export async function exportStemAsset(
  channels: Float32Array[],
  sampleRate: number,
  name: string,
  format: ExportFormat,
  quality: ExportQuality,
): Promise<void> {
  const { data, mime, extension } = await encodeAudio(
    { channels, sampleRate, duration: (channels[0]?.length ?? 0) / sampleRate },
    format,
    quality,
  );
  downloadBlob(data, mime, `${safeName(name)}.${extension}`);
}
