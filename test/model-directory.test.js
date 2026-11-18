import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeDirectory, prepareDirectory } from '../src/main/local/storage.js';
import { LocalRuntime } from '../src/main/local/runtime.js';

function workspace(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'zhidian-model-directory-test-'));
  t.after(() => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent, 'cleanup stays in the temporary directory');
    assert.match(path.basename(target), /^zhidian-model-directory-test-[\w-]+$/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  return root;
}

const config = { mode: 'managed', variant: 'auto', adapter: 'off' };
const binaryName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const smallModel = { id: 'test-model', files: [{ role: 'model', name: 'model.gguf', size: 3 }] };

test('only explicit absolute paths or the default preference are accepted', () => {
  assert.equal(normalizeDirectory('   '), '');
  for (const invalid of [null, {}, 42, '../models', 'models', 'C:models', '\0']) {
    assert.throws(() => normalizeDirectory(invalid));
  }
  if (process.platform === 'win32') {
    assert.throws(() => normalizeDirectory('\\models'));
    assert.throws(() => normalizeDirectory('/models'));
  }
  const location = path.join(os.tmpdir(), "模型 O'Brien", 'nested', '..', 'models');
  assert.equal(normalizeDirectory(` ${location} `), path.normalize(location));
});

test('preparing a directory creates writable destinations without changing existing files', (t) => {
  const root = workspace(t);
  const destination = path.join(root, "模型 O'Brien");
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'existing user data');
  assert.equal(prepareDirectory(destination), destination);
  assert.deepEqual(fs.readdirSync(destination).sort(), ['keep.txt', 'models', 'runtime']);
  assert.deepEqual(fs.readdirSync(path.join(destination, 'models')), []);
  assert.deepEqual(fs.readdirSync(path.join(destination, 'runtime')), []);
  assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'existing user data');
});

test('a regular file cannot be selected as the storage directory', (t) => {
  const root = workspace(t);
  const destination = path.join(root, 'existing-file');
  fs.writeFileSync(destination, 'do not overwrite');
  assert.throws(() => prepareDirectory(destination), /无法写入模型目录/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'do not overwrite');
});

test('blocked models or runtime subdirectories are rejected before use', (t) => {
  const root = workspace(t);
  for (const child of ['models', 'runtime']) {
    const destination = path.join(root, child);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, child), 'keep');
    assert.throws(() => prepareDirectory(destination), /无法写入模型目录/);
    assert.equal(fs.readFileSync(path.join(destination, child), 'utf8'), 'keep');
    assert.equal(fs.readdirSync(destination).some((name) => name.startsWith('.zhidian-write-')), false);
  }
});

test('changing storage stops the old server and reads files from the new directory', (t) => {
  const root = workspace(t);
  const oldDir = prepareDirectory(path.join(root, 'old'));
  const newDir = prepareDirectory(path.join(root, 'new'));
  const runtime = new LocalRuntime({ baseDir: oldDir, getConfig: () => config });
  const oldModel = runtime.modelPath(smallModel, 'model');
  fs.writeFileSync(oldModel, 'old');
  fs.mkdirSync(runtime.runtimeDir(), { recursive: true });
  fs.writeFileSync(path.join(runtime.runtimeDir(), binaryName), 'old-binary');
  let killed = 0;
  runtime.child = { exitCode: null, kill() { killed++; this.exitCode = 0; } };
  runtime.server.state = 'ready';
  const oldEpoch = runtime.epoch;
  runtime.setBaseDir(newDir);
  assert.equal(killed, 1);
  assert.equal(runtime.server.state, 'stopped');
  assert.equal(runtime.child, null);
  assert.ok(runtime.epoch > oldEpoch);
  assert.equal(runtime.status().dir, newDir);
  assert.equal(runtime.binaryPath(), null);
  assert.equal(runtime.modelInstalled(smallModel), false);
  fs.writeFileSync(runtime.modelPath(smallModel, 'model'), 'new');
  assert.equal(runtime.modelInstalled(smallModel), true);
  assert.equal(fs.readFileSync(oldModel, 'utf8'), 'old');
  assert.equal(fs.readFileSync(runtime.modelPath(smallModel, 'model'), 'utf8'), 'new');
});

test('existing weights are found both in the selected folder and under its models subfolder', (t) => {
  const root = workspace(t);
  const model = { id: 'fixture-model', files: [
    { role: 'model', name: 'fixture-Q4.gguf', size: 4 },
    { role: 'mmproj', name: 'mmproj-F16.gguf', saveAs: 'fixture-mmproj-F16.gguf', size: 3 },
  ] };
  for (const layout of ['direct', 'nested']) {
    const base = path.join(root, layout === 'direct' ? "已有权重 O'Brien" : 'base-directory');
    fs.mkdirSync(base);
    const weights = layout === 'direct' ? base : path.join(base, 'models');
    fs.mkdirSync(weights, { recursive: true });
    fs.writeFileSync(path.join(weights, 'fixture-Q4.gguf'), 'GGUF');
    fs.writeFileSync(path.join(weights, 'fixture-mmproj-F16.gguf'), 'vis');
    // Saving an explicit directory creates its managed subdirectories. An empty nested
    // models/ must not hide valid weights already sitting directly in that directory.
    prepareDirectory(base);
    const runtime = new LocalRuntime({baseDir: base, getConfig:()=>config});
    assert.equal(runtime.modelInstalled(model), true, layout);
    assert.equal(runtime.modelPath(model, 'model'), path.join(weights, 'fixture-Q4.gguf'), layout);
    assert.equal(runtime.modelPath(model, 'mmproj'), path.join(weights, 'fixture-mmproj-F16.gguf'), layout);
    assert.equal(fs.readFileSync(path.join(weights, 'fixture-Q4.gguf'), 'utf8'), 'GGUF');
  }
});

test('selecting the existing models directory does not require another models directory containing the weights', (t) => {
  const root = workspace(t);
  const direct = path.join(root, 'models');
  fs.mkdirSync(direct);
  fs.writeFileSync(path.join(direct, 'model.gguf'), 'old');
  prepareDirectory(direct);
  const runtime = new LocalRuntime({baseDir: direct, getConfig:()=>config});
  assert.equal(runtime.modelInstalled(smallModel), true);
  assert.equal(runtime.modelPath(smallModel, 'model'), path.join(direct, 'model.gguf'));
  assert.deepEqual(fs.readdirSync(path.join(direct, 'models')), [], 'discovery must not move or copy weights');
});

test('an incomplete direct model is not installed until every required weight has its expected size', (t) => {
  const root = workspace(t);
  const model = { id: 'fixture-model', files: [
    { role: 'model', name: 'fixture-Q4.gguf', size: 4 },
    { role: 'mmproj', name: 'fixture-vision.gguf', size: 3 },
  ] };
  const runtime = new LocalRuntime({baseDir: root, getConfig:()=>config});
  fs.writeFileSync(path.join(root, 'fixture-Q4.gguf'), 'GGUF');
  assert.equal(runtime.modelInstalled(model), false, 'missing projector');
  fs.writeFileSync(path.join(root, 'fixture-vision.gguf'), 'x');
  assert.equal(runtime.modelInstalled(model), false, 'truncated projector');
  fs.writeFileSync(path.join(root, 'fixture-vision.gguf'), 'vis');
  assert.equal(runtime.modelInstalled(model), true);
});

test('a download in progress keeps its original directory and server', (t) => {
  const root = workspace(t);
  const runtime = new LocalRuntime({ baseDir: path.join(root, 'old'), getConfig: () => config });
  const originalEpoch = runtime.epoch;
  runtime.installing = { progress: { phase: 'download' } };
  assert.throws(() => runtime.setBaseDir(path.join(root, 'new')), /正在下载或安装模型/);
  assert.equal(runtime.baseDir, path.join(root, 'old'));
  assert.equal(runtime.epoch, originalEpoch);
});

test('switching while a server start is pending cancels the old start before spawning', async (t) => {
  const root = workspace(t);
  const runtime = new LocalRuntime({ baseDir: path.join(root, 'old'), getConfig: () => config });
  fs.mkdirSync(runtime.runtimeDir(), { recursive: true });
  fs.writeFileSync(path.join(runtime.runtimeDir(), binaryName), 'not an executable');
  // Exercise the port-allocation boundary without allocating a real multi-GB model.
  runtime.activeModel = () => smallModel;
  const pending = runtime.ensureStarted();
  runtime.setBaseDir(path.join(root, 'new'));
  await assert.rejects(pending, (error) => error.cancelled === true);
  assert.equal(runtime.child, null);
  assert.equal(runtime.starting, null);
  assert.equal(runtime.server.state, 'stopped');
  assert.deepEqual(runtime.logTail, []);
});

test('reselecting the current directory does not restart the server', (t) => {
  const root = workspace(t);
  const runtime = new LocalRuntime({ baseDir: root, getConfig: () => config });
  runtime.server.state = 'ready';
  const originalEpoch = runtime.epoch;
  runtime.setBaseDir(root);
  assert.equal(runtime.epoch, originalEpoch);
  assert.equal(runtime.server.state, 'ready');
});
