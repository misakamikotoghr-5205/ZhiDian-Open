// Office actions, set "pdf": what can be done with one PDF. Split it into pages, save the pages
// as pictures, number the pages, turn it into a Word document. The shape of an action is
// described at the top of tools-basic.js.
//
// Pages are copied and written with pdf-lib here in the main process; drawing a page needs a
// browser engine (env.tools.openPdf) and rebuilding a document needs LibreOffice
// (env.tools.officeConvert). The helpers that only compute are exported for the unit tests.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts, degrees, rgb } from 'pdf-lib';
import { resultName } from '../../core/office-kinds.js';
import { parsePageSpec } from '../../core/page-range.js';

const IMAGE_EDGE = 2000; // pixels along the longer edge of a page saved as a picture
const COMPRESS_EDGE = 1500; // pixels along the longer edge when compacting a scan/image PDF
const COMPRESS_QUALITY = 0.76;
const NUMBER_SIZE = 10; // points, on pages up to A3
const NUMBER_LIFT = 24; // points from the bottom edge to the baseline of the number
const NUMBER_GREY = rgb(0.4, 0.4, 0.4);
const A3_SHORT = 842; // pages larger than this get a proportionally larger number
const ENCRYPTED = '这个 PDF 加了密（设了打开密码或编辑限制），要先解除才能处理';

const onePdf = (ctx) => ctx.kind === 'files' && ctx.files.length === 1 && ctx.files[0].kind === 'pdf';
const stemOf = (file) => file.name.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || 'PDF';

function checkStop(env) {
  if (env.signal?.aborted) throw new Error('已取消');
}

/** 812 字节, 3.4 KB, 120 KB, 2.5 MB */
export function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "报告 第 03 页.pdf": the number is padded so the files sort in page order. */
export function pageFileName(stem, number, total, ext) {
  const width = Math.max(2, String(total).length);
  // A long name is cut so that the name with its page number still fits in a file name.
  const short = [...stem].slice(0, 60).join('').trim() || 'PDF';
  return `${short} 第 ${String(number).padStart(width, '0')} 页.${ext}`;
}

/** "3、7、12", or the first ten and how many there are. */
function pageList(numbers) {
  return numbers.length > 10 ? `${numbers.slice(0, 10).join('、')} 等 ${numbers.length}` : numbers.join('、');
}

/** The PDF as pdf-lib reads it. What cannot be worked on is refused in plain words. */
async function loadPdf(file, options = {}) {
  let bytes;
  try {
    bytes = fs.readFileSync(file.path);
  } catch {
    throw new Error(`读不了这个文件：${file.name}`);
  }
  let doc;
  try {
    // Encrypted files are let in so that they can be told apart from damaged ones.
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, ...options });
  } catch {
    throw new Error('打不开这个 PDF：文件不完整或已损坏');
  }
  if (doc.isEncrypted) throw new Error(ENCRYPTED);
  try {
    doc.getPages();
  } catch {
    throw new Error('打不开这个 PDF：文件不完整或已损坏');
  }
  if (!doc.getPageCount()) throw new Error('这个 PDF 里没有页面');
  return doc;
}

/**
 * Many results into a new folder next to the original. If the work fails part-way, what it
 * wrote is taken away again, so no half-finished folder is left behind.
 * @param {(write: (name: string, data: Uint8Array) => string, dir: string) => Promise<object>} work
 */
async function intoFolder(env, name, work) {
  const dir = env.folder(name);
  const written = [];
  const write = (fileName, data) => {
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, data, { flag: 'wx' }); // never over a file
    written.push(file);
    return file;
  };
  try {
    return await work(write, dir);
  } catch (err) {
    for (const file of written) fs.rmSync(file, { force: true });
    try {
      fs.rmdirSync(dir); // only if nothing else is in it
    } catch {}
    throw err;
  }
}

/**
 * The part of a page that a viewer shows: its crop box as far as that lies on the page (the
 * media box), with a positive width and height whichever way round the corners were written.
 * @param {{x: number, y: number, width: number, height: number}} media
 * @param {{x: number, y: number, width: number, height: number}} [crop]
 */
export function visibleBox(media, crop = media) {
  const corners = (b) => ({ x0: Math.min(b.x, b.x + b.width), y0: Math.min(b.y, b.y + b.height), x1: Math.max(b.x, b.x + b.width), y1: Math.max(b.y, b.y + b.height) });
  const m = corners(media), c = corners(crop);
  const x0 = Math.max(m.x0, c.x0), y0 = Math.max(m.y0, c.y0), x1 = Math.min(m.x1, c.x1), y1 = Math.min(m.y1, c.y1);
  // A crop box that misses the page altogether counts for nothing, as in viewers.
  if (x1 > x0 && y1 > y0) return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  return { x: m.x0, y: m.y0, width: m.x1 - m.x0, height: m.y1 - m.y0 };
}

/** A page's rotation as one of 0, 90, 180, 270 (degrees clockwise), however it was written. */
export const quarterTurn = (angle) => (((Math.round((Number(angle) || 0) / 90) * 90) % 360) + 360) % 360;

/**
 * Where a line of text goes to sit centred at the bottom of a page as it is displayed. A page
 * can be shown turned by 90, 180 or 270 degrees (clockwise), and the part of it that is shown
 * need not start at 0,0.
 * @param {{x: number, y: number, width: number, height: number}} box  the visible part of the page
 * @param {number} angle       the page's own rotation, degrees clockwise
 * @param {number} textWidth
 * @param {number} lift        from the displayed bottom edge up to the baseline
 * @returns {{ x: number, y: number, rotate: 0 | 90 | 180 | 270 }}  start of the baseline in the
 *   page's own coordinates, and how far the text is turned (counter-clockwise) to read upright
 */
export function bottomCentre(box, angle, textWidth, lift) {
  const turn = quarterTurn(angle);
  const across = (turn === 90 || turn === 270 ? box.height : box.width) / 2 - textWidth / 2; // from the displayed left edge
  if (turn === 90) return { x: box.x + box.width - lift, y: box.y + across, rotate: 90 };
  if (turn === 180) return { x: box.x + box.width - across, y: box.y + box.height - lift, rotate: 180 };
  if (turn === 270) return { x: box.x + lift, y: box.y + box.height - across, rotate: 270 };
  return { x: box.x + across, y: box.y + lift, rotate: 0 };
}

/** The size of the page number and its distance from the bottom, for a page of this displayed size. */
export function numberStyle(width, height) {
  const scale = Math.max(1, Math.min(width, height) / A3_SHORT);
  return { size: NUMBER_SIZE * scale, lift: Math.min(NUMBER_LIFT * scale, height * 0.05) };
}

/**
 * Text and its character count, spaces aside. LibreOffice writes every text box twice
 * (once for old versions of Word): the second copy is not counted.
 * @returns {Promise<{ chars: number, text: string } | null>}  null if it cannot be read
 */
async function docxContent(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml').async('string');
    let count = 0;
    let text = '';
    for (const m of xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
      count += [...m[1].replace(/&#?\w+;/g, 'x').replace(/\s+/g, '')].length;
      text += m[1];
    }
    return { chars: count, text };
  } catch {
    return null;
  }
}

/** The Word document's character count, or null when it cannot be read. */
export async function docxChars(buffer) {
  return (await docxContent(buffer))?.chars ?? null;
}

export const PDF_IMPORT_UNAVAILABLE = '这个 LibreOffice 缺少 PDF 导入支持，不能转成 Word。请安装完整版 LibreOffice 后重试。';

const name = (text) => PDFName.of(text);

/**
 * After a page has been copied on its own: the links on it that jump to a place in the
 * document lead nowhere now and are taken off; the other annotations (web links, notes, form
 * fields) are told which page they are on. Returns how many links were taken off.
 */
function settleAnnotations(page, context) {
  const annots = page.node.Annots();
  let dropped = 0;
  for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) {
    const annot = annots.lookup(i);
    if (!(annot instanceof PDFDict)) continue;
    const action = annot.lookup(name('A'));
    const jumps = annot.has(name('Dest')) || (action instanceof PDFDict && action.lookup(name('S')) === name('GoTo'));
    if (annot.lookup(name('Subtype')) === name('Link') && jumps) {
      const item = annots.get(i);
      annots.remove(i);
      if (item instanceof PDFRef) context.delete(item);
      dropped++;
    } else if (annot.has(name('P'))) {
      annot.set(name('P'), page.ref);
    }
  }
  return dropped;
}

/** One page drawn by the hidden page, as JPEG bytes. */
async function pageJpeg(pdf, number) {
  const drawn = await pdf.render(number, IMAGE_EDGE);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(drawn?.dataUrl ?? '');
  if (!m) throw new Error('没有画出来');
  return { data: Buffer.from(m[1], 'base64'), w: drawn.w, h: drawn.h };
}

export const actions = [
  {
    id: 'pdf.word',
    label: '转成 Word',
    hint: '用 LibreOffice 重建成可以编辑的 docx，版式可能和原件不同',
    rank: 12,
    applies: (ctx) => onePdf(ctx) && Boolean(ctx.has?.office),
    async run(ctx, env) {
      const file = ctx.files[0];
      // Some stripped-down LibreOffice builds silently import a PDF as plain text, even with
      // an explicit PDF filter. Reject locked/broken inputs before that fallback can hide it.
      await loadPdf(file);
      let made;
      try {
        made = await env.tools.officeConvert(file.path, 'docx:MS Word 2007 XML', { inFilter: 'writer_pdf_import' });
      } catch (err) {
        // The usual reason LibreOffice gives up on a PDF is a password: say so if that is it.
        const encrypted = await loadPdf(file).then(() => false, (why) => why.message === ENCRYPTED);
        throw encrypted ? new Error('这个 PDF 加了密，LibreOffice 转不了，要先解除密码') : err;
      }
      try {
        const data = fs.readFileSync(made.path);
        const content = await docxContent(data);
        if (!content) throw new Error('LibreOffice 没能生成有效的 Word 文档，请更新或重新安装 LibreOffice 后重试');
        const flat = content.text.replace(/\s+/g, '');
        // A successful conversion must contain page content, not the PDF container itself.
        // Check both ends to avoid mistaking a document that merely mentions "%PDF" for this.
        if (/^%PDF-\d\.\d/.test(flat) && /startxref\d+%%EOF$/.test(flat)) {
          const err = new Error(PDF_IMPORT_UNAVAILABLE);
          err.code = 'LO_PDF_IMPORT_UNAVAILABLE';
          throw err;
        }
        const { chars } = content;
        const out = env.save(resultName(ctx.files, '', 'docx'), data);
        const rebuilt = '版式是 LibreOffice 照着 PDF 重建的，文字大多落在一个个文本框里，可能和原件不同。';
        if (chars === 0) return { kind: 'file', path: out, message: `已转成 Word（${sizeText(data.length)}），但里面没有可以编辑的文字：这个 PDF 可能是扫描件。${rebuilt}` };
        return { kind: 'file', path: out, message: `已转成 Word（${sizeText(data.length)}${chars ? `，${chars} 字` : ''}）。${rebuilt}` };
      } finally {
        made.cleanup();
      }
    },
  },
  {
    id: 'pdf.split',
    label: '拆成单页',
    hint: '每一页存成一个单独的 PDF，放进一个新文件夹',
    rank: 15,
    applies: onePdf,
    async run(ctx, env) {
      const file = ctx.files[0];
      const src = await loadPdf(file);
      const total = src.getPageCount();
      if (total < 2) throw new Error('这个 PDF 只有 1 页，不用拆');
      const srcBytes = fs.statSync(file.path).size;
      // Pages point at each other (links, article threads, form fields), and copying a page
      // follows every pointer: each single page would carry the pages it links to, and theirs.
      // So while pages are copied one by one, no page can be reached through a pointer (this
      // changes only what is in memory); a pointer to a page then simply ends at nothing.
      for (const page of src.getPages()) {
        page.node.delete(name('B'));
        src.context.delete(page.ref);
      }
      const stem = stemOf(file);
      return intoFolder(env, `${stem} 单页`, async (write, dir) => {
        let bytes = 0;
        let links = 0;
        for (let i = 0; i < total; i++) {
          checkStop(env);
          env.step(i, total, `第 ${i + 1} 页`);
          const one = await PDFDocument.create();
          const [page] = await one.copyPages(src, [i]);
          one.addPage(page);
          links += settleAnnotations(page, one.context);
          one.setCreator('Zhidian');
          one.setProducer('Zhidian');
          const data = await one.save();
          write(pageFileName(stem, i + 1, total, 'pdf'), data);
          bytes += data.length;
        }
        env.step(total, total, '');
        const notes = [
          links ? `有 ${links} 个跳到文档内其他位置的链接，在单页里无处可跳，去掉了。` : '',
          // Fonts and pictures that the pages shared are now in every file that uses them.
          bytes > srcBytes * 2 && bytes - srcBytes > 512 * 1024 ? `加起来比原文件（${sizeText(srcBytes)}）大，因为各页共用的字体和图片现在每个文件里都有一份。` : '',
        ];
        return { kind: 'folder', path: dir, message: `拆成了 ${total} 个单页 PDF，共 ${sizeText(bytes)}。${notes.join('')}原文件没有改动。` };
      });
    },
  },
  {
    id: 'pdf.extract',
    label: '提取指定页',
    hint: '按页码或范围（如 1-3, 5）抽成一个新的 PDF',
    rank: 16,
    param: { kind: 'text', label: '页码', placeholder: '如 1-3, 5 或 2、末页', default: '1' },
    applies: onePdf,
    async run(ctx, env) {
      const file = ctx.files[0];
      const src = await loadPdf(file);
      const total = src.getPageCount();
      if (total < 2) throw new Error('这个 PDF 只有 1 页，不用提取');
      const spec = String(env.param ?? '').trim() || '1';
      const pages = parsePageSpec(spec, total);
      for (const page of src.getPages()) {
        page.node.delete(name('B'));
        src.context.delete(page.ref);
      }
      const outDoc = await PDFDocument.create();
      let links = 0;
      for (const [idx, pageNo] of pages.entries()) {
        checkStop(env);
        env.step(idx, pages.length, `第 ${pageNo} 页`);
        const [copied] = await outDoc.copyPages(src, [pageNo - 1]);
        outDoc.addPage(copied);
        links += settleAnnotations(copied, outDoc.context);
      }
      outDoc.setCreator('Zhidian');
      outDoc.setProducer('Zhidian');
      const data = await outDoc.save();
      env.step(pages.length, pages.length, '');
      const tag = pages.length === 1 ? `第 ${pages[0]} 页` : `提取 ${pages.length} 页`;
      const out = env.save(resultName(ctx.files, `（${tag}）`, 'pdf'), data);
      return {
        kind: 'file',
        path: out,
        message: `提取了第 ${pageList(pages)} 页（共 ${pages.length} 页，${sizeText(data.length)}）。${links ? `去掉了 ${links} 个指向其他位置的文档内链接。` : ''}原文件没有改动。`,
      };
    },
  },
  {
    id: 'pdf.images',
    label: '每页存成图片',
    hint: `每一页存成一张 JPEG 图片（长边约 ${IMAGE_EDGE} 像素），多页时放进一个新文件夹`,
    rank: 18,
    applies: onePdf,
    async run(ctx, env) {
      const file = ctx.files[0];
      const pdf = await env.tools.openPdf(file.path).catch((err) => {
        // pdf.js asks for a password in English: say it the way the other actions do.
        throw /password/i.test(String(err?.message)) ? new Error(ENCRYPTED) : err;
      });
      try {
        const total = pdf.pages;
        if (!total) throw new Error('这个 PDF 里没有页面');
        if (total === 1) {
          // One picture needs no folder: it goes next to the PDF.
          let pic;
          try {
            pic = await pageJpeg(pdf, 1);
          } catch {
            throw new Error('这一页没能画成图片');
          }
          const out = env.save(resultName(ctx.files, '', 'jpg'), pic.data);
          return { kind: 'file', path: out, message: `这个 PDF 只有 1 页，存成了一张 JPEG 图片（${pic.w}×${pic.h} 像素，${sizeText(pic.data.length)}）。` };
        }
        const stem = stemOf(file);
        return await intoFolder(env, `${stem} 图片`, async (write, dir) => {
          const edges = [];
          const failed = [];
          let bytes = 0;
          for (let n = 1; n <= total; n++) {
            checkStop(env);
            env.step(n - 1, total, `第 ${n} 页`);
            // A page that cannot be drawn is left out and named at the end; not being able to
            // write is another matter and stops the whole thing.
            const pic = await pageJpeg(pdf, n).catch(() => null);
            if (!pic) {
              failed.push(n);
              continue;
            }
            write(pageFileName(stem, n, total, 'jpg'), pic.data);
            edges.push(Math.max(pic.w, pic.h));
            bytes += pic.data.length;
          }
          env.step(total, total, '');
          if (!edges.length) throw new Error(`${total} 页都没能画成图片`);
          const min = Math.min(...edges), max = Math.max(...edges);
          return {
            kind: 'folder',
            path: dir,
            message: `把 ${edges.length} 页存成了 ${edges.length} 张 JPEG 图片，长边 ${min === max ? max : `${min}–${max}`} 像素，共 ${sizeText(bytes)}。${failed.length ? `第 ${pageList(failed)} 页没能画出来，跳过了。` : ''}`,
          };
        });
      } finally {
        await pdf.close();
      }
    },
  },
  {
    id: 'pdf.rotate',
    label: '顺时针转 90°',
    hint: '把每一页顺时针旋转 90 度，另存一份',
    rank: 36,
    applies: onePdf,
    async run(ctx, env) {
      const doc = await loadPdf(ctx.files[0], { updateMetadata: false });
      const pages = doc.getPages();
      const total = pages.length;
      pages.forEach((page, i) => {
        checkStop(env);
        env.step(i, total, `第 ${i + 1} 页`);
        const nextAngle = quarterTurn(page.getRotation().angle + 90);
        page.setRotation(degrees(nextAngle));
      });
      const data = await doc.save();
      env.step(total, total, '');
      const out = env.save(resultName(ctx.files, '（已旋转）', 'pdf'), data);
      return { kind: 'file', path: out, message: `已把全部 ${total} 页顺时针旋转 90°（${sizeText(data.length)}）。原文件没有改动。` };
    },
  },
  {
    id: 'pdf.compress',
    label: '压缩 PDF',
    hint: '把扫描件或大图 PDF 重绘瘦身；如果原文件已经很紧凑则不会生成反而变大的文件',
    rank: 38,
    applies: onePdf,
    async run(ctx, env) {
      const file = ctx.files[0];
      await loadPdf(file); // verify readable, non-encrypted, and non-empty first
      const srcBytes = fs.statSync(file.path).size;
      const pdf = await env.tools.openPdf(file.path).catch((err) => {
        throw /password/i.test(String(err?.message)) ? new Error(ENCRYPTED) : err;
      });
      try {
        const total = pdf.pages;
        if (!total) throw new Error('这个 PDF 里没有页面');
        const outDoc = await PDFDocument.create();
        for (let n = 1; n <= total; n++) {
          checkStop(env);
          env.step(n - 1, total, `第 ${n} 页`);
          const drawn = await pdf.render(n, COMPRESS_EDGE, COMPRESS_QUALITY).catch(() => null);
          const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(drawn?.dataUrl ?? '');
          if (!m) throw new Error(`第 ${n} 页没能重绘压缩`);
          const jpgBytes = new Uint8Array(Buffer.from(m[1], 'base64'));
          const img = await outDoc.embedJpg(jpgBytes);
          const pw = Math.max(36, Number(drawn.points?.w) || img.width);
          const ph = Math.max(36, Number(drawn.points?.h) || img.height);
          const page = outDoc.addPage([pw, ph]);
          page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
        }
        outDoc.setCreator('Zhidian');
        outDoc.setProducer('Zhidian');
        const data = await outDoc.save();
        env.step(total, total, '');
        if (data.length >= srcBytes) {
          throw new Error(`这个 PDF 已经很紧凑（${sizeText(srcBytes)}），重绘压缩后反而会变大，不需要压缩`);
        }
        const savedPct = Math.min(99, Math.max(1, Math.round(((srcBytes - data.length) / srcBytes) * 100)));
        const out = env.save(resultName(ctx.files, '（已压缩）', 'pdf'), data);
        return {
          kind: 'file',
          path: out,
          message: `已压缩 PDF：${sizeText(srcBytes)} → ${sizeText(data.length)}，小了 ${savedPct}%（共 ${total} 页，已转为紧凑图像页面）。原文件没有改动。`,
        };
      } finally {
        await pdf.close();
      }
    },
  },
  {
    id: 'pdf.number',
    label: '加页码',
    hint: '在每页底部正中写上“页码 / 总页数”，另存一份',
    rank: 40,
    applies: onePdf,
    async run(ctx, env) {
      // The document's own details (title, author, dates) stay as they are.
      const doc = await loadPdf(ctx.files[0], { updateMetadata: false });
      const pages = doc.getPages();
      const total = pages.length;
      const font = await doc.embedFont(StandardFonts.Helvetica);
      pages.forEach((page, i) => {
        checkStop(env);
        env.step(i, total, `第 ${i + 1} 页`);
        const box = visibleBox(page.getMediaBox(), page.getCropBox());
        const angle = quarterTurn(page.getRotation().angle);
        const sideways = angle === 90 || angle === 270;
        const style = numberStyle(sideways ? box.height : box.width, sideways ? box.width : box.height);
        const text = `${i + 1} / ${total}`;
        const at = bottomCentre(box, angle, font.widthOfTextAtSize(text, style.size), style.lift);
        page.drawText(text, { x: at.x, y: at.y, size: style.size, font, color: NUMBER_GREY, rotate: degrees(at.rotate) });
      });
      const data = await doc.save();
      env.step(total, total, '');
      const out = env.save(resultName(ctx.files, '（带页码）', 'pdf'), data);
      return { kind: 'file', path: out, message: `给 ${total} 页都加了页码（${total > 1 ? `“1 / ${total}”到“${total} / ${total}”` : '“1 / 1”'}），灰色小字，在每页底部正中。原文件没有改动。` };
    },
  },
];
