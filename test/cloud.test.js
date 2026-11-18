// The optional network model: where a configuration sends requests, what a request carries, and
// how the replies and the failures are read. The client is driven against a stand-in for the
// network (a fetch function), so every byte that would leave the computer can be looked at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, endpointOf, keyHint, sourceLines, sourcesOf, sseJson, supportsEffort, supportsFallbacks, supportsWebSearch, toAnthropicMessages } from '../src/core/cloud-wire.js';
import { CloudBrain } from '../src/main/cloud/brain-cloud.js';

// ---------------------------------------------------------------- pure helpers
test('endpoint: Claude by default, at Anthropic\'s own address', () => {
  const ep = endpointOf({});
  assert.deepEqual([ep.ok, ep.provider, ep.host, ep.model, ep.firstParty], [true, 'anthropic', 'api.anthropic.com', 'claude-opus-5-5', true]);
  assert.equal(ep.label, 'Claude Opus 5.5');
  assert.equal(endpointOf({ model: 'claude-sonnet-5-5' }).label, 'Claude Sonnet 5.5');
});

test('endpoint: an address the user typed is not first party, and must be https unless it is this machine', () => {
  const gw = endpointOf({ baseUrl: 'https://gateway.example.com/anthropic/' });
  assert.deepEqual([gw.ok, gw.host, gw.firstParty, gw.baseUrl], [true, 'gateway.example.com', false, 'https://gateway.example.com/anthropic']);
  assert.equal(endpointOf({ baseUrl: 'http://gateway.example.com' }).ok, false, 'a key over plain http');
  assert.match(endpointOf({ baseUrl: 'http://gateway.example.com' }).problem, /https/);
  assert.equal(endpointOf({ baseUrl: 'http://127.0.0.1:8080' }).ok, true);
  assert.equal(endpointOf({ baseUrl: 'http://localhost:8080' }).ok, true);
  assert.equal(endpointOf({ baseUrl: 'http://127.0.0.1.example.com' }).ok, false, 'a name that only starts like a loopback address');
  assert.equal(endpointOf({ baseUrl: 'https://user:pw@example.com' }).ok, false);
  assert.equal(endpointOf({ baseUrl: 'not a url' }).ok, false);
  assert.equal(endpointOf({ baseUrl: 'file:///etc/passwd' }).ok, false);
});

test('endpoint: an OpenAI-compatible service needs an address and a model name', () => {
  assert.equal(endpointOf({ provider: 'openai' }).ok, false);
  assert.equal(endpointOf({ provider: 'openai', baseUrl: 'https://api.example.com/v1' }).ok, false);
  const ep = endpointOf({ provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'some-vision-model' });
  assert.deepEqual([ep.ok, ep.host, ep.model, ep.firstParty], [true, 'api.example.com', 'some-vision-model', false]);
  assert.equal(endpointOf({ provider: 'nonsense' }).provider, 'anthropic');
});

test('which request features a model accepts', () => {
  for (const m of PROVIDERS.anthropic.models) assert.ok(supportsEffort(m), m);
  assert.equal(supportsEffort('claude-haiku-4-5'), false);
  assert.equal(supportsEffort('some-other-model'), false);
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5', 'claude-opus-4-8'].map(supportsFallbacks), [true, true, true, false, false]);
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5'].map(supportsWebSearch), [true, true, false, false]);
});

test('conversation to the Anthropic format: screenshots become base64 image blocks, the system message is separate', () => {
  const out = toAnthropicMessages([
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: '@1：' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }, { type: 'text', text: '这是什么？' }] },
    { role: 'assistant', content: '一个按钮。' },
    { role: 'user', content: [{ type: 'text', text: '[截图已省略]' }, { type: 'text', text: '为什么？' }] },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  assert.equal(out[1].content, '一个按钮。');
  assert.deepEqual(out[2].content.map((b) => b.type), ['text', 'text']);
});

test('server-sent events: payloads split across chunks, [DONE] and junk lines', async () => {
  const enc = new TextEncoder();
  const raw = 'data: {"a":1}\n\n: keep-alive\ndata: {"b":"中文"}\n\ndata: not json\ndata: [DONE]\n\ndata: {"c":3}';
  const bytes = enc.encode(raw);
  async function* pieces(n) {
    for (let i = 0; i < bytes.length; i += n) yield bytes.slice(i, i + n);
  }
  for (const n of [1, 3, 7, 1000]) {
    const got = [];
    for await (const j of sseJson(pieces(n))) got.push(j);
    assert.deepEqual(got, [{ a: 1 }, { b: '中文' }, { c: 3 }], `chunks of ${n} bytes`);
  }
});

test('sources of an answer that searched the web: each page once, as plain text', () => {
  const content = [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: 'a', citations: [{ type: 'web_search_result_location', url: 'https://example.com/a', title: 'Page  A' }, { type: 'web_search_result_location', url: 'https://example.com/a', title: 'Page A' }] },
    { type: 'text', text: 'b', citations: [{ type: 'web_search_result_location', url: 'javascript:alert(1)', title: 'x' }, { type: 'char_location' }, { type: 'web_search_result_location', url: 'https://other.example/b', title: null }] },
    { type: 'text', text: 'c', citations: null },
  ];
  const s = sourcesOf(content);
  assert.deepEqual(s, [{ title: 'Page A', url: 'https://example.com/a' }, { title: '', url: 'https://other.example/b' }]);
  assert.equal(sourceLines(s), '\n\n来源：Page A（example.com）；other.example');
  assert.equal(sourceLines([]), '');
});

test('key hint: the last four characters, nothing for a short string', () => {
  assert.equal(keyHint('sk-ant-0123456789abcd'), 'abcd');
  assert.equal(keyHint('short'), '');
});

// ---------------------------------------------------------------- the client against a stand-in network
const KEY = 'sk-test-0123456789abcdef';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ref = (handle, w = 400, h = 200) => ({ handle, state: 'live', image: { buffer: png, mediaType: 'image/png', bytes: png.length }, imageSize: { w, h }, screenFraction: 0.05 });

function anthropicEvents({ model = 'claude-opus-5-5', blocks, stop = 'end_turn', stopDetails }) {
  const ev = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: b.citations ? [] : null } });
      for (let i = 0; i < b.text.length; i += 5) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(i, i + 5) } });
      for (const citation of b.citations ?? []) ev.push({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } });
    } else if (b.type === 'thinking') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } });
    } else {
      ev.push({ type: 'content_block_start', index, content_block: b });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, ...(stopDetails ? { stop_details: stopDetails } : {}) }, usage: { output_tokens: 20 } });
  ev.push({ type: 'message_stop' });
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

/** A Response whose body arrives in pieces, and stops when the request is aborted. */
function streamed(pieces, signal, delay = 0) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      try {
        for (const p of pieces) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (signal?.aborted) return;
          controller.enqueue(enc.encode(p));
        }
        controller.close();
      } catch {
        // already errored by the abort
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const failure = (status, type, message) => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });

/** A brain with its settings and a network that records what it is sent. */
function setup({ cloud = {}, key = KEY, env = {}, reply, pointBack = true } = {}) {
  const calls = [];
  const settings = { pointBack, cloud: { enabled: true, byDefault: false, provider: 'anthropic', model: '', baseUrl: '', effort: 'low', webSearch: false, ...cloud } };
  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call = { url: String(url), method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(call);
    return reply(call, calls.length);
  };
  const brain = new CloudBrain({ getSettings: () => settings, getKey: () => key, fetch, env });
  return { brain, calls, settings };
}

/** Every credential a request carries, whichever header the SDK puts it in. */
const credentials = (call) => [call.headers['x-api-key'], call.headers.authorization?.replace(/^Bearer /, '')].filter(Boolean);

async function ask(brain, o) {
  let text = '';
  const status = [];
  const res = await brain.ask({ onText: (t) => (text += t), onStatus: (s) => status.push(s), ...o });
  return { ...res, text, status };
}

const withEnv = async (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test('Claude: one streamed request to Anthropic, carrying the pinned crop and nothing from the environment', async () => {
  const { brain, calls } = setup({
    reply: (c) => streamed(anthropicEvents({ blocks: [{ type: 'thinking' }, { type: 'text', text: '第二季度最高，1,902 万元。\n{"ref": "@1", "point_2d": [500, 250], "label": "1,902"}' }] }), c.signal),
  });
  assert.equal(brain.available(), true);
  assert.equal(brain.name, '联网 Claude Opus 5.5');
  assert.equal(brain.host, 'api.anthropic.com');
  const r = await withEnv({ ANTHROPIC_AUTH_TOKEN: 'token-from-the-environment', ANTHROPIC_BASE_URL: 'https://elsewhere.example' }, () => ask(brain, { question: '哪个季度最高？', refs: [ref('@1')] }));

  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.match(c.url, /^https:\/\/api\.anthropic\.com\/v1\/messages(\?beta=true)?$/, 'the address shown in the settings, not ANTHROPIC_BASE_URL');
  assert.deepEqual(credentials(c), [KEY], 'the saved key, and no token from the environment next to it');
  assert.match(c.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(c.body.model, 'claude-opus-5-5');
  assert.equal(c.body.stream, true);
  assert.equal(c.body.fallbacks, 'default');
  assert.deepEqual(c.body.output_config, { effort: 'low' });
  assert.equal(c.body.max_tokens, 16000);
  for (const k of ['thinking', 'temperature', 'top_p', 'tools']) assert.equal(k in c.body, false, `${k} is not sent`);
  assert.match(c.body.system, /point_2d/);
  assert.doesNotMatch(c.body.system, /运行在用户自己的电脑上/, 'the model is not told it runs locally');
  assert.equal(c.body.messages.length, 1);
  const parts = c.body.messages[0].content;
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image', 'text']);
  assert.deepEqual(parts[1].source, { type: 'base64', media_type: 'image/png', data: png.toString('base64') });
  assert.equal(parts[2].text, '哪个季度最高？');

  // What the person sees: the answer without the JSON line, then a point inside the crop.
  assert.equal(r.text, '第二季度最高，1,902 万元。[[point @1 200 50 | 1,902]]');
  assert.deepEqual([r.sent, r.where, r.model, r.passes, r.note], [['@1'], 'api.anthropic.com', 'claude-opus-5-5', 1, '']);
  assert.match(r.status[0], /api\.anthropic\.com/);
  assert.equal(r.status.at(-1), '');
});

test('Claude: a follow-up sends the conversation, not the screenshot again', async () => {
  let n = 0;
  const { brain, calls } = setup({ reply: (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: ['一个保存按钮。', '因为它在工具栏里。'][n++] }] }), c.signal) });
  await ask(brain, { question: '这是什么？', refs: [ref('@1')] });
  assert.deepEqual(brain.pending([ref('@1')]), [], 'already shown in this conversation');
  const r = await ask(brain, { question: '为什么？', refs: [] });
  assert.deepEqual(r.sent, []);
  const m = calls[1].body.messages;
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(m[1].content, '一个保存按钮。');
  assert.equal(JSON.stringify(m).split('"type":"image"').length - 1, 1, 'the one screenshot, in the turn that first carried it');
  brain.resetThread();
  assert.equal(brain.pending([ref('@1')]).length, 1, 'a new topic has seen nothing');
});

test('Claude: no point is asked for when there is nowhere to point, or pointing back is off', async () => {
  const reply = (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '好的。' }] }), c.signal);
  const a = setup({ reply });
  await ask(a.brain, { question: '翻译成英文：你好', text: true });
  assert.doesNotMatch(a.calls[0].body.system, /point_2d/);
  assert.match(a.calls[0].body.system, /选中了一段文字/);
  const b = setup({ reply });
  await ask(b.brain, { question: '图里写了什么？', refs: [ref('@图1')], point: false });
  assert.doesNotMatch(b.calls[0].body.system, /point_2d/);
  const c = setup({ reply, pointBack: false });
  await ask(c.brain, { question: '这是什么？', refs: [ref('@1')] });
  assert.doesNotMatch(c.calls[0].body.system, /point_2d/);
});

test('Claude: a model that takes no effort setting or fallbacks is not sent them', async () => {
  const { brain, calls } = setup({ cloud: { model: 'claude-haiku-4-5', effort: 'high' }, reply: (c) => streamed(anthropicEvents({ model: 'claude-haiku-4-5', blocks: [{ type: 'text', text: '好。' }] }), c.signal) });
  await ask(brain, { question: '这是什么？', refs: [ref('@1')] });
  assert.equal('output_config' in calls[0].body, false);
  assert.equal('fallbacks' in calls[0].body, false);
  assert.equal(calls[0].headers['anthropic-beta'], undefined);
});

test('an address the user typed: no fallbacks parameter, and never a key from the environment', async () => {
  const cloud = { baseUrl: 'https://gateway.example.com' };
  const env = { ANTHROPIC_API_KEY: 'sk-from-the-environment' };
  const none = setup({ cloud, key: '', env, reply: () => assert.fail('nothing may be sent') });
  assert.equal(none.brain.configured(), false);
  assert.equal(none.brain.available(), false);
  await assert.rejects(ask(none.brain, { question: 'x', refs: [] }), /密钥/);
  assert.equal(none.calls.length, 0);

  const g = setup({ cloud, env, reply: (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '好。' }] }), c.signal) });
  await withEnv(env, () => ask(g.brain, { question: '这是什么？', refs: [ref('@1')] }));
  assert.equal(g.calls[0].url, 'https://gateway.example.com/v1/messages');
  assert.deepEqual(credentials(g.calls[0]), [KEY]);
  assert.equal('fallbacks' in g.calls[0].body, false);

  // On Anthropic's own address, with nothing saved, the SDK's own credential lookup applies.
  const e = setup({ key: '', env, reply: (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '好。' }] }), c.signal) });
  assert.equal(e.brain.available(), true);
  await withEnv(env, () => ask(e.brain, { question: '这是什么？', refs: [ref('@1')] }));
  assert.deepEqual(credentials(e.calls[0]), ['sk-from-the-environment']);
});

test('switched off or badly configured: not available, and asking sends nothing', async () => {
  const off = setup({ cloud: { enabled: false }, reply: () => assert.fail('nothing may be sent') });
  assert.equal(off.brain.configured(), true);
  assert.equal(off.brain.available(), false);
  const bad = setup({ cloud: { baseUrl: 'http://plain.example.com' }, reply: () => assert.fail('nothing may be sent') });
  assert.equal(bad.brain.available(), false);
  await assert.rejects(ask(bad.brain, { question: 'x', refs: [ref('@1')] }), /https/);
  assert.equal(bad.calls.length, 0);
});

test('Claude with web search: a paused turn is continued as it is, and the pages cited are listed', async () => {
  const search = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} };
  const result = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com/price', title: '价格页', encrypted_content: 'x', page_age: null }] };
  const cite = { type: 'web_search_result_location', url: 'https://example.com/price', title: '价格页', cited_text: '…', encrypted_index: 'i' };
  const { brain, calls } = setup({
    cloud: { webSearch: true },
    reply: (c, n) => streamed(n === 1
      ? anthropicEvents({ blocks: [{ type: 'thinking' }, { type: 'text', text: '我查一下。' }, search], stop: 'pause_turn' })
      : anthropicEvents({ blocks: [result, { type: 'text', text: '现在卖 3,899 元。', citations: [cite] }, { type: 'text', text: '\n{"ref": "@1", "point_2d": [100, 900], "label": "价格"}' }] }), c.signal),
  });
  const r = await ask(brain, { question: '现在多少钱？', refs: [ref('@1')] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
  const again = calls[1].body.messages;
  assert.deepEqual(again.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(again[1].content.map((b) => b.type), ['thinking', 'text', 'server_tool_use'], 'the paused turn goes back unchanged, thinking block included');
  assert.equal(r.text, '我查一下。现在卖 3,899 元。[[point @1 40 180 | 价格]]\n\n来源：价格页（example.com）');
  assert.ok(r.status.includes('正在联网搜索…'));
  // The conversation keeps the answer, not the line for the program.
  const next = await ask(brain, { question: '贵吗？', refs: [] }).catch(() => null);
  assert.ok(next === null || next, 'the follow-up is sent');
  assert.equal(calls[2].body.messages[1].content, '我查一下。现在卖 3,899 元。');
});

test('Claude: a refusal is said as one, with its category', async () => {
  const { brain } = setup({ reply: (c) => streamed(anthropicEvents({ blocks: [], stop: 'refusal', stopDetails: { type: 'refusal', category: 'cyber', explanation: null } }), c.signal) });
  await assert.rejects(ask(brain, { question: 'x', refs: [ref('@1')] }), (err) => err.kind === 'refusal' && /安全策略/.test(err.message) && /cyber/.test(err.message));
  assert.equal(brain.pending([ref('@1')]).length, 1, 'nothing was answered: the screenshot counts as not shown');
});

test('Claude: an answer cut off at the length limit says so', async () => {
  const { brain } = setup({ reply: (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '说到一半' }], stop: 'max_tokens' }), c.signal) });
  const r = await ask(brain, { question: 'x', refs: [ref('@1')] });
  assert.match(r.note, /截断/);
});

test('Claude: failures are sentences that name the host', async () => {
  const cases = [
    [401, 'authentication_error', 'invalid x-api-key', /api\.anthropic\.com 不接受这把密钥/],
    [403, 'permission_error', 'no access', /没有权限使用 claude-opus-5-5/],
    [404, 'not_found_error', 'model: nope', /没有找到模型/],
    [429, 'rate_limit_error', 'slow down', /太频繁|额度/],
    [529, 'overloaded_error', 'Overloaded', /暂时出错（529）/],
    [400, 'invalid_request_error', 'messages: something is wrong', /不接受这次请求（400）.*something is wrong/],
  ];
  for (const [status, type, message, expect] of cases) {
    const { brain, calls } = setup({ reply: () => failure(status, type, message) });
    await assert.rejects(ask(brain, { question: 'x', refs: [ref('@1')] }), (err) => err.kind === 'cloud' && expect.test(err.message), `HTTP ${status}`);
    assert.equal(calls.length, 1, `HTTP ${status} is not retried here`);
    assert.doesNotMatch(String((await ask(brain, { question: 'x', refs: [] }).catch((e) => e)).message), new RegExp(KEY), 'the key is never part of a message');
  }
  const down = setup({ reply: () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  // (The SDK retries a failed connection; its waits make this the slow case of the file.)
  await assert.rejects(ask(down.brain, { question: 'x', refs: [ref('@1')] }), /连不上 api\.anthropic\.com/);
});

test('Claude: Stop ends the request and is reported as stopped, not as an error', async () => {
  const { brain } = setup({ reply: (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '这个回答很长很长很长很长很长很长很长很长很长很长很长很长。' }] }), c.signal, 30) });
  const abort = new AbortController();
  let shown = '';
  const p = brain.ask({ question: 'x', refs: [ref('@1')], signal: abort.signal, onText: (t) => { shown += t; if (shown.length > 6) abort.abort(); }, onStatus() {} });
  await assert.rejects(p, (err) => err.kind === 'aborted');
  assert.equal(brain.pending([ref('@1')]).length, 1, 'a stopped answer is not part of the conversation');
});

test('headers: nothing from ANTHROPIC_CUSTOM_HEADERS goes out, and the saved key is the only credential', async () => {
  const reply = (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '好。' }] }), c.signal);
  const custom = { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer token-for-somewhere-else\nX-Api-Key: another-key\nX-Company-Session: secret-cookie' };
  for (const cloud of [{}, { baseUrl: 'https://gateway.example.com' }]) {
    const { brain, calls } = setup({ cloud, reply });
    await withEnv(custom, () => ask(brain, { question: '这是什么？', refs: [ref('@1')] }));
    const h = calls[0].headers;
    assert.deepEqual([...new Set(credentials(calls[0]))], [KEY], `to ${brain.host}`);
    assert.equal('x-company-session' in h, false);
    assert.ok(h['anthropic-version'], 'what the API needs is still there');
    assert.equal(h['content-type'], 'application/json');
    assert.equal(JSON.stringify(h).includes('somewhere-else'), false);
  }
});

test('Claude: an answer broken off by a refusal is shown with a note, and is not kept as a turn of the conversation', async () => {
  const { brain } = setup({ reply: (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '先说一半' }], stop: 'refusal', stopDetails: { type: 'refusal', category: null, explanation: null } }), c.signal) });
  const r = await ask(brain, { question: 'x', refs: [ref('@1')] });
  assert.equal(r.text, '先说一半');
  assert.match(r.note, /安全策略/);
  assert.equal(brain.pending([ref('@1')]).length, 1, 'the next question starts from before this one');
});

test('what was sent is reported in bytes, also after the turn had to be asked again on its own', async () => {
  let n = 0;
  const { brain } = setup({ cloud: compat, reply: (c) => (++n === 2 ? new Response(JSON.stringify({ error: { message: 'too long' } }), { status: 400 }) : streamed(chat(['好。']), c.signal)) });
  const first = await ask(brain, { question: '这是什么？', refs: [ref('@1')] });
  assert.deepEqual([first.sentBytes, first.sentFraction], [png.length, 0.05]);
  const again = await ask(brain, { question: '再说说', refs: [] });
  assert.equal(again.sentBytes, png.length, 'the screenshot went out a second time, and the result says so');
});

test('taking a topic over from the other model: the conversation as text, its screenshots attached once more', async () => {
  const reply = (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '联网的回答。' }] }), c.signal);
  // The other model's side of the topic: a question about @1 with its screenshot, and a follow-up.
  const other = setup({ reply: (c) => streamed(anthropicEvents({ blocks: [{ type: 'text', text: '本机的回答。' }] }), c.signal) }).brain;
  await ask(other, { question: '这是什么？', refs: [ref('@1')] });
  await ask(other, { question: '为什么？', refs: [] });

  // A follow-up to the new model: everything said so far, without pictures, then the screenshot.
  const a = setup({ reply });
  a.brain.adopt(other);
  assert.deepEqual(a.brain.pending([]).map((r) => r.handle), ['@1'], 'a follow-up will carry what the topic is about');
  const r = await ask(a.brain, { question: '再详细一点', refs: [] });
  assert.deepEqual(r.sent, ['@1']);
  const m = a.calls[0].body.messages;
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(JSON.stringify(m.slice(0, 4)).includes('"type":"image"'), false, 'no picture in the part taken over');
  assert.match(JSON.stringify(m[0]), /截图已省略/);
  assert.equal(m[4].content.filter((b) => b.type === 'image').length, 1);

  // Asking the last question again: the answer it got the first time is left out.
  const b = setup({ reply });
  b.brain.adopt(other, { dropLast: true });
  await ask(b.brain, { question: '为什么？', refs: [] });
  const again = b.calls[0].body.messages;
  assert.deepEqual(again.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(again[1].content, '本机的回答。');
  assert.equal(again[2].content.filter((x) => x.type === 'image').length, 1);
  assert.equal(again[2].content.at(-1).text, '为什么？');
});

// ---------------------------------------------------------------- the OpenAI-compatible format
const chat = (pieces, finish = 'stop') => [
  `data: ${JSON.stringify({ model: 'vision-1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '（想了一下）' } }] })}\n\n`,
  ...pieces.map((content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`),
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
  'data: [DONE]\n\n',
];
const compat = { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'vision-1' };

test('OpenAI-compatible: one streamed chat completion with the key as a bearer token', async () => {
  const { brain, calls } = setup({ cloud: compat, reply: (c) => streamed(chat(['@1 更便宜。', '\n{"ref": "@1", "poi', 'nt_2d": [0, 1000], "label": "价格"}']), c.signal) });
  assert.equal(brain.name, '联网 vision-1');
  const r = await ask(brain, { question: '哪个便宜？', refs: [ref('@1'), ref('@2')] });
  const c = calls[0];
  assert.equal(c.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(c.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(c.body).sort(), ['messages', 'model', 'stream'], 'no parameter that services disagree about');
  assert.equal(c.body.messages[0].role, 'system');
  assert.equal(c.body.messages[1].content.filter((p) => p.type === 'image_url').length, 2);
  assert.equal(r.text, '@1 更便宜。[[point @1 0 200 | 价格]]', 'reasoning is not shown; the JSON line became a point');
  assert.deepEqual([r.where, r.model, r.sent], ['api.example.com', 'vision-1', ['@1', '@2']]);
});

test('OpenAI-compatible: failures, and an error sent in the middle of a stream', async () => {
  const bad = setup({ cloud: compat, reply: () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }) });
  await assert.rejects(ask(bad.brain, { question: 'x', refs: [ref('@1')] }), /api\.example\.com 不接受这把密钥/);
  const mid = setup({ cloud: compat, reply: (c) => streamed([`data: ${JSON.stringify({ choices: [{ delta: { content: '开头' } }] })}\n\n`, `data: ${JSON.stringify({ error: { message: 'quota exceeded' } })}\n\n`], c.signal) });
  await assert.rejects(ask(mid.brain, { question: 'x', refs: [ref('@1')] }), /中途报错：quota exceeded/);
  const cut = setup({ cloud: compat, reply: (c) => streamed(chat(['太长了'], 'length'), c.signal) });
  assert.match((await ask(cut.brain, { question: 'x', refs: [ref('@1')] })).note, /截断/);
});

test('a small context window: after a 400 the turn is asked again on its own, screenshots attached again', async () => {
  let n = 0;
  const { brain, calls } = setup({ cloud: compat, reply: (c) => (++n === 2 ? new Response(JSON.stringify({ error: { message: 'context length exceeded' } }), { status: 400 }) : streamed(chat(['好。']), c.signal)) });
  await ask(brain, { question: '这是什么？', refs: [ref('@1')] });
  const r = await ask(brain, { question: '再说说', refs: [] });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.messages.length, 2, 'the system message and this turn alone');
  assert.equal(calls[2].body.messages[1].content.filter((p) => p.type === 'image_url').length, 1);
  assert.deepEqual(r.sent, ['@1']);
});

// ---------------------------------------------------------------- "test the connection"
test('testing the connection asks for the model, sends no question, and words the failures', async () => {
  const ok = setup({ reply: () => new Response(JSON.stringify({ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  const r = await ok.brain.test();
  assert.equal(r.ok, true);
  assert.match(r.message, /Claude Opus 5\.5 可用/);
  assert.deepEqual([ok.calls[0].method.toUpperCase(), ok.calls[0].url, ok.calls[0].body], ['GET', 'https://api.anthropic.com/v1/models/claude-opus-5-5', null]);
  const denied = await setup({ reply: () => failure(401, 'authentication_error', 'invalid x-api-key') }).brain.test();
  assert.deepEqual([denied.ok, /不接受这把密钥/.test(denied.message)], [false, true]);
  assert.equal((await setup({ key: '', reply: () => assert.fail('no request without a key') }).brain.test()).ok, false);

  const list = (ids) => () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
  assert.equal((await setup({ cloud: compat, reply: list(['vision-1', 'other']) }).brain.test()).ok, true);
  const missing = await setup({ cloud: compat, reply: list(['other']) }).brain.test();
  assert.deepEqual([missing.ok, /没有 vision-1/.test(missing.message)], [false, true]);
  assert.equal((await setup({ cloud: compat, reply: list(['models/vision-1']) }).brain.test()).ok, true, 'a service that lists its models with a prefix');
  const nolist = await setup({ cloud: compat, reply: () => new Response('not found', { status: 404 }) }).brain.test();
  assert.deepEqual([nolist.ok, /不提供模型列表/.test(nolist.message)], [true, true]);
});
