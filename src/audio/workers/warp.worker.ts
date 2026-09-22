/// <reference lib="webworker" />
import { warp } from '../dsp/timestretch.ts';

export interface WarpRequest {
  id: string;
  channels: ArrayBuffer[];
  /** Timeline duration / source duration. */
  stretch: number;
  semitones: number;
  reverse: boolean;
}

export type WarpResponse =
  | { kind: 'done'; id: string; channels: ArrayBuffer[] }
  | { kind: 'error'; id: string; message: string };

self.onmessage = (event: MessageEvent<WarpRequest>) => {
  const { id, channels, stretch, semitones, reverse } = event.data;
  const post = (msg: WarpResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

  try {
    const transfer: Transferable[] = [];
    const out = channels.map((buf) => {
      let data = new Float32Array(buf);
      if (reverse) {
        const rev = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) rev[i] = data[data.length - 1 - i]!;
        data = rev;
      }
      const warped = warp(data, stretch, semitones);
      transfer.push(warped.buffer as ArrayBuffer);
      return warped.buffer as ArrayBuffer;
    });
    post({ kind: 'done', id, channels: out }, transfer);
  } catch (err) {
    post({ kind: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
