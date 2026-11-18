// The referent store: everything the user has pinned. A referent is a crop of the screen with
// a handle (@1, @2, ...), the place it came from, and a signature for telling later whether the
// screen there still shows the same thing.
import { EventEmitter } from 'node:events';

const MAX = 24;

/** Accepts "@2", "2", "#2", "ptr2", "latest" / "last". Returns a canonical handle or null. */
export function normalizeHandle(input, store) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s || s === 'latest' || s === 'last' || s === '最新') return store.latest()?.handle ?? null;
  const m = /^(?:@|#|ptr|ref)?\s*(\d{1,4})$/.exec(s);
  return m ? '@' + Number(m[1]) : null;
}

export class ReferentStore extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this.counter = 0;
  }

  add(data) {
    const ref = {
      handle: '@' + ++this.counter,
      createdAt: Date.now(),
      state: 'live', // 'live' | 'dangling'
      label: '',
      readers: [], // who has dereferenced it: 'Claude API', 'Claude Code', ...
      ...data,
    };
    this.items.push(ref);
    while (this.items.length > MAX) this.items.shift();
    this.emit('change');
    return ref;
  }

  get(handle) {
    return this.items.find((r) => r.handle === handle) ?? null;
  }

  latest() {
    return this.items.at(-1) ?? null;
  }

  list() {
    return [...this.items];
  }

  remove(handle) {
    const n = this.items.length;
    this.items = this.items.filter((r) => r.handle !== handle);
    if (this.items.length !== n) this.emit('change');
  }

  clear() {
    if (!this.items.length) return;
    this.items = [];
    this.emit('change');
  }

  patch(handle, patch) {
    const ref = this.get(handle);
    if (!ref) return null;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (ref[k] !== v) { ref[k] = v; changed = true; }
    }
    if (changed) this.emit('change');
    return ref;
  }

  /** Record that someone read this referent. Returns true the first time for that reader. */
  noteReader(handle, who) {
    const ref = this.get(handle);
    if (!ref) return false;
    if (ref.readers.includes(who)) return false;
    ref.readers = [...ref.readers, who];
    this.emit('change');
    return true;
  }

  /** What the overlay needs to draw the tray: no image buffers. */
  view() {
    return this.items.map((r) => ({
      handle: r.handle,
      label: r.label,
      state: r.state,
      kind: r.kind,
      box: r.box,
      displayId: r.displayId,
      thumb: r.thumb,
      bytes: r.image.bytes,
      imageSize: r.imageSize,
      readers: r.readers,
      createdAt: r.createdAt,
    }));
  }
}
