import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { LocalRuntime } from '../src/main/local/runtime.js';
import { MODELS, RUNTIME, localName, runtimeAsset } from '../src/main/local/catalog.js';

const binaryName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, { directory = 'storage' } = {}) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'zhidian-download-runtime-'));
  const model = MODELS[0];
  const originalFiles = model.files;
  const contents = { model: Buffer.from('GGUF fixture model'), mmproj: Buffer.from('GGUF fixture vision') };
  model.files = Object.entries(contents).map(([role, bytes]) => ({ role, name: `${role}.gguf`, size: bytes.length, sha256: hash(bytes) }));
  t.after(() => {
    model.files = originalFiles;
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.match(path.basename(root), /^zhidian-download-runtime-[\w-]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cfg = { mode: 'managed', variant: 'auto', modelId: '', adapter: 'off' };
  const baseDir = path.join(root, directory);
  const bundleDir = path.join(root, 'bundle');
  const calls = [];
  const runtime = new LocalRuntime({ baseDir, bundleDir, getConfig: () => cfg, fetchImpl: async (url) => {
    calls.push(url);
    const file = model.files.find(f => url.endsWith('/' + f.name));
    assert.ok(file, `unexpected download: ${url}`);
    return new Response(contents[file.role], { headers: { 'content-length': String(file.size) } });
  } });
  runtime.hardware.recommended = model.id;
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const bundledRuntime = () => write(path.join(bundleDir, 'runtime', `${process.platform}-${process.arch}`, binaryName), 'fixture runtime');
  const bundledModel = () => model.files.forEach(f => write(path.join(bundleDir, localName(f)), contents[f.role]));
  return { root, model, contents, cfg, baseDir, bundleDir, runtime, calls, write, bundledRuntime, bundledModel };
}

test('installation verifies and reuses complete bundled assets without downloading or copying them', async t => {
  const f = fixture(t);
  f.bundledRuntime();
  f.bundledModel();
  f.cfg.modelId = 'qwen3.5-4b';
  const before = structuredClone(f.cfg);
  const result = await f.runtime.install({ modelId: f.model.id });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.baseDir), false, 'bundled assets stay in the application directory');
  assert.deepEqual(f.cfg, before, 'downloading does not select a model or change mode');
  assert.equal(f.runtime.installing, null);
});

test('missing projector downloads beside existing direct weights without redownloading the model', async t => {
  const f = fixture(t, { directory: 'existing-weights' });
  f.bundledRuntime();
  f.write(path.join(f.baseDir, 'model.gguf'), f.contents.model);
  assert.equal(f.runtime.status().modelDir, f.baseDir);
  await f.runtime.install({ modelId: f.model.id });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /\/mmproj\.gguf$/);
  assert.deepEqual(fs.readFileSync(path.join(f.baseDir, 'mmproj.gguf')), f.contents.mmproj);
  assert.equal(fs.existsSync(path.join(f.baseDir, 'models')), false);
  assert.equal(f.runtime.modelInstalled(f.model), true);
});

test('an empty directory named models receives weights directly and reuses a custom runtime', async t => {
  const f = fixture(t, { directory: 'models' });
  f.cfg.binaryPath = path.join(f.root, 'custom', binaryName);
  f.write(f.cfg.binaryPath, 'custom runtime');
  assert.equal(f.runtime.status().modelDir, f.baseDir);
  await f.runtime.install({ modelId: f.model.id });
  assert.equal(f.calls.length, 2);
  for (const file of f.model.files) assert.deepEqual(fs.readFileSync(path.join(f.baseDir, localName(file))), f.contents[file.role]);
  assert.equal(fs.existsSync(path.join(f.baseDir, 'runtime')), false);
});

test('an interrupted direct download resumes there after cancellation, with progress visible before fetch', async t => {
  const f = fixture(t, { directory: 'existing-weights' });
  f.bundledRuntime();
  f.write(path.join(f.baseDir, 'model.gguf.part'), f.contents.model.subarray(0, 4));
  let sawInitialProgress = false;
  f.runtime.on('progress', p => { if (p?.current === 'model') sawInitialProgress = true; });
  f.runtime.fetchImpl = async (url, options) => {
    assert.equal(sawInitialProgress, true, 'cancel button/progress can appear before the network responds');
    assert.equal(options.headers.Range, 'bytes=4-');
    f.runtime.cancelInstall();
    throw new Error('cancelled fixture request');
  };
  await assert.rejects(f.runtime.install({ modelId: f.model.id }), e => e.kind === 'aborted');
  assert.equal(f.runtime.installing, null);
  assert.equal(fs.statSync(path.join(f.baseDir, 'model.gguf.part')).size, 4);
  f.runtime.fetchImpl = async (url, options) => {
    const file = f.model.files.find(item => url.endsWith('/' + item.name));
    const start = Number(/bytes=(\d+)-/.exec(options.headers.Range ?? '')?.[1] ?? 0);
    return new Response(f.contents[file.role].subarray(start), {
      status: start ? 206 : 200,
      headers: { 'content-length': String(file.size - start), ...(start ? { 'content-range': `bytes ${start}-${file.size - 1}/${file.size}` } : {}) },
    });
  };
  await f.runtime.install({ modelId: f.model.id });
  assert.deepEqual(fs.readFileSync(path.join(f.baseDir, 'model.gguf')), f.contents.model);
  assert.equal(fs.existsSync(path.join(f.baseDir, 'model.gguf.part')), false);
  assert.equal(f.runtime.modelInstalled(f.model), true);
});

test('same-size damaged bundled weights are not trusted or overwritten; verified replacements use selected storage', async t => {
  const f = fixture(t);
  f.bundledRuntime();
  f.bundledModel();
  const damaged = Buffer.alloc(f.contents.model.length, 0x7f);
  f.write(path.join(f.bundleDir, 'model.gguf'), damaged);
  await f.runtime.install({ modelId: f.model.id });
  assert.equal(f.calls.length, 1, 'only the damaged weight is downloaded');
  assert.deepEqual(fs.readFileSync(path.join(f.bundleDir, 'model.gguf')), damaged, 'application bundle is read-only');
  assert.deepEqual(fs.readFileSync(path.join(f.baseDir, 'models', 'model.gguf')), f.contents.model);
  assert.equal(f.runtime.modelPath(f.model, 'model'), path.join(f.baseDir, 'models', 'model.gguf'));
});

test('a package without models or runtime installs a verified archive and both weights in selected storage', async t => {
  const f = fixture(t);
  const selectedAsset = runtimeAsset();
  const originalAsset = RUNTIME.assets[selectedAsset.name];
  let archive;
  if (process.platform === 'win32') {
    const zip = new JSZip();
    zip.file(`runtime/${binaryName}`, 'fixture runtime');
    archive = await zip.generateAsync({ type: 'nodebuffer' });
  } else {
    const runtimeFixture = path.join(f.root, 'archive-input');
    f.write(path.join(runtimeFixture, 'runtime', binaryName), 'fixture runtime');
    const archivePath = path.join(f.root, 'fixture.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', runtimeFixture, 'runtime']);
    archive = fs.readFileSync(archivePath);
  }
  RUNTIME.assets[selectedAsset.name] = { size: archive.length, sha256: hash(archive) };
  t.after(() => { RUNTIME.assets[selectedAsset.name] = originalAsset; });
  const modelFetch = f.runtime.fetchImpl;
  f.runtime.fetchImpl = async (url, options) => {
    if (url.endsWith('/' + selectedAsset.name)) {
      f.calls.push(url);
      return new Response(archive, { headers: { 'content-length': String(archive.length) } });
    }
    return modelFetch(url, options);
  };
  assert.equal(f.runtime.ready(), false);
  await f.runtime.install({ modelId: f.model.id });
  assert.equal(f.calls.length, 3);
  assert.ok(f.runtime.binaryPath().startsWith(path.join(f.baseDir, 'runtime') + path.sep));
  assert.equal(fs.existsSync(path.join(f.baseDir, 'runtime', selectedAsset.name)), false, 'verified archive is removed after unpacking');
  assert.equal(f.runtime.ready(), true);
});

test('requesting Vulkan does not mistake the bundled default runtime for the requested variant', t => {
  const f = fixture(t);
  f.bundledRuntime();
  assert.ok(f.runtime.binaryPath('auto'));
  assert.equal(f.runtime.binaryPath('vulkan'), null);
  f.write(path.join(f.runtime.runtimeDir('vulkan'), binaryName), 'fixture vulkan runtime');
  assert.ok(f.runtime.binaryPath('vulkan').includes('vulkan'));
});

test('an unknown requested model is rejected without silently downloading the recommendation', async t => {
  const f = fixture(t);
  await assert.rejects(f.runtime.install({ modelId: 'not-a-model' }), /没有找到这个模型/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.runtime.installing, null);
});
