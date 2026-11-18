// The built-in brain: a vision-language model running on this machine. Requests go to
// llama-server on 127.0.0.1 (started by LocalRuntime), or to another local OpenAI-compatible
// server the user already runs (Ollama, LM Studio). Nothing here talks to the internet.
//
// One question is two steps:
//   1. answer:    the question plus the pinned crops, streamed as plain text
//   2. locating:  "where is the thing you just talked about?", in the model's native JSON
//                 format, turned into a [[point ...]] tag so the overlay can fly the AI cursor
//                 there. Two ways, measured on 4-core CPU machines with the stock 0.8B model
//                 (docs/benchmarks.md): 'precise' sends an enlarged copy of each crop as a
//                 request of its own, 9 to 25 s, and its points land on the right element in
//                 3 to 4 of 8 questions; 'fast' asks as a follow-up in the same conversation,
//                 2 to 4 s, but missed all 8. So 'precise' is the default.
// Asking for the location separately keeps the first words fast and lets the model use the
// output format it was trained on, which small models follow far better than a custom one.
//
// With the Zhidian pointer adapter loaded (a LoRA trained for exactly this, see train/), step 2
// disappears: the model ends its answer with one JSON line saying where, and that line is kept
// out of the visible text.
import { nativeImage } from 'electron';
import { GROUNDING_SCHEMA, LOCATE_SCHEMA, SYSTEM_PROMPT, SYSTEM_PROMPT_POINTER, SYSTEM_PROMPT_TEXT, buildGroundingMessages, buildUserContent, locateMessage, stripImages } from '../../core/prompt.js';
import { PointerReplyFilter } from '../../core/pointer-reply.js';
import { pointTag } from '../../core/point-tag.js';
import { Thread } from '../../core/thread.js';
import { groundingSize, groundingToPixels, parseGrounding } from '../../core/grounding.js';
import { getModel } from './catalog.js';

const MAX_GROUNDED = 2;

class BrainError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

const dataUrl = (image) => `data:${image.mediaType};base64,${image.buffer.toString('base64')}`;

/** Wait for a promise, but give up as soon as the signal fires. */
function orAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new BrainError('已停止。', 'aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new BrainError('已停止。', 'aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class LocalBrain {
  /** @param {{ runtime: import('./runtime.js').LocalRuntime, getSettings: () => any }} deps */
  constructor(deps) {
    this.deps = deps;
    this.thread = new Thread();
  }

  #cfg() {
    return this.deps.getSettings().local;
  }

  get name() {
    const cfg = this.#cfg();
    if (cfg.mode === 'external') return `本地 ${cfg.externalModel || '模型'}`;
    const m = this.deps.runtime.activeModel();
    return m ? `本地 ${m.label}` : '本地模型';
  }

  available() {
    const cfg = this.#cfg();
    if (cfg.mode === 'external') return Boolean(cfg.externalUrl && cfg.externalModel);
    return this.deps.runtime.ready();
  }

  resetThread() {
    this.thread.reset();
  }

  /** Isolated text reasoning for real document/application context; no screenshot history. */
  async complete({ system, prompt, signal, onText = () => {} }) {
    const ep = await orAborted(this.#endpoint(), signal);
    const input = String(prompt ?? '');
    const boundedPrompt = input.length > 2800 ? input.slice(0, 2740) + '\n（内容已截断，回答只能依据以上摘录，不要声称读完全文。）' : input;
    const result = await this.#stream(ep, {
      model: ep.model, max_tokens: 512, temperature: 0.1,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'system', content: String(system ?? '').slice(0, 500) }, { role: 'user', content: boundedPrompt }],
    }, onText, signal);
    return result.text;
  }

  /** Which of these referents would have their screenshot sent with the next question. */
  pending(refs) {
    return this.thread.plan(refs).attach;
  }

  /** Continue a topic that was with another model (see Thread.adopt). */
  adopt(other, o) {
    if (other?.thread) this.thread.adopt(other.thread, o);
  }

  async #endpoint() {
    const cfg = this.#cfg();
    if (cfg.mode === 'external') {
      return { baseUrl: String(cfg.externalUrl).replace(/\/+$/, ''), apiKey: cfg.externalKey || 'local', model: cfg.externalModel };
    }
    try {
      return await this.deps.runtime.ensureStarted();
    } catch (err) {
      throw new BrainError(err.message, 'local');
    }
  }

  async #post(ep, body, signal) {
    let res;
    try {
      res = await fetch(`${ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new BrainError('已停止。', 'aborted');
      throw new BrainError(`连不上本地模型服务（${ep.baseUrl}）：${err?.cause?.code ?? err?.message ?? err}`, 'local');
    }
    if (!res.ok) {
      let detail = '';
      let type = '';
      try {
        const j = await res.json();
        detail = j?.error?.message ?? JSON.stringify(j).slice(0, 200);
        type = j?.error?.type ?? '';
      } catch {
        detail = `HTTP ${res.status}`;
      }
      const err = new BrainError(`本地模型返回错误：${detail}`, 'local');
      err.status = res.status;
      err.type = type;
      throw err;
    }
    return res;
  }

  /** Stream one chat completion, calling onText for each piece. Resolves to { text, finish }. */
  async #stream(ep, body, onText, signal) {
    const res = await this.#post(ep, { ...body, stream: true }, signal);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let finish = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const piece = choice?.delta?.content;
          if (typeof piece === 'string' && piece) {
            text += piece;
            onText(piece);
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (err) {
      if (signal?.aborted) throw new BrainError('已停止。', 'aborted');
      throw new BrainError(`本地模型的回答中断了：${err?.message ?? err}`, 'local');
    }
    return { text, finish };
  }

  /**
   * @param {object} o
   * @param {string} o.question
   * @param {object[]} o.refs              referents this question names (empty for a follow-up)
   * @param {(handle: string) => object|null} [o.resolve]  look up a referent the model names
   */
  async ask({ question, refs = [], text = false, point = true, resolve, onText, onStatus, signal }) {
    if (!text && refs.length && this.#cfg().mode === 'external' && this.#cfg().externalVision === 'text') {
      throw new BrainError('当前本地模型只支持文字。请使用“当前应用”读取文件和控件，或在设置中选择支持图片的模型。', 'local');
    }
    const settings = this.deps.getSettings();
    const thread = this.thread;
    const generation = thread.generation;
    if (this.#cfg().mode !== 'external' && this.deps.runtime.server.state !== 'ready') onStatus?.('正在加载本地模型…');
    // Loading can take minutes on a cold disk: Stop and Esc must work during it too.
    const ep = await orAborted(this.#endpoint(), signal);
    onStatus?.('');

    const turn = (plan) => ({
      role: 'user',
      content: buildUserContent({
        question,
        newRefs: plan.attach.map((r) => ({ handle: r.handle, state: r.state, dataUrl: dataUrl(r.image) })),
        knownRefs: plan.known,
      }),
    });
    let plan = thread.plan(refs);
    let userMessage = turn(plan);
    const base = { model: ep.model, max_tokens: text ? 900 : 512, temperature: 0.2, cache_prompt: true, chat_template_kwargs: { enable_thinking: false } };
    // One pass (answer plus a JSON line saying where) when the pointer adapter is loaded, or
    // when the user says their own local server runs a model that has it merged in.
    const cfg = this.#cfg();
    // (A question about selected text has no screenshot: nothing to point at, its own prompt.)
    // (So does a picture from a file: it is not on the screen, there is nowhere to point.)
    const onePass = !text && point && (cfg.adapter === 'force' || (cfg.mode !== 'external' && this.deps.runtime.pointerMode()));
    const system = { role: 'system', content: text ? SYSTEM_PROMPT_TEXT : onePass ? SYSTEM_PROMPT_POINTER : SYSTEM_PROMPT };
    let filter = onePass ? new PointerReplyFilter(onText) : null;
    const visible = (piece) => (filter ? filter.push(piece) : onText(piece));

    const tAsk = Date.now();
    let sent = [system, ...plan.history, userMessage];
    let out;
    try {
      out = await this.#stream(ep, { ...base, messages: sent }, visible, signal);
    } catch (err) {
      // Too much history for the context window: ask again with this turn alone, and with the
      // screenshots it is about attached again, since the earlier turns that carried them are gone.
      if (err.status === 400 && thread.length && !signal?.aborted && thread.generation === generation) {
        if (filter) filter = new PointerReplyFilter(onText);
        thread.clear();
        plan = thread.plan(refs);
        userMessage = turn(plan);
        sent = [system, userMessage];
        out = await this.#stream(ep, { ...base, messages: sent }, visible, signal);
      } else {
        throw err;
      }
    }
    const answerMs = Date.now() - tAsk;
    const pointAt = (json) => this.#tagFromReply(json, plan.targets, plan.visible, resolve);
    let pointed = false;
    if (filter) {
      const { answer, json } = filter.finish();
      const tag = settings.pointBack && json ? pointAt(json) : '';
      if (tag) {
        onText(tag);
        pointed = true;
      }
      out.text = answer;
    }
    // "New topic" or "clear" while this was streaming: the answer belongs to a conversation
    // that no longer exists, and must not become the first exchange of the new one.
    const current = thread.generation === generation;
    if (current) thread.commit(userMessage, out.text, plan.attach, plan.targets);

    if (current && !text && point && settings.pointBack && !pointed && out.text.trim() && !signal?.aborted && plan.targets.length) {
      onStatus?.('正在定位…');
      try {
        const tags = cfg.locate === 'precise'
          ? await this.#locatePrecise(ep, plan.targets.slice(0, MAX_GROUNDED), question, out.text, signal)
          : await this.#locateFast(ep, sent, pointAt, question, out.text, signal);
        for (const tag of tags) onText(tag);
      } catch {
        // A failed pointer is not worth failing the answer for.
      }
      onStatus?.('');
    }
    return {
      stopReason: out.finish || 'stop',
      model: ep.model,
      note: out.finish === 'length' ? '回答因长度上限被截断。' : '',
      passes: onePass ? 1 : 2,
      answerMs, // until the answer finished streaming
      locateMs: Date.now() - tAsk - answerMs, // the separate "where is it" requests, 0 in one pass
      sent: plan.attach.map((r) => r.handle), // screenshots that went out with this question
      sentBytes: plan.attach.reduce((n, r) => n + r.image.bytes, 0),
      sentFraction: plan.attach.reduce((n, r) => n + (r.screenFraction ?? 0), 0),
    };
  }

  /** Turn the model's JSON line into a tag (see src/core/point-tag.js for the rules). */
  #tagFromReply(json, targets, visible, resolve) {
    return pointTag(json, targets, visible, resolve);
  }

  /** One short follow-up in the same conversation: which screenshot, and where in it. */
  async #locateFast(ep, sent, pointAt, question, answer, signal) {
    const body = {
      model: ep.model,
      messages: [...sent, { role: 'assistant', content: answer }, locateMessage(question, answer)],
      max_tokens: 96,
      temperature: 0,
      stream: false,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
    };
    let res;
    try {
      res = await this.#post(ep, { ...body, response_format: { type: 'json_schema', json_schema: { name: 'location', schema: LOCATE_SCHEMA } } }, signal);
    } catch (err) {
      if (err.status !== 400) throw err;
      res = await this.#post(ep, body, signal); // a server without schema-constrained output
    }
    const text = (await res.json())?.choices?.[0]?.message?.content ?? '';
    const tag = pointAt(text);
    return tag ? [tag] : [];
  }

  /** The slower, per-crop way: send an enlarged copy of each crop and ask where the answer is. */
  async #locatePrecise(ep, refs, question, answer, signal) {
    const tags = [];
    for (const ref of refs) {
      const tag = await this.#ground(ep, ref, question, answer, signal);
      if (tag) tags.push(tag);
    }
    return tags;
  }

  /** Ask where in one referent the answer points. Returns a [[point ...]] / [[box ...]] tag or ''. */
  async #ground(ep, ref, question, answer, signal) {
    const targetPixels = Number(this.#cfg().groundPixels) || (this.deps.runtime.activeModel()?.groundPixels ?? 1_050_000);
    const size = groundingSize(ref.imageSize.w, ref.imageSize.h, { targetPixels });
    const img = nativeImage.createFromBuffer(ref.image.buffer).resize({ width: size.w, height: size.h, quality: 'best' });
    const url = 'data:image/jpeg;base64,' + img.toJPEG(92).toString('base64');
    const body = {
      model: ep.model,
      messages: buildGroundingMessages({ question, answer, dataUrl: url }),
      max_tokens: 96,
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    };
    let res;
    try {
      res = await this.#post(ep, { ...body, response_format: { type: 'json_schema', json_schema: { name: 'location', schema: GROUNDING_SCHEMA } } }, signal);
    } catch (err) {
      if (err.status !== 400) throw err;
      res = await this.#post(ep, body, signal); // a server without schema-constrained output
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    const px = groundingToPixels(parseGrounding(text), size, ref.imageSize);
    if (!px) return '';
    const label = String(px.label ?? '').replace(/[|\]\[\n]/g, ' ').trim().slice(0, 24);
    return px.kind === 'box'
      ? `[[box ${ref.handle} ${px.x} ${px.y} ${px.w} ${px.h} | ${label}]]`
      : `[[point ${ref.handle} ${px.x} ${px.y} | ${label}]]`;
  }

  /** For the settings window: is the configured local server answering, and with which models? */
  static async probe(baseUrl, apiKey = 'local') {
    try {
      const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const j = await res.json();
      return { ok: true, models: (j.data ?? []).map((m) => m.id).slice(0, 50) };
    } catch (err) {
      return { ok: false, error: String(err?.cause?.code ?? err?.message ?? err) };
    }
  }
}

export { getModel };
