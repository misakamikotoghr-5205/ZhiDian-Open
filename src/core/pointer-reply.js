// One-pass replies from the pointer adapter look like
//
//     @2 更便宜，便宜 400 元。
//     {"ref": "@2", "point_2d": [217, 602], "label": "¥ 3,899"}
//
// The answer should appear as it streams; the JSON line should never be shown. This filter
// releases text as it arrives but holds back anything that could still turn out to be the start
// of that last line.

const TAIL_RE = /\n?[ \t]*(\{[^{}\n]*"point_2d"[^{}\n]*\})\s*$/;

export function splitPointerReply(text) {
  const m = TAIL_RE.exec(text);
  if (!m) return { answer: text.trim(), json: '' };
  return { answer: text.slice(0, m.index).trim(), json: m[1] };
}

export class PointerReplyFilter {
  /** @param {(text: string) => void} onText receives the visible part, in order, exactly once */
  constructor(onText) {
    this.onText = onText;
    this.all = '';
    this.shown = 0;
  }

  push(piece) {
    this.all += piece;
    const a = this.all;
    let upTo;
    if (/^\s*\{/.test(a)) {
      upTo = 0; // a reply that is nothing but JSON so far
    } else {
      // Look at the last line that has anything on it. If it could be the JSON line, hold back
      // from the line break before it; a line break or spaces after it change nothing. Trailing
      // white space is held back too, because the JSON line may be what comes next.
      const body = a.replace(/\s+$/, '');
      const nl = body.lastIndexOf('\n');
      upTo = nl >= 0 && /^[ \t]*\{/.test(body.slice(nl + 1)) ? nl : body.length;
    }
    if (upTo > this.shown) {
      this.onText(a.slice(this.shown, upTo));
      this.shown = upTo;
    }
  }

  /** Call when the stream ends. Releases held-back text that was not the JSON line. */
  finish() {
    const { json } = splitPointerReply(this.all);
    const cut = json ? this.all.lastIndexOf(json) : this.all.length;
    const rest = this.all.slice(this.shown, Math.max(this.shown, cut)).replace(/\s+$/, '');
    if (rest) this.onText(rest);
    this.shown = this.all.length;
    return { answer: this.all.slice(0, cut).trim(), json };
  }
}
