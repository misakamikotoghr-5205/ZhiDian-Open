import { hardwareProfile } from './hardware.js';
// What the app installs for its built-in local model: one llama.cpp runtime build and one
// vision-language model. Everything here is pinned: exact files, sizes and SHA-256 hashes.
//
// Models are the Qwen3.5 small series (Apache-2.0, native Chinese, trained for GUI grounding),
// in GGUF form from the unsloth conversions. Sizes and hashes were read from the Hugging Face
// API on 2026-11-12. The `ram` figures are estimates of the server's resident memory with a
// 4096-token context, to be replaced by measurements from CI.
export const MODELS = [
  {
    id: 'qwen3.5-0.8b',
    label: 'Qwen3.5-0.8B',
    blurb: '小模型 · 基础办公，自动按内存余量选择',
    // The Zhidian pointer adapter (train/): a LoRA that makes this model answer and point in
    // one pass. Used automatically when the file is present next to the app or the models.
    adapter: 'zhidian-pointer-qwen3.5-0.8b.gguf',
    officeAdapter: 'office-small-lora.gguf',
    ram: '约 1.3 GB',
    groundPixels: 520_000,
    repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    revision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
    files: [
      { role: 'model', name: 'Qwen3.5-0.8B-Q4_K_M.gguf', size: 532517120, sha256: 'bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517' },
      { role: 'mmproj', name: 'mmproj-F16.gguf', saveAs: 'Qwen3.5-0.8B-mmproj-F16.gguf', size: 204987232, sha256: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453' },
    ],
  },
  {
    id: 'qwen3.5-4b',
    label: 'Qwen3.5-4B',
    blurb: '大模型 · 更多办公能力，内存充足时自动启用',
    ram: '约 4.5 GB',
    groundPixels: 1_050_000,
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    revision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
    files: [
      { role: 'model', name: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2740937888, sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4' },
      { role: 'mmproj', name: 'mmproj-F16.gguf', saveAs: 'Qwen3.5-4B-mmproj-F16.gguf', size: 672423616, sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864' },
    ],
  },
];

export const getModel = (id) => MODELS.find((m) => m.id === id) ?? null;
export const modelBytes = (m) => m.files.reduce((n, f) => n + f.size, 0);
export const localName = (f) => f.saveAs ?? f.name;

/** Where model files can come from. All three serve the same bytes; the hash is checked either way. */
export const SOURCES = {
  huggingface: {
    label: 'Hugging Face',
    url: (m, f) => `https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.name}`,
  },
  hfmirror: {
    label: 'hf-mirror（国内镜像）',
    url: (m, f) => `https://hf-mirror.com/${m.repo}/resolve/${m.revision}/${f.name}`,
  },
  modelscope: {
    label: 'ModelScope 魔搭',
    url: (m, f) => `https://modelscope.cn/models/${m.repo}/resolve/master/${f.name}`,
  },
};

// llama.cpp publishes prebuilt llama-server binaries on its GitHub releases. b12110 is the
// nightly behind the v0.9.0 release, and is newer than b10085, the first build with the fix
// for Qwen3-VL/Qwen3.5 grounding coordinates.
//
// The archives contain the program the app then runs, so they are pinned like the models: the
// sizes and SHA-256 hashes below were computed on 2026-11-13 from the files GitHub serves for
// this tag. A download mirror can therefore change where the bytes come from, never the bytes.
export const RUNTIME = {
  tag: 'b12110',
  repo: 'ggml-org/llama.cpp',
  url: (asset) => `https://github.com/ggml-org/llama.cpp/releases/download/b12110/${asset}`,
  assets: {
    'llama-b12110-bin-macos-arm64.tar.gz': { size: 16650691, sha256: '4f5b8de12e0b9516658ca6a5764c6ffb3d7c659c3dd538556b1413c7b4050662' },
    'llama-b12110-bin-macos-x64.tar.gz': { size: 12388601, sha256: 'c8094268b6bf62f4998f0e45656fd9f5e2d4afb6b1cd0044d761db64be1dd47d' },
    'llama-b12110-bin-ubuntu-x64.tar.gz': { size: 23051958, sha256: '368227edcc229be5f9bed16a2223d79b5e41d0ac2e19bcf5825e82291c060e55' },
    'llama-b12110-bin-ubuntu-arm64.tar.gz': { size: 18723578, sha256: '4758b51335e37b4346251f2687d64841ff1c07ecb27fc46323945bb2ec9c44d2' },
    'llama-b12110-bin-ubuntu-vulkan-x64.tar.gz': { size: 35858360, sha256: 'a5d741940956ec62e8783aee7e5a4c7c761af867d6f027c3277a51e1a3ac59b0' },
    'llama-b12110-bin-win-cpu-x64.zip': { size: 24708445, sha256: '98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2' },
    'llama-b12110-bin-win-cpu-arm64.zip': { size: 13197637, sha256: 'f8d20fb07d0b499988ced8963afcd5ded2d2cdd9983b757fbc7e51c4abd722e8' },
    'llama-b12110-bin-win-vulkan-x64.zip': { size: 37661146, sha256: '9732a5e48887ca54d0bfe4af4324dc85fd56cd8cda19b52df3542fa6ebe6874f' },
  },
};

/**
 * Which release archive fits this machine. CPU builds are the default on Windows and Linux:
 * they run everywhere, and the Vulkan builds have open reports of wrong vision output on some
 * GPUs. The macOS arm64 build uses Metal out of the box.
 */
export function runtimeAsset(platform = process.platform, arch = process.arch, variant = 'auto') {
  const tag = RUNTIME.tag;
  const vulkan = variant === 'vulkan';
  const pick = (name, gpu) => ({ name, kind: name.endsWith('.zip') ? 'zip' : 'tar.gz', gpu, ...RUNTIME.assets[name] });
  if (platform === 'darwin') return pick(`llama-${tag}-bin-macos-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`, arch === 'arm64' ? 'Metal' : 'CPU');
  if (platform === 'win32') {
    if (arch === 'arm64') return pick(`llama-${tag}-bin-win-cpu-arm64.zip`, 'CPU');
    return vulkan ? pick(`llama-${tag}-bin-win-vulkan-x64.zip`, 'Vulkan') : pick(`llama-${tag}-bin-win-cpu-x64.zip`, 'CPU');
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return pick(`llama-${tag}-bin-ubuntu-arm64.tar.gz`, 'CPU');
    return vulkan ? pick(`llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`, 'Vulkan') : pick(`llama-${tag}-bin-ubuntu-x64.tar.gz`, 'CPU');
  }
  return null;
}

/**
 * Select the large model only when system memory leaves room for the user’s office applications.
 */
export function recommendModel(resources) {
  return hardwareProfile(resources).recommended;
}
