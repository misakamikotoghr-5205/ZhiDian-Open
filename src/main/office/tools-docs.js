// Office actions, set "docs": quick things to do with documents and with files of any kind.
// Pack files into a ZIP, copy their names, count a Word document, export its pictures or its
// text, and have the local model list the main points of a document. The shape of an action is
// described at the top of tools-basic.js; the counting itself is in core/text-stats.js.
//
// A Word document is read with mammoth (its tree of paragraphs, tables and pictures) and, for
// the pictures as they are stored, with JSZip. A PDF is read through env.tools.openPdf.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { resultName } from '../../core/office-kinds.js';
import { countText, describeCount, grouped, unifyRadicals } from '../../core/text-stats.js';
import { readText } from './convert.js';

export const SUMMARY_CHARS = 4000; // as much of a document as the model is given
export const ZIP_LIMIT = 500 * 1024 * 1024; // everything is packed in memory
const HEAD_BYTES = 256 * 1024; // of a large text file, only this much is read for a summary
const SUMMARY_KINDS = new Set(['word', 'markdown', 'text', 'pdf']);
const PICTURES = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'svg', 'ico', 'emf', 'wmf']);
const NOT_A_DOCX = '可能已损坏、设了打开密码，或者不是真正的 .docx';

// Packing and listing work on everything selected, readable by the converters or not
// (ctx.all); a context made by hand may only have ctx.files.
const picked = (ctx) => ctx.all ?? ctx.files;
const several = (ctx) => ctx.kind === 'files' && picked(ctx).length >= 2;
const oneWord = (ctx) => ctx.kind === 'files' && ctx.files.length === 1 && ctx.files[0].kind === 'word';
const stemOf = (file) => file.name.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || '文档';

function checkStop(env) {
  if (env.signal?.aborted) throw new Error('已取消');
}

/** 812 字节, 3.4 KB, 120 KB, 2.5 MB */
export function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A name that is not in `taken` yet: "a.txt", then "a (2).txt", "a (3).txt". Names are compared
 * without regard to case, as Windows and macOS do; the name given out is added to `taken`.
 * @param {string} name
 * @param {Set<string>} taken
 */
export function uniqueName(name, taken) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** A name from inside an archive as a file name that every system accepts. */
function safeName(name) {
  let clean = String(name ?? '').replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').replace(/[. ]+$/, '').trim();
  if (!clean || clean === '.' || clean === '..') return '_';
  if (/^\.[A-Za-z0-9]{1,8}$/.test(clean)) clean = `_${clean}`;
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)) clean = `_${clean}`;
  return clean;
}

/** Unix line ends, no spaces at the ends of lines, at most one empty line in a row. */
const tidy = (text) => text.replace(/\r\n?/g, '\n').replace(/(?<![^\S\n])[^\S\n]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** A ZIP entry shows the time it is given as UTC: give it the file's local time under that name. */
const zipTime = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

/** Run `work` with a new folder to write into; if it fails, nothing of it is left behind. */
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

// ---------------------------------------------------------------- reading documents

/** A Word document as mammoth reads it: { buffer, tree }. */
async function readDocx(file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file.path);
  } catch {
    throw new Error(`读不了这个文件：${file.name}`);
  }
  let tree = null;
  try {
    // mammoth shows its document tree to a transform before it turns it into HTML. The tree is
    // taken there, and an empty document is handed back so that no HTML is built at all.
    await mammoth.convertToHtml({ buffer }, {
      transformDocument: (document) => {
        tree = document;
        return { ...document, children: [] };
      },
    });
  } catch {
    tree = null;
  }
  if (!tree) throw new Error(`打不开这个 Word 文档：${file.name}（${NOT_A_DOCX}）`);
  return { buffer, tree };
}

/**
 * The text of a Word document tree: a paragraph is a line, a line break inside a paragraph is
 * a line break, a tab is a tab. Empty paragraphs leave at most one empty line.
 * @param {object} tree
 * @param {{ tables?: 'rows' | 'cells' }} [o]  rows: a table row is one line, its cells
 *   separated by tabs (pastes into a spreadsheet); cells: every cell on a line of its own, so
 *   that nothing is counted which is not in the document
 * @returns {{ text: string, paragraphs: number, tables: number, pictures: number, numbered: number }}
 *   paragraphs: those with text, table cells included; numbered: of these, the ones Word
 *   numbers or bullets by itself (the number is not part of the text)
 */
export function docxText(tree, { tables = 'rows' } = {}) {
  const found = { paragraphs: 0, tables: 0, pictures: 0, numbered: 0 };
  const inside = (el) => (el.children ?? []).map(walk).join('');
  function walk(el) {
    switch (el.type) {
      case 'text':
        return el.value;
      case 'tab':
        return '\t';
      case 'break':
        return '\n';
      case 'image':
        found.pictures++;
        return '';
      case 'paragraph': {
        const text = inside(el);
        if (text.trim()) {
          found.paragraphs++;
          if (el.numbering) found.numbered++;
        }
        return text + '\n';
      }
      case 'table': {
        found.tables++;
        const rows = (el.children ?? []).filter((row) => row.type === 'tableRow').map((row) =>
          (row.children ?? []).filter((cell) => cell.type === 'tableCell').map((cell) => {
            const text = inside(cell).trim();
            return tables === 'rows' ? text.replace(/\s*[\n\t]\s*/g, ' ') : text;
          }));
        return rows.map((cells) => cells.join(tables === 'rows' ? '\t' : '\n')).join('\n') + '\n';
      }
      default:
        return inside(el);
    }
  }
  const text = tidy(inside(tree));
  return { text, ...found };
}

/** The beginning of a text file, decoded the way readText decodes: { text, whole }. */
function textHead(file) {
  if (fs.statSync(file).size <= HEAD_BYTES) return { text: readText(file), whole: true };
  const buf = Buffer.alloc(HEAD_BYTES);
  const fd = fs.openSync(file, 'r');
  let read = 0;
  try {
    read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
  } finally {
    fs.closeSync(fd);
  }
  const slice = buf.subarray(0, read);
  // stream: a character cut in half at the end of the piece is left out, not an error.
  const decode = (encoding, bytes, fatal = false) => new TextDecoder(encoding, { fatal }).decode(bytes, { stream: true });
  if (slice[0] === 0xff && slice[1] === 0xfe) return { text: decode('utf-16le', slice.subarray(2)), whole: false };
  if (slice[0] === 0xfe && slice[1] === 0xff) return { text: decode('utf-16be', slice.subarray(2)), whole: false };
  try {
    return { text: decode('utf-8', slice, true), whole: false };
  } catch {
    return { text: decode('gb18030', slice), whole: false };
  }
}

/**
 * The beginning of a document for the model: its first SUMMARY_CHARS characters, and whether
 * the document goes on after them. Of a PDF only as many pages are read as it takes.
 * @returns {Promise<{ text: string, more: boolean }>}
 */
async function documentHead(file, env) {
  let text = '';
  let whole = true;
  if (file.kind === 'pdf') {
    const pdf = await env.tools.openPdf(file.path);
    try {
      if (!pdf.pages) throw new Error('这个 PDF 里没有页面');
      for (let p = 1; p <= pdf.pages; p++) {
        checkStop(env);
        env.step(p - 1, pdf.pages, `第 ${p} 页`);
        // What a PDF gives back for 一, 人, 风 ... may be look-alike radical characters.
        const page = unifyRadicals(tidy(await pdf.text(p)));
        if (page) text += (text ? '\n' : '') + page;
        if (text.length > SUMMARY_CHARS * 2 && p < pdf.pages) {
          whole = false;
          break;
        }
      }
    } finally {
      await pdf.close();
    }
    if (!text) throw new Error('这个 PDF 里没有可以提取的文字（可能是扫描件）');
  } else if (file.kind === 'word') {
    text = docxText((await readDocx(file)).tree).text;
  } else {
    let head;
    try {
      head = textHead(file.path);
    } catch {
      throw new Error(`读不了这个文件：${file.name}`);
    }
    text = tidy(head.text);
    whole = head.whole;
  }
  if (!text) throw new Error('这个文档里没有文字');
  const chars = [...text.slice(0, SUMMARY_CHARS * 2 + 2)];
  const more = !whole || chars.length > SUMMARY_CHARS;
  return { text: more ? chars.slice(0, SUMMARY_CHARS).join('').trim() : text, more };
}

// ---------------------------------------------------------------- the actions

export const actions = [
  {
    id: 'word.count',
    label: '字数统计',
    hint: '数出正文的字数、字符、汉字、英文单词、段落、表格和图片',
    rank: 16,
    applies: oneWord,
    async run(ctx) {
      // Counted cell by cell: the tabs that would separate the cells of a row are not in the document.
      const doc = docxText((await readDocx(ctx.files[0])).tree, { tables: 'cells' });
      const counts = { ...countText(doc.text), paragraphs: doc.paragraphs };
      return { kind: 'info', message: [describeCount(counts, { lines: false }), `表格 ${grouped(doc.tables)}，图片 ${grouped(doc.pictures)}`, '只算正文，页眉、页脚、脚注和批注不在内'].join('\n') };
    },
  },
  {
    id: 'files.zip',
    label: '打包成 ZIP',
    hint: '把选中的文件压缩成一个 ZIP，放在第一个文件旁边',
    rank: 22,
    applies: several,
    async run(ctx, env) {
      const total = picked(ctx).length;
      // Refuse before anything is read: the archive is built in memory.
      const size = picked(ctx).reduce((sum, file) => {
        try {
          return sum + fs.statSync(file.path).size;
        } catch {
          return sum;
        }
      }, 0);
      if (size > ZIP_LIMIT) throw new Error(`这 ${total} 个文件一共 ${sizeText(size)}，超过了一次能打包的 ${sizeText(ZIP_LIMIT)}`);
      const zip = new JSZip();
      const taken = new Set();
      const packed = [];
      const unread = [];
      let before = 0;
      let renamed = 0;
      for (const [i, file] of picked(ctx).entries()) {
        checkStop(env);
        env.step(i, total, file.name);
        let data;
        let changed;
        try {
          data = fs.readFileSync(file.path);
          changed = fs.statSync(file.path).mtime;
        } catch {
          unread.push(file.name);
          continue;
        }
        // Flat: files from different folders may share a name.
        const name = uniqueName(file.name, taken);
        if (name !== file.name) renamed++;
        zip.file(name, data, { binary: true, date: zipTime(changed) });
        packed.push(file);
        before += data.length;
      }
      if (!packed.length) throw new Error('选中的文件一个也读不了');
      const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      checkStop(env);
      env.step(total, total, '');
      const out = env.save(resultName(packed, '', 'zip'), data);
      const saved = before > 0 ? Math.round((1 - data.length / before) * 100) : 0;
      const notes = [
        renamed ? `有 ${renamed} 个文件和别的文件重名，在包里的名字后面加了序号。` : '',
        unread.length ? `没能读取、没有放进去：${unread.join('、')}。` : '',
      ];
      return { kind: 'file', path: out, message: `把 ${packed.length} 个文件打包成了一个 ZIP：${sizeText(before)} → ${sizeText(data.length)}${saved >= 1 ? `（小了 ${saved}%）` : ''}。${notes.join('')}原文件没有改动。` };
    },
  },
  {
    id: 'doc.summary',
    label: '总结要点',
    hint: `让本地模型读文档的开头（最多 ${SUMMARY_CHARS} 字），列出 3 到 5 条要点`,
    rank: 24,
    applies: (ctx) => ctx.kind === 'files' && ctx.files.length === 1 && SUMMARY_KINDS.has(ctx.files[0].kind) && Boolean(ctx.has?.model),
    async run(ctx, env) {
      const file = ctx.files[0];
      const { text, more } = await documentHead(file, env);
      // The first line tells the model what it is looking at, and whether that is all of it.
      const task = more
        ? `下面是文档《${file.name}》开头的 ${SUMMARY_CHARS} 字（文档更长，后面的内容没有给你）。只根据这一部分，用 3 到 5 条简短的要点总结，每条一行，用文档本身的语言；最后另起一行写上“（只读了前 ${SUMMARY_CHARS} 字）”。`
        : `下面是文档《${file.name}》的全部文字。用 3 到 5 条简短的要点总结，每条一行，用文档本身的语言；只输出要点，不要开场白。`;
      return { kind: 'ask', question: `${task}\n\n${text}`, ...(more ? { note: `只读了前 ${SUMMARY_CHARS} 字` } : {}) };
    },
  },
  {
    id: 'word.text',
    label: '转成纯文本',
    hint: '只留文字，存成 txt：一段一行，表格一行一行',
    rank: 32,
    applies: oneWord,
    async run(ctx, env) {
      const doc = docxText((await readDocx(ctx.files[0])).tree);
      if (!doc.text) throw new Error('这个文档的正文里没有文字');
      const out = env.save(resultName(ctx.files, '', 'txt'), doc.text + '\n');
      const notes = [
        doc.tables ? `${doc.tables} 个表格按行导出，同一行的格子之间用制表符隔开。` : '',
        doc.numbered ? `有 ${doc.numbered} 段的自动编号或项目符号没有带过去。` : '',
        doc.pictures ? `${doc.pictures} 张图片没有带过去。` : '',
      ];
      return { kind: 'file', path: out, message: `导出了 ${grouped(doc.paragraphs)} 段文字，共 ${grouped(countText(doc.text).charsNoSpace)} 个字符（不计空格）。${notes.join('')}字体和版式没有保留，页眉、页脚和脚注不在内。` };
    },
  },
  {
    id: 'word.images',
    label: '导出图片',
    hint: '把文档里存的图片原样取出来，放进一个新文件夹',
    rank: 34,
    applies: oneWord,
    async run(ctx, env) {
      const file = ctx.files[0];
      let bytes;
      try {
        bytes = fs.readFileSync(file.path);
      } catch {
        throw new Error(`读不了这个文件：${file.name}`);
      }
      let zip;
      try {
        zip = await JSZip.loadAsync(bytes);
      } catch {
        throw new Error(`打不开这个 Word 文档：${file.name}（${NOT_A_DOCX}）`);
      }
      const media = Object.values(zip.files)
        .filter((entry) => !entry.dir && /^word\/media\/[^/\\]+$/.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      if (!media.length) throw new Error('这个文档里没有图片');
      return intoFolder(env, `${stemOf(file)} 图片`, async (write, dir) => {
        const taken = new Set();
        let size = 0;
        let pictures = 0;
        let vector = 0;
        for (const [i, entry] of media.entries()) {
          checkStop(env);
          const name = uniqueName(safeName(entry.name.slice('word/media/'.length)), taken);
          env.step(i, media.length, name);
          const data = await entry.async('nodebuffer');
          write(name, data);
          size += data.length;
          const ext = path.extname(name).slice(1).toLowerCase();
          if (PICTURES.has(ext)) pictures++;
          if (ext === 'emf' || ext === 'wmf') vector++;
        }
        env.step(media.length, media.length, '');
        const other = media.length - pictures;
        const what = other ? `${pictures} 张图片和 ${other} 个不是图片的文件（文档里嵌的音视频等）` : `${pictures} 张图片`;
        const note = vector ? `其中 ${vector} 个是 EMF/WMF 矢量图，一般的看图软件打不开。` : '';
        return { kind: 'folder', path: dir, message: `导出了 ${what}，共 ${sizeText(size)}：是文档里存的原件，没有重新压缩，文件名也是文档里的。${note}` };
      });
    },
  },
  {
    id: 'files.names',
    label: '复制文件名清单',
    hint: '把选中文件的名字复制下来，每行一个',
    rank: 60,
    applies: several,
    // No full stop at the end: the panel adds its own sentence about pasting.
    run: async (ctx) => ({ kind: 'clipboard', text: picked(ctx).map((file) => file.name).join('\n'), message: `复制了 ${picked(ctx).length} 个文件名，每行一个` }),
  },
];
