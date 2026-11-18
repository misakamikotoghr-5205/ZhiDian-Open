// A stand-in brain for rehearsing the interaction without a key or a network, and for the
// automated tests. It never claims to be a model: the overlay labels its answers as scripted.
// Start the app with `npm run rehearse` (or ZHIDIAN_BRAIN=fake) to use it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FakeBrain {
  constructor() {
    this.thread = [];
    this.shown = new Set(); // handles whose screenshot this conversation has been given
    this.calls = [];
  }

  get name() {
    return '排练脚本';
  }

  available() {
    return true;
  }

  resetThread() {
    this.thread = [];
    this.shown.clear();
  }

  /** Which of these referents would have their screenshot sent with the next question. */
  pending(refs) {
    return refs.filter((r) => !this.shown.has(r.handle));
  }

  async ask({ question, refs = [], text: about = false, onText, signal }) {
    const newRefs = this.pending(refs);
    const knownRefs = refs.filter((r) => this.shown.has(r.handle));
    this.calls.push({ question, newRefs: newRefs.map((r) => r.handle), knownRefs: knownRefs.map((r) => r.handle) });
    let text = newRefs.map((r) => `[[name ${r.handle} | 屏幕片段 ${r.imageSize.w}×${r.imageSize.h}]]`).join('');
    text += '【排练脚本，不是模型的回答】';
    if (about) {
      text += `收到一段选中的文字。真实模型会按要求处理它（这里的要求是：${question.split('\n')[0].slice(0, 40)}）。`;
    } else if (!refs.length) {
      text += this.thread.length ? '这是接着上一个话题的追问，真实模型会结合前面的截图继续回答。' : '还没有钉住任何东西。先指一下，再问我。';
    } else if (refs.length === 1) {
      const r = refs[0];
      text += `你指的是 ${r.handle}。真实模型会在这里解释它，并像这样指回去 `;
      text += `[[point ${r.handle} ${Math.round(r.imageSize.w / 2)} ${Math.round(r.imageSize.h / 2)} | 这里]]。`;
    } else {
      const [a, b] = refs;
      text += `你钉住了 ${refs.map((r) => r.handle).join('、')}。真实模型会比较它们，并分别指回去 `;
      text += `[[point ${a.handle} ${Math.round(a.imageSize.w / 2)} ${Math.round(a.imageSize.h / 2)} | 这个]] 和 `;
      text += `[[box ${b.handle} ${Math.round(b.imageSize.w * 0.2)} ${Math.round(b.imageSize.h * 0.2)} ${Math.round(b.imageSize.w * 0.6)} ${Math.round(b.imageSize.h * 0.6)} | 那个]]。`;
    }
    if (question && !about) text += `（你的问题：${question}）`;

    // Stream in small, uneven chunks so tag splitting gets exercised.
    for (let i = 0; i < text.length; ) {
      if (signal?.aborted) throw { kind: 'aborted', message: '已停止。' };
      const n = 3 + ((i * 7) % 5);
      onText(text.slice(i, i + n));
      i += n;
      await sleep(12);
    }
    this.thread.push({ role: 'user', content: question }, { role: 'assistant', content: text });
    for (const r of newRefs) this.shown.add(r.handle);
    return { stopReason: 'end_turn', model: 'rehearsal-script', usage: { input: 0, output: 0 }, note: '', sent: newRefs.map((r) => r.handle) };
  }
}
