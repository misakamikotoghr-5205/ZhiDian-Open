// Replays answers the real local model gave in a recorded self-check run, with the recorded
// timing and the recorded point. It exists for one purpose: recording a demonstration on a
// machine that cannot run the model. It never claims to be live: its name ends in "回放" and the
// answer bubble carries a "回放" badge.
//
//   ZHIDIAN_BRAIN=replay ZHIDIAN_REPLAY=recording.json npm start
//
// recording.json:
//   { "model": "Qwen3.5-0.8B + 指针适配器", "source": "CI run ..., Windows, 4-core CPU",
//     "offset": { "x": 1, "y": 20 },      where the recorded page sits on this screen
//     "cases": [{ "question": "...", "answer": "...", "first_ms": 3100, "answer_ms": 4200,
//                 "point": { "x": 1012, "y": 251, "label": "重试" } }] }   page coordinates
import fs from 'node:fs';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject({ kind: 'aborted', message: '已停止。' });
    }, { once: true });
  });

export class ReplayBrain {
  constructor(file) {
    this.data = { model: '本地模型', source: '', offset: { x: 0, y: 0 }, cases: [] };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      // no recording: every question gets the "nothing recorded" answer below
    }
    this.shown = new Set();
    this.calls = [];
  }

  get name() {
    return `本地 ${this.data.model} · 回放`;
  }

  available() {
    return true;
  }

  resetThread() {
    this.shown.clear();
  }

  pending(refs) {
    return refs.filter((r) => !this.shown.has(r.handle));
  }

  async ask({ question, refs = [], onText, signal }) {
    const q = String(question ?? '').trim();
    const norm = (s) => s.replace(/\s+/g, '');
    const found = this.data.cases.find((c) => norm(c.question) === norm(q)) ?? this.data.cases.find((c) => norm(q) && (norm(c.question).includes(norm(q)) || norm(q).includes(norm(c.question))));
    this.calls.push({ question: q, found: Boolean(found) });
    const sent = this.pending(refs).map((r) => r.handle);
    if (!found) {
      onText('（这段录制里没有这个问题的记录。）');
      return { stopReason: 'stop', model: 'replay', note: '', sent };
    }
    // The handles in the recording belong to that run (its first referent may have been @3);
    // say the same thing about the things pinned now, in the same order.
    const recorded = found.handles?.length ? found.handles : [...new Set(found.answer.match(/@\d+/g) ?? [])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    // When the recording names fewer things than are pinned now, it named the last ones.
    const shift = Math.max(0, refs.length - recorded.length);
    let answer = found.answer;
    recorded.forEach((h, i) => {
      if (refs[i + shift]) answer = answer.split(h).join(`\u0000${i + shift}\u0000`);
    });
    answer = answer.replace(/\u0000(\d+)\u0000/g, (_m, i) => refs[Number(i)].handle);

    await sleep(Math.max(0, found.first_ms ?? 0), signal);
    const chars = [...answer];
    const each = Math.max(8, ((found.answer_ms ?? 0) - (found.first_ms ?? 0)) / Math.max(1, chars.length));
    for (const ch of chars) {
      if (signal?.aborted) throw { kind: 'aborted', message: '已停止。' };
      onText(ch);
      await sleep(each, signal);
    }
    if (found.point && refs.length) {
      // The recorded point is in the coordinates of the page; find the pinned thing it is in.
      const sx = found.point.x + (this.data.offset?.x ?? 0), sy = found.point.y + (this.data.offset?.y ?? 0);
      const ref = refs.find((r) => sx >= r.cropBox.x && sx <= r.cropBox.x + r.cropBox.w && sy >= r.cropBox.y && sy <= r.cropBox.y + r.cropBox.h) ?? null;
      if (found.locate_ms) await sleep(found.locate_ms, signal);
      if (ref) {
        const ix = Math.round(((sx - ref.cropBox.x) / ref.cropBox.w) * ref.imageSize.w);
        const iy = Math.round(((sy - ref.cropBox.y) / ref.cropBox.h) * ref.imageSize.h);
        onText(`[[point ${ref.handle} ${ix} ${iy} | ${String(found.point.label ?? '').replace(/[|\]\[\n]/g, ' ').slice(0, 24)}]]`);
      }
    }
    for (const h of sent) this.shown.add(h);
    return { stopReason: 'stop', model: 'replay', note: '', sent, passes: found.passes ?? 1, answerMs: found.answer_ms ?? 0, locateMs: found.locate_ms ?? 0 };
  }
}
