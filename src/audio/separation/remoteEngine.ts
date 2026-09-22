import { encodeWav, decodeWav } from '../dsp/wav.ts';
import {
  STEM_META,
  type SeparatedStem,
  type SeparationEngine,
  type SeparationProgress,
  type SeparationRequest,
  type StemId,
} from './types.ts';

/**
 * Talks to a self-hosted separation service.
 *
 * The contract is deliberately tiny so any model can sit behind it — the
 * reference implementation in `docs/model-backend.md` wraps Demucs in ~40
 * lines of Python.
 *
 *   GET  {baseUrl}/health   -> 200 { "stems": ["lead-vocals", "drums", ...] }
 *   POST {baseUrl}/separate
 *        multipart/form-data: audio=<wav>, targets=<comma-separated stem ids>
 *        -> 200 multipart or JSON { "stems": { "<id>": "<base64 wav>" } }
 *
 * Nothing about the app assumes this exists; it is an optional quality
 * upgrade, and the UI falls back to the built-in engine when it is absent.
 */
export class RemoteModelEngine implements SeparationEngine {
  readonly id = 'remote-model';
  readonly name = 'Model backend';
  readonly description =
    'Sends audio to a separation service you run yourself (e.g. Demucs). Much better vocal isolation and instrument-level stems. Audio leaves the browser, so only point this at a server you control.';

  supports: StemId[] = [];

  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
    this.supports = [];
  }

  async available(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { stems?: string[] };
      const stems = (body.stems ?? []).filter((s): s is StemId => s in STEM_META);
      this.supports = stems;
      return stems.length > 0;
    } catch {
      return false;
    }
  }

  async separate(
    request: SeparationRequest,
    onProgress?: (p: SeparationProgress) => void,
  ): Promise<SeparatedStem[]> {
    onProgress?.({ value: 0.05, stage: 'Encoding audio' });
    const wav = encodeWav(request.channels, request.sampleRate, 24);

    const form = new FormData();
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'input.wav');
    form.append('targets', request.targets.join(','));

    onProgress?.({ value: 0.15, stage: 'Uploading to model backend' });
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/separate`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Model backend returned ${res.status}: ${await res.text().catch(() => '')}`);
    }

    onProgress?.({ value: 0.75, stage: 'Decoding stems' });
    const body = (await res.json()) as { stems?: Record<string, string> };
    const stems: SeparatedStem[] = [];
    for (const [id, b64] of Object.entries(body.stems ?? {})) {
      if (!(id in STEM_META)) continue;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const decoded = decodeWav(bytes.buffer as ArrayBuffer);
      stems.push({ id: id as StemId, channels: decoded.channels });
    }
    onProgress?.({ value: 1, stage: 'Done' });
    return stems;
  }
}
