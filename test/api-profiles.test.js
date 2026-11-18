import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudProfileStore, migrateLegacyProfiles } from '../src/main/cloud/profiles.js';
import { PRESETS, getPreset } from '../src/main/cloud/presets.js';
import { endpointOf } from '../src/core/cloud-wire.js';

const claude = {
  provider: 'anthropic', presetId: 'anthropic', vision: 'vision', model: 'claude-opus-5-5', baseUrl: '',
  key: 'sealed:claude-secret', keyHost: 'api.anthropic.com', keyHint: '1234',
  enabled: true, byDefault: true, effort: 'high', webSearch: true,
};
const openai = {
  provider: 'openai', presetId: 'openai', vision: 'vision', model: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1',
  key: 'sealed:openai-secret', keyHost: 'api.openai.com', keyHint: '5678',
  enabled: true, byDefault: false, effort: 'low', webSearch: false,
};

function harness(initial = {}) {
  let state = structuredClone({ apiProfiles: [], activeApiProfile: '', apiProfilesMigrated: true, cloud: claude, ...initial });
  let writes = 0;
  const settings = {
    load: () => state,
    update(patch) {
      writes++;
      state = { ...state, ...structuredClone(patch), cloud: { ...state.cloud, ...(patch.cloud ?? {}) } };
      return state;
    },
  };
  return { store: new CloudProfileStore({ settings }), settings, writes: () => writes };
}

test('API presets cover supported services with editable models and valid wire endpoints', () => {
  assert.deepEqual(Object.keys(PRESETS), ['anthropic', 'openai', 'gemini', 'deepseek', 'dashscope', 'siliconflow', 'openrouter', 'custom']);
  for (const p of Object.values(PRESETS)) {
    assert.equal(getPreset(p.id), p);
    assert.ok(['anthropic', 'openai'].includes(p.provider));
    assert.ok(['auto', 'vision', 'text'].includes(p.vision));
    assert.equal(p.editable, true);
    assert.equal(p.discoverable, true);
    if (p.id !== 'custom') assert.equal(endpointOf(p).ok, true, p.id);
  }
  assert.equal(PRESETS.anthropic.baseUrl, '', 'retain first-party credential behavior');
  assert.equal(PRESETS.deepseek.vision, 'text');
  assert.equal(PRESETS.custom.vision, 'auto');
  assert.equal(getPreset('not-a-preset'), null);
  assert.equal(getPreset('__proto__'), null);
});

test('legacy migration is pure and runs once without inventing a profile on fresh install', () => {
  const fresh = { cloud: { provider: 'anthropic', model: '', baseUrl: '', key: '' } };
  const out = migrateLegacyProfiles(fresh);
  assert.deepEqual(out.apiProfiles, []);
  assert.equal(out.activeApiProfile, '');
  assert.equal(out.apiProfilesMigrated, true);
  assert.equal(fresh.apiProfilesMigrated, undefined);

  const old = { cloud: structuredClone(claude), otherSetting: 42 };
  const original = structuredClone(old);
  const migrated = migrateLegacyProfiles(old);
  assert.deepEqual(old, original);
  assert.equal(migrated.otherSetting, 42);
  assert.equal(migrated.activeApiProfile, 'legacy');
  assert.equal(migrated.apiProfiles.length, 1);
  assert.deepEqual(migrated.apiProfiles[0].config, claude);
  assert.equal(migrateLegacyProfiles(migrated), migrated);

  const deleted = { ...migrated, apiProfiles: [], activeApiProfile: '' };
  assert.deepEqual(migrateLegacyProfiles(deleted).apiProfiles, [], 'deleted profiles stay deleted');
});

test('legacy migration retains an existing profile list and active choice', () => {
  const { store, settings } = harness();
  const saved = store.save('已有配置');
  const old = { ...settings.load(), apiProfilesMigrated: false };
  const migrated = migrateLegacyProfiles(old);
  assert.equal(migrated.activeApiProfile, saved.id);
  assert.deepEqual(migrated.apiProfiles, old.apiProfiles);
  assert.equal(migrated.apiProfilesMigrated, true);
});

test('saving and switching profiles retain each sealed key and unsaved active edits separately', () => {
  const { store, settings } = harness();
  const a = store.save('工作 Claude');
  assert.match(a.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/);
  settings.update({ cloud: { model: 'claude-sonnet-5-5', effort: 'medium' } });
  const b = store.save('备用 Claude');
  assert.notEqual(a.id, b.id);
  settings.update({ cloud: openai });
  store.syncActive();
  store.select(a.id);
  assert.equal(settings.load().cloud.model, 'claude-sonnet-5-5');
  assert.equal(settings.load().cloud.effort, 'medium');
  assert.equal(settings.load().cloud.key, claude.key);
  assert.equal(settings.load().cloud.keyHost, 'api.anthropic.com');
  settings.update({ cloud: { webSearch: false } });
  store.select(b.id);
  assert.deepEqual(settings.load().cloud, openai);
  store.select(a.id);
  assert.equal(settings.load().cloud.webSearch, false, 'select saves the outgoing changes');
  assert.equal(settings.load().cloud.key, claude.key);
});

test('profile summaries and mutation results never expose credentials or arbitrary extra fields', () => {
  const { store, settings } = harness({ cloud: { ...claude, apiKey: 'raw-secret', surprise: 'unrecognized', local: { externalKey: 'other-secret' } } });
  const saved = store.save('  个人 API  ');
  const renamed = store.rename(saved.id, '新的名称');
  const synced = store.syncActive();
  const selected = store.select(saved.id);
  assert.equal(saved.name, '个人 API');
  assert.equal(renamed.name, '新的名称');
  assert.deepEqual(Object.keys(store.view()[0]).sort(), ['id', 'name', 'provider', 'presetId', 'model', 'baseUrl', 'hasKey', 'keyHint'].sort());
  for (const result of [saved, renamed, synced, selected, store.view()]) {
    assert.doesNotMatch(JSON.stringify(result), /sealed:|raw-secret|other-secret|keyHost|apiKey/);
  }
  const config = settings.load().apiProfiles[0].config;
  assert.equal(config.key, claude.key);
  assert.equal(config.apiKey, undefined);
  assert.equal(config.surprise, undefined);
  assert.equal(config.local, undefined);
});

test('creating a connection starts blank and preserves edits to the previous profile', () => {
  const { store, settings } = harness();
  const previous = store.save('已配置');
  settings.update({ cloud: { model: 'claude-sonnet-5-5' } });
  const fresh = store.create();
  assert.equal(fresh.name, '新连接');
  assert.equal(settings.load().activeApiProfile, fresh.id);
  assert.deepEqual(settings.load().cloud, {
    provider: 'openai', presetId: 'custom', vision: 'auto', model: '', baseUrl: '',
    effort: 'low', webSearch: false, enabled: false, byDefault: false, key: '', keyHost: '', keyHint: '',
  });
  store.select(previous.id);
  assert.equal(settings.load().cloud.key, claude.key);
  assert.equal(settings.load().cloud.model, 'claude-sonnet-5-5');
});

test('switching to a profile with a mismatched credential host clears its key and disables it', () => {
  const corrupt = { ...openai, baseUrl: 'https://other.example.com/v1' };
  const { store, settings } = harness({ apiProfiles: [{ id: 'wrong-host', name: '网关', config: corrupt }] });
  assert.equal(store.view()[0].hasKey, false);
  assert.equal(store.view()[0].keyHint, '');
  store.select('wrong-host');
  for (const config of [settings.load().cloud, settings.load().apiProfiles[0].config]) {
    assert.equal(config.key, '');
    assert.equal(config.keyHost, '');
    assert.equal(config.keyHint, '');
    assert.equal(config.enabled, false);
    assert.equal(config.byDefault, false);
  }
});

test('invalid endpoints stay disabled and byDefault cannot outlive the master switch', () => {
  const { store, settings } = harness({ cloud: { ...openai, baseUrl: 'http://api.openai.com/v1' } });
  const saved = store.save('无效地址');
  store.select(saved.id);
  assert.equal(settings.load().cloud.enabled, false);
  assert.equal(settings.load().cloud.byDefault, false);
  settings.update({ cloud: { ...claude, enabled: false, byDefault: true } });
  store.syncActive();
  assert.equal(settings.load().apiProfiles[0].config.byDefault, false);
});

test('profiles can retain first-party environment-auth preference without storing a key', () => {
  const envConfig = { ...claude, key: '', keyHost: '', keyHint: '' };
  const { store, settings } = harness({ cloud: envConfig });
  const saved = store.save('系统环境密钥');
  store.select(saved.id);
  assert.equal(saved.hasKey, false);
  assert.equal(settings.load().cloud.enabled, true);
  assert.equal(settings.load().cloud.byDefault, true);
});

test('deleting the active profile clears credentials and selection without deleting other profiles', () => {
  const { store, settings } = harness();
  const a = store.save('A');
  const b = store.save('B');
  assert.equal(store.remove(b.id), true);
  assert.deepEqual(store.view().map((p) => p.id), [a.id]);
  assert.equal(settings.load().activeApiProfile, '');
  assert.equal(settings.load().cloud.key, '');
  assert.equal(settings.load().cloud.enabled, false);
  assert.equal(settings.load().cloud.byDefault, false);
  assert.equal(settings.load().cloud.model, claude.model);
  store.select(a.id);
  assert.equal(settings.load().cloud.key, claude.key);
  store.remove(a.id);
  assert.deepEqual(migrateLegacyProfiles(settings.load()).apiProfiles, []);
});

test('deleting an inactive profile preserves current credentials and pending edits', () => {
  const { store, settings } = harness();
  const a = store.save('A');
  const b = store.save('B');
  settings.update({ cloud: openai });
  store.remove(a.id);
  assert.equal(settings.load().activeApiProfile, b.id);
  assert.equal(settings.load().cloud.key, openai.key);
  assert.equal(settings.load().apiProfiles[0].config.key, openai.key);
});

test('unknown ids and empty names fail without writing settings', () => {
  const { store, writes } = harness();
  for (const operation of [() => store.select('missing'), () => store.remove('missing'), () => store.rename('missing', '名字'), () => store.save('  ')]) {
    assert.throws(operation);
  }
  assert.equal(store.syncActive(), null);
  assert.equal(writes(), 0);
});
