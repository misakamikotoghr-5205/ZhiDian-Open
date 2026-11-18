import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverModels, modelVision } from '../src/main/cloud/model-discovery.js';
import { PRESETS } from '../src/main/cloud/presets.js';

const list = (data) => Response.json({ data });

test('model capability metadata recognizes Claude, Ollama and OpenRouter without guessing names', () => {
  assert.equal(modelVision({ capabilities: { image_input: { supported: true } } }), true);
  assert.equal(modelVision({ capabilities: { image_input: { supported: false } } }), false);
  assert.equal(modelVision({ capabilities: ['completion', 'vision'] }), true);
  assert.equal(modelVision({ capabilities: ['completion', 'embedding'] }), false);
  assert.equal(modelVision({ architecture: { input_modalities: ['text', 'image'] } }), true);
  assert.equal(modelVision({ input_modalities: ['text'] }), false);
  assert.equal(modelVision({ supports_vision: false }), false);
  assert.equal(modelVision({ vision: true }), true);
  assert.equal(modelVision({ capabilities: { vision: true } }), true);
  assert.equal(modelVision({ id: 'qwen-vl-vision-123' }), null);
  assert.equal(modelVision({ id: 'gpt-4.1' }), null);
  assert.equal(modelVision(null), null);
});

test('all cloud presets use their configured model-list URL and the appropriate credential format', async () => {
  for (const preset of Object.values(PRESETS).filter((p) => p.id !== 'custom')) {
    const calls = [];
    const out = await discoverModels({ ...preset, key: 'test-key', fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return list([{ id: preset.model, display_name: 'Friendly name' }]);
    } });
    assert.equal(out.ok, true, preset.id);
    assert.equal(out.models[0].id, preset.model);
    assert.equal(out.models[0].label, 'Friendly name');
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, preset.provider === 'anthropic' ? 'https://api.anthropic.com/v1/models?limit=1000' : preset.baseUrl + '/models');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    if (preset.provider === 'anthropic') {
      assert.equal(headers.get('x-api-key'), 'test-key');
      assert.equal(headers.get('anthropic-version'), '2023-06-01');
      assert.equal(headers.has('authorization'), false);
    } else {
      assert.equal(headers.get('authorization'), 'Bearer test-key');
      assert.equal(headers.has('x-api-key'), false);
    }
  }
});

test('discovery supports custom gateways, trims trailing slashes, and does not send an empty credential', async () => {
  const out = await discoverModels({ provider: 'anthropic', baseUrl: 'https://gateway.example/claude///', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://gateway.example/claude/v1/models?limit=1000');
    assert.deepEqual(init.headers, { 'anthropic-version': '2023-06-01' });
    return list([{ id: 'claude-custom', capabilities: { image_input: { supported: true } } }]);
  } });
  assert.deepEqual(out.models, [{ id: 'claude-custom', label: 'claude-custom', vision: true }]);
});

test('discovery filters malformed and duplicate rows and preserves explicitly unknown capability', async () => {
  const out = await discoverModels({ baseUrl: 'http://localhost:1234/v1', fetchImpl: async () => Response.json({ models: [
    null, {}, { id: '' }, { id: 'one', display_name: 'One' }, { id: 'one', vision: true }, { name: 'two', vision: false },
  ] }) });
  assert.deepEqual(out, { ok: true, models: [
    { id: 'one', label: 'One', vision: null }, { id: 'two', label: 'two', vision: false },
  ] });
});

test('Ollama capability enrichment uses /api/show with bounded concurrency and keeps failed models usable', async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const out = await discoverModels({ baseUrl: 'http://127.0.0.1:11434/v1', key: 'local-key', local: true, localPreset: 'ollama', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/models')) return list(['vision', 'text', 'legacy', 'broken', 'last'].map((id) => ({ id })));
    assert.equal(url, 'http://127.0.0.1:11434/api/show');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer local-key');
    assert.equal(init.headers['content-type'], 'application/json');
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const id = JSON.parse(init.body).model;
    if (id === 'legacy') return new Response('', { status: 404 });
    if (id === 'broken') throw new Error('old server');
    return Response.json({ capabilities: id === 'vision' ? ['completion', 'vision'] : ['completion'] });
  } });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 6);
  assert.ok(peak <= 3);
  assert.ok(peak > 1);
  assert.deepEqual(out.models.map((m) => [m.id, m.vision]), [['vision', true], ['text', false], ['legacy', null], ['broken', null], ['last', false]]);
});

test('generic local and cloud connections do not receive Ollama-specific requests', async () => {
  for (const options of [{ local: false, localPreset: 'ollama' }, { local: true, localPreset: 'lmstudio' }]) {
    let count = 0;
    const out = await discoverModels({ ...options, baseUrl: 'http://localhost:1234/v1', fetchImpl: async (url) => {
      count++;
      assert.equal(url, 'http://localhost:1234/v1/models');
      return list([{ id: 'some-model' }]);
    } });
    assert.equal(out.ok, true);
    assert.equal(count, 1);
  }
});

test('caller cancellation during Ollama enrichment is reported as cancelled', async () => {
  const abort = new AbortController();
  const out = await discoverModels({ baseUrl: 'http://localhost:11434/v1', local: true, localPreset: 'ollama', signal: abort.signal, fetchImpl: async (url) => {
    if (url.endsWith('/models')) return list([{ id: 'one' }]);
    abort.abort();
    throw abort.signal.reason;
  } });
  assert.equal(out.ok, false);
  assert.deepEqual(out.models, []);
  assert.match(out.error, /已取消/);
});

test('invalid addresses never receive a discovery request', async () => {
  for (const baseUrl of ['', 'not-a-url', 'http://api.example.com/v1', 'https://user:password@api.example.com']) {
    let count = 0;
    const out = await discoverModels({ baseUrl, fetchImpl: async () => { count++; return list([]); } });
    assert.equal(out.ok, false, baseUrl);
    assert.equal(count, 0, baseUrl);
  }
});

test('discovery errors distinguish authentication, unsupported listing, invalid response, and timeout', async () => {
  for (const [status, message] of [[401, /密钥/], [403, /密钥/], [404, /手动填写/], [405, /手动填写/], [500, /HTTP 500/]]) {
    const out = await discoverModels({ baseUrl: 'https://api.example.com/v1', fetchImpl: async () => new Response('', { status }) });
    assert.equal(out.ok, false);
    assert.match(out.error, message);
  }
  const malformed = await discoverModels({ baseUrl: 'https://api.example.com/v1', fetchImpl: async () => Response.json({ nonsense: true }) });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /有效模型列表/);
  const timeout = await discoverModels({ baseUrl: 'https://api.example.com/v1', fetchImpl: async () => { throw new DOMException('Timed out', 'TimeoutError'); } });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /超时/);
});

test('an actual HTTP redirect cannot forward a discovery credential to another endpoint', async (t) => {
  let received = 0;
  let authorization = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      authorization = req.headers.authorization;
      res.writeHead(302, { location: '/unexpected' }).end();
    } else {
      received++;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const out = await discoverModels({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, key: 'private-test-key' });
  assert.equal(authorization, 'Bearer private-test-key');
  assert.equal(received, 0);
  assert.equal(out.ok, false);
});
