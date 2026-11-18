// Starting points, not a model allowlist: accounts and gateways expose different models.
// Both the address and the model remain editable, and the settings UI can discover models.
const preset = (id, label, provider, baseUrl, model, vision, models = [model]) => Object.freeze({
  id, label, provider, baseUrl, model, vision,
  models: Object.freeze(models.filter(Boolean)),
  editable: true,
  discoverable: true,
});

export const PRESETS = Object.freeze({
  anthropic: preset('anthropic', 'Claude（Anthropic）', 'anthropic', '', 'claude-opus-5-5', 'vision', [
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2',
  ]),
  openai: preset('openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', 'gpt-4.1', 'vision', [
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o',
  ]),
  gemini: preset('gemini', 'Gemini（Google）', 'openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash', 'vision', [
    'gemini-2.5-flash', 'gemini-2.5-pro',
  ]),
  deepseek: preset('deepseek', 'DeepSeek', 'openai', 'https://api.deepseek.com/v1', 'deepseek-chat', 'text', [
    'deepseek-chat', 'deepseek-reasoner',
  ]),
  dashscope: preset('dashscope', '通义千问（阿里云百炼）', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-vl-max', 'vision', [
    'qwen-vl-max', 'qwen-vl-plus', 'qwen-plus',
  ]),
  siliconflow: preset('siliconflow', '硅基流动（SiliconFlow）', 'openai', 'https://api.siliconflow.cn/v1', 'Qwen/Qwen2.5-VL-72B-Instruct', 'vision'),
  openrouter: preset('openrouter', 'OpenRouter', 'openai', 'https://openrouter.ai/api/v1', 'openai/gpt-4.1', 'vision'),
  custom: preset('custom', '自定义 OpenAI 兼容接口', 'openai', '', '', 'auto', []),
});

export const getPreset = (id) => Object.hasOwn(PRESETS, id) ? PRESETS[id] : null;
