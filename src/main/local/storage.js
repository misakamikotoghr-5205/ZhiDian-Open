import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Accept explicit filesystem locations only; an empty preference restores the default. */
export function normalizeDirectory(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('请输入有效的文件夹路径。');
  const directory = value.trim();
  if (!directory) return '';
  if (!path.isAbsolute(directory) || (process.platform === 'win32' && /^[\\/](?![\\/])/.test(directory))) {
    throw new Error('请填写完整路径，例如 D:\\ZhidianModels，或点击“选择文件夹”。');
  }
  return path.normalize(directory);
}

/** Probe the actual download destinations before persisting a new preference. */
export function prepareDirectory(directory) {
  for (const dir of [directory, path.join(directory, 'models'), path.join(directory, 'runtime')]) {
    let probe;
    let fd;
    try {
      fs.mkdirSync(dir, { recursive: true });
      probe = path.join(dir, `.zhidian-write-${crypto.randomUUID()}`);
      fd = fs.openSync(probe, 'wx');
      fs.writeFileSync(fd, 'ok');
    } catch (err) {
      throw new Error(`无法写入模型目录，请检查磁盘、文件夹路径和写入权限（${err.code || '写入失败'}）。`);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
        fs.unlinkSync(probe);
      }
    }
  }
  return directory;
}
