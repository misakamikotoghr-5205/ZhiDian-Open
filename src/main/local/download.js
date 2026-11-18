// Resumable file download with size and SHA-256 verification. Used for the llama.cpp runtime
// archive and the model files. A download writes to "<dest>.part" and is renamed only after it
// has been verified, so a half-finished file is never mistaken for a good one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class DownloadError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'network' | 'http' | 'size' | 'hash' | 'disk' | 'aborted'
  }
}

export async function sha256File(file, { signal } = {}) {
  try {
    const h = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { signal })) h.update(chunk);
    return h.digest('hex');
  } catch (err) {
    if (signal?.aborted) throw new DownloadError('下载已取消', 'aborted');
    throw err;
  }
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.dest            final path
 * @param {number} [o.size]          expected size in bytes
 * @param {string} [o.sha256]        expected hash (hex)
 * @param {(p:{received:number,total:number})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {typeof fetch} [o.fetchImpl]  Electron's net.fetch when running in the app
 */
export async function download({ url, dest, size, sha256, onProgress, signal, fetchImpl = fetch }) {
  if (signal?.aborted) throw new DownloadError('下载已取消', 'aborted');
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    // A complete file may have been corrupted since its first download. Size alone does
    // not establish that a cached model or executable archive still matches the catalog.
    if ((!size || st.size === size) && (!sha256 || await sha256File(dest, { signal }) === sha256.toLowerCase())) {
      onProgress?.({ received: st.size, total: size ?? st.size });
      return { path: dest, bytes: st.size, skipped: true };
    }
    fs.rmSync(dest); // wrong size or hash: download a verified replacement
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (size && have > size) {
    fs.rmSync(part);
    have = 0;
  }

  if (!size || have < size) {
    let res;
    try {
      res = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow', signal });
    } catch (err) {
      if (signal?.aborted) throw new DownloadError('下载已取消', 'aborted');
      throw new DownloadError(`连接失败：${err?.message ?? err}`, 'network');
    }
    if (res.status === 200 && have) {
      have = 0; // the server ignored the Range header: restart from the beginning
    } else if (res.status === 416) {
      fs.rmSync(part, { force: true });
      throw new DownloadError('服务器拒绝了续传请求，请重试', 'http');
    } else if (res.status !== 200 && res.status !== 206) {
      throw new DownloadError(`下载失败：HTTP ${res.status}`, 'http');
    }
    // A mirror or a proxy can answer 200 with something that is not the file (an error or
    // sign-in page). Appending the real remainder to that later would waste a whole download,
    // so anything whose announced length or range does not fit is refused before a byte is kept.
    const length = Number(res.headers.get('content-length')) || 0;
    const plain = !/gzip|br|deflate|zstd/i.test(res.headers.get('content-encoding') ?? '');
    const range = /bytes\s+(\d+)-/i.exec(res.headers.get('content-range') ?? '');
    const wrongLength = size && length && plain && length !== size - have;
    const wrongRange = res.status === 206 && range && Number(range[1]) !== have;
    if (wrongLength || wrongRange) {
      await res.body?.cancel().catch(() => {});
      fs.rmSync(part, { force: true });
      throw new DownloadError(`下载源返回的不是这个文件（长度 ${length}，应为 ${size - have} 字节），请换一个下载源或稍后重试`, 'http');
    }
    const total = size ?? length + have;
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    // A failed write (disk full, file not writable) must end the download, not hang it: without
    // a listener the stream's 'error' would be an uncaught exception and 'drain' would never come.
    let writeError = null;
    const writeFailed = new Promise((_, reject) => {
      out.once('error', (err) => {
        writeError = err;
        reject(err);
      });
    });
    writeFailed.catch(() => {});
    const closeOut = () => new Promise((resolve) => (out.destroyed ? resolve() : out.end(() => resolve())));
    let received = have;
    let last = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), writeFailed]);
        if (done) break;
        received += value.length;
        if (size && received > size) throw new Error('收到的数据比文件本身还长');
        if (!out.write(value)) await Promise.race([new Promise((r) => out.once('drain', r)), writeFailed]);
        const now = Date.now();
        if (now - last > 200) {
          last = now;
          onProgress?.({ received, total });
        }
      }
      await Promise.race([new Promise((resolve) => out.end(resolve)), writeFailed]);
    } catch (err) {
      reader.cancel().catch(() => {});
      await closeOut();
      if (writeError) throw new DownloadError(`写入磁盘失败：${writeError.message}（检查磁盘空间后重试，已下载的部分会保留）`, 'disk');
      if (signal?.aborted) throw new DownloadError('下载已取消', 'aborted');
      if (size && received > size) fs.rmSync(part, { force: true });
      throw new DownloadError(`下载中断：${err?.message ?? err}（已下载的部分会保留，重试即可续传）`, 'network');
    }
    onProgress?.({ received, total });
  }

  const got = fs.statSync(part).size;
  if (size && got !== size) {
    // Keep a short file for resuming; a long one cannot be right.
    if (got > size) fs.rmSync(part);
    throw new DownloadError(`文件大小不对（${got} / ${size} 字节），请重试`, 'size');
  }
  if (sha256) {
    const actual = await sha256File(part, { signal });
    if (actual !== sha256.toLowerCase()) {
      fs.rmSync(part);
      throw new DownloadError('文件校验失败（SHA-256 不匹配），已删除，请换一个下载源重试', 'hash');
    }
  }
  fs.renameSync(part, dest);
  return { path: dest, bytes: got, skipped: false };
}
