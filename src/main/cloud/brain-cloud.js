// The optional brain on the network: a far larger model than the one that fits on a laptop, for
// the questions the local one answers badly. It is off until the user turns it on and gives it a
// key in the settings window, and nothing in this file runs before that.
//
// What leaves the computer is exactly what the local model would have been shown: the question
// and the crops the user pinned (never the whole screen), and for a question about selected
// text, that text. The overlay says so before the question is sent, with the name of the host.
//
// Two wire formats:
//   anthropic  Claude, through the official SDK (@anthropic-ai/sdk): streaming, one pass (the
//              answer ends with a JSON line saying where, like the local pointer adapter), and
//              optionally the server-side web search tool.
//   openai     any service that speaks the OpenAI chat-completions format; the user gives the
//              address and the model name.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT_CLOUD, SYSTEM_PROMPT_CLOUD_POINTER, SYSTEM_PROMPT_CLOUD_TEXT, buildUserContent } from '../../core/prompt.js';
import { PointerReplyFilter } from '../../core/pointer-reply.js';
import { pointTag } from '../../core/point-tag.js';
import { Thread } from '../../core/thread.js';
import { endpointOf, sourceLines, sourcesOf, sseJson, supportsEffort, supportsFallbacks, supportsWebSearch, toAnthropicMessages } from '../../core/cloud-wire.js';

const MAX_TOKENS = 16000; // thinking and the answer together; the answer itself is a few sentences
const MAX_PAUSES = 3; // how often a turn paused by a server-side tool is continued
const EFFORTS = new Set(['low', 'medium', 'high']);
const SENT_HEADERS = /^(content-type|content-length|accept|user-agent|anthropic-version|anthropic-beta|x-stainless-[\w-]+|x-api-key|authorization)$/i;

class BrainError extends Error {
  constructor(message, kind = 'cloud') {
    super(message);
    this.kind = kind;
  }
}

const dataUrl = (image) => `data:${image.mediaType};base64,${image.buffer.toString('base64')}`;
const brief = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

async function* chunksOf(body) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

/** A failed HTTP status as a sentence for the person, naming the host it came from. */
function statusProblem(status, detail, ep) {
  if (status === 401) return `${ep.host} 不接受这把密钥（401）。请在设置里检查密钥。`;
  if (status === 402) return `${ep.host} 提示账户余额不足（402）。`;
  if (status === 403) return `这把密钥没有权限使用 ${ep.model}（403）。${brief(detail)}`;
  if (status === 404) return `${ep.host} 上没有找到模型 ${ep.model}（404）。请在设置里检查模型名和服务地址。`;
  if (status === 429) return `请求太频繁，或者额度用完了（429）。稍后再试。`;
  if (status >= 500) return `${ep.host} 暂时出错（${status}），请稍后再试。`;
  return `${ep.host} 不接受这次请求（${status}）：${brief(detail) || '没有给出原因'}`;
}

/** An error from the Anthropic SDK as a BrainError. Most specific class first. */
function fromSdk(err, ep, signal) {
  if (err instanceof BrainError) return err;
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return new BrainError('已停止。', 'aborted');
  let out;
  if (err instanceof Anthropic.APIConnectionTimeoutError) out = new BrainError(`连接 ${ep.host} 超时。请检查网络或系统代理。`);
  else if (err instanceof Anthropic.APIConnectionError) out = new BrainError(`连不上 ${ep.host}。请检查网络或系统代理。`);
  else if (err instanceof Anthropic.APIError) out = new BrainError(statusProblem(err.status ?? 0, err.error?.error?.message ?? err.message, ep));
  else out = new BrainError(`联网模型出错：${brief(err?.message ?? err)}`);
  out.status = err?.status;
  return out;
}

export class CloudBrain {
  /**
   * @param {object} deps
   * @param {() => any} deps.getSettings
   * @param {() => string} deps.getKey     the saved key for the configured host, or ''
   * @param {typeof fetch} deps.fetch      the system's network stack (proxy settings included)
   * @param {Record<string, string|undefined>} [deps.env]
   */
  constructor(deps) {
    this.deps = deps;
    // A large context: more of the conversation is kept than for the local model.
    this.thread = new Thread({ maxMessages: 16 });
  }

  #cfg() {
    return this.deps.getSettings().cloud;
  }

  endpoint() {
    return endpointOf(this.#cfg());
  }

  get name() {
    const ep = this.endpoint();
    return `联网 ${ep.label || '模型'}`;
  }

  get host() {
    return this.endpoint().host;
  }

  /**
   * The credential a request would carry: the key saved in the settings window, or, for
   * Anthropic's own endpoint only, one the SDK finds in the environment (ANTHROPIC_API_KEY).
   * An environment key is never sent to an address the user typed in.
   */
  #credential(ep = this.endpoint()) {
    const key = this.deps.getKey();
    if (key) return { key, source: 'saved' };
    const env = this.deps.env ?? process.env;
    if (ep.provider === 'anthropic' && ep.firstParty && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) return { key: '', source: 'env' };
    return null;
  }

  /** Is there an address, a model and a credential? (Says nothing about the switch.) */
  configured() {
    const ep = this.endpoint();
    return ep.ok && Boolean(this.#credential(ep));
  }

  /** Configured and switched on. */
  available() {
    return Boolean(this.#cfg().enabled) && this.configured();
  }

  resetThread() {
    this.thread.reset();
  }

  /** Application plans use a fresh text request, without screenshot/conversation carryover. */
  async complete({ system, prompt, signal, onText = () => {} }) {
    if (!this.available()) throw new BrainError('请先启用并配置联网模型。');
    const ep = this.endpoint();
    const cred = this.#credential(ep);
    const messages = [{ role: 'user', content: prompt }];
    const out = ep.provider === 'anthropic'
      ? await this.#anthropic(ep, cred, { ...this.#cfg(), webSearch: false }, system, messages, onText, () => {}, signal)
      : await this.#openai(ep, cred, system, messages, onText, signal);
    return out.text;
  }

  /** Which of these referents would have their screenshot sent with the next question. */
  pending(refs) {
    return this.thread.plan(refs).attach;
  }

  /** Continue a topic that was with another model (see Thread.adopt). */
  adopt(other, o) {
    if (other?.thread) this.thread.adopt(other.thread, o);
  }

  #client(ep, cred) {
    return new Anthropic({
      // With a saved key, nothing from the environment goes along; without one (Anthropic's own
      // endpoint only) the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN itself.
      ...(cred.source === 'saved' ? { apiKey: cred.key, authToken: null } : {}),
      // Always explicit, so that requests go where the settings window says they go and not to
      // an ANTHROPIC_BASE_URL that happens to be set.
      baseURL: ep.baseUrl,
      fetch: (url, init) => this.deps.fetch(url, { ...init, headers: this.#headers(init?.headers, cred) }),
      maxRetries: 2,
      timeout: 120_000,
    });
  }

  /**
   * The headers a request to the service may carry: the ones the API needs and nothing else.
   * The SDK also adds whatever ANTHROPIC_CUSTOM_HEADERS in the environment says, which could
   * send a credential meant for somewhere else to the address typed in the settings, or replace
   * the saved key. With a saved key, that key is the only credential that goes out.
   */
  #headers(given, cred) {
    const headers = new Headers(given);
    for (const name of [...headers.keys()]) if (!SENT_HEADERS.test(name)) headers.delete(name);
    if (cred.source === 'saved') {
      if (headers.has('x-api-key')) headers.set('x-api-key', cred.key);
      if (headers.has('authorization')) headers.set('authorization', `Bearer ${cred.key}`);
    }
    return headers;
  }

  /**
   * @param {object} o
   * @param {string} o.question
   * @param {object[]} o.refs              referents this question names (empty for a follow-up)
   * @param {boolean} [o.text]             a question about selected text: there is no screenshot
   * @param {boolean} [o.point]            false when there is nowhere on the screen to point
   * @param {(handle: string) => object|null} [o.resolve]
   */
  async ask({ question, refs = [], text = false, point = true, resolve, onText, onStatus, signal }) {
    if (!text && refs.length && this.#cfg().vision === 'text') {
      throw new BrainError('当前 API 模型只支持文字。请使用“当前应用”处理实际文件和控件，或切换支持图片的模型。');
    }
    const settings = this.deps.getSettings();
    const cfg = settings.cloud;
    const ep = endpointOf(cfg);
    if (!ep.ok) throw new BrainError(ep.problem);
    const cred = this.#credential(ep);
    if (!cred) throw new BrainError('联网模型还没有密钥。请在设置里填写。');
    if (signal?.aborted) throw new BrainError('已停止。', 'aborted');

    const thread = this.thread;
    const generation = thread.generation;
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
    const pointing = !text && point && settings.pointBack && plan.targets.length > 0;
    const system = text ? SYSTEM_PROMPT_CLOUD_TEXT : pointing ? SYSTEM_PROMPT_CLOUD_POINTER : SYSTEM_PROMPT_CLOUD;

    let filter = pointing ? new PointerReplyFilter(onText) : null;
    let started = false;
    let status = '';
    const say = (line) => {
      if (line !== status) onStatus?.((status = line));
    };
    const visible = (piece) => {
      started = true;
      say('');
      if (filter) filter.push(piece);
      else onText(piece);
    };
    const send = (p, message) => {
      const messages = [...p.history, message];
      return ep.provider === 'anthropic' ? this.#anthropic(ep, cred, cfg, system, messages, visible, say, signal) : this.#openai(ep, cred, system, messages, visible, signal);
    };

    say(`正在连接 ${ep.host}…`);
    const tAsk = Date.now();
    let out;
    try {
      out = await send(plan, userMessage);
    } catch (err) {
      // A service with a small context window: ask again with this turn alone, and with the
      // screenshots it is about attached again, since the turns that carried them are gone.
      if (err.status === 400 && !started && thread.length && !signal?.aborted && thread.generation === generation) {
        if (filter) filter = new PointerReplyFilter(onText);
        thread.clear();
        plan = thread.plan(refs);
        userMessage = turn(plan);
        out = await send(plan, userMessage);
      } else {
        throw err;
      }
    }
    say('');
    const answerMs = Date.now() - tAsk;

    let answer = out.text;
    if (filter) {
      const done = filter.finish();
      answer = done.answer;
      const tag = done.json ? pointTag(done.json, plan.targets, plan.visible, resolve) : '';
      if (tag) onText(tag);
    }
    if (out.tail) onText(out.tail);
    // "New topic" or "clear" while this was streaming: the answer belongs to a conversation
    // that no longer exists, and must not become the first exchange of the new one.
    // Nor does an answer the model broke off for its safety policy: half an answer is not a
    // turn to build the rest of the conversation on.
    if (thread.generation === generation && answer.trim() && out.stop !== 'refusal') thread.commit(userMessage, answer, plan.attach, plan.targets);

    return {
      stopReason: out.stop || 'stop',
      model: out.model || ep.model,
      note: out.note ?? '',
      passes: 1,
      answerMs,
      locateMs: 0,
      sent: plan.attach.map((r) => r.handle), // screenshots that went out with this question
      sentBytes: plan.attach.reduce((n, r) => n + r.image.bytes, 0),
      sentFraction: plan.attach.reduce((n, r) => n + (r.screenFraction ?? 0), 0),
      where: ep.host,
    };
  }

  /** Claude, through the official SDK. */
  async #anthropic(ep, cred, cfg, system, history, visible, say, signal) {
    const client = this.#client(ep, cred);
    const params = { model: ep.model, max_tokens: MAX_TOKENS, system };
    if (supportsEffort(ep.model)) params.output_config = { effort: EFFORTS.has(cfg.effort) ? cfg.effort : 'low' };
    if (cfg.webSearch && supportsWebSearch(ep.model)) params.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];
    // When a safety classifier declines a request, let the service hand it to the model it
    // chooses for that case instead of ending the turn. Anthropic's own endpoint only: a
    // gateway at another address may not know the parameter.
    const fallbacks = ep.firstParty && supportsFallbacks(ep.model);

    let messages = toAnthropicMessages(history);
    let text = '';
    let final;
    try {
      for (let pauses = 0; ; pauses++) {
        const stream = fallbacks
          ? client.beta.messages.stream({ ...params, messages, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
          : client.messages.stream({ ...params, messages }, { signal });
        // These models think before they write, and the thinking itself is not sent: without a
        // word here the wait would look like nothing is happening.
        stream.on('connect', () => say('模型正在思考…'));
        stream.on('streamEvent', (event) => {
          if (event.type === 'content_block_start' && event.content_block.type === 'server_tool_use') say('正在联网搜索…');
        });
        stream.on('text', (delta) => {
          text += delta;
          visible(delta);
        });
        final = await stream.finalMessage();
        // A server-side tool (web search) ran long: send the turn back as it is and it continues.
        if (final.stop_reason !== 'pause_turn' || pauses >= MAX_PAUSES) break;
        messages = [...messages, { role: 'assistant', content: final.content }];
      }
    } catch (err) {
      throw fromSdk(err, ep, signal);
    }

    if (final.stop_reason === 'refusal' && !text.trim()) {
      const why = final.stop_details?.category ? `（类别：${final.stop_details.category}）` : '';
      throw new BrainError(`模型出于安全策略没有回答这个问题${why}。`, 'refusal');
    }
    const handedOver = final.content.some((b) => b.type === 'fallback');
    const note =
      final.stop_reason === 'max_tokens' ? '回答因长度上限被截断。'
      : final.stop_reason === 'refusal' ? '模型出于安全策略中止了回答。'
      : final.stop_reason === 'pause_turn' ? '联网搜索没有在限定的轮数内完成，回答可能不完整。'
      : handedOver ? `首选模型没有接这个问题，由 ${final.model} 回答。`
      : '';
    return { text, stop: final.stop_reason, model: final.model, note, tail: sourceLines(sourcesOf(final.content)) };
  }

  /** Any service that speaks the OpenAI chat-completions format. */
  async #openai(ep, cred, system, history, visible, signal) {
    // No max_tokens and no temperature: services disagree about which of them they accept
    // (and under which name), and their defaults are fine for a short answer.
    const body = { model: ep.model, messages: [{ role: 'system', content: system }, ...history], stream: true };
    let res;
    try {
      res = await this.deps.fetch(`${ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.key}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new BrainError('已停止。', 'aborted');
      throw new BrainError(`连不上 ${ep.host}。请检查网络或系统代理。（${brief(err?.cause?.code ?? err?.message ?? err)}）`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.error?.message ?? j?.message ?? JSON.stringify(j);
      } catch {
        // No JSON body: the status has to do.
      }
      const err = new BrainError(statusProblem(res.status, detail, ep));
      err.status = res.status;
      throw err;
    }
    let text = '';
    let stop = '';
    let model = '';
    try {
      for await (const chunk of sseJson(chunksOf(res.body))) {
        if (chunk.error) throw new BrainError(`${ep.host} 中途报错：${brief(chunk.error.message ?? JSON.stringify(chunk.error))}`);
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        // (Models that think send their reasoning as delta.reasoning_content: not shown.)
        const piece = choice?.delta?.content;
        if (typeof piece === 'string' && piece) {
          text += piece;
          visible(piece);
        }
        if (choice?.finish_reason) stop = choice.finish_reason;
      }
    } catch (err) {
      if (err instanceof BrainError) throw err;
      if (signal?.aborted) throw new BrainError('已停止。', 'aborted');
      throw new BrainError(`${ep.host} 的回答中断了：${brief(err?.message ?? err)}`);
    }
    return { text, stop, model, note: stop === 'length' ? '回答因长度上限被截断。' : stop === 'content_filter' ? '服务的内容过滤中止了回答。' : '', tail: '' };
  }

  /**
   * For the settings window: is the configured service reachable with this key, and does it
   * know the model? Sends no question and no screen content, and costs nothing.
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async test() {
    const ep = this.endpoint();
    if (!ep.ok) return { ok: false, message: ep.problem };
    const cred = this.#credential(ep);
    if (!cred) return { ok: false, message: '还没有填密钥。' };
    const signal = AbortSignal.timeout(15_000);
    if (ep.provider === 'anthropic') {
      try {
        const info = await this.#client(ep, cred).models.retrieve(ep.model, {}, { signal, maxRetries: 0 });
        return { ok: true, message: `连上了 ${ep.host}，密钥有效，模型 ${info.display_name ?? ep.model} 可用。` };
      } catch (err) {
        return { ok: false, message: signal.aborted ? `连接 ${ep.host} 超时。请检查网络或系统代理。` : fromSdk(err, ep).message };
      }
    }
    try {
      const res = await this.deps.fetch(`${ep.baseUrl}/models`, { headers: { authorization: `Bearer ${cred.key}` }, signal });
      if (res.status === 404 || res.status === 405) return { ok: true, message: `连上了 ${ep.host}，但它不提供模型列表，无法预先检查密钥和模型名：直接提问试一下。` };
      if (!res.ok) return { ok: false, message: statusProblem(res.status, '', ep) };
      // (Some services list their models as "models/<name>" and take the bare name in requests.)
      const bare = (id) => String(id ?? '').replace(/^models\//, '');
      const ids = ((await res.json())?.data ?? []).map((m) => bare(m.id));
      if (ids.length && !ids.includes(bare(ep.model))) return { ok: false, message: `连上了 ${ep.host}，密钥有效，但它的模型列表里没有 ${ep.model}。请检查模型名；有的服务列表不全，也可以直接提问试一下。` };
      return { ok: true, message: `连上了 ${ep.host}，密钥有效${ids.length ? `，模型 ${ep.model} 可用` : ''}。` };
    } catch (err) {
      return { ok: false, message: `连不上 ${ep.host}。请检查网络或系统代理。（${brief(err?.cause?.code ?? err?.message ?? err)}）` };
    }
  }
}
