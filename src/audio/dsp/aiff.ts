/**
 * Minimal AIFF / AIFC (uncompressed PCM) decoder.
 *
 * Chrome and Firefox refuse AIFF in `decodeAudioData`, so importing one of the
 * formats the app claims to support needs this fallback.
 */
export interface DecodedAiff {
  channels: Float32Array[];
  sampleRate: number;
}

/** Read an 80-bit IEEE 754 extended float — how AIFF stores its sample rate. */
function readExtended(view: DataView, offset: number): number {
  const expon = ((view.getUint8(offset) & 0x7f) << 8) | view.getUint8(offset + 1);
  const sign = view.getUint8(offset) & 0x80 ? -1 : 1;
  let hiMant = view.getUint32(offset + 2, false);
  let loMant = view.getUint32(offset + 6, false);
  if (expon === 0 && hiMant === 0 && loMant === 0) return 0;
  if (expon === 0x7fff) return sign * Infinity;
  const e = expon - 16383 - 31;
  return sign * (hiMant * Math.pow(2, e) + loMant * Math.pow(2, e - 32));
}

export function decodeAiff(buffer: ArrayBuffer): DecodedAiff {
  const view = new DataView(buffer);
  const tag = (o: number) =>
    String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));

  if (tag(0) !== 'FORM') throw new Error('Not an AIFF file');
  const formType = tag(8);
  if (formType !== 'AIFF' && formType !== 'AIFC') throw new Error('Unsupported AIFF variant');

  let numChannels = 2;
  let numFrames = 0;
  let sampleSize = 16;
  let sampleRate = 44100;
  let ssndOffset = -1;
  let compression = 'NONE';

  let pos = 12;
  while (pos + 8 <= buffer.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, false);
    const body = pos + 8;
    if (id === 'COMM') {
      numChannels = view.getUint16(body, false);
      numFrames = view.getUint32(body + 2, false);
      sampleSize = view.getUint16(body + 6, false);
      sampleRate = Math.round(readExtended(view, body + 8));
      if (size >= 22) compression = tag(body + 18);
    } else if (id === 'SSND') {
      const dataOffset = view.getUint32(body, false);
      ssndOffset = body + 8 + dataOffset;
    }
    pos = body + size + (size % 2);
  }

  if (ssndOffset < 0) throw new Error('AIFF file has no sound data');
  const isFloat = compression === 'fl32' || compression === 'FL32';
  const littleEndian = compression === 'sowt';
  const bytes = sampleSize / 8;
  const channels = Array.from({ length: numChannels }, () => new Float32Array(numFrames));

  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const o = ssndOffset + (i * numChannels + c) * bytes;
      if (o + bytes > buffer.byteLength) break;
      let v = 0;
      if (isFloat) {
        v = view.getFloat32(o, littleEndian);
      } else if (sampleSize === 8) {
        v = view.getInt8(o) / 128;
      } else if (sampleSize === 16) {
        v = view.getInt16(o, littleEndian) / 0x8000;
      } else if (sampleSize === 24) {
        const b0 = view.getUint8(o);
        const b1 = view.getUint8(o + 1);
        const b2 = view.getUint8(o + 2);
        const raw = littleEndian ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 0x800000;
      } else if (sampleSize === 32) {
        v = view.getInt32(o, littleEndian) / 0x80000000;
      }
      channels[c]![i] = v;
    }
  }
  return { channels, sampleRate };
}
