// A hidden page that does the two jobs only a browser engine does well: drawing PDF pages (with
// pdf.js) and decoding image formats. The main process calls window.cw.* and gets plain data back.
// Everything it loads comes from the app itself through the zhidian:// scheme; it has no access
// to the network or to Node.
import * as pdfjs from '../pdfjs/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../pdfjs/build/pdf.worker.min.mjs', import.meta.url).href;
const ASSETS = new URL('../pdfjs/', import.meta.url).href;

let pdf = null;
let task = null; // the loading task owns the document: destroying it frees everything

function toCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

window.cw = {
  ready: true,

  async openPdf(url) {
    await this.closePdf();
    task = pdfjs.getDocument({ url, cMapUrl: ASSETS + 'cmaps/', cMapPacked: true, standardFontDataUrl: ASSETS + 'standard_fonts/', wasmUrl: ASSETS + 'wasm/', iccUrl: ASSETS + 'iccs/' });
    try {
      pdf = await task.promise;
      return pdf.numPages;
    } catch (err) {
      await this.closePdf();
      throw err;
    }
  },

  /** One page as a JPEG data URL, its longer edge about `maxEdge` pixels. */
  async renderPage(number, maxEdge = 1600, quality = 0.88) {
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxEdge / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = toCanvas(viewport.width, viewport.height);
    try {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      return { dataUrl: canvas.toDataURL('image/jpeg', quality), w: canvas.width, h: canvas.height, points: { w: base.width, h: base.height } };
    } finally {
      canvas.width = canvas.height = 1;
      page.cleanup();
    }
  },

  /** The text of one page, lines rebuilt from the positions of the pieces. */
  async pageText(number) {
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent();
      let text = '';
      let lastY = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
        text += item.str;
        if (item.hasEOL && !text.endsWith('\n')) text += '\n';
        lastY = y;
      }
      return text;
    } finally {
      page.cleanup();
    }
  },

  async closePdf() {
    const old = task;
    pdf = null;
    task = null;
    if (old) await old.destroy().catch(() => {});
  },

  /** Any image the browser can read (webp, gif, bmp, ...) as a PNG data URL. */
  async decodeImage(url, maxEdge = 2400) {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) throw new Error('empty image');
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = toCanvas(img.naturalWidth * scale, img.naturalHeight * scale);
    try {
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
    } finally {
      canvas.width = canvas.height = 1;
    }
  },

  // ---- pictures (src/main/office/tools-image.js, through `canvas` in src/main/office/render.js)
  //
  // What can be expected to go wrong comes back as data, { error: 'unreadable' | 'large', ... },
  // for the main process to put into words. An encoded picture stays here under an id and is
  // fetched in pieces with resultPiece(), so that a large one never has to cross in one message.

  /**
   * The size of a picture, and whether any of its pixels is transparent.
   * @param {boolean} [opaque]  the caller knows there is no transparency (a JPEG): do not look
   */
  async measureImage(url, opaque = false) {
    const img = await loadImage(url);
    if (!img) return { error: 'unreadable' };
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!fitsCanvas(w, h)) return { error: 'large', w, h };
    return { w, h, alpha: !opaque && seesThrough(img) };
  },

  /**
   * Encode a picture again, made smaller if its longer edge is over `maxEdge` (0: as it is).
   * @param {{ maxEdge?: number, type?: 'jpeg' | 'png' | 'auto', quality?: number, opaque?: boolean }} [o]
   *   'auto' is PNG for a picture with transparent pixels and JPEG for any other; in a JPEG,
   *   what was transparent is white
   * @returns {Promise<{ id, bytes, w, h, type: 'jpeg' | 'png', srcW, srcH, alpha } | { error }>}
   */
  async encodeImage(url, { maxEdge = 0, type = 'auto', quality = 0.9, opaque = false } = {}) {
    const img = await loadImage(url);
    if (!img) return { error: 'unreadable' };
    const srcW = img.naturalWidth, srcH = img.naturalHeight;
    if (!fitsCanvas(srcW, srcH)) return { error: 'large', w: srcW, h: srcH };
    const alpha = !opaque && seesThrough(img);
    const as = type === 'auto' ? (alpha ? 'png' : 'jpeg') : type;
    const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(srcW, srcH)) : 1;
    const canvas = toCanvas(srcW * scale, srcH * scale);
    paint(canvas, (as === 'png' || as === 'webp') && alpha).drawImage(img, 0, 0, canvas.width, canvas.height);
    const made = await keep(canvas, as, quality);
    return made.error ? made : { ...made, srcW, srcH, alpha };
  },

  /**
   * Several pictures one under another, each drawn `width` wide and as tall as `heights` says.
   * @param {string[]} urls
   * @param {{ width: number, heights: number[], type?: 'jpeg' | 'png' | 'webp', quality?: number }} o
   * @returns {Promise<{ id, bytes, w, h, type } | { error, index? }>}
   */
  async stackImages(urls, { width, heights, type = 'jpeg', quality = 0.9 }) {
    const total = heights.reduce((sum, h) => sum + h, 0);
    if (!fitsCanvas(width, total)) return { error: 'large', w: width, h: total };
    const canvas = toCanvas(width, total);
    const ctx = paint(canvas, type === 'png' || type === 'webp');
    let y = 0;
    for (let i = 0; i < urls.length; i++) {
      const img = await loadImage(urls[i]);
      if (!img) {
        canvas.width = canvas.height = 1;
        return { error: 'unreadable', index: i };
      }
      ctx.drawImage(img, 0, y, width, heights[i]);
      y += heights[i];
    }
    return keep(canvas, type, quality);
  },

  /** Bytes `from` to `to` of an encoded picture. */
  async resultPiece(id, from, to) {
    const blob = kept.get(id);
    if (!blob) throw new Error('no such result');
    return new Uint8Array(await blob.slice(from, to).arrayBuffer());
  },

  dropResult(id) {
    kept.delete(id);
  },
};

const kept = new Map(); // encoded pictures waiting to be fetched: id -> Blob
let keptCount = 0;

/** A picture file as an image element, or null if the engine cannot read it. */
async function loadImage(url) {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  return img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null;
}

/** The engine's limits for a canvas: beyond them it stays blank. */
const fitsCanvas = (w, h) => w <= 65535 && h <= 65535 && w * h <= 16384 * 16384;

/** Whether any pixel lets what is behind it show through. Every pixel is looked at, band by band. */
function seesThrough(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const rows = Math.max(1, Math.min(h, Math.floor(4_000_000 / w)));
  const band = toCanvas(w, rows);
  try {
    const ctx = band.getContext('2d', { willReadFrequently: true });
    for (let y = 0; y < h; y += rows) {
      ctx.clearRect(0, 0, w, rows);
      ctx.drawImage(img, 0, -y);
      const data = ctx.getImageData(0, 0, w, Math.min(rows, h - y)).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
    }
    return false;
  } finally {
    band.width = band.height = 1;
  }
}

/**
 * The drawing context of a fresh canvas. One that is not to be seen through is white underneath
 * and has no transparency at all: encoded as PNG it has no alpha channel either.
 */
function paint(canvas, seenThrough) {
  const ctx = canvas.getContext('2d', { alpha: seenThrough });
  if (!seenThrough) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Encode a canvas and keep the bytes for resultPiece(). */
async function keep(canvas, type, quality) {
  const outType = type === 'png' ? 'png' : type === 'webp' ? 'webp' : 'jpeg';
  const mime = outType === 'png' ? 'image/png' : outType === 'webp' ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  const w = canvas.width, h = canvas.height;
  canvas.width = canvas.height = 1; // give the pixels back now, not when the canvas is collected
  if (!blob) return { error: 'large', w, h };
  const id = ++keptCount;
  kept.set(id, blob);
  return { id, bytes: blob.size, w, h, type: outType };
}
