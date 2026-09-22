import { decodeWav } from './dsp/wav.ts';
import { decodeAiff } from './dsp/aiff.ts';
import { resampleTo } from './dsp/resample.ts';
import { audioAssets, type AudioAsset } from './assets.ts';

export const SUPPORTED_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.flac',
  '.aac',
  '.m4a',
  '.ogg',
  '.oga',
  '.opus',
  '.aif',
  '.aiff',
  '.aifc',
  '.webm',
] as const;

export const ACCEPT_ATTRIBUTE = `audio/*,${SUPPORTED_EXTENSIONS.join(',')}`;

export interface ImportedAudio {
  asset: AudioAsset;
  fileName: string;
  name: string;
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

export function isSupportedFile(file: File): boolean {
  const ext = extensionOf(file.name);
  return (
    (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext) || file.type.startsWith('audio/')
  );
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/**
 * Decode a file to float samples at the project's working rate.
 *
 * `decodeAudioData` handles whatever the browser supports (MP3, AAC/M4A, OGG,
 * FLAC and WAV in current browsers). AIFF and any WAV the browser rejects fall
 * through to the in-repo decoders, so the supported-format list is real rather
 * than aspirational.
 */
export async function importAudioFile(file: File, targetSampleRate: number): Promise<ImportedAudio> {
  const buffer = await file.arrayBuffer();
  const ext = extensionOf(file.name);

  let channels: Float32Array[] | null = null;
  let sampleRate = targetSampleRate;

  if (ext === '.aif' || ext === '.aiff' || ext === '.aifc') {
    const decoded = decodeAiff(buffer);
    channels = decoded.channels;
    sampleRate = decoded.sampleRate;
  } else {
    try {
      // A fresh context per decode, because `decodeAudioData` detaches the
      // buffer and a shared context would keep the decoded copy alive.
      const ctx = new OfflineAudioContext(1, 1, targetSampleRate);
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
      channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, c) =>
        audioBuffer.getChannelData(c).slice(),
      );
      sampleRate = audioBuffer.sampleRate;
    } catch (err) {
      try {
        const decoded = decodeWav(buffer);
        channels = decoded.channels;
        sampleRate = decoded.sampleRate;
      } catch {
        throw new Error(
          `Could not decode ${file.name}. ${err instanceof Error ? err.message : ''}`.trim(),
        );
      }
    }
  }

  if (!channels || channels.length === 0 || channels[0]!.length === 0) {
    throw new Error(`${file.name} contains no audio`);
  }

  if (sampleRate !== targetSampleRate) {
    channels = channels.map((c) => resampleTo(c, sampleRate, targetSampleRate));
    sampleRate = targetSampleRate;
  }

  const asset = audioAssets.add(channels, sampleRate);
  return { asset, fileName: file.name, name: stripExtension(file.name) };
}

/** Pull audio files out of a drag-and-drop payload, including dropped folders. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);

  if (entries.length === 0) {
    return Array.from(dt.files).filter(isSupportedFile);
  }

  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      );
      if (file && isSupportedFile(file)) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([])),
      );
      for (const child of children) await walk(child);
    }
  };

  for (const entry of entries) await walk(entry);
  return out;
}
