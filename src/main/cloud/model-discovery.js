// Model discovery sends credentials only to the configured endpoint. Capability labels are
// based on server metadata; model names alone are not evidence that a model accepts images.
import { endpointOf } from '../../core/cloud-wire.js';

export function modelVision(model) {
  if (typeof model?.supports_vision === 'boolean') return model.supports_vision;
  if (typeof model?.vision === 'boolean') return model.vision;
  const caps = model?.capabilities;
  if (typeof caps?.vision === 'boolean') return caps.vision;
  if (typeof caps?.image_input?.supported === 'boolean') return caps.image_input.supported;
  if (Array.isArray(caps)) return caps.includes('vision') || caps.includes('image');
  const modalities = model?.input_modalities ?? model?.architecture?.input_modalities;
  if (Array.isArray(modalities)) return modalities.includes('image');
  return null;
}

export async function discoverModels({ provider = 'openai', baseUrl, key = '', fetchImpl = fetch, local = false, localPreset, signal } = {}) {
  try {
    const ep = endpointOf({ provider, baseUrl, model: '_discovery' });
    if (!ep.ok) throw new Error(ep.problem);
    const deadline = AbortSignal.timeout(15_000);
    const cancel = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const headers = provider === 'anthropic'
      ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
      : key ? { authorization: `Bearer ${key}` } : {};
    const suffix = provider === 'anthropic' ? '/v1/models?limit=1000' : '/models';
    const response = await fetchImpl(ep.baseUrl.replace(/\/+$/, '') + suffix, { headers, signal: cancel, redirect: 'error' });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '密钥无效或没有读取模型列表的权限。' : response.status === 404 || response.status === 405 ? '这个服务未提供模型列表，请手动填写模型名。' : `读取模型列表失败（HTTP ${response.status}）。`);
    const payload = await response.json();
    const source = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : null;
    if (!source) throw new Error('服务返回的不是有效模型列表，请检查 API 地址。');
    const seen = new Set();
    const models = source.flatMap((m) => {
      const id = typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : '';
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{ id, label: String(m.display_name ?? m.name ?? id), vision: modelVision(m) }];
    }).slice(0, 1000);
    if (local && localPreset === 'ollama') {
      const origin = new URL(ep.baseUrl).origin;
      // Ollama's OpenAI compatibility list omits capabilities; /api/show supplies them.
      // Bound concurrency and retain unknown when an older Ollama does not support this.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, models.length) }, async () => {
        while (next < models.length) {
          const model = models[next++];
          try {
            const result = await fetchImpl(origin + '/api/show', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id }), signal: cancel, redirect: 'error' });
            if (result.ok) model.vision = modelVision(await result.json());
          } catch { /* Listing still works if capability discovery is unavailable. */ }
        }
      }));
    }
    if (signal?.aborted) throw signal.reason;
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: signal?.aborted ? '已取消读取模型列表。' : /timeout|abort/i.test(err?.name ?? '') ? '读取模型列表超时，请确认服务已启动。' : String(err?.message ?? err) };
  }
}
