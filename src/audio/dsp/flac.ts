import { BitWriter, crc8, crc16 } from './bitwriter.ts';

export type FlacBitDepth = 16 | 24;

const BLOCK_SIZE = 4096;
const MAX_FIXED_ORDER = 4;

/** Fixed-predictor residuals for orders 0–4. */
function fixedResidual(x: Int32Array, order: number, out: Int32Array): void {
  const n = x.length;
  switch (order) {
    case 0:
      for (let i = 0; i < n; i++) out[i] = x[i]!;
      break;
    case 1:
      for (let i = 1; i < n; i++) out[i] = x[i]! - x[i - 1]!;
      break;
    case 2:
      for (let i = 2; i < n; i++) out[i] = x[i]! - 2 * x[i - 1]! + x[i - 2]!;
      break;
    case 3:
      for (let i = 3; i < n; i++) out[i] = x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]!;
      break;
    case 4:
      for (let i = 4; i < n; i++)
        out[i] = x[i]! - 4 * x[i - 1]! + 6 * x[i - 2]! - 4 * x[i - 3]! + x[i - 4]!;
      break;
    default:
      break;
  }
}

/** Rice parameter minimising encoded size for one run of residuals. */
function bestRiceParam(residual: Int32Array, from: number, to: number): { k: number; bits: number } {
  const n = to - from;
  if (n <= 0) return { k: 0, bits: 0 };
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = residual[i]!;
    sum += v >= 0 ? v * 2 : -v * 2 - 1;
  }
  const mean = sum / n;
  const start = Math.max(0, Math.min(30, Math.floor(Math.log2(mean + 1))));

  let bestK = start;
  let bestBits = Infinity;
  for (let k = Math.max(0, start - 2); k <= Math.min(30, start + 2); k++) {
    let bits = 0;
    const div = Math.pow(2, k);
    for (let i = from; i < to; i++) {
      const v = residual[i]!;
      const u = v >= 0 ? v * 2 : -v * 2 - 1;
      bits += Math.floor(u / div) + 1 + k;
    }
    if (bits < bestBits) {
      bestBits = bits;
      bestK = k;
    }
  }
  return { k: bestK, bits: bestBits };
}

function writeSubframe(bw: BitWriter, samples: Int32Array, bitsPerSample: number): void {
  const n = samples.length;

  // Constant subframe — cheap win on silence, which stems are full of.
  let constant = true;
  for (let i = 1; i < n; i++) {
    if (samples[i] !== samples[0]) {
      constant = false;
      break;
    }
  }
  if (constant) {
    bw.writeBits(0, 1);
    bw.writeBits(0b000000, 6);
    bw.writeBits(0, 1);
    bw.writeSignedBits(samples[0] ?? 0, bitsPerSample);
    return;
  }

  const residual = new Int32Array(n);
  let bestOrder = 0;
  let bestBits = Infinity;
  let bestK = 0;
  const scratch = new Int32Array(n);

  const maxOrder = Math.min(MAX_FIXED_ORDER, n - 1);
  for (let order = 0; order <= maxOrder; order++) {
    scratch.fill(0);
    fixedResidual(samples, order, scratch);
    const { k, bits } = bestRiceParam(scratch, order, n);
    const total = bits + order * bitsPerSample;
    if (total < bestBits) {
      bestBits = total;
      bestOrder = order;
      bestK = k;
      residual.set(scratch);
    }
  }

  // Fall back to verbatim if prediction didn't help.
  const verbatimBits = n * bitsPerSample;
  if (bestBits >= verbatimBits) {
    bw.writeBits(0, 1);
    bw.writeBits(0b000001, 6);
    bw.writeBits(0, 1);
    for (let i = 0; i < n; i++) bw.writeSignedBits(samples[i]!, bitsPerSample);
    return;
  }

  bw.writeBits(0, 1);
  bw.writeBits(0b001000 | bestOrder, 6);
  bw.writeBits(0, 1);
  for (let i = 0; i < bestOrder; i++) bw.writeSignedBits(samples[i]!, bitsPerSample);

  // Partitioned Rice, method 1 (5-bit parameters), a single partition.
  bw.writeBits(0b01, 2);
  bw.writeBits(0, 4);
  bw.writeBits(bestK, 5);
  for (let i = bestOrder; i < n; i++) bw.writeRiceSigned(residual[i]!, bestK);
}

/** Frame-header sample-rate codes, and any extra bytes they imply. */
const SAMPLE_RATE_CODES: Record<number, number> = {
  88200: 0b0001,
  176400: 0b0010,
  192000: 0b0011,
  8000: 0b0100,
  16000: 0b0101,
  22050: 0b0110,
  24000: 0b0111,
  32000: 0b1000,
  44100: 0b1001,
  48000: 0b1010,
  96000: 0b1011,
};

interface RateEncoding {
  code: number;
  /** Extra value written after the frame number, with its bit width. */
  extra?: { value: number; bits: number };
}

/**
 * Encode the sample rate into the frame header.
 *
 * Writing it explicitly rather than deferring to STREAMINFO keeps streaming
 * parsers happy — several of them read the rate straight off the frame.
 */
function rateEncoding(sampleRate: number): RateEncoding {
  const code = SAMPLE_RATE_CODES[sampleRate];
  if (code !== undefined) return { code };
  if (sampleRate % 1000 === 0 && sampleRate / 1000 <= 255) {
    return { code: 0b1100, extra: { value: sampleRate / 1000, bits: 8 } };
  }
  if (sampleRate <= 0xffff) return { code: 0b1101, extra: { value: sampleRate, bits: 16 } };
  if (sampleRate % 10 === 0 && sampleRate / 10 <= 0xffff) {
    return { code: 0b1110, extra: { value: sampleRate / 10, bits: 16 } };
  }
  return { code: 0b0000 };
}

function writeFrame(
  channels: Int32Array[],
  frameNumber: number,
  blockSize: number,
  bitsPerSample: number,
  sampleRate: number,
): Uint8Array {
  const rate = rateEncoding(sampleRate);
  const bw = new BitWriter(blockSize * channels.length * 4 + 64);

  bw.writeBits(0b11111111111110, 14);
  bw.writeBits(0, 1); // reserved
  bw.writeBits(0, 1); // fixed blocksize strategy
  bw.writeBits(0b0111, 4); // block size: 16 bits follow the header
  bw.writeBits(rate.code, 4);
  bw.writeBits(channels.length - 1, 4); // independent channels
  bw.writeBits(bitsPerSample === 24 ? 0b110 : 0b100, 3);
  bw.writeBits(0, 1); // reserved
  bw.writeUtf8(frameNumber);
  bw.writeBits(blockSize - 1, 16);
  if (rate.extra) bw.writeBits(rate.extra.value, rate.extra.bits);

  const headerBytes = bw.toUint8Array();
  const header = new Uint8Array(headerBytes.length + 1);
  header.set(headerBytes);
  header[headerBytes.length] = crc8(headerBytes);

  const body = new BitWriter(blockSize * channels.length * 4 + 64);
  for (const ch of channels) writeSubframe(body, ch, bitsPerSample);
  body.align();
  const bodyBytes = body.toUint8Array();

  const frame = new Uint8Array(header.length + bodyBytes.length + 2);
  frame.set(header, 0);
  frame.set(bodyBytes, header.length);
  const crc = crc16(frame.subarray(0, header.length + bodyBytes.length));
  frame[frame.length - 2] = (crc >> 8) & 0xff;
  frame[frame.length - 1] = crc & 0xff;
  return frame;
}

function quantise(channels: Float32Array[], bitsPerSample: number): Int32Array[] {
  const max = Math.pow(2, bitsPerSample - 1);
  return channels.map((ch) => {
    const out = new Int32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]!));
      out[i] = Math.max(-max, Math.min(max - 1, Math.round(v * (max - 1))));
    }
    return out;
  });
}

/**
 * Encode float channels as FLAC.
 *
 * Uses fixed predictors with Rice-coded residuals — the subset of the format
 * that gives most of the compression for a fraction of the complexity of full
 * LPC. Output is genuinely lossless with respect to the quantised integers.
 */
export function encodeFlac(
  channels: Float32Array[],
  sampleRate: number,
  bitsPerSample: FlacBitDepth = 24,
): ArrayBuffer {
  if (channels.length === 0 || channels.length > 8) {
    throw new Error('FLAC export supports 1–8 channels');
  }
  const ints = quantise(channels, bitsPerSample);
  const totalSamples = ints[0]?.length ?? 0;

  const frames: Uint8Array[] = [];
  let minBlock = BLOCK_SIZE;
  let maxBlock = 0;
  let minFrame = Infinity;
  let maxFrame = 0;

  for (let offset = 0, n = 0; offset < totalSamples; offset += BLOCK_SIZE, n++) {
    const size = Math.min(BLOCK_SIZE, totalSamples - offset);
    const block = ints.map((ch) => ch.subarray(offset, offset + size));
    const frame = writeFrame(
      block.map((b) => (b instanceof Int32Array ? b : new Int32Array(b))),
      n,
      size,
      bitsPerSample,
      sampleRate,
    );
    frames.push(frame);
    minBlock = Math.min(minBlock, size);
    maxBlock = Math.max(maxBlock, size);
    minFrame = Math.min(minFrame, frame.length);
    maxFrame = Math.max(maxFrame, frame.length);
  }

  const streamInfo = new BitWriter(64);
  streamInfo.writeBits(minBlock, 16);
  streamInfo.writeBits(maxBlock, 16);
  streamInfo.writeBits(Number.isFinite(minFrame) ? minFrame : 0, 24);
  streamInfo.writeBits(maxFrame, 24);
  streamInfo.writeBits(sampleRate, 20);
  streamInfo.writeBits(channels.length - 1, 3);
  streamInfo.writeBits(bitsPerSample - 1, 5);
  streamInfo.writeBits(totalSamples, 36);
  // MD5 of the unencoded audio: all zeros means "not computed", which is legal.
  for (let i = 0; i < 16; i++) streamInfo.writeBits(0, 8);
  const streamInfoBytes = streamInfo.toUint8Array();

  const totalFrameBytes = frames.reduce((a, f) => a + f.length, 0);
  const out = new Uint8Array(4 + 4 + streamInfoBytes.length + totalFrameBytes);
  let pos = 0;
  out.set([0x66, 0x4c, 0x61, 0x43], pos); // "fLaC"
  pos += 4;
  out[pos++] = 0x80; // last metadata block, type 0 (STREAMINFO)
  out[pos++] = 0;
  out[pos++] = 0;
  out[pos++] = streamInfoBytes.length;
  out.set(streamInfoBytes, pos);
  pos += streamInfoBytes.length;
  for (const frame of frames) {
    out.set(frame, pos);
    pos += frame.length;
  }
  return out.buffer;
}
