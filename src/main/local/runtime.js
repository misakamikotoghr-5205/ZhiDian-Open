// Manages the built-in local model: installs the llama.cpp runtime and the model files once,
// then runs llama-server as a child process bound to 127.0.0.1 with a per-launch key.
// After installation nothing here needs the network: the server is started with --offline.
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { MODELS, RUNTIME, SOURCES, getModel, localName, modelBytes, runtimeAsset } from './catalog.js';
import { download, sha256File } from './download.js';
import { hardwareProfile } from './hardware.js';

const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

function findBinary(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 3) return null;
  const direct = path.join(dir, exe);
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findBinary(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败：${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export class LocalRuntime extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.baseDir            app-owned directory for the runtime and the models
   * @param {() => object} o.getConfig    returns settings.local
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor({ baseDir, getConfig, fetchImpl, bundleDir, resources }) {
    super();
    this.baseDir = baseDir;
    this.bundleDir = bundleDir; // read in place; never copy bundled model weights into userData
    this.hardware = hardwareProfile(resources);
    this.getConfig = getConfig;
    this.fetchImpl = fetchImpl;
    this.child = null;
    this.server = { state: 'stopped', port: 0, key: '', error: '', modelId: '', startedMs: 0 };
    this.logTail = [];
    this.installing = null; // { abort, progress }
    this.starting = null; // { epoch, promise }
    this.epoch = 0; // bumped by stop(): a start from an older epoch has been cancelled
  }

  // ------------------------------------------------------------ what is on disk

  /** Change storage without moving or deleting existing files. Downloads must finish first. */
  setBaseDir(directory) {
    if (this.installing) throw new Error('正在下载或安装模型，请完成或取消后再更换目录。');
    if (this.baseDir === directory) return;
    this.stop(); // also invalidates an in-flight start before it can use paths from the new directory
    this.baseDir = directory;
    this.logTail = [];
    this.emit('change');
  }

  runtimeDir(variant = this.getConfig().variant) {
    return path.join(this.baseDir, 'runtime', `${RUNTIME.tag}-${variant === 'vulkan' ? 'vulkan' : 'default'}`);
  }

  binaryPath(variant = this.getConfig().variant) {
    const custom = this.getConfig().binaryPath;
    if (custom && fs.existsSync(custom)) return custom;
    // The packaged runtime is the default build, not the optional Vulkan build.
    return findBinary(this.runtimeDir(variant)) || (variant !== 'vulkan' && this.bundleDir && findBinary(path.join(this.bundleDir, 'runtime', `${process.platform}-${process.arch}`))) || null;
  }

  /** Keep new downloads alongside existing direct weights, including interrupted downloads. */
  modelDir() {
    const direct = path.basename(this.baseDir).toLowerCase() === 'models' || MODELS.some(m => m.files.some(f =>
      ['', '.part'].some(suffix => fs.existsSync(path.join(this.baseDir, localName(f) + suffix)))));
    return direct ? this.baseDir : path.join(this.baseDir, 'models');
  }

  modelPath(model, role) {
    const f = model.files.find((x) => x.role === role);
    if (!f) return null;
    const direct = path.join(this.baseDir, localName(f));
    const user = path.join(this.baseDir, 'models', localName(f));
    const bundled = this.bundleDir && path.join(this.bundleDir, localName(f));
    // Accept both the storage root and an existing directory containing GGUF files.
    if (this.fileMatches(direct, f)) return direct;
    if (this.fileMatches(user, f)) return user;
    return bundled && this.fileMatches(bundled, f) ? bundled : path.join(this.modelDir(), localName(f));
  }

  fileMatches(file, info) {
    try { return fs.statSync(file).isFile() && fs.statSync(file).size === info.size; } catch { return false; }
  }

  modelInstalled(model) {
    return model.files.every((f) => {
      return this.fileMatches(this.modelPath(model, f.role), f);
    });
  }

  installedModels() {
    return MODELS.filter((m) => this.modelInstalled(m)).map((m) => m.id);
  }

  /** Explicit preferences win; only automatic selection uses the session's memory budget. */
  activeModel() {
    const explicit = getModel(this.getConfig().modelId);
    if (explicit) return this.modelInstalled(explicit) ? explicit : null;
    const wanted = getModel(this.hardware.recommended);
    if (wanted && this.modelInstalled(wanted)) return wanted;
    const small = MODELS[0];
    return this.modelInstalled(small) ? small : null;
  }

  tier() {
    return this.activeModel()?.id === 'qwen3.5-4b' ? 'large' : 'small';
  }

  ready() {
    return Boolean(this.binaryPath() && this.activeModel());
  }

  /** Path of the pointer adapter for a model, if one is installed (bundled with the app or downloaded). */
  adapterPath(model = this.activeModel()) {
    if (!model || this.getConfig().adapter === 'off') return null;
    // Office LoRA has a different response contract from the old pointer adapter.
    const names = [model.officeAdapter, model.adapter].filter(Boolean);
    const candidates = names.flatMap(name => [this.bundleDir && path.join(this.bundleDir, name), path.join(this.baseDir, 'models', name)]);
    return candidates.find((p) => p && fs.existsSync(p)) ?? null;
  }

  /** True when the running (or to-be-started) model has the adapter loaded: one-pass answers. */
  pointerMode() {
    return this.server.state === 'ready' ? this.server.pointerAdapter : Boolean(this.activeModel()?.adapter && path.basename(this.adapterPath() || '') === this.activeModel().adapter);
  }

  status() {
    const cfg = this.getConfig();
    const asset = runtimeAsset(process.platform, process.arch, cfg.variant);
    const explicit = getModel(cfg.modelId);
    const active = this.activeModel();
    const modelPath = active ? this.modelPath(active, 'model') : null;
    return {
      mode: cfg.mode,
      runtimeInstalled: Boolean(this.binaryPath()),
      runtimeTag: RUNTIME.tag,
      runtimeAsset: asset?.name ?? null,
      accel: asset?.gpu ?? 'CPU',
      installedModels: this.installedModels(),
      activeModel: active?.id ?? null,
      selectionMode: explicit ? 'manual' : 'auto',
      configuredModel: explicit?.id ?? '',
      selectionReason: explicit ? (active ? `手动指定 ${explicit.label}` : `手动指定的 ${explicit.label} 文件不完整，请检查模型目录；不会自动切换到其他模型。`) : this.hardware.reason,
      modelPath,
      recommended: this.hardware.recommended,
      tier: this.tier(),
      hardware: this.hardware,
      bundled: Boolean(this.bundleDir && MODELS.every(m => m.files.every(f => this.fileMatches(path.join(this.bundleDir, localName(f)), f)))),
      models: MODELS.map((m) => ({ id: m.id, label: m.label, blurb: m.blurb, ram: m.ram, bytes: modelBytes(m), installed: this.modelInstalled(m) })),
      sources: Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label })),
      server: { state: this.server.state, error: this.server.error, modelId: this.server.modelId, startedMs: this.server.startedMs },
      adapter: Boolean(this.adapterPath()),
      installing: this.installing ? this.installing.progress : null,
      dir: this.baseDir,
      modelDir: this.modelDir(),
      log: this.logTail.slice(-12),
    };
  }

  // ------------------------------------------------------------ install

  /**
   * Download the runtime (if missing) and one model. Safe to call again after a failure or a
   * cancel: finished files are kept and partial files resume.
   */
  async install({ modelId, source = 'huggingface', variant } = {}) {
    if (this.installing) throw new Error('已经在安装中');
    const cfg = this.getConfig();
    const model = modelId ? getModel(modelId) : getModel(cfg.modelId) ?? getModel(this.hardware.recommended);
    if (!model) throw new Error('没有找到这个模型，请重新选择要下载的模型。');
    const src = SOURCES[source] ?? SOURCES.huggingface;
    const useVariant = variant ?? cfg.variant;
    const asset = runtimeAsset(process.platform, process.arch, useVariant);
    if (!asset) throw new Error(`暂不支持这个平台：${process.platform} ${process.arch}`);

    const abort = new AbortController();
    const needRuntime = !this.binaryPath(useVariant);
    const modelDir = this.modelDir();
    const steps = [
      ...(needRuntime ? [{ key: 'runtime', label: `llama.cpp 运行时（${asset.gpu}）`, received: 0, total: asset.size ?? 0 }] : []),
      ...model.files.map((f) => ({ key: f.role, label: f.role === 'model' ? `${model.label} 模型` : '视觉投影器', received: 0, total: f.size })),
    ];
    this.installing = { abort, progress: { modelId: model.id, steps, current: steps[0]?.key ?? '', phase: 'download', error: '' } };
    this.emit('progress', this.installing.progress);
    const tick = (key, p) => {
      const step = steps.find((s) => s.key === key);
      if (step) {
        step.received = p.received;
        if (p.total) step.total = p.total;
      }
      this.installing.progress.current = key;
      this.emit('progress', this.installing.progress);
    };

    try {
      if (needRuntime) {
        const dir = this.runtimeDir(useVariant);
        const archive = path.join(this.baseDir, 'runtime', asset.name);
        const base = String(cfg.ghMirror ?? '').trim();
        // The archive is a program this app will run: it is accepted only with the pinned size
        // and hash, whichever mirror it came through.
        await download({
          url: base + RUNTIME.url(asset.name),
          dest: archive,
          size: asset.size,
          sha256: asset.sha256,
          onProgress: (p) => tick('runtime', p),
          signal: abort.signal,
          fetchImpl: this.fetchImpl,
        });
        this.installing.progress.phase = 'unpack';
        this.emit('progress', this.installing.progress);
        // Unpack next to the final place and move it there in one step, so an unpack that was
        // interrupted half way is never taken for an installed runtime.
        const tmp = dir + '.unpacking';
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        try {
          await this.#unpack(archive, tmp);
          if (!findBinary(tmp)) throw new Error('运行时解压后没有找到 llama-server');
          fs.rmSync(dir, { recursive: true, force: true });
          fs.renameSync(tmp, dir);
        } catch (err) {
          fs.rmSync(tmp, { recursive: true, force: true });
          throw err;
        } finally {
          fs.rmSync(archive, { force: true });
        }
        this.installing.progress.phase = 'download';
      }
      for (const f of model.files) {
        const existing = this.modelPath(model, f.role);
        // Verify reused files as well as new downloads. Read bundled weights in place;
        // a damaged bundled file is replaced in the selected writable directory only.
        if (this.fileMatches(existing, f) && (!f.sha256 || await sha256File(existing, { signal: abort.signal }) === f.sha256.toLowerCase())) {
          tick(f.role, { received: f.size, total: f.size });
          continue;
        }
        await download({
          url: src.url(model, f),
          dest: path.join(modelDir, localName(f)),
          size: f.size,
          sha256: f.sha256,
          onProgress: (p) => tick(f.role, p),
          signal: abort.signal,
          fetchImpl: this.fetchImpl,
        });
      }
      return { ok: true, modelId: model.id };
    } finally {
      this.installing = null;
      this.emit('progress', null);
      this.emit('change');
    }
  }

  cancelInstall() {
    this.installing?.abort.abort();
  }

  /**
   * Delete an installed model's files (unless another installed model shares the same file).
   * Stops llama-server first if it is currently serving this model.
   */
  removeModel(modelId) {
    const model = getModel(modelId);
    if (!model) throw new Error('没有找到这个模型');
    if (this.installing && this.installing.progress?.modelId === model.id) {
      throw new Error('这个模型正在下载中，请先取消下载');
    }
    if (this.server.modelId === model.id && this.server.state !== 'stopped') {
      this.stop();
    }
    const others = MODELS.filter((m) => m.id !== model.id && this.modelInstalled(m));
    const sharedNames = new Set(others.flatMap((m) => m.files.map((f) => localName(f))));
    let removedBytes = 0;
    for (const f of model.files) {
      const name = localName(f);
      if (sharedNames.has(name)) continue;
      for (const suffix of ['', '.part']) {
        const p = path.join(this.baseDir, 'models', name + suffix);
        try {
          if (fs.existsSync(p)) {
            removedBytes += fs.statSync(p).size;
            fs.rmSync(p, { force: true });
          }
        } catch {
          // ignore already-removed files
        }
      }
    }
    this.emit('change');
    return { ok: true, modelId: model.id, removedBytes };
  }

  async #unpack(archive, dir) {
    // tar is present on macOS, Linux and Windows 10+ (bsdtar, which also reads .zip).
    try {
      await run('tar', ['-xf', archive, '-C', dir]);
    } catch (err) {
      if (process.platform !== 'win32') throw err;
      await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]);
    }
    if (process.platform === 'darwin') {
      // A browser-downloaded archive would carry the quarantine flag; ours does not, but
      // clearing it is harmless and saves a confusing Gatekeeper refusal.
      await run('xattr', ['-dr', 'com.apple.quarantine', dir]).catch(() => {});
    }
    const bin = findBinary(dir);
    if (bin && process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  }

  // ------------------------------------------------------------ server process

  /**
   * Start llama-server if it is not running with the model that should be running.
   * Resolves to { baseUrl, apiKey, model }.
   */
  async ensureStarted() {
    const want = this.activeModel();
    if (this.server.state === 'ready' && this.child && this.server.modelId === want?.id) return this.endpoint();
    if (this.starting) {
      if (this.starting.epoch === this.epoch) return this.starting.promise;
      // stop() cancelled that start and it is still winding down: wait, then start afresh.
      await this.starting.promise.catch(() => {});
      return this.ensureStarted();
    }
    this.stop(); // a server for another model, or one that died
    const epoch = this.epoch;
    // If the first start fails (most often a GPU backend that does not initialise on this
    // machine), try once more on the CPU alone before giving up. Being stopped on purpose is
    // not a failure and is not retried.
    const promise = this.#start(false, epoch)
      .catch((err) => {
        if (err.cancelled || this.installing) throw err;
        this.logTail.push(`first start failed: ${err.message}; retrying on CPU only`);
        return this.#start(true, epoch);
      })
      .finally(() => {
        if (this.starting?.promise === promise) this.starting = null;
      });
    this.starting = { epoch, promise };
    return promise;
  }

  endpoint() {
    return { baseUrl: `http://127.0.0.1:${this.server.port}/v1`, apiKey: this.server.key, model: this.server.modelId };
  }

  async #start(cpuOnly, epoch) {
    const cancelled = () => Object.assign(new Error('本地模型的启动被取消了'), { cancelled: true });
    const bin = this.binaryPath();
    const model = this.activeModel();
    if (!bin || !model) throw new Error('本地模型还没有安装');
    this.#kill();
    const port = await freePort();
    if (epoch !== this.epoch) throw cancelled();
    const key = crypto.randomBytes(18).toString('hex');
    const adapter = this.adapterPath(model);
    const args = [
      '--host', '127.0.0.1',
      '--port', String(port),
      '-m', this.modelPath(model, 'model'),
      '--mmproj', this.modelPath(model, 'mmproj'),
      '-c', '4096', // plenty for a few crops and a short answer, and it keeps memory low
      '-np', '1',
      '--api-key', key,
      '--no-webui',
      '--offline',
      '--reasoning', 'off',
      // The model's own preprocessor never shows it an image smaller than 64 tokens (65,536
      // pixels); this vision file does not carry that limit, so llama.cpp would feed tiny
      // crops as they are. Say it explicitly: same picture as in training, for the adapter too.
      '--image-min-tokens', '64',
      ...(adapter ? ['--lora', adapter] : []),
      ...(cpuOnly ? ['-ngl', '0'] : []),
      ...(this.getConfig().extraArgs ?? []),
    ];
    const t0 = Date.now();
    if (!cpuOnly) this.logTail = [];
    this.server = { state: 'starting', port, key, error: '', modelId: model.id, startedMs: 0, adapter: Boolean(adapter), pointerAdapter: Boolean(adapter && path.basename(adapter) === model.adapter) };
    this.emit('change');

    const binDir = path.dirname(bin);
    const childEnv = { ...process.env };
    if (process.platform === 'linux') childEnv.LD_LIBRARY_PATH = [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    else if (process.platform === 'darwin') childEnv.DYLD_LIBRARY_PATH = [binDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
    const child = spawn(bin, args, { cwd: binDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const keep = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logTail.push(line.slice(0, 300));
        if (this.logTail.length > 80) this.logTail.shift();
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let exited = null;
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      if (this.child === child) {
        this.child = null;
        if (this.server.state !== 'stopped') {
          this.server = { ...this.server, state: 'error', error: `llama-server 已退出（${signal ?? code}）` };
          this.emit('change');
        }
      }
    });
    child.once('error', (err) => {
      exited = { code: -1, signal: null, err };
    });

    // The model can take a while to load from a cold disk; /health answers 503 until it has.
    const deadline = Date.now() + 180_000;
    for (;;) {
      // stop() was called while this model was loading (the settings changed, the app is
      // quitting): whatever state there is now belongs to someone else.
      if (epoch !== this.epoch) throw cancelled();
      if (exited) {
        const why = exited.err?.message ?? this.logTail.slice(-4).join(' | ');
        this.server = { ...this.server, state: 'error', error: `本地模型启动失败：${why}` };
        this.emit('change');
        throw new Error(this.server.error);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        if (res.status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        this.#kill();
        this.server = { ...this.server, state: 'error', error: '本地模型加载超时（3 分钟）' };
        this.emit('change');
        throw new Error(this.server.error);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (epoch !== this.epoch) throw cancelled();
    this.server = { ...this.server, state: 'ready', startedMs: Date.now() - t0 };
    this.emit('change');
    return this.endpoint();
  }

  /** Stop the server, and cancel a start that is in progress. */
  stop() {
    this.epoch++;
    this.#kill();
    if (this.server.state !== 'stopped') {
      this.server = { state: 'stopped', port: 0, key: '', error: '', modelId: '', startedMs: 0 };
      this.emit('change');
    }
  }

  #kill() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
      // Some builds ignore SIGTERM while loading: make sure nothing is left holding the model.
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2000).unref();
    }
  }
}
