// What goes over the wire to a model service on the network, and where it goes. Pure functions:
// which host a configuration points at, whether that is acceptable, and the conversion between
// the conversation as the app keeps it (OpenAI-style content parts, see prompt.js) and the
// Anthropic Messages format.

/** The services the settings window offers. `openai` is any server speaking that chat format. */
export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude（Anthropic）',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容接口',
    baseUrl: '',
    model: '',
    models: [],
  },
};

const LABELS = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-fable-5-2': 'Claude Fable 5.2',
};

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** Is this host name (URL.hostname) this computer itself? */
export const isLoopback = (hostname) => LOOPBACK.test(String(hostname ?? ''));

/**
 * Where a cloud configuration sends requests.
 * @param {{ provider?: string, baseUrl?: string, model?: string }} cloud
 * @returns {{ ok: boolean, problem: string, provider: string, baseUrl: string, host: string, model: string, label: string, firstParty: boolean }}
 */
export function endpointOf(cloud = {}) {
  const provider = PROVIDERS[cloud.provider] ? cloud.provider : 'anthropic';
  const preset = PROVIDERS[provider];
  const typed = String(cloud.baseUrl ?? '').trim().replace(/\/+$/, '');
  const baseUrl = typed || preset.baseUrl;
  const model = String(cloud.model ?? '').trim() || preset.model;
  const out = { ok: false, problem: '', provider, baseUrl, host: '', model, label: LABELS[model] ?? model, firstParty: provider === 'anthropic' && !typed };
  if (!baseUrl) return { ...out, problem: '还没有填服务地址。' };
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ...out, problem: '服务地址不是一个网址。' };
  }
  out.host = url.host;
  if (url.username || url.password) return { ...out, problem: '服务地址里不要带用户名和密码，密钥请填在下面。' };
  // The key travels in a header: over plain http anyone on the network path can read it.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) {
    return { ...out, problem: '服务地址必须以 https:// 开头（只有本机地址可以用 http）。' };
  }
  if (!model) return { ...out, problem: '还没有填模型名。' };
  return { ...out, ok: true };
}

/** Request features that only some Claude models accept; sending them to the others is a 400. */
export const supportsEffort = (model) => /^claude-(fable|mythos)-5|^claude-(opus|sonnet|haiku)-5|^claude-opus-4-[5-8]$|^claude-sonnet-4-6$/.test(model);
export const supportsFallbacks = (model) => /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/.test(model);
export const supportsWebSearch = (model) => /^claude-(fable|mythos)-5|^claude-(opus|sonnet)-5|^claude-opus-4-[6-8]$|^claude-sonnet-4-6$/.test(model);

const DATA_URL = /^data:([\w/+.-]+);base64,(.*)$/s;

/** One message's content, OpenAI-style parts or a plain string, as Anthropic content blocks. */
export function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => {
    if (part.type !== 'image_url') return { type: 'text', text: String(part.text ?? '') };
    const m = DATA_URL.exec(part.image_url?.url ?? '');
    if (!m) return { type: 'text', text: '[截图已省略]' };
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  });
}

/** The conversation without its system message, in the Anthropic Messages format. */
export function toAnthropicMessages(messages) {
  return messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
}

/** The pages an answer cites after a web search: [{ title, url }], each page once, at most `max`. */
export function sourcesOf(content, max = 3) {
  const seen = new Map();
  for (const block of content ?? []) {
    if (block?.type !== 'text') continue;
    for (const c of block.citations ?? []) {
      if (c?.type !== 'web_search_result_location' || !/^https?:\/\//i.test(c.url ?? '') || seen.has(c.url)) continue;
      seen.set(c.url, { title: String(c.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60), url: c.url });
    }
  }
  return [...seen.values()].slice(0, max);
}

/** "来源" lines for the end of an answer. Plain text: the bubble shows text, not links. */
export function sourceLines(sources) {
  if (!sources.length) return '';
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  return '\n\n来源：' + sources.map((s) => (s.title ? `${s.title}（${host(s.url)}）` : host(s.url))).join('；');
}

/**
 * Parse a server-sent-events body into the JSON payloads of its `data:` lines.
 * @param {AsyncIterable<Uint8Array>} chunks
 */
export async function* sseJson(chunks) {
  const decoder = new TextDecoder();
  let buf = '';
  const lines = function* (final) {
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0 || (final && buf.length)) {
      const line = (nl >= 0 ? buf.slice(0, nl) : buf).trim();
      buf = nl >= 0 ? buf.slice(nl + 1) : '';
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // A keep-alive comment or a broken line: skip it.
      }
    }
  };
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    yield* lines(false);
  }
  buf += decoder.decode();
  yield* lines(true);
}

/** The last four characters of a key, for "a key ending in …" in the settings window. */
export function keyHint(key) {
  const k = String(key ?? '').trim();
  return k.length >= 12 ? k.slice(-4) : '';
}
