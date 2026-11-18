// Named API configurations. Keys stay sealed exactly as settings/cloud/secrets.js saved them;
// only the main process reads this store. view() is the sole renderer-facing representation.
import { randomUUID } from 'node:crypto';
import { endpointOf } from '../../core/cloud-wire.js';
import { getPreset } from './presets.js';

const defaults = {
  provider: 'anthropic', presetId: 'anthropic', vision: 'auto',
  model: '', baseUrl: '', effort: 'low', webSearch: false,
  enabled: false, byDefault: false, key: '', keyHost: '', keyHint: '',
};
const texts = ['model', 'baseUrl', 'key', 'keyHost', 'keyHint'];

/** Copy only supported config fields; a key never follows a profile to a different host. */
function configOf(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const out = { ...defaults };
  out.provider = input.provider === 'openai' ? 'openai' : 'anthropic';
  const chosen = getPreset(input.presetId);
  out.presetId = chosen?.provider === out.provider ? chosen.id : out.provider === 'anthropic' ? 'anthropic' : 'custom';
  if (['auto', 'vision', 'text'].includes(input.vision)) out.vision = input.vision;
  if (['low', 'medium', 'high'].includes(input.effort)) out.effort = input.effort;
  for (const k of texts) if (typeof input[k] === 'string') out[k] = input[k];
  out.model = out.model.trim();
  out.baseUrl = out.baseUrl.trim();
  out.webSearch = Boolean(input.webSearch);
  out.enabled = Boolean(input.enabled);
  out.byDefault = out.enabled && Boolean(input.byDefault);
  const ep = endpointOf(out);
  if (out.key && (!out.keyHost || out.keyHost !== ep.host)) {
    out.key = '';
    out.enabled = false;
    out.byDefault = false;
  }
  if (!out.key) {
    out.keyHost = '';
    out.keyHint = '';
  }
  if (!ep.ok) out.enabled = out.byDefault = false;
  return out;
}

function nameOf(value) {
  const name = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  if (!name) throw new Error('请填写配置名称');
  return name;
}

function summary(profile, config = profile.config) {
  const c = configOf(config);
  return {
    id: profile.id,
    name: profile.name,
    provider: c.provider,
    presetId: c.presetId,
    model: c.model,
    baseUrl: c.baseUrl,
    hasKey: Boolean(c.key),
    keyHint: c.key ? c.keyHint : '',
  };
}

/**
 * One-time, pure migration of the previous single-cloud settings. Call before persisting load.
 * A fresh install gets no example profile. Deleting the final profile cannot recreate it later.
 */
export function migrateLegacyProfiles(value = {}) {
  const state = value && typeof value === 'object' ? value : {};
  if (state.apiProfilesMigrated) return state;
  const profiles = Array.isArray(state.apiProfiles) ? [...state.apiProfiles] : [];
  let active = typeof state.activeApiProfile === 'string' ? state.activeApiProfile : '';
  const cloud = state.cloud ?? {};
  if (!profiles.length && !active && ['key', 'model', 'baseUrl'].some((k) => typeof cloud[k] === 'string' && cloud[k].trim())) {
    profiles.push({ id: 'legacy', name: '原有 API 配置', config: configOf(cloud) });
    active = 'legacy';
  }
  return { ...state, apiProfiles: profiles, activeApiProfile: active, apiProfilesMigrated: true };
}

export class CloudProfileStore {
  /** @param {{settings: {load: () => object, update: (patch: object) => object}}} deps */
  constructor({ settings }) {
    this.settings = settings;
  }

  #profiles(state) {
    return Array.isArray(state.apiProfiles) ? state.apiProfiles : [];
  }

  #require(state, id) {
    const profile = this.#profiles(state).find((p) => p.id === id);
    if (!profile) throw new Error('没有找到这个 API 配置');
    return profile;
  }

  #synced(state) {
    return this.#profiles(state).map((p) => p.id === state.activeApiProfile ? { ...p, config: configOf(state.cloud) } : p);
  }

  /** Save edits to the selected profile without copying unrelated settings or plaintext keys. */
  syncActive() {
    const state = this.settings.load();
    const profile = this.#profiles(state).find((p) => p.id === state.activeApiProfile);
    if (!profile) return null;
    const profiles = this.#synced(state);
    this.settings.update({ apiProfiles: profiles, apiProfilesMigrated: true });
    return summary(profiles.find((p) => p.id === profile.id));
  }

  /** Save the current configuration as a new profile and select it. */
  save(name) {
    const cleanName = nameOf(name);
    const state = this.settings.load();
    const profile = { id: randomUUID(), name: cleanName, config: configOf(state.cloud) };
    this.settings.update({
      apiProfiles: [...this.#synced(state), profile],
      activeApiProfile: profile.id,
      apiProfilesMigrated: true,
    });
    return summary(profile);
  }

  /** Start an empty connection without replacing the profile the person was editing. */
  create(name = '新连接') {
    const cleanName = nameOf(name);
    const state = this.settings.load();
    const config = configOf({ provider: 'openai', presetId: 'custom' });
    const profile = { id: randomUUID(), name: cleanName, config };
    this.settings.update({
      apiProfiles: [...this.#synced(state), profile],
      activeApiProfile: profile.id,
      apiProfilesMigrated: true,
      cloud: config,
    });
    return summary(profile);
  }

  /** Persist the outgoing profile before loading the incoming one. */
  select(id) {
    const state = this.settings.load();
    this.#require(state, id);
    const profiles = this.#synced(state);
    const profile = profiles.find((p) => p.id === id);
    const config = configOf(profile.config);
    // Store the validated copy as well: a discarded key must not come back on the next load.
    this.settings.update({
      apiProfiles: profiles.map((p) => p.id === id ? { ...p, config } : p),
      activeApiProfile: id,
      apiProfilesMigrated: true,
      cloud: config,
    });
    return summary(profile, config);
  }

  rename(id, name) {
    const cleanName = nameOf(name);
    const state = this.settings.load();
    this.#require(state, id);
    const profiles = this.#synced(state).map((p) => p.id === id ? { ...p, name: cleanName } : p);
    this.settings.update({ apiProfiles: profiles, apiProfilesMigrated: true });
    return summary(profiles.find((p) => p.id === id));
  }

  remove(id) {
    const state = this.settings.load();
    this.#require(state, id);
    const patch = { apiProfiles: this.#synced(state).filter((p) => p.id !== id), apiProfilesMigrated: true };
    if (state.activeApiProfile === id) {
      patch.activeApiProfile = '';
      patch.cloud = { ...configOf(state.cloud), key: '', keyHost: '', keyHint: '', enabled: false, byDefault: false };
    }
    this.settings.update(patch);
    return true;
  }

  /** Safe for IPC: neither encrypted credentials nor their binding metadata leave the process. */
  view() {
    const state = this.settings.load();
    return this.#profiles(state).map((p) => summary(p, p.id === state.activeApiProfile ? state.cloud : p.config));
  }
}
