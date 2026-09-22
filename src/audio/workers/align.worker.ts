/// <reference lib="webworker" />
import { smartVocalAlign, type AlignPlan } from '../dsp/vocalAlign.ts';

export interface AlignRequest {
  id: string;
  channels: ArrayBuffer[];
  sampleRate: number;
  /** Target grid positions, in the same time base as the audio. */
  beats: number[];
  divisions: number;
  tolerance: number;
}

export type AlignResponse =
  | { kind: 'done'; id: string; channels: ArrayBuffer[]; plan: AlignPlan }
  | { kind: 'error'; id: string; message: string };

self.onmessage = (event: MessageEvent<AlignRequest>) => {
  const { id, channels, sampleRate, beats, divisions, tolerance } = event.data;
  const post = (msg: AlignResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

  try {
    const result = smartVocalAlign(
      channels.map((c) => new Float32Array(c)),
      sampleRate,
      beats,
      { divisions, tolerance },
    );
    const transfer: Transferable[] = [];
    const out = result.channels.map((c) => {
      transfer.push(c.buffer as ArrayBuffer);
      return c.buffer as ArrayBuffer;
    });
    post({ kind: 'done', id, channels: out, plan: result.plan }, transfer);
  } catch (err) {
    post({ kind: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
