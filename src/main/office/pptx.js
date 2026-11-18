// Files into editable template slides. PDF text follows the same outline rules as documents;
// only pages without extractable text fall back to an explicitly labelled page image.
import fs from 'node:fs';
import PptxGenJS from 'pptxgenjs';
import { documentTheme } from '../../core/document-themes.js';
import { outlineFromText } from './convert.js';
import { unifyRadicals } from '../../core/text-stats.js';

const Pptx = PptxGenJS.default ?? PptxGenJS;
const W = 13.333, H = 7.5; // 16:9, inches
const MAX_POINTS = 5;
const POINT_CHARS = 64;
const MAX_PDF_PAGES = 80;
const TABLE_HEIGHT = 4.45;

const chars = (s) => [...s].length;

/** The first sentence or two of a paragraph, short enough to read on a slide. */
export function shorten(text, limit = POINT_CHARS) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (chars(t) <= limit) return t;
  let out = '';
  for (const piece of t.split(/(?<=[。！？!?；;])/)) {
    if (chars(out + piece) > limit) break;
    out += piece;
  }
  if (out) return out.trim();
  // One long sentence: cut at the last comma that fits, else hard.
  const head = [...t].slice(0, limit).join('');
  const comma = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf('、'));
  return (comma > limit * 0.5 ? head.slice(0, comma) : head) + '…';
}

function fit(w, h, boxW, boxH) {
  if (!(w > 0) || !(h > 0)) return { w: boxW, h: boxH };
  const s = Math.min(boxW / w, boxH / h);
  return { w: w * s, h: h * s };
}

function parsePngSize(buf, requireEnd = false) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w <= 0 || h <= 0) return null;
  if (!requireEnd) return { w, h };
  for (let o = 8; o + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (o + 12 + len > buf.length) return null;
    if (buf.toString('latin1', o + 4, o + 8) === 'IEND') return { w, h };
    o += 12 + len;
  }
  return null;
}

function parseJpegSize(buf, requireEnd = false) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let o = 2;
  let size = null;
  while (o < buf.length) {
    if (buf[o] !== 0xff) return null;
    while (o < buf.length && buf[o] === 0xff) o++;
    if (o >= buf.length) return null;
    const marker = buf[o++];
    if (marker === 0xd9) return size;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (o + 2 > buf.length) return null;
    const len = buf.readUInt16BE(o);
    if (len < 2 || o + len > buf.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 7) return null;
      const h = buf.readUInt16BE(o + 3), w = buf.readUInt16BE(o + 5);
      if (w <= 0 || h <= 0) return null;
      if (!requireEnd) return { w, h };
      size = { w, h };
    } else if (marker === 0xda) {
      if (!size) return null;
      if (!requireEnd) return size;
      return buf.indexOf(Buffer.from([0xff, 0xd9]), o + len) >= 0 ? size : null;
    }
    o += len;
  }
  return null;
}

function readDirectImage(buf) {
  const png = parsePngSize(buf, true);
  if (png) return { mime: 'image/png', ...png };
  const jpg = parseJpegSize(buf, true);
  if (jpg) return { mime: 'image/jpeg', ...jpg };
  return null;
}

const imageSize = (dataUrl) => {
  const buf = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
  return parsePngSize(buf) ?? parseJpegSize(buf) ?? { w: 4, h: 3 };
};

// Conservative character widths plus explicit line breaks keep native table cells inside
// their measured rows. Long cells continue on later slides; the unwrapped source is in notes.
function wrapTableCell(value, width, fontSize) {
  const max = Math.max(1, (width - 0.28) * 72 / fontSize);
  const lines = [];
  for (const paragraph of String(value ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = '', used = 0;
    for (const char of paragraph) {
      const advance = /\s/u.test(char) ? 0.35 : /[MW@#%]/.test(char) ? 0.9 : char.codePointAt(0) > 0xff ? 1.05 : /[ilI.,:;'!|]/.test(char) ? 0.32 : 0.62;
      if (line && used + advance > max) { lines.push(line); line = ''; used = 0; }
      line += char; used += advance;
    }
    lines.push(line);
  }
  return lines;
}

function tablePages(sourceRows) {
  if (!sourceRows.length) return [];
  const columns = Math.max(1, ...sourceRows.map((r) => r.length));
  const groups = [];
  if (columns <= 6) groups.push(Array.from({ length: columns }, (_, i) => i));
  else for (let start = 1; start < columns; start += 5) groups.push([0, ...Array.from({ length: Math.min(5, columns - start) }, (_, i) => start + i)]);
  const pages = [];
  for (const indices of groups) {
    const fontSize = indices.length > 4 ? 13 : 15;
    const colWidth = (W - 1.6) / indices.length;
    const lineHeight = fontSize * 1.32 / 72;
    const rawHeader = indices.map((c) => String(sourceRows[0][c] ?? ''));
    const headerLines = rawHeader.map((v) => wrapTableCell(v, colWidth, fontSize));
    const headerParts = Math.max(...headerLines.map((v) => Math.ceil(v.length / 8)));
    // An unusually long heading also gets native continuation pages, never an ellipsis.
    if (headerParts > 1) {
      for (let part = 0; part < headerParts; part++) {
        const lines = headerLines.map((v) => v.slice(part * 8, (part + 1) * 8));
        pages.push({ indices, fontSize, rows: [lines.map((v) => v.join('\n'))], heights: [Math.max(0.45, Math.max(...lines.map((v) => v.length)) * lineHeight + 0.2)], notes: [rawHeader], headerContinuation: true });
      }
    }
    const shownHeader = headerLines.map((v) => v.slice(0, 8).join('\n'));
    const headerHeight = Math.max(0.45, Math.min(8, Math.max(...headerLines.map((v) => v.length))) * lineHeight + 0.2);
    const maxLines = Math.max(1, Math.floor((TABLE_HEIGHT - headerHeight - 0.2) / lineHeight));
    let rows = [shownHeader], heights = [headerHeight], notes = [rawHeader], height = headerHeight;
    const flush = () => {
      if (rows.length > 1 || sourceRows.length === 1 && headerParts === 1) pages.push({ indices, fontSize, rows, heights, notes });
      rows = [shownHeader]; heights = [headerHeight]; notes = [rawHeader]; height = headerHeight;
    };
    for (const source of sourceRows.slice(1)) {
      const raw = indices.map((c) => String(source[c] ?? ''));
      const lines = raw.map((v) => wrapTableCell(v, colWidth, fontSize));
      const parts = Math.max(...lines.map((v) => Math.ceil(v.length / maxLines)));
      for (let part = 0; part < parts; part++) {
        const pieces = lines.map((v) => v.slice(part * maxLines, (part + 1) * maxLines));
        const rowHeight = Math.max(0.45, Math.max(...pieces.map((v) => v.length)) * lineHeight + 0.2);
        if (height + rowHeight > TABLE_HEIGHT + 0.001) flush();
        rows.push(pieces.map((v) => v.join('\n'))); heights.push(rowHeight); notes.push(raw); height += rowHeight;
      }
    }
    flush();
  }
  return pages;
}

function pdfBodyText(text, page, pages, filename) {
  const lines = text.split('\n');
  const last = lines[lines.length - 1]?.replace(/\s/g, '');
  // Only remove a definite current-page/total-page footer. Untouched extraction remains in
  // notes, including metadata; ordinary numbers and other short source lines are retained.
  if (last === `${page}/${pages}` || last === `第${page}页共${pages}页`) {
    lines.pop();
    if (lines[lines.length - 1]?.trim() === filename.replace(/\.[^.]+$/, '')) lines.pop();
  }
  return lines.join('\n').trim();
}

/**
 * @param {Array<{path,name,ext,kind}>} files
 * @param {object} tools
 * @param {(path) => Promise<{title, sections}>} tools.outlineOf
 * @param {(path) => Promise<{pages, text(n), render(n, maxEdge), close()}>} tools.openPdf
 * @param {(path) => Promise<{dataUrl, w, h}>} tools.decodeImage
 * @param {{ title?: string, template?: 'business' | 'clean' | 'warm', signal?: AbortSignal }} [o]
 * @returns {Promise<{ buffer: Buffer, slides: number, used: string[], skipped: object[], warnings: object[], shortened: number, paginatedTables: number, pdfTextPages: number, pdfImagePages: number }>}
 */
export async function filesToPptx(files, tools, { title, signal, template } = {}, onProgress) {
  const theme = documentTheme(template);
  const FONT = process.platform === 'linux' ? 'Noto Sans CJK SC' : theme.font;
  const BODY_FONT = process.platform === 'linux' ? (theme.serif ? 'Noto Serif CJK SC' : FONT) : theme.bodyFont;
  const INK = theme.ink, DIM = theme.muted, ACCENT = theme.accent;
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Zhidian';
  pptx.company = '';
  pptx.subject = `${theme.label}模板`;
  pptx.theme = { headFontFace: FONT, bodyFontFace: BODY_FONT, lang: 'zh-CN' };
  const docs = files.filter((f) => f.kind === 'word' || f.kind === 'markdown' || f.kind === 'text');
  const footer = [
    { line: { x: 0.8, y: 7.02, w: W - 1.6, h: 0, line: { color: theme.line, width: 0.7 } } },
    { rect: { x: 0.8, y: 7.15, w: 0.34, h: 0.035, line: { transparency: 100 }, fill: { color: ACCENT } } },
  ];
  pptx.defineSlideMaster({
    title: 'CONTENT', background: { color: theme.paper },
    objects: [{ rect: { x: 0.8, y: 0, w: 1.1, h: 0.07, line: { transparency: 100 }, fill: { color: ACCENT } } }, ...footer],
    slideNumber: { x: W - 1.35, y: 7.1, w: 0.55, h: 0.22, fontSize: 9, color: DIM, fontFace: FONT, align: 'right' },
  });
  pptx.defineSlideMaster({ title: 'PICTURE', background: { color: theme.paper }, objects: footer, slideNumber: { x: W - 1.35, y: 7.1, w: 0.55, h: 0.22, fontSize: 9, color: DIM, fontFace: FONT, align: 'right' } });

  let slides = 0;
  let shortened = 0;
  let paginatedTables = 0, pdfTextPages = 0, pdfImagePages = 0;
  const used = [];
  const skipped = [];
  const warnings = [];
  const titleSlide = (text, sub) => {
    const s = pptx.addSlide();
    s.background = { color: theme.cover };
    s.addShape(pptx.ShapeType.rect, { x: 9.8, y: 0, w: W - 9.8, h: H, line: { transparency: 100 }, fill: { color: ACCENT, transparency: 88 } });
    s.addShape(pptx.ShapeType.rect, { x: 10.8, y: 0, w: 0.035, h: H, line: { transparency: 100 }, fill: { color: ACCENT, transparency: 60 } });
    s.addText('演示文稿', { x: 0.95, y: 0.85, w: 8.2, h: 0.35, fontSize: 11, color: theme.coverInk, fontFace: FONT, margin: 0 });
    s.addText(text, { x: 0.95, y: 2.0, w: 10.3, h: 2.2, fontSize: chars(text) > 30 ? 34 : 42, bold: true, color: theme.coverInk, fontFace: FONT, valign: 'middle', breakLine: false, fit: 'shrink', margin: 0 });
    s.addShape(pptx.ShapeType.rect, { x: 0.95, y: 4.63, w: 0.85, h: 0.06, line: { transparency: 100 }, fill: { color: ACCENT } });
    if (sub) s.addText(sub, { x: 0.95, y: 5.08, w: 8.8, h: 0.7, fontSize: 15, color: theme.coverInk, fontFace: FONT, valign: 'top', fit: 'shrink', margin: 0 });
    slides++;
    return s;
  };
  const head = (s, text, label = '内容 / CONTENT') => {
    s.addText(label, { x: 0.82, y: 0.43, w: W - 1.64, h: 0.24, fontSize: 8.5, charSpacing: 1.5, color: ACCENT, fontFace: FONT, margin: 0 });
    s.addText(text, { x: 0.8, y: 0.85, w: W - 1.6, h: 0.84, fontSize: chars(text) > 28 ? 25 : 30, bold: true, color: INK, fontFace: FONT, valign: 'middle', fit: 'shrink', margin: 0 });
  };
  const noteMarker = (s) => s.addText('完整内容见本页备注', { x: 0.85, y: 6.68, w: W - 1.7, h: 0.2, fontSize: 8.5, color: DIM, fontFace: FONT, margin: 0 });
  const pictureSlide = (dataUrl, size, caption, master = 'PICTURE') => {
    const s = pptx.addSlide({ masterName: master });
    const top = caption && master === 'CONTENT' ? 1.9 : 0.35;
    const bottom = caption && master !== 'CONTENT' ? 0.85 : 0.65;
    const room = { w: W - 1.6, h: H - top - bottom };
    const box = fit(size.w, size.h, room.w, room.h);
    if (caption && master === 'CONTENT') head(s, caption, '图文 / VISUAL');
    s.addImage({ data: dataUrl.replace(/^data:/, ''), x: (W - box.w) / 2, y: top + (room.h - box.h) / 2, w: box.w, h: box.h });
    if (caption && master !== 'CONTENT') s.addText(caption, { x: 0.8, y: 6.66, w: W - 2.2, h: 0.25, fontSize: 11, color: DIM, fontFace: FONT, margin: 0, fit: 'shrink' });
    slides++;
    return s;
  };

  const addSections = (sections, sourceNote = '') => {
    for (const section of sections) {
      if (signal?.aborted) throw new Error('已取消');
      // Text and bullets fill slides of up to MAX_POINTS points; tables, pictures and code
      // get a slide of their own under the same title.
      let points = [];
      let notes = [];
      let part = 0;
      const flush = () => {
        if (!points.length) return;
        const s = pptx.addSlide({ masterName: 'CONTENT' });
        head(s, section.title + (part ? '（续）' : ''));
        const gap = 0.12;
        const height = Math.min(1.25, (4.5 - gap * (points.length - 1)) / points.length);
        points.forEach((text, index) => {
          const y = 1.97 + index * (height + gap);
          s.addShape(pptx.ShapeType.rect, { x: 0.8, y, w: W - 1.6, h: height, line: { transparency: 100 }, fill: { color: theme.surface } });
          s.addText(String(part * MAX_POINTS + index + 1).padStart(2, '0'), { x: 1.03, y: y + 0.16, w: 0.55, h: 0.32, fontSize: 13, color: ACCENT, bold: true, fontFace: FONT, margin: 0 });
          s.addText(text, { x: 1.78, y: y + 0.1, w: W - 2.85, h: height - 0.2, fontSize: points.length > 4 ? 17 : 21, color: INK, fontFace: BODY_FONT, valign: 'middle', margin: 0, breakLine: false });
        });
        if (notes.length || sourceNote) { s.addNotes([sourceNote, ...notes].filter(Boolean).join('\n\n')); noteMarker(s); }
        slides++;
        part++;
        points = [];
        notes = [];
      };
      for (let bi = 0; bi < section.blocks.length; bi++) {
        const b = section.blocks[bi];
        // "图 1 ……" right after a picture is that picture's caption, not a point of its own.
        const caption = (x) => x?.type === 'text' && chars(x.text) <= 40 && /^(图|表|figure|fig\.?|table)\s*\d/i.test(x.text);
        if (caption(b) && section.blocks[bi - 1]?.type === 'image') continue;
        if (b.type === 'text' || b.type === 'bullet') {
          const short = shorten(b.text);
          if (short !== b.text.replace(/\s+/g, ' ').trim()) {
            shortened++;
            notes.push(b.text);
          }
          points.push(short);
          if (points.length >= MAX_POINTS) flush();
        } else if (b.type === 'table') {
          flush();
          const pages = tablePages(b.rows);
          if (pages.length > 1) paginatedTables++;
          for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const page = pages[pageIndex];
            const rows = page.rows.map((r, ri) => r.map((text) => ({ text, options: { bold: ri === 0, fill: { color: ri === 0 ? ACCENT : ri % 2 === 0 ? theme.surface : theme.paper }, color: ri === 0 ? 'FFFFFF' : INK, fontFace: FONT, fontSize: page.fontSize, valign: 'middle', paraSpaceAfterPt: 0, breakLine: false } })));
            const s = pptx.addSlide({ masterName: 'CONTENT' });
            const label = `数据 / DATA${pages.length > 1 ? ` · ${pageIndex + 1}/${pages.length}` : ''}${page.headerContinuation ? ' · 表头续页' : ''}`;
            head(s, section.title, label);
            s.addTable(rows, { x: 0.8, y: 1.98, w: W - 1.6, h: page.heights.reduce((a, b) => a + b, 0), colW: (W - 1.6) / page.indices.length, rowH: page.heights, border: { type: 'solid', color: theme.line, pt: 0.5 }, margin: [0.08, 0.14, 0.08, 0.14], autoPage: false });
            s.addNotes(`原始表格数据（本页对应列 ${page.indices.map((c) => c + 1).join('、')}；长行、表头和首列可能在续页重复）：\n${page.notes.map((r) => r.join('\t')).join('\n')}`);
            noteMarker(s);
            slides++;
          }
        } else if (b.type === 'image') {
          flush();
          const next = section.blocks[bi + 1];
          pictureSlide(b.dataUrl, imageSize(b.dataUrl), caption(next) ? `${section.title} · ${next.text}` : section.title, 'CONTENT');
        } else if (b.type === 'code') {
          flush();
          const s = pptx.addSlide({ masterName: 'CONTENT' });
          head(s, section.title, '代码 / CODE');
          const codeLines = b.text.split('\n');
          // Bound physical lines, including long source lines that would otherwise wrap
          // below the slide. The untouched code remains available in speaker notes.
          const wrapped = codeLines.flatMap((line) => {
            const out = [];
            let piece = '', width = 0;
            for (const char of line) {
              const advance = char.codePointAt(0) > 0xff ? 2 : 1;
              if (width + advance > 100) { out.push(piece); piece = ''; width = 0; }
              piece += char; width += advance;
            }
            out.push(piece);
            return out;
          });
          s.addText(wrapped.slice(0, 18).join('\n'), { x: 0.8, y: 1.98, w: W - 1.6, h: 4.5, fontSize: 12, fontFace: 'Consolas', color: INK, fill: { color: theme.surface }, valign: 'top', margin: 0.22 });
          if (wrapped.length > 18) {
            shortened++;
          }
          if (wrapped.length > 18 || wrapped.length !== codeLines.length) {
            s.addNotes(b.text);
            noteMarker(s);
          }
          slides++;
        }
      }
      flush();
      if (!part && !section.blocks.length) {
        // A heading with nothing under it: a divider slide.
        const s = pptx.addSlide({ masterName: 'CONTENT' });
        s.addText(section.title, { x: 0.9, y: 2.6, w: W - 1.8, h: 1.4, fontSize: 36, bold: true, color: INK, fontFace: FONT, valign: 'middle' });
        if (sourceNote) { s.addNotes(sourceNote); noteMarker(s); }
        slides++;
      }
    }
  };

  // A cover when there is something to name it after.
  const deckTitle = title || (files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') || files[0].name : '');
  const hasCover = Boolean(deckTitle) && !(docs.length === 1 && files.length === 1);
  const coverSlide = hasCover ? titleSlide(deckTitle, '') : null;

  let i = 0;
  for (const file of files) {
    if (signal?.aborted) throw new Error('已取消');
    onProgress?.(i++, files.length, file.name);
    try {
      if (file.kind === 'image') {
        const raw = fs.readFileSync(file.path);
        const direct = readDirectImage(raw);
        let dataUrl, size;
        if (direct) {
          dataUrl = `data:${direct.mime};base64,${raw.toString('base64')}`;
          size = { w: direct.w, h: direct.h };
        } else {
          const img = await tools.decodeImage(file.path);
          dataUrl = img.dataUrl;
          size = { w: img.w, h: img.h };
        }
        pictureSlide(dataUrl, size, file.name.replace(/\.[^.]+$/, '') || file.name);
      } else if (file.kind === 'pdf') {
        const pdf = await tools.openPdf(file.path);
        try {
          if (!pdf.pages) throw new Error('这个 PDF 里没有页面');
          const n = Math.min(pdf.pages, MAX_PDF_PAGES);
          let readPages = 0;
          for (let p = 1; p <= n; p++) {
            if (signal?.aborted) throw new Error('已取消');
            try {
              let text = '', reason = '';
              if (typeof pdf.text === 'function') {
                try { text = unifyRadicals(String((await pdf.text(p)) ?? '')).trim(); }
                catch (err) { reason = `文字提取失败：${String(err?.message ?? err).slice(0, 80)}`; }
              } else reason = '当前 PDF 读取器未提供文字提取';
              if (signal?.aborted) throw new Error('已取消');
              const body = pdfBodyText(text, p, pdf.pages, file.name);
              if (body) {
                const pageName = `${file.name} · 第 ${p} 页`;
                const outline = outlineFromText(body, pageName);
                const sections = outline.sections.length ? outline.sections.map((section, index) => ({ ...section, title: !index && section.title !== outline.title ? `${outline.title} · ${section.title}` : section.title })) : [{ title: outline.title, blocks: [] }];
                addSections(sections, `来源：${pageName}\nPDF 提取原文：\n${text}`);
                pdfTextPages++;
              } else {
                if (typeof pdf.render !== 'function') throw new Error('没有可提取的文字，也无法读取页面图片');
                const page = await pdf.render(p, 1920);
                const why = `${reason || (text ? '只有页眉、页码，没有可用于排版的正文' : '没有可提取的文字（可能是扫描件）')}；已按页面图片插入，图片内文字不可编辑`;
                const s = pictureSlide(page.dataUrl, { w: page.w, h: page.h }, `${file.name} · 第 ${p} 页 · 页面图片（文字不可编辑）`);
                s.addNotes(`来源：${file.name}，第 ${p} 页。\n${why}。`);
                warnings.push({ name: file.name, page: p, why });
                pdfImagePages++;
              }
              readPages++;
            } catch (err) {
              if (signal?.aborted) throw new Error('已取消');
              skipped.push({ name: `${file.name} 第 ${p} 页`, why: String(err?.message ?? err).slice(0, 120) });
            }
          }
          if (!readPages) throw new Error('这个 PDF 没有能转换的页面');
          if (pdf.pages > n) skipped.push({ name: file.name, why: `只放了前 ${n} 页（共 ${pdf.pages} 页）` });
        } finally {
          await pdf.close();
        }
      } else if (file.kind === 'word' || file.kind === 'markdown' || file.kind === 'text') {
        const outline = await tools.outlineOf(file.path);
        titleSlide(outline.title, files.length > 1 ? file.name : '');
        addSections(outline.sections);
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
  if (!used.length) throw new Error(skipped.length ? `没有一个文件能做成幻灯片：${skipped.map((s) => `${s.name}（${s.why}）`).join('；')}` : '没有可以用的文件');
  if (coverSlide && files.length > 1) coverSlide.addText(`${used.length} 个文件`, { x: 0.95, y: 5.08, w: 8.8, h: 0.6, fontSize: 15, color: theme.coverInk, fontFace: FONT, valign: 'top', margin: 0 });
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return { buffer: Buffer.from(buffer), slides, used, skipped, warnings, shortened, paginatedTables, pdfTextPages, pdfImagePages };
}
