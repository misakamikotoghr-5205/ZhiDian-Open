import { isLoopback } from '../../core/cloud-wire.js';

export const VOICE_DEFAULTS = Object.freeze({
  enabled: false,
  preset: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
  language: 'zh',
  key: '',
  keyHost: '',
  keyHint: '',
});

export const VOICE_PRESETS = Object.freeze([
  Object.freeze({ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' }),
  Object.freeze({ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' }),
  Object.freeze({ id: 'local-openai', label: '本地 OpenAI 兼容服务', baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1' }),
  Object.freeze({ id: 'custom', label: '自定义兼容服务', baseUrl: '', model: '' }),
]);

/** Validate the transcription destination independently of the selected preset or chat model. */
export function validateVoiceConfig(config = {}) {
  const c = { ...VOICE_DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl.trim().replace(/\/+$/, '') : '';
  const model = typeof c.model === 'string' ? c.model.trim() : '';
  const language = c.language === 'auto' ? '' : c.language;
  const result = { ok: false, problem: '', baseUrl, endpoint: '', host: '', local: false, model, language: typeof language === 'string' ? language : '' };
  const fail = (problem) => ({ ...result, problem });
  if (!baseUrl) return fail('请填写语音转写服务地址。');
  let url;
  try { url = new URL(baseUrl); }
  catch { return fail('语音转写服务地址不是有效的网址。'); }
  result.host = url.host;
  result.local = isLoopback(url.hostname);
  if (url.username || url.password) return fail('服务地址里不能包含用户名或密码，请在密钥栏填写凭证。');
  if (baseUrl.includes('?') || baseUrl.includes('#')) return fail('服务地址不能包含查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && result.local)) {
    return fail('语音转写地址必须使用 HTTPS；只有本机回环地址可以使用 HTTP。');
  }
  if (!model || model.length > 200) return fail('请填写语音转写模型名，长度不能超过 200 个字符。');
  if (typeof language !== 'string' || (language !== '' && !/^[a-z]{2,3}$/.test(language))) {
    return fail('语言请留空以自动识别，或填写两到三个小写英文字母，例如 zh、en。');
  }
  return { ...result, ok: true, endpoint: baseUrl + '/audio/transcriptions' };
}
