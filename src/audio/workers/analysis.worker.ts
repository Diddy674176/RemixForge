/// <reference lib="webworker" />
import { computeFeatures, toMono } from '../analysis/features.ts';
import { detectBeatGrid, normaliseBpm } from '../analysis/bpm.ts';
import { detectKey, detectChords } from '../analysis/key.ts';
import { detectStructure } from '../analysis/structure.ts';
import type { AnalysisRequest, AnalysisResponse } from './protocol.ts';

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const { id, channels, sampleRate } = event.data;
  const post = (msg: AnalysisResponse) => (self as unknown as Worker).postMessage(msg);

  try {
    post({ kind: 'progress', id, value: 0.05, stage: 'Reading audio' });
    const mono = toMono(channels.map((c) => new Float32Array(c)));
    const duration = mono.length / sampleRate;

    post({ kind: 'progress', id, value: 0.2, stage: 'Spectral analysis' });
    const features = computeFeatures(mono, sampleRate);

    post({ kind: 'progress', id, value: 0.5, stage: 'Detecting tempo and beats' });
    const grid = detectBeatGrid(features);

    post({ kind: 'progress', id, value: 0.7, stage: 'Detecting key' });
    const key = detectKey(features);
    const barGrid = grid.downbeats.length > 2 ? grid.downbeats : grid.beats;
    const chords = detectChords(features, barGrid.length > 2 ? barGrid : [0, duration]);

    post({ kind: 'progress', id, value: 0.85, stage: 'Detecting song structure' });
    const sections = detectStructure(features, grid, duration);

    post({
      kind: 'done',
      id,
      result: {
        duration,
        bpm: grid.bpm,
        displayBpm: normaliseBpm(grid.bpm),
        bpmConfidence: grid.confidence,
        meter: grid.meter,
        beats: grid.beats,
        downbeats: grid.downbeats,
        tempoSections: grid.sections,
        key,
        chords,
        sections,
      },
    });
  } catch (err) {
    post({ kind: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
