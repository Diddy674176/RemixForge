/**
 * Smart Vocal Align checks.
 *
 * Renders syllable-like bursts deliberately off the beat, aligns them, then
 * re-detects onsets in the rendered audio and measures how close they land to
 * the grid. End-to-end rather than checking the plan against itself.
 *
 *   npm run verify:align
 */
import { smartVocalAlign, detectOnsets } from '../src/audio/dsp/vocalAlign.ts';

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM;
const SECONDS = 8;

let failures = 0;
function report(ok, name, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** A syllable: noisy attack into a pitched vowel. */
function render(times) {
  const n = Math.round(SECONDS * SR);
  const x = new Float32Array(n);
  for (const t0 of times) {
    const start = Math.round(t0 * SR);
    const len = Math.round(0.18 * SR);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 0.006) * Math.exp(-t / 0.09);
      const vowel =
        Math.sin(2 * Math.PI * 220 * t) * 0.6 +
        Math.sin(2 * Math.PI * 440 * t) * 0.3 +
        Math.sin(2 * Math.PI * 880 * t) * 0.12;
      const attack = (Math.random() * 2 - 1) * Math.exp(-t / 0.008) * 0.5;
      x[start + i] += (vowel + attack) * env * 0.5;
    }
  }
  return x;
}

const beats = [];
for (let t = 0; t < SECONDS; t += BEAT) beats.push(t);

const ideal = [];
for (let i = 0; i < 12; i++) ideal.push(0.5 + i * (BEAT / 2));

/**
 * Mean distance from each intended syllable to the nearest detected onset.
 *
 * Matching to the intended positions rather than averaging over every
 * detection keeps the measurement honest: onset detection also fires inside
 * sustained vowels, and those extra peaks would otherwise dominate.
 */
function meanErrorMs(detected, intended) {
  let sum = 0;
  for (const want of intended) {
    let best = Infinity;
    for (const got of detected) best = Math.min(best, Math.abs(got - want));
    sum += best;
  }
  return (sum / intended.length) * 1000;
}

// --- syllables off the grid, within the tolerance the aligner will act on ---
{
  const offsets = [0.034, -0.028, 0.039, -0.022, 0.036, -0.031, 0.026, 0.041, -0.033, 0.037, -0.024, 0.030];
  const input = render(ideal.map((t, i) => t + offsets[i]));

  const before = meanErrorMs(detectOnsets(input, SR), ideal);
  const { channels, plan } = smartVocalAlign([input], SR, beats);
  const after = meanErrorMs(detectOnsets(channels[0], SR), ideal);

  report(
    plan.moved >= 8,
    'plan moves most off-grid syllables',
    `moved ${plan.moved}, kept ${plan.kept}, mean shift ${plan.meanShiftMs}ms`,
  );
  report(after < before * 0.5, 'syllables land closer to the beat', `${before.toFixed(1)}ms → ${after.toFixed(1)}ms`);

  const drift = Math.abs(channels[0].length / SR - input.length / SR);
  report(drift < 0.25, 'duration preserved', `drift ${(drift * 1000).toFixed(0)}ms`);

  const slew = (a) => {
    let max = 0;
    for (let i = 1; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - a[i - 1]));
    return max;
  };
  report(
    slew(channels[0]) < slew(input) * 2,
    'no clicks at segment joins',
    `slew ${slew(channels[0]).toFixed(3)} vs input ${slew(input).toFixed(3)}`,
  );

  let peak = 0;
  for (const v of channels[0]) peak = Math.max(peak, Math.abs(v));
  report(peak < 1.5, 'output stays in range', `peak ${peak.toFixed(3)}`);
}

// --- restraint: leave material alone when it does not need help ------------
{
  const onGrid = smartVocalAlign([render(ideal)], SR, beats);
  report(onGrid.plan.moved <= 2, 'already-aligned material is left alone', `moved ${onGrid.plan.moved}`);

  // Sitting halfway between two subdivisions is phrasing, not a timing error:
  // it is maximally far from any grid point, so nothing should be pulled.
  // (A uniform offset near another subdivision is a different case — that one
  // *should* be corrected, and is, which is why the offset here is exactly
  // half a sixteenth rather than an arbitrary large number.)
  const halfStep = BEAT / 8;
  const offGrid = smartVocalAlign([render(ideal.map((t) => t + halfStep))], SR, beats);
  report(
    offGrid.plan.kept >= offGrid.plan.moved * 10,
    'material between subdivisions is not force-quantised',
    `moved ${offGrid.plan.moved}, kept ${offGrid.plan.kept}`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll alignment checks passed');
process.exit(failures ? 1 : 0);
