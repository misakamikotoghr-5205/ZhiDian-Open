// Pure geometry helpers shared by the main process, the overlay and the tests.
// Boxes are {x, y, w, h}. "DIP" means display-independent pixels, local to one display.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function clampBox(b, W, H) {
  const x = clamp(Math.round(b.x), 0, Math.max(0, W - 1));
  const y = clamp(Math.round(b.y), 0, Math.max(0, H - 1));
  const w = clamp(Math.round(b.w), 1, W - x);
  const h = clamp(Math.round(b.h), 1, H - y);
  return { x, y, w, h };
}

export function expandBox(b, margin, W, H) {
  return clampBox({ x: b.x - margin, y: b.y - margin, w: b.w + margin * 2, h: b.h + margin * 2 }, W, H);
}

export function scaleBox(b, s) {
  return { x: b.x * s, y: b.y * s, w: b.w * s, h: b.h * s };
}

export function boxFromPoints(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function contains(b, x, y) {
  return x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;
}

export function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Largest size with the same aspect ratio whose long edge is at most maxEdge. Never upscales. */
export function fitWithin(w, h, maxEdge) {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { w: Math.round(w), h: Math.round(h), scale: 1 };
  const scale = maxEdge / long;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

/**
 * Map a point given in a referent image's pixel space back to display DIP.
 * `ref.cropBox` is the DIP rectangle the image shows, `ref.imageSize` its pixel size.
 * Returns null when the point is not a pair of finite numbers. The point is clamped to the image,
 * because a model that overshoots by a few pixels still means "the edge of this thing".
 */
export function imageToDisplay(ref, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { cropBox, imageSize } = ref;
  const px = clamp(x, 0, imageSize.w);
  const py = clamp(y, 0, imageSize.h);
  return {
    x: cropBox.x + (px / imageSize.w) * cropBox.w,
    y: cropBox.y + (py / imageSize.h) * cropBox.h,
    clamped: px !== x || py !== y,
  };
}

export function imageBoxToDisplay(ref, x, y, w, h) {
  const a = imageToDisplay(ref, x, y);
  const b = imageToDisplay(ref, x + w, y + h);
  if (!a || !b) return null;
  return { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y), clamped: a.clamped || b.clamped };
}

/** Place a panel of size (pw, ph) near an anchor box without leaving the screen. */
export function placeNear(anchor, pw, ph, W, H, gap = 12) {
  const candidates = [
    { x: anchor.x, y: anchor.y + anchor.h + gap }, // below, left aligned
    { x: anchor.x + anchor.w + gap, y: anchor.y }, // right
    { x: anchor.x, y: anchor.y - ph - gap }, // above
    { x: anchor.x - pw - gap, y: anchor.y }, // left
  ];
  for (const c of candidates) {
    if (c.x >= 8 && c.y >= 8 && c.x + pw <= W - 8 && c.y + ph <= H - 8) return c;
  }
  return {
    x: clamp(anchor.x, 8, Math.max(8, W - pw - 8)),
    y: clamp(anchor.y + anchor.h + gap, 8, Math.max(8, H - ph - 8)),
  };
}
