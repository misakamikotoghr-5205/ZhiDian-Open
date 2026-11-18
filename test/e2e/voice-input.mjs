// Real Electron microphone capture and renderer/main-process transcription. Chromium supplies
// a fake microphone; the recorder, WAV encoder, IPC and multipart request are production code.
// No external service receives audio. Run under X11 (xvfb-run) or an interactive desktop.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-voice-'));
const output = process.env.E2E_OUT || temp;
fs.mkdirSync(output, { recursive: true });
const requests = [];
const pending = [];
let responseMode = 'success';
const transcript = '请总结当前文档的三个重点。';
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const form = await new Request('http://127.0.0.1/transcribe', {
      method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: bytes,
    }).formData();
    const file = form.get('file');
    const audio = file && typeof file.arrayBuffer === 'function' ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, model: form.get('model'), language: form.get('language'), format: form.get('response_format'), name: file?.name, type: file?.type, audio });
    const send = (status, body) => { if (!res.destroyed) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
    if (responseMode === 'hold') return void pending.push(() => send(200, { text: '这条迟到结果不应覆盖草稿。' }));
    if (responseMode === 'unauthorized') return send(401, { error: { message: 'PRIVATE_SERVER_DETAIL_DO_NOT_RENDER sk-private-key' } });
    send(200, { text: transcript });
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const userData = path.join(temp, 'user-data');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  seenIntro: true, mcp: { enabled: false }, actions: { ambient: false },
  voice: { enabled: true, preset: 'local-openai', baseUrl: endpoint, model: 'whisper-1', language: 'zh', key: '', keyHost: '', keyHint: '' },
}));
const wm = process.platform === 'linux' ? spawn('openbox', ['--sm-disable'], { stdio: 'ignore' }) : null;
wm?.on('error', () => {});
let app;
let overlay;
const pageErrors = [];
const state = (name) => overlay.waitForFunction((wanted) => document.getElementById('voicepanel')?.dataset.state === wanted, name, { timeout: 10000 });
const inactive = () => overlay.waitForFunction(() => {
  const panel = document.getElementById('voicepanel');
  return panel?.hidden || !['starting', 'listening', 'transcribing'].includes(panel?.dataset.state);
}, null, { timeout: 10000 });
async function startRecording() {
  await overlay.locator('#qmic').click();
  await state('listening');
  await sleep(750); // Include fake-device warmup and at least one worklet batch.
}
async function stopRecording() {
  await overlay.locator('#voice-stop').click();
}
function checkWave(audio) {
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  let fmt;
  let pcm;
  for (let at = 12; at + 8 <= audio.length;) {
    const name = audio.toString('ascii', at, at + 4);
    const size = audio.readUInt32LE(at + 4);
    assert.ok(at + 8 + size <= audio.length, 'WAV chunk stays inside its payload');
    if (name === 'fmt ') fmt = audio.subarray(at + 8, at + 8 + size);
    if (name === 'data') pcm = audio.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size & 1);
  }
  assert.ok(fmt && pcm, 'actual WAV includes format and samples');
  assert.deepEqual([fmt.readUInt16LE(0), fmt.readUInt16LE(2), fmt.readUInt32LE(4), fmt.readUInt16LE(14)], [1, 1, 16000, 16]);
  assert.ok(pcm.length >= 3200, 'at least 100ms of real captured samples');
  assert.ok(pcm.some((value) => value !== 0), 'fake microphone produced a non-silent waveform');
}
try {
  app = await electron.launch({
    executablePath: require('electron'),
    // Keep the production Electron permission handlers active. The fake-UI flag can bypass
    // permission decisions; only the microphone hardware itself is replaced here.
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', repo, '--rehearse'],
    env: { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData, ZHIDIAN_LOCAL_DIR: path.join(temp, 'local') },
  });
  overlay = await app.firstWindow();
  overlay.on('pageerror', (error) => pageErrors.push(error.message));
  await overlay.waitForLoadState('domcontentloaded');
  await overlay.waitForFunction(() => window.__overlay?.S.config?.voice?.available === true);
  console.log('▸ Production permissions refuse capture before an explicit recording session');
  const beforeLease = await overlay.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      return 'granted';
    } catch (error) { return error.name; }
  });
  assert.equal(beforeLease, 'NotAllowedError');
  await overlay.evaluate(() => {
    window.__voiceStreams = [];
    window.__originalMicrophone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await window.__originalMicrophone(...args);
      window.__voiceStreams.push(stream);
      return stream;
    };
  });
  await app.evaluate(() => globalThis.__zhidian.enterPointing());
  await overlay.waitForFunction(() => window.__overlay.S.mode === 'pointing');
  await overlay.waitForSelector('#ask:not(.quiet)', { state: 'visible' });
  await overlay.locator('#q').fill('请保留这段原有草稿：');
  const oldDraft = await overlay.locator('#q').inputValue();
  const asked = await app.evaluate(() => globalThis.__zhidian.fakeBrain.calls.length);
  console.log('▸ Real microphone and listening animation; no upload before explicit stop');
  await startRecording();
  assert.equal(requests.length, 0);
  assert.ok(await overlay.evaluate(() => window.__voiceStreams.some((stream) => stream.getAudioTracks().some((track) => track.readyState === 'live'))), 'microphone track is really recording');
  const videoPermission = await overlay.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      return 'granted';
    } catch (error) { return error.name; }
  });
  assert.equal(videoPermission, 'NotAllowedError', 'a microphone lease never grants camera permission');
  const listeningAnimation = await overlay.locator('#voicepanel').evaluate((panel) => panel.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running'));
  await overlay.screenshot({ path: path.join(output, 'voice-listening.png') });
  await overlay.emulateMedia({ reducedMotion: 'reduce' });
  await sleep(100);
  const reducedAnimations = await overlay.locator('#voicepanel').evaluate((panel) => panel.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length);
  await overlay.emulateMedia({ reducedMotion: 'no-preference' });
  await stopRecording();
  await overlay.waitForFunction((text) => document.getElementById('q').value.includes(text), transcript, { timeout: 10000 });
  await inactive();
  assert.equal(requests.length, 1);
  const sent = requests[0];
  assert.deepEqual([sent.method, sent.url, sent.auth, sent.model, sent.language, sent.format, sent.type], ['POST', '/v1/audio/transcriptions', undefined, 'whisper-1', 'zh', 'json', 'audio/wav']);
  assert.match(sent.name, /\.wav$/);
  checkWave(sent.audio);
  assert.ok((await overlay.locator('#q').inputValue()).startsWith(oldDraft), 'transcript preserves the existing input');
  assert.equal(await app.evaluate(() => globalThis.__zhidian.fakeBrain.calls.length), asked, 'dictation never auto-sends the question');
  assert.ok(await overlay.evaluate(() => window.__voiceStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), 'stop releases every audio track');
  await overlay.screenshot({ path: path.join(output, 'voice-success.png') });

  console.log('▸ Cancelling recording sends no audio and retains the draft');
  const draft = await overlay.locator('#q').inputValue();
  await startRecording();
  await overlay.locator('#voice-cancel').click();
  await inactive();
  await sleep(150);
  assert.equal(requests.length, 1);
  assert.equal(await overlay.locator('#q').inputValue(), draft);
  assert.ok(await overlay.evaluate(() => window.__voiceStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))));
  const afterCancel = await overlay.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      return 'granted';
    } catch (error) { return error.name; }
  });
  assert.equal(afterCancel, 'NotAllowedError', 'cancelling the lease also revokes capture permission');

  console.log('▸ Cancelled transcription ignores a late response');
  responseMode = 'hold';
  await startRecording();
  await stopRecording();
  await state('transcribing');
  for (let i = 0; i < 50 && pending.length === 0; i++) await sleep(50);
  assert.equal(pending.length, 1);
  await overlay.screenshot({ path: path.join(output, 'voice-transcribing.png') });
  await overlay.locator('#voice-cancel').click();
  await inactive();
  pending.shift()();
  await sleep(250);
  assert.equal(await overlay.locator('#q').inputValue(), draft);

  console.log('▸ Service errors are readable and do not expose raw server details');
  responseMode = 'unauthorized';
  await startRecording();
  await stopRecording();
  await state('error');
  const errorText = await overlay.locator('#voicepanel').textContent();
  assert.match(errorText, /密钥|认证|授权|401/);
  assert.doesNotMatch(errorText, /PRIVATE_SERVER_DETAIL|sk-private-key/);
  assert.equal(await overlay.locator('#q').inputValue(), draft);

  console.log('▸ Microphone permission denial is handled without an upload');
  const beforeDenied = requests.length;
  await overlay.evaluate(() => {
    window.__allowedMicrophone = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test permission denial', 'NotAllowedError'); };
  });
  await overlay.locator('#qmic').click();
  await state('error');
  assert.match(await overlay.locator('#voicepanel').textContent(), /麦克风|权限/);
  assert.equal(requests.length, beforeDenied);
  await overlay.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__allowedMicrophone; });

  console.log('▸ Holding the microphone records, and pointer release transcribes exactly once');
  responseMode = 'success';
  const beforeHold = requests.length;
  const mic = await overlay.locator('#qmic').boundingBox();
  await overlay.mouse.move(mic.x + mic.width / 2, mic.y + mic.height / 2);
  await overlay.mouse.down();
  await state('listening');
  await sleep(750);
  assert.equal(requests.length, beforeHold, 'holding still keeps the audio on this device');
  await overlay.mouse.up();
  await state('success');
  assert.equal(requests.length, beforeHold + 1);
  assert.ok((await overlay.locator('#q').inputValue()).startsWith(draft));

  console.log('▸ Oversized IPC audio and overlay settings writes are rejected before HTTP');
  const beforeOversize = requests.length;
  const tooLarge = await overlay.evaluate(async () => {
    const session = await window.zhidian.voiceBegin();
    const result = session.ok ? await window.zhidian.voiceTranscribe({ id: session.id, audio: new ArrayBuffer(4 * 1024 * 1024 + 1), mimeType: 'audio/wav' }) : null;
    return { session, result };
  });
  assert.equal(tooLarge.session.ok, true, 'the oversized request uses a valid recording session');
  assert.equal(tooLarge.result.ok, false);
  assert.equal(requests.length, beforeOversize);
  const beforeConfig = await overlay.evaluate(() => JSON.stringify(window.__overlay.S.config.voice));
  const unauthorized = await overlay.evaluate(async () => {
    try { return await window.zhidian.voiceUpdate({ enabled: false, baseUrl: 'http://127.0.0.1:1/v1' }); }
    catch (error) { return { ok: false, error: error.message }; }
  });
  assert.ok(unauthorized === false || unauthorized?.ok === false || unauthorized?.error, 'only the settings renderer may configure transcription');
  await sleep(100);
  assert.equal(await overlay.evaluate(() => JSON.stringify(window.__overlay.S.config.voice)), beforeConfig);
  assert.equal(await app.evaluate(() => globalThis.__zhidian.fakeBrain.calls.length), asked);
  console.log('▸ The settings window cannot start a recording or request a microphone');
  const settingsWindow = app.waitForEvent('window');
  await overlay.evaluate(() => window.zhidian.openSettings('voice'));
  const settingsPage = await settingsWindow;
  settingsPage.on('pageerror', (error) => pageErrors.push(error.message));
  await settingsPage.waitForLoadState('domcontentloaded');
  const settingsPermission = await settingsPage.evaluate(async () => {
    const begin = await window.zhidian.voiceBegin();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      return { begin, microphone: 'granted' };
    } catch (error) { return { begin, microphone: error.name }; }
  });
  assert.equal(settingsPermission.begin.ok, false);
  assert.equal(settingsPermission.microphone, 'NotAllowedError');
  assert.ok(listeningAnimation, 'listening shows an active animation');
  assert.equal(reducedAnimations, 0, 'reduced-motion setting stops decorative voice animation');
  assert.deepEqual(pageErrors, [], 'voice interactions produce no uncaught renderer errors');
  console.log('PASS: real microphone/WAV/multipart path, explicit upload, draft insertion, cancellation, permission/service errors and IPC boundaries');
} catch (error) {
  if (overlay) {
    console.error('Voice diagnostics:', await overlay.evaluate(() => ({ panel: document.getElementById('voicepanel')?.outerHTML, config: window.__overlay?.S.config?.voice, focused: document.hasFocus() })).catch(() => null));
    await overlay.screenshot({ path: path.join(output, 'voice-failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  for (const respond of pending) respond();
  await app?.close().catch(() => {});
  wm?.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (!process.env.KEEP && process.env.E2E_OUT) fs.rmSync(temp, { recursive: true, force: true });
}
