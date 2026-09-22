/**
 * Round-trip test for the hand-written encoders.
 *
 * FLAC output is checked against libFLAC (compiled to WASM) and WAV against
 * this repo's own decoder, so "lossless export" is a claim with a test behind
 * it rather than an assertion.
 *
 *   npm run verify:codecs
 */
import { encodeFlac } from '../src/audio/dsp/flac.ts';
import { encodeWav, decodeWav } from '../src/audio/dsp/wav.ts';
import { decodeAiff } from '../src/audio/dsp/aiff.ts';
import { FLACDecoder } from '@wasm-audio-decoders/flac';

const SR = 44100;
let failures = 0;

function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** Signal with tonal, noisy, silent and full-scale regions. */
function testSignal(n) {
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    left[i] = 0.7 * Math.sin(2 * Math.PI * 440 * t) + 0.12 * Math.sin(2 * Math.PI * 3300 * t);
    right[i] = 0.55 * Math.sin(2 * Math.PI * 220 * t) + (Math.random() * 2 - 1) * 0.05;
  }
  for (let i = 1000; i < Math.min(n, 2000); i++) {
    left[i] = 0;
    right[i] = 0;
  }
  for (let i = 3000; i < Math.min(n, 3010); i++) {
    left[i] = 0.999;
    right[i] = -0.999;
  }
  return [left, right];
}

function maxError(a, b, n) {
  let max = 0;
  for (let c = 0; c < a.length; c++) {
    for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(a[c][i] - b[c][i]));
  }
  return max;
}

// --- FLAC ------------------------------------------------------------------
for (const bits of [16, 24]) {
  for (const n of [5000, 4096, 12000]) {
    const channels = testSignal(n);
    const encoded = encodeFlac(channels, SR, bits);
    const decoder = new FLACDecoder();
    await decoder.ready;
    const out = await decoder.decodeFile(new Uint8Array(encoded));
    await decoder.free();

    const tolerance = 2.5 / Math.pow(2, bits - 1);
    if (out.samplesDecoded !== n) {
      report(false, `flac ${bits}-bit ${n} samples`, `decoded ${out.samplesDecoded}`);
      continue;
    }
    const err = maxError(out.channelData, channels, n);
    const ratio = ((encoded.byteLength / (n * 2 * (bits / 8))) * 100).toFixed(1);
    report(
      err <= tolerance && out.sampleRate === SR,
      `flac ${bits}-bit ${n} samples`,
      `maxErr=${err.toExponential(2)} size=${ratio}% of raw`,
    );
  }
}

// --- WAV -------------------------------------------------------------------
for (const bits of [16, 24, 32]) {
  const n = 5000;
  const channels = testSignal(n);
  const decoded = decodeWav(encodeWav(channels, SR, bits));
  const tolerance = bits === 32 ? 1e-7 : 2.5 / Math.pow(2, bits - 1);
  const err = maxError(decoded.channels, channels, n);
  report(
    err <= tolerance && decoded.sampleRate === SR && decoded.channels.length === 2,
    `wav ${bits}-bit`,
    `maxErr=${err.toExponential(2)}`,
  );
}

// --- AIFF ------------------------------------------------------------------
{
  // Build a small AIFF by hand and check the decoder reads it back.
  const n = 512;
  const channels = testSignal(n);
  const bytes = new Uint8Array(54 + n * 4);
  const view = new DataView(bytes.buffer);
  const tag = (o, s) => {
    for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, 'FORM');
  view.setUint32(4, bytes.length - 8, false);
  tag(8, 'AIFF');
  tag(12, 'COMM');
  view.setUint32(16, 18, false);
  view.setUint16(20, 2, false);
  view.setUint32(22, n, false);
  view.setUint16(26, 16, false);
  // 44100 as an 80-bit extended float. 44100 = 1.0101100010001b x 2^15, so the
  // exponent field is 15 + 16383 and the explicit-leading-one mantissa is
  // 44100 x 2^48 — whose top 32 bits are 44100 x 2^16.
  view.setUint16(28, 16398, false);
  view.setUint32(30, 44100 * Math.pow(2, 16), false);
  view.setUint32(34, 0, false);
  tag(38, 'SSND');
  view.setUint32(42, 8 + n * 4, false);
  view.setUint32(46, 0, false);
  view.setUint32(50, 0, false);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 2; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(54 + (i * 2 + c) * 2, Math.round(v * 32767), false);
    }
  }
  const decoded = decodeAiff(bytes.buffer);
  const err = maxError(decoded.channels, channels, n);
  report(
    err <= 4 / 32768 && decoded.sampleRate === 44100,
    'aiff 16-bit',
    `maxErr=${err.toExponential(2)} rate=${decoded.sampleRate}`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll codec checks passed');
process.exit(failures ? 1 : 0);
