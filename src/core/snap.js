// Local "pixels to objects" snapping. No model call, no network.
//
// Given a screenshot and a cursor position, propose a ladder of boxes from tight to wide
// (roughly: word, line, paragraph or control, card, section). The idea is whitespace-gap
// expansion, the same intuition as XY-cut page segmentation: grow a box from the cursor until
// every side is bordered by a band of uniform colour at least `gap` pixels thick. A small gap
// stops at word spacing, a large gap only stops at the margins around a whole card.
//
// If the cursor sits on empty background, the nearest non-background pixel is used as the seed,
// so the pointer always holds exactly one referent (a bubble cursor for pixels).
//
// The image is {data, width, height} with 4 bytes per pixel. Channel order does not matter:
// only colour differences are used.

import { iou } from './geometry.js';

export const SNAP_DEFAULTS = Object.freeze({
  gaps: [3, 6, 10, 16, 24, 36, 56],
  tol: 6, // per-channel range that still counts as "one colour" (cards are often only ~10 off the page)
  searchRadius: 160, // how far to look for content when the cursor is on background
  minSide: 6,
  maxFraction: 0.92, // boxes covering more than this of both dimensions are dropped (use "screen" instead)
});

/** Returns the colour [r,g,b] if every pixel in the inclusive rectangle is within `tol`, else null. */
export function uniformColor(img, x0, y0, x1, y1, tol) {
  const { data, width } = img;
  let o = (y0 * width + x0) * 4;
  const r0 = data[o], g0 = data[o + 1], b0 = data[o + 2];
  let rmin = r0, rmax = r0, gmin = g0, gmax = g0, bmin = b0, bmax = b0;
  for (let y = y0; y <= y1; y++) {
    o = (y * width + x0) * 4;
    for (let x = x0; x <= x1; x++, o += 4) {
      const r = data[o], g = data[o + 1], b = data[o + 2];
      if (r < rmin) rmin = r; else if (r > rmax) rmax = r;
      if (g < gmin) gmin = g; else if (g > gmax) gmax = g;
      if (b < bmin) bmin = b; else if (b > bmax) bmax = b;
      if (rmax - rmin > tol || gmax - gmin > tol || bmax - bmin > tol) return null;
    }
  }
  return [(rmin + rmax) >> 1, (gmin + gmax) >> 1, (bmin + bmax) >> 1];
}

/** If (cx, cy) is on flat background, return the nearest pixel that is not; otherwise the point itself. */
export function seedPoint(img, cx, cy, opts = {}) {
  const { tol, searchRadius } = { ...SNAP_DEFAULTS, ...opts };
  const { data, width, height } = img;
  const s = 2;
  const x0 = Math.max(0, cx - s), x1 = Math.min(width - 1, cx + s);
  const y0 = Math.max(0, cy - s), y1 = Math.min(height - 1, cy + s);
  const bg = uniformColor(img, x0, y0, x1, y1, tol);
  if (!bg) return { x: cx, y: cy, moved: false };

  const differs = (x, y) => {
    const o = (y * width + x) * 4;
    return Math.abs(data[o] - bg[0]) > tol || Math.abs(data[o + 1] - bg[1]) > tol || Math.abs(data[o + 2] - bg[2]) > tol;
  };
  for (let r = 3; r <= searchRadius; r += 2) {
    let best = null;
    let bestD = Infinity;
    const consider = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      if (!differs(x, y)) return;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bestD) { bestD = d; best = { x, y }; }
    };
    for (let i = -r; i <= r; i++) {
      consider(cx + i, cy - r);
      consider(cx + i, cy + r);
      consider(cx - r, cy + i);
      consider(cx + r, cy + i);
    }
    if (best) return { ...best, moved: true };
  }
  return { x: cx, y: cy, moved: false, empty: true };
}

// Scan a band outward from the box, nearest line first. Returns -1 if the whole band is one
// colour (written to `out`), otherwise the coordinate of the nearest line holding a pixel that
// differs from the band's first pixel. Every line before it has that same flat colour, so the
// box edge can jump to the line just before the hit (and always moves at least one line): the
// result is identical to stepping one line at a time, only faster.
function scanRows(img, x0, x1, yFrom, yTo, tol, out) {
  const { data, width } = img;
  const dir = yTo >= yFrom ? 1 : -1;
  let o = (yFrom * width + x0) * 4;
  const r0 = data[o], g0 = data[o + 1], b0 = data[o + 2];
  for (let y = yFrom; dir > 0 ? y <= yTo : y >= yTo; y += dir) {
    o = (y * width + x0) * 4;
    for (let x = x0; x <= x1; x++, o += 4) {
      if (Math.abs(data[o] - r0) > tol || Math.abs(data[o + 1] - g0) > tol || Math.abs(data[o + 2] - b0) > tol) return y;
    }
  }
  out[0] = r0; out[1] = g0; out[2] = b0;
  return -1;
}

function scanCols(img, y0, y1, xFrom, xTo, tol, out) {
  const { data, width } = img;
  const dir = xTo >= xFrom ? 1 : -1;
  const o0 = (y0 * width + xFrom) * 4;
  const r0 = data[o0], g0 = data[o0 + 1], b0 = data[o0 + 2];
  const stride = width * 4;
  for (let x = xFrom; dir > 0 ? x <= xTo : x >= xTo; x += dir) {
    let o = (y0 * width + x) * 4;
    for (let y = y0; y <= y1; y++, o += stride) {
      if (Math.abs(data[o] - r0) > tol || Math.abs(data[o + 1] - g0) > tol || Math.abs(data[o + 2] - b0) > tol) return x;
    }
  }
  out[0] = r0; out[1] = g0; out[2] = b0;
  return -1;
}

const near = (a, b, tol) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

/**
 * Grow a box from (cx, cy) until every side has a uniform band `gap` thick outside it.
 * Each side stops on a line that actually contains content, so the result is tight.
 *
 * `opts.inside` is the flat colour immediately around the pointed-at element (its card or panel
 * background). Once any side has broken out of that colour, the sides still looking at it are
 * pushed to where it ends. This is what captures a borderless card whose content does not fill
 * it: the far sides would otherwise stop in the card's own empty space.
 *
 * Returns the box plus `bands`: the colour of the blank band on each side (null at a screen edge).
 */
export function expand(img, cx, cy, gap, opts = {}) {
  const { tol } = { ...SNAP_DEFAULTS, ...opts };
  const inside = opts.inside ?? null;
  const W = img.width, H = img.height;
  // Start from a small patch, not a single pixel: a one-pixel column inside a glyph stroke is
  // "uniform" along the stroke and would never grow.
  let x0 = Math.max(0, cx - 2), x1 = Math.min(W - 1, cx + 2);
  let y0 = Math.max(0, cy - 2), y1 = Math.min(H - 1, cy + 2);
  const c = [0, 0, 0];
  const bands = { t: null, b: null, l: null, r: null };

  for (let round = 0; round < 8; round++) {
    // Each side is pushed as far as it will go before the next side is looked at. A side that
    // creeps along a border one line at a time then costs one cheap failed scan per line
    // instead of a full rescan of all four bands.
    for (let guard = 0; guard < 400; guard++) {
      let moved = false;
      bands.t = bands.b = bands.l = bands.r = null;
      while (y0 > 0) {
        const hit = scanRows(img, x0, x1, y0 - 1, Math.max(0, y0 - gap), tol, c);
        if (hit < 0) { bands.t = [c[0], c[1], c[2]]; break; }
        y0 = Math.min(y0 - 1, hit + 1); moved = true;
      }
      while (y1 < H - 1) {
        const hit = scanRows(img, x0, x1, y1 + 1, Math.min(H - 1, y1 + gap), tol, c);
        if (hit < 0) { bands.b = [c[0], c[1], c[2]]; break; }
        y1 = Math.max(y1 + 1, hit - 1); moved = true;
      }
      while (x0 > 0) {
        const hit = scanCols(img, y0, y1, x0 - 1, Math.max(0, x0 - gap), tol, c);
        if (hit < 0) { bands.l = [c[0], c[1], c[2]]; break; }
        x0 = Math.min(x0 - 1, hit + 1); moved = true;
      }
      while (x1 < W - 1) {
        const hit = scanCols(img, y0, y1, x1 + 1, Math.min(W - 1, x1 + gap), tol, c);
        if (hit < 0) { bands.r = [c[0], c[1], c[2]]; break; }
        x1 = Math.max(x1 + 1, hit - 1); moved = true;
      }
      if (!moved) break;
    }

    if (!inside) break;
    const sides = [bands.t, bands.b, bands.l, bands.r].filter(Boolean);
    const brokeOut = sides.some((s) => !near(s, inside, tol)) || sides.length < 4;
    if (!brokeOut) break;
    let pushed = false;
    if (bands.t && near(bands.t, inside, tol)) {
      const hit = scanRows(img, x0, x1, y0 - 1, 0, tol, c);
      const ny = hit < 0 ? 0 : hit + 1;
      if (ny < y0) { y0 = ny; pushed = true; }
    }
    if (bands.b && near(bands.b, inside, tol)) {
      const hit = scanRows(img, x0, x1, y1 + 1, H - 1, tol, c);
      const ny = hit < 0 ? H - 1 : hit - 1;
      if (ny > y1) { y1 = ny; pushed = true; }
    }
    if (bands.l && near(bands.l, inside, tol)) {
      const hit = scanCols(img, y0, y1, x0 - 1, 0, tol, c);
      const nx = hit < 0 ? 0 : hit + 1;
      if (nx < x0) { x0 = nx; pushed = true; }
    }
    if (bands.r && near(bands.r, inside, tol)) {
      const hit = scanCols(img, y0, y1, x1 + 1, W - 1, tol, c);
      const nx = hit < 0 ? W - 1 : hit - 1;
      if (nx > x1) { x1 = nx; pushed = true; }
    }
    if (!pushed) break;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, bands };
}

// ---------------------------------------------------------------------------------------------
// Background regions. A card, a button, a table cell or a dialog is usually one flat colour with
// content on it. The bounding box of the connected area of that colour is the container, no
// matter how its padding compares with the spacing to its neighbours (which is where the
// gap ladder alone merges adjacent cards).

let stamps = null; // per-pixel generation marks, reused between calls
let stampGen = 0;
let stack = null;

/**
 * Bounding box of the connected region whose colour matches the pixel at (sx, sy).
 * Returns null if the region is so large that it is the page itself, not a container.
 */
export function regionBox(img, sx, sy, opts = {}) {
  const { tol } = { ...SNAP_DEFAULTS, ...opts };
  const { data, width: W, height: H } = img;
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const maxPixels = Math.floor(W * H * (opts.maxFraction ?? 0.4));
  if (!stamps || stamps.length !== W * H) {
    stamps = new Uint32Array(W * H);
    stampGen = 0;
  }
  if (!stack || stack.length < W * 4) stack = new Int32Array(Math.max(W, H) * 8);
  const gen = ++stampGen;
  const o0 = (sy * W + sx) * 4;
  const r0 = data[o0], g0 = data[o0 + 1], b0 = data[o0 + 2];
  const same = (i) => {
    const o = i * 4;
    return Math.abs(data[o] - r0) <= tol && Math.abs(data[o + 1] - g0) <= tol && Math.abs(data[o + 2] - b0) <= tol;
  };
  let x0 = sx, x1 = sx, y0 = sy, y1 = sy, count = 0, sp = 0;
  const push = (x, y) => {
    if (sp + 2 > stack.length) {
      const bigger = new Int32Array(stack.length * 2);
      bigger.set(stack);
      stack = bigger;
    }
    stack[sp++] = x;
    stack[sp++] = y;
  };
  push(sx, sy);
  while (sp > 0) {
    const y = stack[--sp];
    let x = stack[--sp];
    let i = y * W + x;
    if (stamps[i] === gen || !same(i)) continue;
    // Walk to the left end of this run, then fill rightwards, seeding the rows above and below.
    while (x > 0 && stamps[i - 1] !== gen && same(i - 1)) { x--; i--; }
    let upOpen = false, downOpen = false;
    const runStart = x;
    for (; x < W && stamps[i] !== gen && same(i); x++, i++) {
      stamps[i] = gen;
      count++;
      if (y > 0) {
        const ok = stamps[i - W] !== gen && same(i - W);
        if (ok && !upOpen) push(x, y - 1);
        upOpen = ok;
      }
      if (y < H - 1) {
        const ok = stamps[i + W] !== gen && same(i + W);
        if (ok && !downOpen) push(x, y + 1);
        downOpen = ok;
      }
    }
    if (runStart < x0) x0 = runStart;
    if (x - 1 > x1) x1 = x - 1;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (count > maxPixels) return null;
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w > W * 0.9 && h > H * 0.9) return null;
  // One pixel of margin takes in the usual hairline border.
  const bx = Math.max(0, x0 - 1), by = Math.max(0, y0 - 1);
  return { x: bx, y: by, w: Math.min(W - bx, w + 2), h: Math.min(H - by, h + 2), count };
}

/**
 * Ladder of candidate boxes around the cursor, tight to wide, without near-duplicates.
 * Always ends with a "screen" entry. Returns { boxes, seed, defaultIndex }.
 *
 * Two sources are merged: whitespace-gap expansion from the content under the cursor (word,
 * line, paragraph ...) and flat-colour regions (the button, cell, card or dialog it sits in).
 */
export function snapLadder(img, cx, cy, opts = {}) {
  const o = { ...SNAP_DEFAULTS, ...opts };
  const W = img.width, H = img.height;
  cx = Math.min(W - 1, Math.max(0, Math.round(cx)));
  cy = Math.min(H - 1, Math.max(0, Math.round(cy)));
  const seed = seedPoint(img, cx, cy, o);
  const found = [];
  const usable = (b) => b && b.w >= o.minSide && b.h >= o.minSide && !(b.w > W * o.maxFraction && b.h > H * o.maxFraction);
  const add = (b, kind, gap) => {
    if (!usable(b)) return null;
    const dup = found.find((p) => iou(p, b) > 0.88);
    if (dup) return dup;
    const item = { x: b.x, y: b.y, w: b.w, h: b.h, gap, kind };
    found.push(item);
    return item;
  };

  // The flat area the cursor itself is on: empty space inside a card means the card.
  let own = null;
  if (seed.moved || seed.empty) own = add(regionBox(img, cx, cy, o), 'region', 0);

  if (!seed.empty) {
    let inside = null;
    for (const gap of o.gaps) {
      const { bands, ...b } = expand(img, seed.x, seed.y, gap, { ...o, inside });
      // The flat colour around the tightest box is the element's own backdrop.
      if (!inside) {
        inside = bands.t ?? bands.l ?? bands.b ?? bands.r;
        const side = bands.t ? [seed.x, b.y - 1] : bands.l ? [b.x - 1, seed.y] : bands.b ? [seed.x, b.y + b.h] : bands.r ? [b.x + b.w, seed.y] : null;
        // ... and the connected area of that backdrop is its container (button, cell, card).
        if (side) {
          const container = regionBox(img, Math.min(W - 1, Math.max(0, side[0])), Math.min(H - 1, Math.max(0, side[1])), o);
          if (container && container.w >= b.w && container.h >= b.h) add(container, 'region', 0);
        }
      }
      add(b, 'snap', gap);
    }
  }
  found.sort((a, b) => a.w * a.h - b.w * b.h);
  const boxes = found;
  if (!boxes.length) {
    // Nothing recognisable: a fixed window centred on the cursor is the honest fallback.
    const w = Math.min(W, 480), h = Math.min(H, 320);
    boxes.push({
      x: Math.min(W - w, Math.max(0, cx - (w >> 1))),
      y: Math.min(H - h, Math.max(0, cy - (h >> 1))),
      w, h, gap: 0, kind: 'window',
    });
  }
  boxes.push({ x: 0, y: 0, w: W, h: H, gap: Infinity, kind: 'screen' });

  // Default scope. On empty space inside a container, the container. Otherwise the first box
  // that is more than a single word: words are one wheel notch away, but "this" most often
  // means a line, a control or a block.
  // (A cursor resting in the gap between two words is still pointing at the text.)
  const far = seed.empty || Math.hypot(seed.x - cx, seed.y - cy) > 24;
  let defaultIndex = own && far ? boxes.indexOf(own) : -1;
  if (defaultIndex < 0) defaultIndex = boxes.findIndex((b) => b.kind !== 'screen' && b.w * b.h >= 1200 && Math.min(b.w, b.h) >= 12);
  if (defaultIndex < 0) defaultIndex = 0;
  return { boxes, seed, defaultIndex };
}
