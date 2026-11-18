#!/usr/bin/env node
// Builds verified ZhiDian v0.5.0 release archives into dist/release-v0.5.0/
// Includes:
//   - Zhidian-v0.5.0-windows-x64.7z.001.. (Full Offline bundle with Qwen3.5 0.8B/4B + LoRAs + runtime)
//   - Zhidian-v0.5.0-windows-x64-lite.zip
//   - Zhidian-v0.5.0-linux-x64-lite.tar.gz
//   - 解压说明.txt & SHA256SUMS.txt
// Optional: pass --upload to upload built assets via `gh release upload v0.5.0`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUNTIME, runtimeAsset } from '../src/main/local/catalog.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = path.join(repo, 'models');
const outDir = path.join(repo, 'dist', 'release-v0.5.0');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-pkg-'));
const ggufCache = path.join(repo, 'dist', '.gguf-cache');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(ggufCache, { recursive: true });

for (const f of fs.readdirSync(modelDir)) {
  if (f.startsWith('Qwen3.5-') && f.endsWith('.gguf')) {
    fs.renameSync(path.join(modelDir, f), path.join(ggufCache, f));
  }
}

function sh(cmd, args, opts = {}) {
  console.log(`\n>>> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed with code ${r.status}`);
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function ensureRuntimeOnly(platform, arch) {
  const asset = runtimeAsset(platform, arch);
  const rtRoot = path.join(modelDir, 'runtime');
  fs.rmSync(rtRoot, { recursive: true, force: true });
  fs.rmSync(path.join(modelDir, 'bundle-manifest.json'), { force: true });
  const archive = path.join(workDir, asset.name);
  if (!fs.existsSync(archive) || fs.statSync(archive).size !== asset.size || await sha256(archive) !== asset.sha256) {
    sh('curl', ['--fail', '--location', '--retry', '4', '--connect-timeout', '30', '--output', archive, RUNTIME.url(asset.name)]);
    if (await sha256(archive) !== asset.sha256) throw new Error(`SHA256 mismatch on ${asset.name}`);
  }
  const unpack = path.join(workDir, `unpack-${platform}-${arch}`);
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  if (archive.endsWith('.zip')) sh('7z', ['x', '-y', `-o${unpack}`, archive]);
  else sh('tar', ['-xf', archive, '-C', unpack]);

  const all = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else all.push(p);
    }
  };
  walk(unpack);
  const serverName = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const server = all.find((p) => path.basename(p) === serverName);
  if (!server) throw new Error(`Missing ${serverName}`);
  const destDir = path.join(rtRoot, `${platform}-${arch}`);
  fs.mkdirSync(destDir, { recursive: true });
  const records = [], symlinks = [];
  const serverDir = path.dirname(server);
  for (const e of fs.readdirSync(serverDir, { withFileTypes: true })) {
    const src = path.join(serverDir, e.name);
    const dst = path.join(destDir, e.name);
    if (e.isSymbolicLink()) {
      const target = fs.readlinkSync(src);
      if (path.isAbsolute(target) || target.includes('..') || path.basename(target) !== target) continue;
      fs.symlinkSync(target, dst);
      symlinks.push({ name: e.name, target });
      continue;
    }
    if (!e.isFile()) continue;
    fs.copyFileSync(src, dst);
    if (platform !== 'win32' && e.name === 'llama-server') fs.chmodSync(dst, 0o755);
    records.push({ name: e.name, size: fs.statSync(src).size, sha256: await sha256(src) });
  }
  fs.writeFileSync(path.join(destDir, 'verified-runtime.json'), JSON.stringify({ archive: asset.name, archiveSha256: asset.sha256, files: records, symlinks }, null, 2) + '\n');
  fs.rmSync(unpack, { recursive: true, force: true });
}

const ignoreLite = '^/(test|docs|dist|train|promo|build|hackathon|\\.github)';
const packager = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-packager.cmd' : 'electron-packager');

console.log('=== [1/3] Building Lite Linux x64 ===');
await ensureRuntimeOnly('linux', 'x64');
const liteLinuxDir = path.join(workDir, 'lite-linux');
sh(packager, ['.', 'Zhidian', '--platform=linux', '--arch=x64', '--out', liteLinuxDir, '--overwrite', '--no-asar', `--ignore=${ignoreLite}`]);
sh('tar', ['-czf', path.join(outDir, 'Zhidian-v0.5.0-linux-x64-lite.tar.gz'), '-C', liteLinuxDir, 'Zhidian-linux-x64']);
fs.rmSync(liteLinuxDir, { recursive: true, force: true });

console.log('=== [2/3] Building Lite Windows x64 ===');
await ensureRuntimeOnly('win32', 'x64');
const liteWinDir = path.join(workDir, 'lite-win');
sh(packager, ['.', 'Zhidian', '--platform=win32', '--arch=x64', '--out', liteWinDir, '--overwrite', '--no-asar', `--ignore=${ignoreLite}`]);
sh('7z', ['a', '-tzip', '-mx=3', '-bso0', path.join(outDir, 'Zhidian-v0.5.0-windows-x64-lite.zip'), 'Zhidian-win32-x64'], { cwd: liteWinDir });
fs.rmSync(liteWinDir, { recursive: true, force: true });

for (const f of fs.readdirSync(ggufCache)) {
  if (f.endsWith('.gguf')) fs.renameSync(path.join(ggufCache, f), path.join(modelDir, f));
}
fs.rmSync(ggufCache, { recursive: true, force: true });

console.log('=== [3/3] Packaging Full Offline Windows x64 Split Release ===');
fs.rmSync(path.join(modelDir, 'runtime'), { recursive: true, force: true });
sh('node', ['build/bundle-local.mjs', '--platform=win32', '--arch=x64']);
sh('node', ['build/bundle-local.mjs', '--platform=win32', '--arch=x64', '--verify-only']);
const fullWinDir = path.join(workDir, 'full-win');
sh(packager, ['.', 'Zhidian', '--platform=win32', '--arch=x64', '--out', fullWinDir, '--overwrite', '--no-asar', `--ignore=${ignoreLite}`]);
sh('7z', ['a', '-t7z', '-v1900m', '-mx=1', '-bso0', path.join(outDir, 'Zhidian-v0.5.0-windows-x64.7z'), 'Zhidian-win32-x64'], { cwd: fullWinDir });
fs.rmSync(fullWinDir, { recursive: true, force: true });
fs.rmSync(workDir, { recursive: true, force: true });

for (const extra of ['promo/zhidian-hackathon-deck.pptx', 'promo/zhidian-hackathon-deck.mp4']) {
  const src = path.join(repo, extra);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, path.basename(src)));
}

fs.writeFileSync(path.join(outDir, '解压说明.txt'), [
  '指点 ZhiDian v0.5.0 发行包说明',
  '================================',
  '',
  '【方案一：完整离线包（推荐，开箱即用，无需联网下载模型）】',
  '1. 请下载本版本全部 Zhidian-v0.5.0-windows-x64.7z.001、.7z.002、.7z.003 分卷，放到同一个文件夹。',
  '2. 使用 7-Zip 打开 .7z.001 并解压到任意目录（不要单独解压后面的分卷）。',
  '3. 解压完成后双击 Zhidian-win32-x64/Zhidian.exe 即可运行（已内置 Qwen3.5 0.8B/4B 模型、Office LoRA 与 llama.cpp 运行时）。',
  '',
  '【方案二：轻量包（体积约 200MB，快速下载）】',
  '- Windows: 下载 Zhidian-v0.5.0-windows-x64-lite.zip 解压后运行 Zhidian.exe。',
  '- Linux (X11): 下载 Zhidian-v0.5.0-linux-x64-lite.tar.gz 解压后运行 Zhidian。',
  '- 确定性办公动作无需模型立即可用；如需本地模型，可在「高级设置 → 本地模型 → 下载模型」中选择魔搭 ModelScope 一键补齐。',
  '',
].join('\n'), 'utf8');

const sums = [];
for (const name of fs.readdirSync(outDir).filter((f) => f !== 'SHA256SUMS.txt').sort()) {
  const digest = await sha256(path.join(outDir, name));
  sums.push(`${digest}  ${name}`);
}
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
console.log(`\nRelease archives ready in: ${outDir}`);

if (process.argv.includes('--upload')) {
  const files = fs.readdirSync(outDir).map((f) => path.join(outDir, f));
  sh('gh', ['release', 'upload', 'v0.5.0', ...files, '--clobber']);
}
