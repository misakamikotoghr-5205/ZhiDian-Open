// Streaming parser for the inline tags the model uses to name referents and to point back.
//
//   [[name @1 | error dialog]]
//   [[point @1 412 188 | Retry button]]
//   [[box @2 40 60 200 32 | total price]]
//
// Text arrives in arbitrary chunks, so a tag can be split anywhere. The parser holds back an
// unfinished tag (up to MAX_TAG characters) and releases everything else immediately.

const MAX_TAG = 240;
const TAG_RE = /^\s*(name|point|box)\s+(@[A-Za-z0-9_]+)\s*([^|]*?)\s*(?:\|\s*([\s\S]*?))?\s*$/i;

export function parseTag(body) {
  const m = TAG_RE.exec(body);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const ref = m[2];
  const nums = m[3].split(/[\s,]+/).filter(Boolean).map(Number);
  const label = (m[4] ?? '').trim();
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (type === 'name') return nums.length === 0 && label ? { type, ref, label } : null;
  if (type === 'point') return nums.length === 2 ? { type, ref, x: nums[0], y: nums[1], label } : null;
  if (type === 'box') {
    return nums.length === 4 && nums[2] > 0 && nums[3] > 0
      ? { type, ref, x: nums[0], y: nums[1], w: nums[2], h: nums[3], label }
      : null;
  }
  return null;
}

export class TagStream {
  constructor() {
    this.buf = '';
  }

  /** Feed a chunk; returns segments in order: {type:'text', text} or {type:'tag', tag}. */
  push(chunk) {
    this.buf += chunk;
    return this.#drain(false);
  }

  /** Call once at the end of the stream; releases anything still held back as plain text. */
  flush() {
    return this.#drain(true);
  }

  #drain(final) {
    const out = [];
    const text = (t) => {
      if (!t) return;
      const last = out[out.length - 1];
      if (last && last.type === 'text') last.text += t;
      else out.push({ type: 'text', text: t });
    };
    for (;;) {
      const open = this.buf.indexOf('[[');
      if (open < 0) {
        // A lone trailing "[" may be the first half of "[[": hold it until the next chunk.
        if (!final && this.buf.endsWith('[')) {
          text(this.buf.slice(0, -1));
          this.buf = '[';
        } else {
          text(this.buf);
          this.buf = '';
        }
        break;
      }
      text(this.buf.slice(0, open));
      const close = this.buf.indexOf(']]', open + 2);
      if (close < 0) {
        const pending = this.buf.slice(open);
        if (final || pending.length > MAX_TAG) {
          text(pending); // not a tag after all
          this.buf = '';
        } else {
          this.buf = pending;
        }
        break;
      }
      const body = this.buf.slice(open + 2, close);
      const tag = body.length <= MAX_TAG ? parseTag(body) : null;
      if (tag) out.push({ type: 'tag', tag });
      else text(this.buf.slice(open, close + 2));
      this.buf = this.buf.slice(close + 2);
    }
    return out;
  }
}

/** Handles such as @1 or @12 mentioned in a question, in order of first appearance. */
export function mentionedHandles(question) {
  const seen = new Set();
  for (const m of String(question).matchAll(/@(\d{1,3})(?!\w)/g)) seen.add('@' + Number(m[1]));
  return [...seen];
}
