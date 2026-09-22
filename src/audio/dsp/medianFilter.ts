/**
 * Sliding median over one axis of a 2-D array stored in a flat Float32Array.
 *
 * Uses an insertion-sorted window, so cost per output sample is O(window)
 * rather than O(window log window) — which matters, because HPSS runs this
 * over every cell of a full-resolution spectrogram twice.
 */
export function medianFilterAxis(
  src: Float32Array,
  dst: Float32Array,
  rows: number,
  cols: number,
  axis: 'rows' | 'cols',
  window: number,
): void {
  const w = window % 2 === 0 ? window + 1 : window;
  const half = w >> 1;
  const n = axis === 'rows' ? cols : rows;
  const lines = axis === 'rows' ? rows : cols;
  const stride = axis === 'rows' ? 1 : cols;
  const lineStride = axis === 'rows' ? cols : 1;

  const line = new Float32Array(n);
  const sorted = new Float32Array(w);

  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    for (let i = 0; i < n; i++) line[i] = src[base + i * stride]!;

    // Prime the window with edge replication.
    let count = 0;
    for (let i = -half; i <= half; i++) {
      const v = line[Math.min(n - 1, Math.max(0, i))]!;
      insert(sorted, count++, v);
    }

    for (let i = 0; i < n; i++) {
      dst[base + i * stride] = sorted[half]!;
      if (i + 1 < n) {
        const outIdx = Math.min(n - 1, Math.max(0, i - half));
        const inIdx = Math.min(n - 1, Math.max(0, i + half + 1));
        remove(sorted, w, line[outIdx]!);
        insert(sorted, w - 1, line[inIdx]!);
      }
    }
  }
}

/** Insert `v` into the first `count` sorted entries of `arr`. */
function insert(arr: Float32Array, count: number, v: number): void {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  for (let i = count; i > lo; i--) arr[i] = arr[i - 1]!;
  arr[lo] = v;
}

/** Remove one occurrence of `v` from the first `count` sorted entries. */
function remove(arr: Float32Array, count: number, v: number): void {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < count - 1; i++) arr[i] = arr[i + 1]!;
}
