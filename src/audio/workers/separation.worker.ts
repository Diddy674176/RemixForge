/// <reference lib="webworker" />
import { DspSeparationEngine } from '../separation/dspEngine.ts';
import { RemoteModelEngine } from '../separation/remoteEngine.ts';
import type { SeparationWorkerRequest, SeparationWorkerResponse } from './protocol.ts';

self.onmessage = async (event: MessageEvent<SeparationWorkerRequest>) => {
  const { id, channels, sampleRate, targets, engineId, backendUrl } = event.data;
  const post = (msg: SeparationWorkerResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

  try {
    const engine =
      engineId === 'remote-model' && backendUrl
        ? new RemoteModelEngine(backendUrl)
        : new DspSeparationEngine();

    const stems = await engine.separate(
      { channels: channels.map((c) => new Float32Array(c)), sampleRate, targets },
      (p) => post({ kind: 'progress', id, value: p.value, stage: p.stage }),
    );

    const transfer: Transferable[] = [];
    const payload = stems.map((s) => {
      const chans = s.channels.map((c) => {
        const buf = c.buffer as ArrayBuffer;
        transfer.push(buf);
        return buf;
      });
      return { id: s.id, channels: chans };
    });
    post({ kind: 'done', id, stems: payload }, transfer);
  } catch (err) {
    post({ kind: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
