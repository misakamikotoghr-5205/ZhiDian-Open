// Perceptual signature of a screen region, used to tell whether a pinned referent still shows
// what it showed when it was pinned. If not, the referent is "dangling": the pointer is still
// there but the thing it pointed at has gone.

export const GRID = 12;
export const DANGLING_THRESHOLD = 9; // mean absolute luminance difference per cell, 0..255

/** Mean luminance over a GRID x GRID lattice of cells covering `box` (clamped to the image). */
export function signature(img, box) {
  const { data, width, height } = img;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w));
  const y1 = Math.min(height, Math.ceil(box.y + box.h));
  const sig = new Uint8Array(GRID * GRID);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return sig;
  for (let gy = 0; gy < GRID; gy++) {
    const ya = y0 + Math.floor((gy * bh) / GRID);
    const yb = Math.max(ya + 1, y0 + Math.floor(((gy + 1) * bh) / GRID));
    for (let gx = 0; gx < GRID; gx++) {
      const xa = x0 + Math.floor((gx * bw) / GRID);
      const xb = Math.max(xa + 1, x0 + Math.floor(((gx + 1) * bw) / GRID));
      let sum = 0, n = 0;
      // Sample at most ~8 points per axis per cell: plenty for a 12x12 signature.
      const sy = Math.max(1, Math.floor((yb - ya) / 8));
      const sx = Math.max(1, Math.floor((xb - xa) / 8));
      for (let y = ya; y < yb && y < height; y += sy) {
        let o = (y * width + xa) * 4;
        for (let x = xa; x < xb && x < width; x += sx, o += 4 * sx) {
          // Channel order is unknown (RGBA or BGRA); equal weights avoid depending on it.
          sum += (data[o] + data[o + 1] + data[o + 2]) / 3;
          n++;
        }
      }
      sig[gy * GRID + gx] = n ? Math.round(sum / n) : 0;
    }
  }
  return sig;
}

export function distance(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

export function isDangling(a, b, threshold = DANGLING_THRESHOLD) {
  return distance(a, b) > threshold;
}
