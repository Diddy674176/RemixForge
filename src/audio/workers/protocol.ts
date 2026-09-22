import type { StemId } from '../separation/types.ts';
import type { KeyEstimate, Chord } from '../analysis/key.ts';
import type { Section } from '../analysis/structure.ts';
import type { TempoSection } from '../analysis/bpm.ts';

export interface AnalysisResult {
  duration: number;
  /** Tempo as detected. */
  bpm: number;
  /** Same tempo folded into the 70–140 range for display. */
  displayBpm: number;
  bpmConfidence: number;
  meter: number;
  beats: number[];
  downbeats: number[];
  tempoSections: TempoSection[];
  key: KeyEstimate;
  chords: Chord[];
  sections: Section[];
}

export interface AnalysisRequest {
  id: string;
  channels: ArrayBuffer[];
  sampleRate: number;
}

export type AnalysisResponse =
  | { kind: 'progress'; id: string; value: number; stage: string }
  | { kind: 'done'; id: string; result: AnalysisResult }
  | { kind: 'error'; id: string; message: string };

export interface SeparationWorkerRequest {
  id: string;
  channels: ArrayBuffer[];
  sampleRate: number;
  targets: StemId[];
  engineId: string;
  backendUrl?: string;
}

export type SeparationWorkerResponse =
  | { kind: 'progress'; id: string; value: number; stage: string }
  | { kind: 'done'; id: string; stems: { id: StemId; channels: ArrayBuffer[] }[] }
  | { kind: 'error'; id: string; message: string };
