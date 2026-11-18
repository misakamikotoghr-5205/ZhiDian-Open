// Many files into one PDF, in the order given. PDFs contribute their pages as they are, pictures
// become one page each, documents are printed to pages first.
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 28;

/**
 * @param {Array<{path,name,ext,kind}>} files
 * @param {object} tools
 * @param {(file) => Promise<Buffer>} tools.documentPdf  Word / Markdown / text to PDF bytes
 * @param {(file) => Promise<{buffer: Buffer}>} tools.decodeImage  any image to PNG bytes
 * @param {(done: number, total: number, name: string) => void} [onProgress]
 * @returns {Promise<{ buffer: Buffer, pages: number, used: string[], skipped: Array<{name, why}> }>}
 */
export async function filesToPdf(files, tools, onProgress, signal) {
  const out = await PDFDocument.create();
  const used = [];
  const skipped = [];
  let i = 0;
  for (const file of files) {
    if (signal?.aborted) throw new Error('已取消');
    onProgress?.(i++, files.length, file.name);
    try {
      if (file.kind === 'pdf') {
        const src = await PDFDocument.load(fs.readFileSync(file.path), { ignoreEncryption: true });
        if (src.isEncrypted) throw new Error('这个 PDF 加了密');
        if (!src.getPageCount()) throw new Error('这个 PDF 里没有页面');
        for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      } else if (file.kind === 'image') {
        const raw = fs.readFileSync(file.path);
        let image;
        if (file.ext === 'png') image = await out.embedPng(raw).catch(() => null);
        else if (file.ext === 'jpg' || file.ext === 'jpeg') image = await out.embedJpg(raw).catch(() => null);
        if (!image) image = await out.embedPng((await tools.decodeImage(file.path)).buffer);
        // The page takes the orientation of the picture; the picture is never enlarged past
        // its own size at 96 dpi and never cropped.
        const landscape = image.width > image.height;
        const page = out.addPage(landscape ? [A4.h, A4.w] : [A4.w, A4.h]);
        const room = { w: page.getWidth() - MARGIN * 2, h: page.getHeight() - MARGIN * 2 };
        const scale = Math.min(room.w / image.width, room.h / image.height, 0.75 * 2);
        const w = image.width * scale, h = image.height * scale;
        page.drawImage(image, { x: (page.getWidth() - w) / 2, y: (page.getHeight() - h) / 2, width: w, height: h });
      } else if (file.kind === 'word' || file.kind === 'markdown' || file.kind === 'text' || file.kind === 'sheet' || file.kind === 'office') {
        const src = await PDFDocument.load(await tools.documentPdf(file));
        if (!src.getPageCount()) throw new Error('这个文档没有生成任何页面');
        for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      } else {
        throw new Error('不支持这种文件');
      }
      used.push(file.name);
    } catch (err) {
      if (signal?.aborted) throw new Error('已取消');
      skipped.push({ name: file.name, why: [...String(err?.message ?? err)].slice(0, 120).join('') });
    }
  }
  onProgress?.(files.length, files.length, '');
  if (!out.getPageCount()) throw new Error(skipped.length ? `没有一个文件能转成 PDF：${skipped.map((s) => `${s.name}（${s.why}）`).join('；')}` : '没有可以合并的文件');
  out.setCreator('Zhidian');
  out.setProducer('Zhidian');
  return { buffer: Buffer.from(await out.save()), pages: out.getPageCount(), used, skipped };
}
