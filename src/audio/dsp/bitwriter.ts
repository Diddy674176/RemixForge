/** Growable MSB-first bit writer, with the CRCs the FLAC container needs. */
export class BitWriter {
  private bytes: Uint8Array;
  private length = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(initialCapacity = 1 << 16) {
    this.bytes = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    let cap = this.bytes.length * 2;
    while (cap < this.length + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  private pushByte(b: number): void {
    this.ensure(1);
    this.bytes[this.length++] = b & 0xff;
  }

  /** Write the low `count` bits of `value`, most significant first. */
  writeBits(value: number, count: number): void {
    if (count <= 0) return;
    if (count > 30) {
      // Split so the shifts stay inside 32-bit territory.
      const high = Math.floor(value / 0x40000000);
      this.writeBits(high, count - 30);
      this.writeBits(value >>> 0 & 0x3fffffff, 30);
      return;
    }
    for (let i = count - 1; i >= 0; i--) {
      this.bitBuffer = (this.bitBuffer << 1) | ((value >>> i) & 1);
      this.bitCount++;
      if (this.bitCount === 8) {
        this.pushByte(this.bitBuffer);
        this.bitBuffer = 0;
        this.bitCount = 0;
      }
    }
  }

  writeSignedBits(value: number, count: number): void {
    const mask = count >= 32 ? 0xffffffff : (1 << count) - 1;
    this.writeBits(value & mask, count);
  }

  /** `n` zero bits followed by a single one — FLAC's unary quotient. */
  writeUnary(n: number): void {
    let remaining = n;
    while (remaining >= 24) {
      this.writeBits(0, 24);
      remaining -= 24;
    }
    this.writeBits(0, remaining);
    this.writeBits(1, 1);
  }

  /** Zigzag the sign out, then Rice-code with parameter `k`. */
  writeRiceSigned(value: number, k: number): void {
    const u = value >= 0 ? value * 2 : -value * 2 - 1;
    const quotient = Math.floor(u / Math.pow(2, k));
    this.writeUnary(quotient);
    if (k > 0) this.writeBits(u % Math.pow(2, k), k);
  }

  /** FLAC's UTF-8-like coding, extended to 36-bit frame numbers. */
  writeUtf8(value: number): void {
    if (value < 0x80) {
      this.writeBits(value, 8);
      return;
    }
    const thresholds = [0x800, 0x10000, 0x200000, 0x4000000, 0x80000000, 0x1000000000];
    let extraBytes = 1;
    for (const t of thresholds) {
      if (value < t) break;
      extraBytes++;
    }
    const leadBits = 7 - extraBytes;
    const lead = ((0xff << (leadBits + 1)) & 0xff) | (Math.floor(value / Math.pow(2, 6 * extraBytes)) & ((1 << leadBits) - 1));
    this.writeBits(lead, 8);
    for (let i = extraBytes - 1; i >= 0; i--) {
      const chunk = Math.floor(value / Math.pow(2, 6 * i)) % 64;
      this.writeBits(0x80 | chunk, 8);
    }
  }

  /** Pad with zeros to the next byte boundary. */
  align(): void {
    if (this.bitCount > 0) this.writeBits(0, 8 - this.bitCount);
  }

  get byteLength(): number {
    return this.length;
  }

  isAligned(): boolean {
    return this.bitCount === 0;
  }

  /** Bytes written so far. Only valid when byte-aligned. */
  view(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }

  toUint8Array(): Uint8Array {
    this.align();
    return this.bytes.slice(0, this.length);
  }
}

const CRC8_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    table[i] = crc;
  }
  return table;
})();

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    table[i] = crc;
  }
  return table;
})();

export function crc8(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) crc = CRC8_TABLE[crc ^ data[i]!]!;
  return crc;
}

export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ data[i]!) & 0xff]!) & 0xffff;
  return crc;
}
