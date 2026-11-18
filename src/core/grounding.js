// Parsing of a vision model's grounding output ("where is it?").
//
// The Qwen3-VL / Qwen3.5 line answers with JSON such as {"point_2d": [x, y], "label": "..."} or
// {"bbox_2d": [x1, y1, x2, y2], "label": "..."}, with coordinates on a 0-1000 grid relative to
// the image that was sent, whatever its pixel size. Small models rename keys, wrap the JSON in
// code fences or return a list, so this parser is deliberately forgiving.

const POINT_KEYS = ['point_2d', 'point', 'coordinate', 'coordinates', 'click', 'position', 'center'];
const BOX_KEYS = ['bbox_2d', 'bbox', 'box', 'bounding_box'];
const GEMMA_BOX_KEYS = ['box_2d']; // [y1, x1, y2, x2]

const nums = (v, n) => (Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : null);

function fromObject(o) {
  if (!o || typeof o !== 'object') return null;
  const label = typeof o.label === 'string' ? o.label : typeof o.text === 'string' ? o.text : typeof o.name === 'string' ? o.name : '';
  for (const k of POINT_KEYS) {
    const p = nums(o[k], 2);
    if (p) return { kind: 'point', x: p[0], y: p[1], label };
  }
  for (const k of BOX_KEYS) {
    const b = nums(o[k], 4);
    if (b) return box(b[0], b[1], b[2], b[3], label);
  }
  for (const k of GEMMA_BOX_KEYS) {
    const b = nums(o[k], 4);
    if (b) return box(b[1], b[0], b[3], b[2], label);
  }
  if (Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.y)) && o.x !== null && o.y !== null) {
    return { kind: 'point', x: Number(o.x), y: Number(o.y), label };
  }
  if (o.arguments) return fromObject(o.arguments);
  return null;
}

function box(x1, y1, x2, y2, label) {
  const x = Math.min(x1, x2), y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  if (w < 1 || h < 1) return { kind: 'point', x: x + w / 2, y: y + h / 2, label };
  return { kind: 'box', x, y, w, h, label };
}

/** Every balanced {...} or [...] substring that parses as JSON, outermost first. */
function jsonCandidates(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try {
          out.push(JSON.parse(text.slice(i, j + 1)));
          i = j;
        } catch {
          // not JSON: keep scanning from the next character
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Returns { kind: 'point', x, y, label } or { kind: 'box', x, y, w, h, label } in the units the
 * model used (normally the 0-1000 grid), or null when the text holds no usable location.
 */
export function parseGrounding(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const cand of jsonCandidates(text)) {
    const list = Array.isArray(cand) ? cand : [cand];
    // A bare [x, y] or [x1, y1, x2, y2] list.
    const p = nums(cand, 2);
    if (p) return { kind: 'point', x: p[0], y: p[1], label: '' };
    const b = nums(cand, 4);
    if (b) return box(b[0], b[1], b[2], b[3], '');
    for (const item of list) {
      const hit = fromObject(item);
      if (hit) return hit;
    }
  }
  // Last resort: "(412, 188)" style text.
  const m = /\(?\s*(\d{1,4}(?:\.\d+)?)\s*,\s*(\d{1,4}(?:\.\d+)?)\s*\)?/.exec(text);
  return m ? { kind: 'point', x: Number(m[1]), y: Number(m[2]), label: '' } : null;
}

/**
 * Convert a parsed location to pixels of an image of the given size.
 * `sent` is the pixel size of the image the model actually saw, `target` the size to express the
 * result in (they share the same aspect ratio). Values are read as the 0-1000 grid; if any of
 * them is above 1000 the model must have answered in pixels of the image it saw.
 * Returns null if the location falls clearly outside the image.
 */
export function groundingToPixels(g, sent, target = sent) {
  if (!g) return null;
  const vals = g.kind === 'box' ? [g.x, g.y, g.x + g.w, g.y + g.h] : [g.x, g.y];
  const absolute = vals.some((v) => v > 1000);
  const sx = absolute ? target.w / sent.w : target.w / 1000;
  const sy = absolute ? target.h / sent.h : target.h / 1000;
  const x = g.x * sx, y = g.y * sy;
  const slack = 0.03;
  const inside = (px, py) => px >= -target.w * slack && py >= -target.h * slack && px <= target.w * (1 + slack) && py <= target.h * (1 + slack);
  const clampX = (v) => Math.min(target.w, Math.max(0, v));
  const clampY = (v) => Math.min(target.h, Math.max(0, v));
  if (g.kind === 'box') {
    const w = g.w * sx, h = g.h * sy;
    if (!inside(x, y) || !inside(x + w, y + h)) return null;
    const x0 = clampX(x), y0 = clampY(y);
    return { kind: 'box', x: Math.round(x0), y: Math.round(y0), w: Math.round(clampX(x + w) - x0), h: Math.round(clampY(y + h) - y0), label: g.label };
  }
  if (!inside(x, y)) return null;
  return { kind: 'point', x: Math.round(clampX(x)), y: Math.round(clampY(y)), label: g.label };
}

/**
 * Size to send an image at for a grounding request. Small crops are enlarged so the model gets
 * enough image tokens to localise precisely (llama.cpp's own advice for the Qwen-VL line is at
 * least 1024 tokens, which is about a megapixel at 32 px per token), without blowing up tiny
 * crops by more than `maxScale`. Both sides are multiples of 32 so the server does not resize again.
 */
export function groundingSize(w, h, { targetPixels = 1_050_000, maxScale = 4, maxEdge = 1792, patch = 32 } = {}) {
  let scale = Math.sqrt(targetPixels / (w * h));
  scale = Math.min(scale, maxScale, maxEdge / Math.max(w, h));
  scale = Math.max(scale, Math.min(1, maxEdge / Math.max(w, h)));
  const round = (v) => Math.max(patch, Math.round((v * scale) / patch) * patch);
  return { w: round(w), h: round(h) };
}
