export type BitDepth = 16 | 24 | 32;

export interface DecodedWav {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * Encode interleaved PCM as a RIFF/WAVE file.
 *
 * 16- and 24-bit write integer PCM; 32-bit writes IEEE float, which is
 * bit-exact for material that never left the float domain.
 */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: BitDepth = 24,
): ArrayBuffer {
  const numCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;
  const isFloat = bitDepth === 32;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? 3 : 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const raw = channels[c]![i] ?? 0;
      if (isFloat) {
        view.setFloat32(offset, raw, true);
        offset += 4;
        continue;
      }
      const s = Math.max(-1, Math.min(1, raw));
      if (bitDepth === 16) {
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      } else {
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      }
    }
  }
  return buffer;
}

/** Decode a RIFF/WAVE file. Handles 8/16/24/32-bit PCM and 32-bit float. */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);
  const readStr = (offset: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') throw new Error('Not a WAV file');

  let pos = 12;
  let format = 1;
  let numCh = 2;
  let sampleRate = 44100;
  let bitDepth = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (pos + 8 <= buffer.byteLength) {
    const id = readStr(pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      numCh = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, buffer.byteLength - body);
    }
    pos = body + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('WAV file has no data chunk');

  const bytesPerSample = bitDepth / 8;
  const frames = Math.floor(dataSize / (bytesPerSample * numCh));
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const o = dataOffset + (i * numCh + c) * bytesPerSample;
      let v = 0;
      if (format === 3) {
        v = bitDepth === 64 ? view.getFloat64(o, true) : view.getFloat32(o, true);
      } else if (bitDepth === 8) {
        v = (view.getUint8(o) - 128) / 128;
      } else if (bitDepth === 16) {
        v = view.getInt16(o, true) / 0x8000;
      } else if (bitDepth === 24) {
        const raw = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 0x800000;
      } else if (bitDepth === 32) {
        v = view.getInt32(o, true) / 0x80000000;
      }
      channels[c]![i] = v;
    }
  }
  return { channels, sampleRate };
}
