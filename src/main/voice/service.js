// Speech recognition uses a dedicated audio endpoint. It does not send audio to a chat
// model, use browser speech services, or upload anything until transcribe is called.
import { VOICE_DEFAULTS, VOICE_PRESETS, validateVoiceConfig } from './config.js';
import { MAX_AUDIO_BYTES, MAX_DURATION_SECONDS, validateWav } from './wav.js';

const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 20_000;
const failure = (error) => ({ ok: false, text: '', error });

function statusError(status) {
  if (status === 401 || status === 403) return '语音服务密钥无效或没有转写权限，请检查语音设置。';
  if (status === 404 || status === 405) return '这个地址未提供语音转写接口，请填写支持 /audio/transcriptions 的服务。';
  if (status === 413) return '语音服务拒绝了这段录音，请缩短后重试。';
  if (status === 429) return '语音服务请求过多或额度不足，请稍后重试或检查账户。';
  return '语音服务暂时无法完成转写，请稍后重试。';
}

// Bound untrusted successful responses too. Error bodies are never read or shown to users.
async function readPayload(response) {
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES || !response.body?.getReader) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

export class VoiceService {
  constructor({ getSettings, getKey = () => '', fetchImpl = fetch }) {
    this.getSettings = getSettings;
    this.getKey = getKey;
    this.fetchImpl = fetchImpl;
    this.active = null;
  }

  config() {
    const settings = this.getSettings?.() ?? {};
    return { ...VOICE_DEFAULTS, ...(settings.voice ?? settings) };
  }

  state() {
    const config = this.config();
    const endpoint = validateVoiceConfig(config);
    let key = '';
    if (endpoint.ok) {
      // The caller decrypts only a key bound to this endpoint. Refuse a known mismatch here
      // as well, so changing the address can never move an existing credential to a new host.
      try { key = String(this.getKey(config) ?? '').trim(); } catch { /* An unavailable key is shown as missing. */ }
      if (config.keyHost && config.keyHost !== endpoint.host) key = '';
    }
    const problem = endpoint.problem || (!endpoint.local && !key ? '先在语音设置中保存这个服务的密钥。' : '');
    return { config, endpoint, key, problem, configured: endpoint.ok && (endpoint.local || Boolean(key)) };
  }

  view() {
    const { config, endpoint, key, problem, configured } = this.state();
    return {
      enabled: Boolean(config.enabled), preset: config.preset,
      baseUrl: config.baseUrl, model: config.model, language: config.language,
      presets: VOICE_PRESETS, host: endpoint.host, local: endpoint.local,
      where: endpoint.local ? 'local' : endpoint.host,
      problem, hasKey: Boolean(key), keyHint: key ? String(config.keyHint ?? '').slice(-4) : '',
      configured, available: Boolean(config.enabled) && configured,
      maxDurationSeconds: MAX_DURATION_SECONDS, maxBytes: MAX_AUDIO_BYTES,
    };
  }

  configured() { return this.state().configured; }
  available() { return this.view().available; }
  cancel() { this.active?.abort(); }

  async transcribe({ audio, mimeType = 'audio/wav', signal } = {}) {
    if (signal?.aborted) return failure('已取消语音转写。');
    if (this.active) return failure('上一段录音仍在转写，请稍后重试。');
    const { config, endpoint, key, problem, configured } = this.state();
    if (!config.enabled) return failure('请先在设置中启用语音输入。');
    if (!configured) return failure(problem || '请先完成语音服务设置。');
    const wav = validateWav(audio, mimeType);
    if (!wav.ok) return failure(wav.error);

    const controller = new AbortController();
    this.active = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const body = new FormData();
      body.append('file', new Blob([wav.bytes], { type: 'audio/wav' }), 'recording.wav');
      body.append('model', endpoint.model);
      if (endpoint.language) body.append('language', endpoint.language);
      body.append('response_format', 'json');
      const response = await this.fetchImpl(endpoint.endpoint, {
        method: 'POST', body, headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: controller.signal, redirect: 'error',
      });
      if (controller.signal.aborted) throw new Error('cancelled');
      if (response.redirected) return failure('语音服务发生了重定向，请检查服务地址。');
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return failure(statusError(response.status)); }
      const payload = await readPayload(response);
      if (controller.signal.aborted) throw new Error('cancelled');
      if (typeof payload?.text !== 'string' || payload.text.length > MAX_TEXT_LENGTH) return failure('语音服务没有返回有效的转写文字，请检查服务与模型设置。');
      // A faulty service must not echo an authorization key back into a renderer as text.
      const text = (key ? payload.text.replaceAll(key, '[密钥已隐藏]') : payload.text).trim();
      if (!text) return failure('没有识别到文字，请靠近麦克风重新录制。');
      return { ok: true, text };
    } catch {
      return failure(timedOut ? '语音转写超时，请稍后重试。' : controller.signal.aborted ? '已取消语音转写。' : '无法连接语音转写服务，请检查地址、网络和服务是否已启动。');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      if (this.active === controller) this.active = null;
    }
  }
}
