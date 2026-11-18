// Tiny software rasteriser for building synthetic "screenshots" in tests.
export function makeImage(width, height, color = [255, 255, 255]) {
  const data = new Uint8Array(width * height * 4);
  const img = { data, width, height };
  fill(img, 0, 0, width, height, color);
  return img;
}

export function fill(img, x, y, w, h, [r, g, b]) {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
      const o = (yy * img.width + xx) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
}

export function stroke(img, x, y, w, h, color) {
  fill(img, x, y, w, 1, color);
  fill(img, x, y + h - 1, w, 1, color);
  fill(img, x, y, 1, h, color);
  fill(img, x + w - 1, y, 1, h, color);
}

/** Draw fake text: rows of dark "words". Returns the word boxes per line. */
export function textBlock(img, x, y, { lines = 3, wordsPerLine = 5, wordW = 40, wordH = 12, space = 5, lineGap = 8, color = [30, 30, 30] } = {}) {
  const out = [];
  for (let l = 0; l < lines; l++) {
    const row = [];
    for (let w = 0; w < wordsPerLine; w++) {
      const bx = x + w * (wordW + space);
      const by = y + l * (wordH + lineGap);
      // Make words non-uniform inside, like glyphs: alternate columns.
      for (let c = 0; c < wordW; c += 2) fill(img, bx + c, by, 1, wordH, color);
      fill(img, bx, by + (wordH >> 1), wordW, 1, color);
      row.push({ x: bx, y: by, w: wordW, h: wordH });
    }
    out.push(row);
  }
  return out;
}

export const approx = (a, b, tol = 2) =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol * 2 && Math.abs(a.h - b.h) <= tol * 2;
