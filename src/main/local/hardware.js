import os from 'node:os';

const GiB = 1024 ** 3;
/** Conservative CPU-compatible memory budget; the shipped runtime does not require a GPU. */
export function hardwareProfile({ totalMemory = os.totalmem(), freeMemory = os.freemem() } = {}) {
  const large = totalMemory >= 15 * GiB && freeMemory >= 7 * GiB;
  return {
    totalMemory, freeMemory, tier: large ? 'large' : 'small',
    recommended: large ? 'qwen3.5-4b' : 'qwen3.5-0.8b',
    reason: large ? '内存余量足够，使用大模型' : '优先保持电脑流畅，使用小模型',
  };
}
