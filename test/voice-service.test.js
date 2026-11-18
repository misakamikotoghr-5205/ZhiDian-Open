import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { VoiceService } from '../src/main/voice/service.js';
import { VOICE_DEFAULTS } from '../src/main/voice/config.js';
import * as settings from '../src/main/settings.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function wav(seconds = 0.1) {
  const frames = Math.round(16000 * seconds);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  return bytes;
}

const local = (extra = {}) => ({ ...VOICE_DEFAULTS, enabled: true, preset: 'local-openai', baseUrl: 'http://127.0.0.1:8000/v1', ...extra });
const remote = (extra = {}) => ({ ...VOICE_DEFAULTS, enabled: true, keyHost: 'api.openai.com', key: 'sealed-private-key', keyHint: '1234', ...extra });
const service = (voice, fetchImpl, getKey = () => '') => new VoiceService({ getSettings: () => ({ voice }), getKey, fetchImpl });

test('voice defaults are persisted independently and remain disabled without changing chat configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-settings-'));
  const previous = process.env.ZHIDIAN_USER_DATA;
  process.env.ZHIDIAN_USER_DATA = dir;
  settings.resetForTest();
  try {
    const fresh = settings.load();
    assert.deepEqual(fresh.voice, VOICE_DEFAULTS);
    const chat = structuredClone(fresh.cloud);
    settings.update({ voice: { enabled: true, preset: 'groq', model: 'whisper-large-v3-turbo' } });
    settings.resetForTest();
    assert.equal(settings.load().voice.enabled, true);
    assert.equal(settings.load().voice.model, 'whisper-large-v3-turbo');
    assert.deepEqual(settings.load().cloud, chat);
  } finally {
    if (previous === undefined) delete process.env.ZHIDIAN_USER_DATA; else process.env.ZHIDIAN_USER_DATA = previous;
    settings.resetForTest(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitized views expose destination and readiness without sealed keys or host binding fields', () => {
  const key = 'private-key-1234';
  const api = service(remote(), async () => Response.json({ text: 'ok' }), () => key);
  const view = api.view();
  assert.equal(view.hasKey, true); assert.equal(view.keyHint, '1234');
  assert.equal(view.where, 'api.openai.com'); assert.equal(view.available, true);
  assert.equal(view.maxDurationSeconds, 60); assert.equal(view.maxBytes, 4 * 1024 * 1024);
  assert.equal(api.configured(), true); assert.equal(api.available(), true);
  assert.equal('key' in view, false); assert.equal('keyHost' in view, false);
  assert.equal(JSON.stringify(view).includes(key), false);
  assert.equal(JSON.stringify(view).includes('sealed-private-key'), false);
  assert.equal(service(local()).view().where, 'local');
  const changed = service(remote({ baseUrl: 'https://other.example/v1' }), undefined, () => key).view();
  assert.equal(changed.hasKey, false); assert.equal(changed.keyHint, ''); assert.equal(changed.available, false);
});

test('disabled, missing-key, malformed-config and malformed-audio requests never upload', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ text: 'bad' }); };
  for (const [config, audio, getKey] of [
    [local({ enabled: false }), wav()],
    [remote(), wav()],
    [remote({ baseUrl: 'https://other.example/v1' }), wav(), () => 'private-key'],
    [local({ baseUrl: 'http://remote.example/v1' }), wav()],
    [local(), new Uint8Array(44)],
  ]) {
    const result = await service(config, fetchImpl, getKey).transcribe({ audio });
    assert.equal(result.ok, false); assert.equal(result.text, ''); assert.ok(result.error);
  }
  assert.equal(calls, 0);
});

test('explicit transcription sends dedicated multipart audio with model, language and exact WAV bytes', async (t) => {
  const original = wav();
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    try {
      calls++;
      assert.equal(req.url, '/v1/audio/transcriptions'); assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, undefined);
      const form = await new Request('http://localhost', { method: 'POST', body: req, duplex: 'half', headers: req.headers }).formData();
      assert.equal(form.get('model'), 'whisper-1'); assert.equal(form.get('language'), 'zh');
      assert.equal(form.get('response_format'), 'json');
      const file = form.get('file');
      assert.equal(file.name, 'recording.wav'); assert.equal(file.type, 'audio/wav');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), original);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: '  整理今天的会议纪要。\n' }));
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = service(local({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  assert.equal(api.view().available, true); assert.equal(calls, 0, 'configuration does not upload');
  assert.deepEqual(await api.transcribe({ audio: original, mimeType: 'audio/wav' }), { ok: true, text: '整理今天的会议纪要。' });
  assert.equal(calls, 1);
});

test('remote transcription includes only the bound key and omits auto-detect language', async () => {
  const key = 'voice-secret-1234';
  const api = service(remote({ language: '' }), async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(init.headers.authorization, `Bearer ${key}`);
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body.has('language'), false);
    assert.equal(init.body.has('prompt'), false, 'no chat/context instruction is sent');
    return Response.json({ text: 'A short transcript' });
  }, () => key);
  assert.equal((await api.transcribe({ audio: wav() })).text, 'A short transcript');
});

test('service failures never expose secrets, response bodies or transport error details', async () => {
  const secret = 'private-secret-do-not-show';
  for (const status of [400, 401, 403, 404, 405, 413, 429, 500, 503]) {
    const result = await service(remote(), async () => new Response(`debug ${secret}`, { status }), () => secret).transcribe({ audio: wav() });
    assert.equal(result.ok, false); assert.equal(result.error.includes(secret), false); assert.equal(result.error.includes('debug'), false);
  }
  const result = await service(remote(), async () => { throw new Error(`request failed Authorization Bearer ${secret}`); }, () => secret).transcribe({ audio: wav() });
  assert.equal(result.ok, false); assert.equal(result.error.includes(secret), false); assert.match(result.error, /无法连接/);
  const echo = await service(remote(), async () => Response.json({ text: `misconfigured server echoed ${secret}` }), () => secret).transcribe({ audio: wav() });
  assert.equal(echo.ok, true); assert.equal(echo.text.includes(secret), false); assert.match(echo.text, /密钥已隐藏/);
});

test('invalid, empty and oversized success responses do not become input text', async () => {
  for (const response of [
    new Response('<html>private backend error</html>'), Response.json({ message: 'private backend error' }),
    Response.json({ text: ' \n' }), Response.json({ text: 42 }), Response.json({ text: 'x'.repeat(20001) }),
    new Response('x', { headers: { 'content-length': String(1024 * 1024) } }), new Response('x'.repeat(256 * 1024 + 1)),
  ]) {
    const result = await service(local(), async () => response).transcribe({ audio: wav() });
    assert.equal(result.ok, false); assert.equal(result.text, ''); assert.equal(result.error.includes('private backend'), false);
  }
});

test('HTTP redirects are refused without forwarding the audio or credential', async (t) => {
  let redirected = 0;
  let original = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/audio/transcriptions') { original++; res.writeHead(307, { location: '/stolen' }).end(); }
    else { redirected++; res.writeHead(200).end('{"text":"unexpected"}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await service(local({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` })).transcribe({ audio: wav() });
  assert.equal(result.ok, false); assert.equal(original, 1); assert.equal(redirected, 0);
});

test('caller cancellation aborts the upload, rejects duplicate work and allows a new recording', async () => {
  const caller = new AbortController();
  let pendingSignal;
  const api = service(local(), async (_url, init) => {
    pendingSignal = init.signal;
    return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private abort details')), { once: true }));
  });
  const pending = api.transcribe({ audio: wav(), signal: caller.signal });
  assert.match((await api.transcribe({ audio: wav() })).error, /上一段/);
  caller.abort();
  assert.equal(pendingSignal.aborted, true);
  assert.match((await pending).error, /已取消/);
  api.fetchImpl = async () => Response.json({ text: '下一段' });
  assert.equal((await api.transcribe({ audio: wav() })).text, '下一段');
  assert.match((await api.transcribe({ audio: wav(), signal: caller.signal })).error, /已取消/);
});

test('settings-change cancel aborts active work and discards a late response', async () => {
  let finish;
  const api = service(local(), async () => new Promise((resolve) => { finish = resolve; }));
  const pending = api.transcribe({ audio: wav() });
  api.cancel();
  finish(Response.json({ text: 'This must never reach the input' }));
  assert.match((await pending).error, /已取消/);
});

test('the transcription deadline aborts after 60 seconds and produces a safe timeout message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const api = service(local(), async (_url, init) => {
    requestSignal = init.signal;
    return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private timeout details')), { once: true }));
  });
  const pending = api.transcribe({ audio: wav() });
  t.mock.timers.tick(59_999); assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1); assert.equal(requestSignal.aborted, true);
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /超时/); assert.equal(result.error.includes('private'), false);
});
