// Reading documents: Word, Markdown and plain text into HTML (for printing to PDF), into
// Markdown, and into an outline of titled sections (for slides). No Electron in here.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mammoth from 'mammoth';
import { marked } from 'marked';
import { DOMParser } from '@xmldom/xmldom';
import { headingLevelOf } from './restyle.js';
import { documentTheme } from '../../core/document-themes.js';
import { detectDelimiter, fitTable, parseCsv, readXlsx } from './sheet.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Put a <base href="..."> into <head> safely, even when `baseDir` holds `$'` / `$&` / quotes. */
export function injectBaseHref(html, baseDir) {
  if (!baseDir) return html;
  const href = pathToFileURL(baseDir + path.sep).toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return html.replace(/<head>/i, () => `<head><base href="${href}">`);
}

/** A complete report page, using only fonts and assets already on this computer. */
export function pageHtml(body, title = '', { template } = {}) {
  const theme = documentTheme(template);
  // Lift a leading source title into the opening block instead of printing it twice.
  const leading = /^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
  let heading = title;
  if (leading) {
    const fragment = new DOMParser({ onError: () => {} }).parseFromString(`<div>${leading[1]}</div>`, 'text/html');
    heading = fragment.documentElement.textContent.trim() || title;
    body = body.slice(leading[0].length);
  }
  const fonts = theme.serif
    ? '"Georgia", "Songti SC", "SimSun", "宋体", "Noto Serif CJK SC", serif'
    : '"Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(heading)}</title><style>
@page { size: A4; margin: 24mm 22mm 22mm; }
html { font-size: 10.5pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: ${fonts}; line-height: 1.8; color: #${theme.ink}; background: #${theme.paper}; overflow-wrap: anywhere; }
.document-heading { margin: 0 0 24pt; padding: 18pt 20pt 20pt; background: #${theme.surface}; border-top: 4pt solid #${theme.accent}; break-inside: avoid; }
.document-heading .eyebrow { font-family: Arial, sans-serif; font-size: 8pt; letter-spacing: 2pt; color: #${theme.muted}; margin: 0 0 12pt; }
.document-heading h1 { font-size: 27pt; line-height: 1.3; margin: 0; color: #${theme.ink}; }
h1, h2, h3, h4, h5, h6 { font-family: "Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; line-height: 1.4; break-after: avoid; }
h1 { font-size: 23pt; margin: 22pt 0 12pt; }
h2 { font-size: 16pt; color: #${theme.accent}; margin: 24pt 0 10pt; padding-bottom: 5pt; border-bottom: 1pt solid #${theme.line}; }
h3 { font-size: 12.5pt; margin: 18pt 0 7pt; }
h4, h5, h6 { font-size: 11pt; margin: 14pt 0 6pt; }
p { margin: 0 0 10pt; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 12pt; padding-left: 1.7em; }
li { margin: 3pt 0; padding-left: 3pt; }
li::marker { color: #${theme.accent}; }
table { border-collapse: collapse; width: 100%; margin: 12pt 0 18pt; font-size: 9.5pt; line-height: 1.5; break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
td, th { border-bottom: 0.6pt solid #${theme.line}; padding: 7pt 9pt; vertical-align: top; text-align: left; }
th { background: #${theme.accent}; color: white; font-weight: 700; }
tbody tr:nth-child(even) { background: #${theme.surface}; }
img { max-width: 100%; max-height: 230mm; height: auto; object-fit: contain; }
pre, code { font-family: Consolas, Menlo, "DejaVu Sans Mono", monospace; font-size: 9pt; }
code { background: #${theme.surface}; padding: 1pt 3pt; }
pre { white-space: pre-wrap; word-break: break-word; background: #${theme.surface}; border-left: 2pt solid #${theme.accent}; padding: 12pt 14pt; border-radius: 4pt; }
pre code { padding: 0; }
blockquote { margin: 12pt 0 18pt; padding: 10pt 16pt; border-left: 3pt solid #${theme.accent}; background: #${theme.surface}; color: #${theme.muted}; }
blockquote p:last-child { margin-bottom: 0; }
hr { border: 0; border-top: 1pt solid #${theme.line}; margin: 20pt 0; }
a { color: #${theme.accent}; text-decoration: none; }
.plain { white-space: pre-wrap; word-break: break-word; text-align: left; }
</style></head><body data-document-theme="${theme.id}">${heading ? `<header class="document-heading"><div class="eyebrow">DOCUMENT</div><h1>${esc(heading)}</h1></header>` : ''}<main>${body}</main></body></html>`;
}

/** Word to HTML, pictures embedded as data URLs. */
export async function docxToHtml(file) {
  const head = Buffer.alloc(4);
  let read = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      read = fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw new Error('打不开这个 Word 文档：文件不存在或无法读取');
  }
  if (read >= 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new Error('打不开这个 Word 文档：它加了打开密码，或者其实是旧版的 .doc 文件');
  }
  let result;
  try {
    result = await mammoth.convertToHtml(
      { path: file },
      { convertImage: mammoth.images.imgElement(async (image) => ({ src: `data:${image.contentType};base64,${await image.read('base64')}` })) },
    );
  } catch {
    // (The library's own words here are about zip internals.)
    throw new Error('打不开这个 Word 文档：文件是空的或已损坏');
  }
  return result.value;
}

/** Word to Markdown: headings, lists, tables, bold and italic. Pictures become a visible note. */
export async function docxToMarkdown(file) {
  const blocks = promoteHeadings(htmlToBlocks(await docxToHtml(file)));
  const cell = (c) => String(c).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out = [];
  let title = true;
  for (const b of blocks) {
    if (b.type === 'heading') out.push(`${'#'.repeat(Math.min(6, title ? 1 : b.level + 1))} ${b.text}`);
    else if (b.type === 'bullet') out.push(`- ${b.md ?? b.text}`);
    else if (b.type === 'table' && b.rows.length) {
      const width = Math.max(...b.rows.map((r) => r.length));
      const row = (r) => `| ${Array.from({ length: width }, (_x, i) => cell(r[i] ?? '')).join(' | ')} |`;
      out.push([row(b.rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...b.rows.slice(1).map(row)].join('\n'));
    } else if (b.type === 'code') out.push('```\n' + b.text + '\n```');
    else if (b.type === 'image') out.push('（此处原有图片）');
    else out.push(b.md ?? b.text);
    title = false;
  }
  if (!out.length) throw new Error('这个文档里没有可以导出的内容');
  // Consecutive list items stay together; everything else is separated by a blank line.
  let md = '';
  out.forEach((line, i) => {
    md += line + (line.startsWith('- ') && out[i + 1]?.startsWith('- ') ? '\n' : '\n\n');
  });
  return md.trim() + '\n';
}

export function readText(file) {
  const buf = fs.readFileSync(file);
  // UTF-8 with or without a mark, UTF-16 with a mark, otherwise GB18030 (old Chinese text files).
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

async function sheetToHtml(file, ext, title, options) {
  let sheets;
  if (ext === '.xlsx') {
    const all = await readXlsx(fs.readFileSync(file));
    sheets = all.filter((s) => !s.hidden).map((s) => ({ name: s.name, ...fitTable(s.rows) })).filter((s) => s.rows.length);
    if (!sheets.length) throw new Error('这个工作簿里没有数据');
  } else {
    const raw = readText(file);
    const delimiter = ext === '.tsv' ? '\t' : detectDelimiter(raw);
    const table = fitTable(parseCsv(raw, delimiter));
    if (!table.rows.length) throw new Error('这个表格是空的，没有可以转换的内容');
    sheets = [{ name: title, ...table }];
  }
  const totalRows = sheets.reduce((sum, s) => sum + s.rows.length, 0);
  if (totalRows > 5000) throw new Error('这个表格行数太多，需要安装 LibreOffice 才能转成 PDF');
  const cellHtml = (v) => esc(v ?? '').replace(/\r\n?|\n/g, '<br>');
  const parts = sheets.map((s) => {
    const head = sheets.length > 1 ? `<h2>${esc(s.name)}</h2>` : '';
    const cols = s.cols;
    const tr = (row, tag) => `<tr>${Array.from({ length: cols }, (_x, i) => `<${tag}>${cellHtml(row[i])}</${tag}>`).join('')}</tr>`;
    const body = s.rows.slice(1).map((r) => tr(r, 'td')).join('');
    return `${head}<table><thead>${tr(s.rows[0], 'th')}</thead>${body ? `<tbody>${body}</tbody>` : ''}</table>`;
  });
  return pageHtml(parts.join('\n'), title, options);
}

/** Any readable document as a complete HTML page. Returns { html, baseDir }. */
export async function fileToHtml(file, { template } = {}) {
  const title = path.basename(file).replace(/\.[^.]+$/, '') || path.basename(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') {
    const body = await docxToHtml(file);
    if (!htmlToBlocks(body).length) throw new Error('这个文档是空的，没有可以转换的内容');
    return { html: pageHtml(body, title, { template }) };
  }
  if (ext === '.xlsx' || ext === '.csv' || ext === '.tsv') {
    return { html: await sheetToHtml(file, ext, title, { template }) };
  }
  if (ext === '.md' || ext === '.markdown') {
    const raw = readText(file);
    if (!raw.trim()) throw new Error('这个文档是空的，没有可以转换的内容');
    return { html: pageHtml(marked.parse(raw, { gfm: true }), title, { template }), baseDir: path.dirname(file) };
  }
  const raw = readText(file);
  if (!raw.trim()) throw new Error('这个文档是空的，没有可以转换的内容');
  return { html: pageHtml(`<div class="plain">${esc(raw)}</div>`, title, { template }) };
}

// ---------------------------------------------------------------- outline for slides

const textOf = (node) => (node.textContent ?? '').replace(/[\s\u00a0\u3000]+/g, ' ').trim();

/** Inline content as Markdown: bold, italic and links survive, everything else is its text. */
function inlineMd(node) {
  let out = '';
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3) out += c.nodeValue.replace(/[\s\u00a0\u3000]+/g, ' ');
    else if (c.nodeType === 1) {
      const tag = c.tagName.toLowerCase();
      const inner = inlineMd(c);
      if (!inner.trim() && tag !== 'br') continue;
      if (tag === 'strong' || tag === 'b') out += `**${inner.trim()}**`;
      else if (tag === 'em' || tag === 'i') out += `*${inner.trim()}*`;
      else if (tag === 'a' && c.getAttribute('href') && !c.getAttribute('href').startsWith('#')) out += `[${inner.trim()}](${c.getAttribute('href').replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
      else if (tag === 'br') out += ' ';
      else if (tag !== 'ul' && tag !== 'ol') out += inner;
    }
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

function htmlToBlocks(html) {
  const doc = new DOMParser({ onError: () => {} }).parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.getElementsByTagName('div')[0] ?? doc.documentElement;
  const blocks = [];
  const walk = (node) => {
    for (const el of Array.from(node.childNodes)) {
      if (el.nodeType !== 1) continue;
      const tag = el.tagName.toLowerCase();
      const imgs = Array.from(el.getElementsByTagName('img'));
      if (/^h[1-6]$/.test(tag)) {
        if (textOf(el)) blocks.push({ type: 'heading', level: Number(tag[1]), text: textOf(el) });
      } else if (tag === 'ul' || tag === 'ol') {
        for (const li of Array.from(el.getElementsByTagName('li'))) {
          // The text of the item itself, without the items nested inside it.
          const own = Array.from(li.childNodes).filter((c) => !(c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName))).map((c) => c.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
          if (own) blocks.push({ type: 'bullet', text: own, md: inlineMd(li) });
        }
      } else if (tag === 'table') {
        const rows = Array.from(el.getElementsByTagName('tr')).map((tr) => Array.from(tr.childNodes).filter((c) => c.nodeType === 1 && /^t[dh]$/i.test(c.tagName)).map(textOf));
        if (rows.length) blocks.push({ type: 'table', rows });
      } else if (tag === 'pre') {
        if (el.textContent.trim()) blocks.push({ type: 'code', text: el.textContent.replace(/\s+$/, '') });
      } else if (tag === 'p' || tag === 'blockquote' || tag === 'div') {
        for (const img of imgs) if (/^data:image\//.test(img.getAttribute('src') ?? '')) blocks.push({ type: 'image', dataUrl: img.getAttribute('src') });
        if (tag === 'div' && !textOf(el) && !imgs.length) walk(el);
        else if (textOf(el)) blocks.push({ type: 'text', text: textOf(el), md: inlineMd(el) });
      } else if (tag === 'img') {
        if (/^data:image\//.test(el.getAttribute('src') ?? '')) blocks.push({ type: 'image', dataUrl: el.getAttribute('src') });
      } else {
        walk(el);
      }
    }
  };
  walk(root);
  return blocks;
}

/**
 * Many documents have no heading styles at all, only paragraphs numbered like headings
 * ("一、", "（一）", "第一章"). Treat those as the headings they are meant to be.
 */
function promoteHeadings(blocks) {
  const styled = blocks.some((b) => b.type === 'heading');
  const out = blocks.map((b) => {
    if (b.type !== 'text') return b;
    const level = headingLevelOf(b.text);
    return level ? { type: 'heading', level: styled ? Math.min(6, level + 1) : level, text: b.text } : b;
  });
  // A short opening line is the title.
  const first = out[0];
  if (first?.type === 'text' && [...first.text].length <= 40 && !/[。；;，,！？!?]$/.test(first.text) && out.length > 1) out[0] = { type: 'heading', level: 0, text: first.text };
  return out;
}

function textToBlocks(text) {
  const blocks = [];
  const joinedText = (lines) => lines.reduce((joined, line) => {
    if (!joined) return line;
    const tight = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？；：、）】》」』]$/u.test(joined)
      && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？；：、（【《「『]/u.test(line);
    return joined + (tight ? '' : ' ') + line;
  }, '');
  for (const para of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let pending = [];
    const flush = () => { if (pending.length) blocks.push({ type: 'text', text: joinedText(pending) }); pending = []; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const md = /^(#{1,6})\s+(.+)$/.exec(line);
      const bullet = /^([-*•·]|\d{1,3}[.)）])\s+(.+)$/.exec(line);
      const numbered = !bullet && headingLevelOf(line);
      // Exported PDF/plain-text headings often have only one newline after them.
      const opening = !blocks.length && !pending.length && i === 0 && lines.length > 1 && [...line].length <= 40 && !/[。；;，,：:！？!?.]$/.test(line);
      const standalone = lines.length === 1 && [...line].length <= 30 && !/[。；;，,：:！？!?.]$/.test(line);
      if (md || numbered || (!bullet && (opening || standalone))) {
        flush();
        blocks.push({ type: 'heading', level: md ? md[1].length : numbered || 2, text: md ? md[2] : line });
      } else if (bullet) {
        flush();
        blocks.push({ type: 'bullet', text: bullet[2] });
      } else {
        // A line that already ends a sentence need not absorb the next paragraph. Wrapped
        // lines without final punctuation still join, including Chinese word boundaries.
        if (pending.length && /[。！？!?;；.]$/.test(pending[pending.length - 1])) flush();
        pending.push(line);
      }
    }
    flush();
  }
  return blocks;
}

/** The same heading/paragraph rules are shared by extracted PDF text and text files. */
export function outlineFromText(text, name = '文档') {
  return blocksToOutline(promoteHeadings(textToBlocks(String(text))), name);
}

function blocksToOutline(blocks, name) {
  if (!blocks.length) throw new Error('这个文档里没有内容');
  let title = name;
  if (blocks[0]?.type === 'heading') title = blocks.shift().text;
  const sections = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === 'heading') {
      cur = { title: b.text, blocks: [] };
      sections.push(cur);
    } else {
      if (!cur) { cur = { title, blocks: [] }; sections.push(cur); }
      cur.blocks.push(b);
    }
  }
  return { title, sections: sections.filter((s) => s.blocks.length || s.title !== title) };
}

/**
 * A document as titled sections for slides.
 * @returns {Promise<{ title: string, sections: Array<{ title: string, blocks: object[] }> }>}
 */
export async function outlineOf(file) {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file).replace(/\.[^.]+$/, '') || path.basename(file);
  let blocks;
  if (ext === '.docx') blocks = promoteHeadings(htmlToBlocks(await docxToHtml(file)));
  else if (ext === '.md' || ext === '.markdown') blocks = htmlToBlocks(marked.parse(readText(file), { gfm: true }));
  else blocks = promoteHeadings(textToBlocks(readText(file)));
  return blocksToOutline(blocks, name);
}
