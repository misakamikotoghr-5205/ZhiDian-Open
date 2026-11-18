// The parts of document work that need a browser engine, done in hidden windows:
//   - HTML to PDF (Chromium's own print-to-PDF)
//   - PDF pages to images and text (pdf.js), and decoding image formats
// The hidden worker page is served from the app's own files over a private scheme, so it can
// load pdf.js and its font data without any access to the file system or the network.
import { BrowserWindow, app, net, protocol, session } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { injectBaseHref } from './convert.js';
import { documentTheme } from '../../core/document-themes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = {
  worker: path.resolve(here, '../../renderer/worker'),
  pdfjs: path.resolve(here, '../../../node_modules/pdfjs-dist'),
};
const SCHEME = 'zhidian';
const blobs = new Map(); // one-time tokens for files the worker page may read

function sipsToPng(file) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-heic-'));
    const out = path.join(dir, 'decoded.png');
    execFile('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', out], { timeout: 30_000 }, (err) => {
      if (!err && fs.existsSync(out) && fs.statSync(out).size > 0) {
        resolve({ path: out, done: () => fs.rmSync(dir, { recursive: true, force: true }) });
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
        reject(new Error('HEIC 转换失败'));
      }
    });
  });
}

async function prepareImage(file) {
  if (process.platform === 'darwin' && /\.(heic|heif)$/i.test(file) && fs.existsSync('/usr/bin/sips')) {
    return sipsToPng(file);
  }
  return { path: file, done: () => {} };
}

/** Must run before the app is ready. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}

/** Must run once the app is ready. */
export function installProtocol() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const [, area, ...rest] = decodeURIComponent(url.pathname).split('/');
    let file = null;
    if (area === 'blob') {
      file = blobs.get(rest.join('/')) ?? null;
    } else if (ROOTS[area]) {
      const resolved = path.resolve(ROOTS[area], rest.join('/'));
      if (resolved.startsWith(ROOTS[area] + path.sep)) file = resolved;
    }
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function lend(file) {
  const token = crypto.randomBytes(12).toString('hex') + path.extname(file).toLowerCase();
  blobs.set(token, file);
  return { url: `${SCHEME}://app/blob/${token}`, done: () => blobs.delete(token) };
}

let worker = null;
let workerReady = null;

async function workerPage() {
  if (worker && !worker.isDestroyed()) return workerReady;
  worker = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false } });
  const win = worker;
  workerReady = (async () => {
    await win.loadURL(`${SCHEME}://app/worker/worker.html`);
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('Boolean(window.cw && window.cw.ready)').catch(() => false)) return win;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('内部转换页面没有启动');
  })();
  workerReady.catch(() => {
    if (!win.isDestroyed()) win.destroy();
    if (worker === win) worker = null;
  });
  return workerReady;
}

const call = async (expr) => (await workerPage()).webContents.executeJavaScript(expr, true);

export function closeWorker() {
  if (worker && !worker.isDestroyed()) worker.destroy();
  worker = null;
}

/**
 * Open a PDF for page-by-page work.
 * @returns {Promise<{ pages: number, render(n, maxEdge, quality?): Promise<{dataUrl,w,h,points}>, text(n): Promise<string>, close(): Promise<void> }>}
 */
export async function openPdf(file) {
  const lent = lend(file);
  try {
    const pages = await call(`window.cw.openPdf(${JSON.stringify(lent.url)})`);
    return {
      pages,
      render: (n, maxEdge = 1600, quality = 0.88) => call(`window.cw.renderPage(${Number(n)}, ${Number(maxEdge)}, ${Number(quality)})`),
      text: (n) => call(`window.cw.pageText(${Number(n)})`),
      close: async () => {
        lent.done();
        await call('window.cw.closePdf()').catch(() => {});
      },
    };
  } catch (err) {
    lent.done();
    const raw = String(err?.message ?? err).replace(/^Error invoking remote method.*?: /, '').slice(0, 160);
    if (/password/i.test(raw)) throw new Error('这个 PDF 加了密（设了打开密码或编辑限制），要先解除才能处理');
    if (/empty|zero bytes/i.test(raw)) throw new Error('打不开这个 PDF：文件是空的');
    throw new Error(/[\u4e00-\u9fff]/.test(raw) ? `打不开这个 PDF：${raw}` : '打不开这个 PDF：文件不完整或已损坏');
  }
}

/** An image file of any format Chromium reads (plus HEIC on macOS), as PNG bytes. */
export async function decodeImage(file, maxEdge = 2400) {
  let prep = null;
  let lent = null;
  try {
    prep = await prepareImage(file);
    lent = lend(prep.path);
    const out = await call(`window.cw.decodeImage(${JSON.stringify(lent.url)}, ${Number(maxEdge)})`);
    return { buffer: Buffer.from(out.dataUrl.split(',')[1], 'base64'), w: out.w, h: out.h, dataUrl: out.dataUrl };
  } catch {
    // What the page rejects with is not an Error the caller could show.
    throw new Error('这张图片读不出来：文件是空的、已损坏，或不是图片');
  } finally {
    lent?.done();
    prep?.done();
  }
}

let printSession = null;

/** Documents may reference local pictures, but printing must never contact a server. */
function offlinePrintSession() {
  if (printSession) return printSession;
  printSession = session.fromPartition('zhidian-offline-print', { cache: false });
  printSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, ({ url }, callback) => {
    let local = false;
    try {
      const target = new URL(url);
      // A file URL with a remote hostname can open a network share on Windows.
      local = (target.protocol === 'file:' && (!target.hostname || target.hostname === 'localhost'))
        || target.protocol === 'data:' || target.protocol === 'blob:' || target.protocol === 'about:';
    } catch {}
    callback({ cancel: !local });
  });
  printSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  printSession.setPermissionCheckHandler(() => false);
  return printSession;
}

/**
 * Print an HTML document to PDF. Scripts in it never run.
 * @param {string} html  a complete document
 * @param {{ baseDir?: string, title?: string, template?: string }} [o]  relative images and page furniture
 */
export async function htmlToPdf(html, { baseDir, template, title = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-print-'));
  const file = path.join(dir, 'page.html');
  const withBase = injectBaseHref(html, baseDir);
  fs.writeFileSync(file, withBase, 'utf8');
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { session: offlinePrintSession(), sandbox: true, contextIsolation: true, javascript: false, webSecurity: true } });
  try {
    await win.loadFile(file);
    await new Promise((r) => setTimeout(r, 150)); // let images and fonts settle
    const theme = documentTheme(template);
    const safeTitle = String(title).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const chromeStyle = `width:100%;margin:0 22mm;font-family:Arial,sans-serif;font-size:8px;color:#${theme.muted};`;
    return await win.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: `<div style="${chromeStyle}padding-bottom:7px;border-bottom:1px solid #${theme.line};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeTitle}</div>`,
      footerTemplate: `<div style="${chromeStyle}display:flex;justify-content:space-between;align-items:center;"><span style="display:block;width:22px;height:2px;background:#${theme.accent};"></span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Canvas work in the hidden page, for actions on pictures: measure(file) -> { w, h, alpha },
 * encode(file, opts) and stack(files, opts) -> { buffer, w, h, type, ... } (see the matching
 * window.cw.* functions in renderer/worker/worker.js).
 */
export const canvas = {
  /**
   * The size of a picture in pixels, and whether any pixel of it is transparent.
   * @param {{ opaque?: boolean }} [o]  opaque: known to have no transparency (a JPEG), so it is not looked for
   * @returns {Promise<{ w: number, h: number, alpha: boolean }>}
   */
  async measure(file, { opaque = false } = {}) {
    let prep = null;
    let lent = null;
    try {
      prep = await prepareImage(file).catch(() => ({ path: file, done: () => {} }));
      lent = lend(prep.path);
      return canvas.checked(await call(`window.cw.measureImage(${JSON.stringify(lent.url)}, ${Boolean(opaque)})`));
    } finally {
      lent?.done();
      prep?.done();
    }
  },

  /**
   * A picture encoded again, scaled down first if its longer edge is over `maxEdge` (0: never).
   * @param {{ maxEdge?: number, type?: 'jpeg' | 'png' | 'webp' | 'auto', quality?: number, opaque?: boolean }} [o]
   *   'auto': PNG if any pixel is transparent, otherwise JPEG. In a JPEG, transparent becomes white.
   * @returns {Promise<{ buffer: Buffer, w: number, h: number, type: 'jpeg' | 'png' | 'webp', srcW: number, srcH: number, alpha: boolean }>}
   */
  async encode(file, { maxEdge = 0, type = 'auto', quality = 0.9, opaque = false } = {}) {
    let prep = null;
    let lent = null;
    try {
      prep = await prepareImage(file).catch(() => ({ path: file, done: () => {} }));
      lent = lend(prep.path);
      const o = { maxEdge: Number(maxEdge) || 0, type: String(type), quality: Number(quality), opaque: Boolean(opaque) };
      const made = canvas.checked(await call(`window.cw.encodeImage(${JSON.stringify(lent.url)}, ${JSON.stringify(o)})`));
      return { buffer: await canvas.fetched(made), w: made.w, h: made.h, type: made.type, srcW: made.srcW, srcH: made.srcH, alpha: made.alpha };
    } finally {
      lent?.done();
      prep?.done();
    }
  },

  /**
   * Pictures one under another in one tall picture: each is drawn `width` wide and as tall as
   * its entry in `heights`. A JPEG has white where the pictures are transparent.
   * @param {string[]} files
   * @param {{ width: number, heights: number[], type?: 'jpeg' | 'png' | 'webp', quality?: number }} o
   * @returns {Promise<{ buffer: Buffer, w: number, h: number, type: 'jpeg' | 'png' | 'webp' }>}
   */
  async stack(files, { width, heights, type = 'jpeg', quality = 0.9 }) {
    const preps = [];
    const lent = [];
    try {
      for (const f of files) {
        const p = await prepareImage(f).catch(() => ({ path: f, done: () => {} }));
        preps.push(p);
        lent.push(lend(p.path));
      }
      const o = { width: Number(width), heights: heights.map(Number), type: String(type), quality: Number(quality) };
      const made = canvas.checked(await call(`window.cw.stackImages(${JSON.stringify(lent.map((l) => l.url))}, ${JSON.stringify(o)})`), files);
      return { buffer: await canvas.fetched(made), w: made.w, h: made.h, type: made.type };
    } finally {
      for (const l of lent) l.done();
      for (const p of preps) p.done();
    }
  },

  /**
   * What the hidden page answered; or, if it could not do the work, an error that says why:
   * `message` stands on its own, `why` is the same without naming the picture.
   */
  checked(out, files = []) {
    if (!out?.error) return out;
    const why = out.error === 'large' ? `有 ${out.w}×${out.h} 像素，太大了，处理不了` : '读不出来，可能不是图片或文件已损坏';
    const which = files[out.index] ? `${path.basename(files[out.index])} ` : files.length ? '拼出来的图片' : '这张图片';
    throw Object.assign(new Error(which + why), { why });
  },

  /** The bytes of a picture the hidden page has encoded: fetched in pieces, then let go of there. */
  async fetched(made) {
    const PIECE = 16 * 1024 * 1024;
    try {
      const pieces = [];
      for (let at = 0; at < made.bytes; at += PIECE) pieces.push(await call(`window.cw.resultPiece(${Number(made.id)}, ${at}, ${Math.min(made.bytes, at + PIECE)})`));
      return Buffer.concat(pieces);
    } finally {
      call(`window.cw.dropResult(${Number(made.id)})`).catch(() => {});
    }
  },
};

export const tempDir = () => fs.mkdtempSync(path.join(app.getPath('temp'), 'zhidian-office-'));
