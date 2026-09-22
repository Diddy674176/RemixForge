import type {
  AnalysisRequest,
  AnalysisResponse,
  AnalysisResult,
  SeparationWorkerRequest,
  SeparationWorkerResponse,
} from './protocol.ts';
import type { StemId } from '../separation/types.ts';

export interface JobProgress {
  value: number;
  stage: string;
}

let jobCounter = 0;
const nextId = () => `job-${++jobCounter}`;

/**
 * Copy a channel's samples into a fresh ArrayBuffer.
 *
 * Transferring detaches the buffer on this side, so audio that the UI still
 * needs (waveforms, playback) has to be copied rather than handed over.
 */
function copyChannels(channels: Float32Array[]): ArrayBuffer[] {
  return channels.map((c) => {
    const copy = new Float32Array(c.length);
    copy.set(c);
    return copy.buffer;
  });
}

export function analyseAudio(
  channels: Float32Array[],
  sampleRate: number,
  onProgress?: (p: JobProgress) => void,
): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    const id = nextId();

    worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.kind === 'progress') onProgress?.({ value: msg.value, stage: msg.stage });
      else if (msg.kind === 'done') {
        worker.terminate();
        resolve(msg.result);
      } else {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Analysis worker failed'));
    };

    const payload: AnalysisRequest = { id, channels: copyChannels(channels), sampleRate };
    worker.postMessage(payload, payload.channels);
  });
}

export interface SeparationJobResult {
  id: StemId;
  channels: Float32Array[];
}

export function separateAudio(
  channels: Float32Array[],
  sampleRate: number,
  targets: StemId[],
  engineId: string,
  backendUrl: string | undefined,
  onProgress?: (p: JobProgress) => void,
): { promise: Promise<SeparationJobResult[]>; cancel: () => void } {
  const worker = new Worker(new URL('./separation.worker.ts', import.meta.url), { type: 'module' });
  const id = nextId();
  let settled = false;

  const promise = new Promise<SeparationJobResult[]>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<SeparationWorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.kind === 'progress') {
        onProgress?.({ value: msg.value, stage: msg.stage });
      } else if (msg.kind === 'done') {
        settled = true;
        worker.terminate();
        resolve(msg.stems.map((s) => ({ id: s.id, channels: s.channels.map((c) => new Float32Array(c)) })));
      } else {
        settled = true;
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      settled = true;
      worker.terminate();
      reject(new Error(e.message || 'Separation worker failed'));
    };

    const payload: SeparationWorkerRequest = {
      id,
      channels: copyChannels(channels),
      sampleRate,
      targets,
      engineId,
      backendUrl,
    };
    worker.postMessage(payload, payload.channels);
  });

  return {
    promise,
    cancel: () => {
      if (!settled) worker.terminate();
    },
  };
}
