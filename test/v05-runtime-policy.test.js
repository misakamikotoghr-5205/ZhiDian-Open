import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardwareProfile } from '../src/main/local/hardware.js';
import { MODELS } from '../src/main/local/catalog.js';
import { LocalRuntime } from '../src/main/local/runtime.js';
import { Office } from '../src/main/office/index.js';
import { BASIC_ACTIONS } from '../src/main/office/policy.js';

test('memory pressure selects small; a capable idle machine selects large; middle removed', () => {
  const GiB = 1024 ** 3;
  assert.equal(hardwareProfile({totalMemory: 16*GiB, freeMemory: 8*GiB}).tier, 'large');
  assert.equal(hardwareProfile({totalMemory: 16*GiB, freeMemory: 4*GiB}).tier, 'small');
  assert.equal(hardwareProfile({totalMemory: 8*GiB, freeMemory: 7*GiB}).tier, 'small');
  assert.deepEqual(MODELS.map(m=>m.id), ['qwen3.5-0.8b', 'qwen3.5-4b']);
});

test('automatic selection uses the hardware recommendation and may fall back to installed small', () => {
  const runtime = new LocalRuntime({baseDir: os.tmpdir(), getConfig:()=>({modelId:''}), resources:{totalMemory:32*1024**3,freeMemory:16*1024**3}});
  runtime.modelInstalled = () => true;
  assert.equal(runtime.activeModel().id, 'qwen3.5-4b');
  runtime.modelInstalled = m => m.id === 'qwen3.5-0.8b';
  assert.equal(runtime.activeModel().id, 'qwen3.5-0.8b');
  assert.equal(runtime.tier(), 'small');
});

test('a saved explicit large-model choice is honored even when available memory recommends small', () => {
  const runtime = new LocalRuntime({baseDir: os.tmpdir(), getConfig:()=>({modelId:'qwen3.5-4b'}), resources:{totalMemory:16*1024**3,freeMemory:4*1024**3}});
  runtime.modelInstalled = () => true;
  assert.equal(runtime.hardware.recommended, 'qwen3.5-0.8b');
  assert.equal(runtime.activeModel().id, 'qwen3.5-4b');
  assert.equal(runtime.tier(), 'large');
});

test('a saved explicit small-model choice is honored on a machine that recommends large', () => {
  const runtime = new LocalRuntime({baseDir: os.tmpdir(), getConfig:()=>({modelId:'qwen3.5-0.8b'}), resources:{totalMemory:32*1024**3,freeMemory:16*1024**3}});
  runtime.modelInstalled = () => true;
  assert.equal(runtime.hardware.recommended, 'qwen3.5-4b');
  assert.equal(runtime.activeModel().id, 'qwen3.5-0.8b');
  assert.equal(runtime.tier(), 'small');
});

test('an unavailable explicitly selected model never silently runs the other installed model', () => {
  for (const requested of MODELS) {
    const runtime = new LocalRuntime({baseDir: os.tmpdir(), getConfig:()=>({modelId:requested.id}), resources:{totalMemory:32*1024**3,freeMemory:16*1024**3}});
    runtime.modelInstalled = model => model.id !== requested.id;
    runtime.binaryPath = () => 'present-runtime';
    assert.equal(runtime.activeModel(), null, `missing ${requested.id} must require a new selection`);
    assert.equal(runtime.ready(), false);
  }
});

test('returning from an explicit choice to automatic follows the hardware recommendation', () => {
  const config = { modelId: 'qwen3.5-4b' };
  const runtime = new LocalRuntime({baseDir: os.tmpdir(), getConfig:()=>config, resources:{totalMemory:16*1024**3,freeMemory:4*1024**3}});
  runtime.modelInstalled = () => true;
  assert.equal(runtime.activeModel().id, 'qwen3.5-4b');
  config.modelId = '';
  assert.equal(runtime.activeModel().id, 'qwen3.5-0.8b');
});

test('a removed legacy 2B preference remains compatible with automatic selection', () => {
  const runtime = new LocalRuntime({baseDir: os.tmpdir(), getConfig:()=>({modelId:'qwen3.5-2b'}), resources:{totalMemory:32*1024**3,freeMemory:16*1024**3}});
  runtime.modelInstalled = () => true;
  assert.equal(runtime.activeModel().id, 'qwen3.5-4b');
});

test('bundled weights stay in place and an office adapter never enables pointer response parsing', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zhidian-bundle-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bundle=path.join(dir,'bundled');fs.mkdirSync(bundle);
  const runtime=new LocalRuntime({baseDir:path.join(dir,'user'),bundleDir:bundle,getConfig:()=>({})});
  const file={role:'model',name:'fixture.gguf',size:4};const model={id:'fixture',files:[file],adapter:'pointer.gguf',officeAdapter:'office.gguf'};
  fs.writeFileSync(path.join(bundle,file.name),'GGUF');
  fs.writeFileSync(path.join(bundle,model.officeAdapter),'GGUF');
  runtime.activeModel=()=>model;
  assert.equal(runtime.modelPath(model,'model'),path.join(bundle,file.name));
  assert.equal(runtime.modelInstalled(model),true);
  assert.equal(runtime.pointerMode(),false);
  assert.equal(fs.existsSync(path.join(dir,'user')),false);
});

test('small tier limits advertised and executable actions; advanced commands cannot bypass UI', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zhidian-policy-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'source.txt');fs.writeFileSync(file,'This is the source document.');
  let tier='small';const office=new Office({documentsDir:dir,getTier:()=>tier});
  const ctx=office.context({files:[file]});
  assert.ok(office.offers(ctx).every(a=>BASIC_ACTIONS.includes(a.id)));
  await assert.rejects(office.run('file.typeset',ctx),/模型档位/);
  assert.deepEqual(fs.readdirSync(dir),['source.txt']);
  tier='large';assert.ok(office.offers(ctx).some(a=>a.id==='file.typeset'));
  assert.ok(!office.offers(ctx).some(a=>a.id==='files.zip'));
});
