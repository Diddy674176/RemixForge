/**
 * Accuracy checks for the analysis stage.
 *
 * Synthesises material with a known tempo and key and asserts the detectors
 * recover it. These caught a real bug: chroma computed from the 2048-point
 * onset FFT cannot resolve semitones below ~500 Hz, and key detection was
 * wrong on 17 of 24 keys until it got its own high-resolution pass.
 *
 *   npm run verify:analysis
 */
import { computeFeatures } from '../src/audio/analysis/features.ts';
import { detectKey } from '../src/audio/analysis/key.ts';
import { detectBeatGrid, normaliseBpm } from '../src/audio/analysis/bpm.ts';
import { detectStructure } from '../src/audio/analysis/structure.ts';

const SR = 44100;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

let failures = 0;
function report(ok, name, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** A I–IV–V–I (or i–iv–v–i) progression in the requested key. */
function renderProgression(tonicPc, mode, seconds = 12) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const prog =
    mode === 'major'
      ? [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]]
      : [[0, 3, 7], [5, 8, 12], [7, 10, 14], [0, 3, 7]];
  const chordLen = Math.floor(n / prog.length);

  for (let c = 0; c < prog.length; c++) {
    for (const interval of prog[c]) {
      for (const octave of [-12, 0]) {
        const hz = midiHz(60 + tonicPc + interval + octave);
        for (let i = 0; i < chordLen; i++) {
          const t = i / SR;
          const env = Math.min(1, t * 20) * Math.exp(-t * 0.6);
          const idx = c * chordLen + i;
          if (idx < n) {
            x[idx] += (Math.sin(2 * Math.PI * hz * t) + 0.35 * Math.sin(4 * Math.PI * hz * t)) * env * 0.12;
          }
        }
      }
    }
  }
  return x;
}

/** Kick/snare/hat pattern at a known tempo. */
function renderBeat(bpm, seconds = 20) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beatIdx = Math.floor(t / beat);
    const inBeat = t - beatIdx * beat;
    if (beatIdx % 2 === 0) {
      x[i] += Math.sin(2 * Math.PI * 55 * inBeat * Math.exp(-inBeat * 18)) * Math.exp(-inBeat / 0.09) * 0.9;
    } else {
      x[i] += (Math.random() * 2 - 1) * Math.exp(-inBeat / 0.05) * 0.5;
    }
    const eighth = (t % (beat / 2));
    x[i] += (Math.random() * 2 - 1) * Math.exp(-eighth / 0.012) * 0.14;
  }
  return x;
}

// --- key over all 24 keys --------------------------------------------------
{
  let wrong = [];
  for (const mode of ['major', 'minor']) {
    for (let pc = 0; pc < 12; pc++) {
      const key = detectKey(computeFeatures(renderProgression(pc, mode), SR));
      if (key.tonic !== pc || key.mode !== mode) {
        wrong.push(`${NAMES[pc]} ${mode} → ${key.name}`);
      }
    }
  }
  report(wrong.length === 0, 'key detection over all 24 keys', wrong.join('; ') || '24/24');
}

// --- tempo -----------------------------------------------------------------
{
  const bad = [];
  for (const bpm of [90, 100, 120, 128, 140, 150, 174]) {
    const grid = detectBeatGrid(computeFeatures(renderBeat(bpm), SR));
    const detected = normaliseBpm(grid.bpm);
    // Accept octave-equivalent readings, as any tempo tracker may return them.
    const ratios = [1, 2, 0.5].map((r) => Math.abs(detected * r - bpm) / bpm);
    if (Math.min(...ratios) > 0.02) bad.push(`${bpm} → ${detected.toFixed(1)}`);
  }
  report(bad.length === 0, 'tempo detection across 90–174 BPM', bad.join('; ') || '7/7');
}

// --- beat grid -------------------------------------------------------------
{
  const features = computeFeatures(renderBeat(120, 20), SR);
  const grid = detectBeatGrid(features);
  const expected = Math.floor(20 / (60 / 120));
  const close = Math.abs(grid.beats.length - expected) <= 3;
  const spacing = [];
  for (let i = 1; i < grid.beats.length; i++) spacing.push(grid.beats[i] - grid.beats[i - 1]);
  const mean = spacing.reduce((a, b) => a + b, 0) / spacing.length;
  report(
    close && Math.abs(mean - 0.5) < 0.02 && grid.downbeats.length > 4,
    'beat grid at 120 BPM',
    `${grid.beats.length} beats (expected ~${expected}), mean interval ${mean.toFixed(3)}s, ${grid.downbeats.length} downbeats`,
  );
}

// --- structure -------------------------------------------------------------
{
  // Quiet 8 s, loud 16 s, quiet 8 s — the boundaries should be found.
  const seconds = 32;
  const beat = renderBeat(120, seconds);
  for (let i = 0; i < beat.length; i++) {
    const t = i / SR;
    beat[i] *= t < 8 || t > 24 ? 0.22 : 1;
  }
  const features = computeFeatures(beat, SR);
  const grid = detectBeatGrid(features);
  const sections = detectStructure(features, grid, seconds);
  report(
    sections.length >= 2 && sections.length <= 8,
    'structure finds section boundaries',
    `${sections.length} sections: ${sections.map((s) => s.label).join(', ')}`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll analysis checks passed');
process.exit(failures ? 1 : 0);
