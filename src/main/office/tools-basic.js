// The first set of office actions: PDF, slides, Word, and tidying text.
//
// Every action in src/main/office/tools-*.js has the same shape:
//
//   {
//     id: 'pdf.split',                 unique, "<what it is about>.<what it does>"
//     label: '拆成单页',                 the button
//     hint: '每一页存成一个 PDF',         the tooltip: what will happen, in a few words
//     rank: 40,                        order of the buttons, lowest first (the first four show,
//                                      the rest sit behind "更多")
//     applies(ctx) -> boolean          is it worth offering for this selection? must be cheap
//     run(ctx, env) -> result          do it
//   }
//
// ctx  = { kind: 'files' | 'text', files: [{ path, name, ext, kind }], text: string,
//          has: { office: boolean, model: boolean } }
//        `files` holds only files that can be read (see core/office-kinds.js for the kinds).
// env  = { save(name, data) -> path          write next to the originals, never over a file
//          folder(name) -> path              a new folder next to the originals, for many results
//          step(done, total, name)           progress
//          signal                            AbortSignal
//          tools: { openPdf, decodeImage, htmlToPdf, documentPdf, officeConvert, canvas, ... } }
// result is one of
//   { kind: 'file', path, message }          one file was written
//   { kind: 'folder', path, message }        several files were written into this folder
//   { kind: 'clipboard', text, message }     put this on the clipboard
//   { kind: 'info', message, copy? }         nothing was written: just tell (and offer to copy)
//   { kind: 'ask', question, images? }       a job for the local model; images are file paths
//
// Modules import nothing from Electron: what needs a browser engine comes in through env.tools,
// so every action can be unit-tested with plain Node.
import fs from 'node:fs';
import { resultName } from '../../core/office-kinds.js';
import { describeTypeset, typeset } from '../../core/typeset.js';
import { unifyRadicals } from '../../core/text-stats.js';
import { docxToMarkdown, outlineOf, readText } from './convert.js';
import { filesToPdf } from './pdf.js';
import { filesToPptx } from './pptx.js';
import { describeRestyle, restyleDocx } from './restyle.js';
import path from 'node:path';

const skippedNote = (skipped) => (skipped.length ? ` 没能处理：${skipped.map((s) => `${s.name}（${s.why}）`).join('；')}。` : '');
const only = (ctx, kind) => ctx.kind === 'files' && ctx.files.length === 1 && ctx.files[0].kind === kind;
const SLIDE_KINDS = new Set(['pdf', 'image', 'word', 'markdown', 'text']);
const hasText = (ctx) => ctx.kind === 'text' && ctx.text.trim().length >= 2;
const MODEL_TEXT_LIMIT = 6000;

function modelSnippet(text) {
  const chars = [...unifyRadicals(text.trim())];
  return chars.length > MODEL_TEXT_LIMIT ? { text: chars.slice(0, MODEL_TEXT_LIMIT).join('').trim(), cut: true } : { text: chars.join(''), cut: false };
}

export const actions = [
  {
    id: 'files.pdf',
    label: '合并成 PDF',
    labelFor: (ctx) => (ctx.files.length > 1 ? '合并成 PDF' : '转成 PDF'),
    hint: '多个文件按选中的顺序合成一个 PDF；单个文件生成同名的 PDF',
    rank: 10,
    applies: (ctx) => ctx.kind === 'files' && ctx.files.length > 0 && !only(ctx, 'pdf') && !only(ctx, 'sheet'),
    async run(ctx, env) {
      let viaOffice = 0;
      const documentPdf = async (file) => {
        const r = await env.tools.documentPdf(file);
        if (r.viaOffice) viaOffice++;
        return r.buffer;
      };
      const r = await filesToPdf(ctx.files, { documentPdf, decodeImage: env.tools.decodeImage }, env.step, env.signal);
      const out = env.save(resultName(ctx.files, ctx.files.length > 1 ? ' 合并' : '', 'pdf'), r.buffer);
      const usedSet = new Set(r.used);
      const how = ctx.files.some((f) => f.kind === 'word' && usedSet.has(f.name)) ? (viaOffice ? '（Word 文档用 LibreOffice 转换，版式照原样）' : '（Word 文档按标准版式重排，复杂版面可能和原件不同）') : '';
      return { kind: 'file', path: out, message: `${r.used.length > 1 ? `合并了 ${r.used.length} 个文件` : '已转成 PDF'}，共 ${r.pages} 页${how}。${skippedNote(r.skipped)}` };
    },
  },
  {
    id: 'files.pptx',
    label: '做成 PPT',
    hint: '读取 PDF、Word 和文本，按标题填入可编辑模板；长表格自动分页',
    rank: 20,
    applies: (ctx) => ctx.kind === 'files' && ctx.files.some((f) => SLIDE_KINDS.has(f.kind)),
    async run(ctx, env) {
      const usable = ctx.files.filter((f) => SLIDE_KINDS.has(f.kind));
      // Several files: the deck is named after the folder they are in.
      const r = await filesToPptx(usable, { outlineOf, openPdf: env.tools.openPdf, decodeImage: env.tools.decodeImage }, { title: usable.length > 1 ? path.basename(path.dirname(usable[0].path)) : '', signal: env.signal, template: env.template }, env.step);
      const out = env.save(resultName(usable, usable.length > 1 ? ' 演示' : '', 'pptx'), r.buffer);
      const pdfNote = r.pdfTextPages ? `${r.pdfTextPages} 页 PDF 文字已填入可编辑模板，未保留原版式和图片。` : '';
      const warningNote = r.warnings.length ? `注意：${r.warnings.slice(0, 3).map((w) => `${w.name} 第 ${w.page} 页：${w.why}`).join('；')}。${r.warnings.length > 3 ? `另有 ${r.warnings.length - 3} 页同类提示，详见对应幻灯片及备注。` : ''}` : '';
      return { kind: 'file', path: out, message: `做成了 ${r.slides} 张幻灯片。${pdfNote}${r.paginatedTables ? `${r.paginatedTables} 个长表格已分页，表头重复显示。` : ''}${r.shortened ? `有 ${r.shortened} 处内容在幻灯片上做了节选，完整内容在该页的备注里。` : ''}${warningNote}${skippedNote(r.skipped)}` };
    },
  },
  {
    id: 'word.restyle',
    label: '一键排版',
    hint: '统一字体、字号、行距和缩进，另存一份',
    rank: 12,
    applies: (ctx) => only(ctx, 'word'),
    async run(ctx, env) {
      const r = await restyleDocx(fs.readFileSync(ctx.files[0].path), { template: env.template });
      return { kind: 'file', path: env.save(resultName(ctx.files, '（已排版）', 'docx'), r.buffer), message: describeRestyle(r.counts, { template: env.template }) };
    },
  },
  {
    id: 'word.markdown',
    label: '转成 Markdown',
    hint: '导出文字和标题结构',
    rank: 30,
    applies: (ctx) => only(ctx, 'word'),
    async run(ctx, env) {
      return { kind: 'file', path: env.save(resultName(ctx.files, '', 'md'), await docxToMarkdown(ctx.files[0].path)), message: '已导出标题、正文、列表和表格。图片没有带过去，原处留了标记。' };
    },
  },
  {
    id: 'pdf.text',
    label: '提取文字',
    hint: '把 PDF 里的文字存成 txt',
    rank: 30,
    applies: (ctx) => only(ctx, 'pdf'),
    async run(ctx, env) {
      const pdf = await env.tools.openPdf(ctx.files[0].path);
      try {
        if (!pdf.pages) throw new Error('这个 PDF 里没有页面');
        const parts = [];
        for (let p = 1; p <= pdf.pages; p++) {
          if (env.signal?.aborted) throw new Error('已取消');
          env.step(p - 1, pdf.pages, `第 ${p} 页`);
          // (PDFs made with some CJK fonts give back radical look-alikes for common characters.)
          parts.push(unifyRadicals((await pdf.text(p)).trim()));
        }
        const text = parts.join('\n\n').trim();
        if (!text) throw new Error('这个 PDF 里没有可以提取的文字（可能是扫描件）');
        return { kind: 'file', path: env.save(resultName(ctx.files, '', 'txt'), text + '\n'), message: `提取了 ${pdf.pages} 页的文字，共 ${[...text].length} 字。` };
      } finally {
        await pdf.close();
      }
    },
  },
  {
    id: 'file.typeset',
    label: '自动排版',
    hint: '理顺空格、标点和断行，另存一份',
    rank: 8,
    applies: (ctx) => only(ctx, 'text'),
    async run(ctx, env) {
      const raw = readText(ctx.files[0].path);
      if (!raw.trim()) throw new Error('这个文件是空的，没有可以排版的文字');
      const r = typeset(raw);
      return { kind: 'file', path: env.save(resultName(ctx.files, '（已排版）', ctx.files[0].ext || 'txt'), r.text + '\n'), message: describeTypeset(r.changes) + '。原文件没有改动。' };
    },
  },
  {
    id: 'text.typeset',
    label: '自动排版',
    hint: '理顺空格、标点和断行，不改一个字',
    rank: 10,
    applies: hasText,
    async run(ctx) {
      const r = typeset(ctx.text);
      return { kind: 'clipboard', text: r.text, message: describeTypeset(r.changes) };
    },
  },
  {
    id: 'text.explain',
    label: '解释一下',
    hint: '让本地模型讲讲这段话',
    rank: 20,
    applies: (ctx) => hasText(ctx) && Boolean(ctx.has?.model),
    async run(ctx) {
      const { text, cut } = modelSnippet(ctx.text);
      return { kind: 'ask', question: `用户选中了下面这段文字，请用几句话讲清楚它的意思，先说结论：\n\n${text}`, ...(cut ? { note: `只处理了前 ${MODEL_TEXT_LIMIT} 字` } : {}) };
    },
  },
  {
    id: 'text.translate',
    label: '翻译',
    hint: '默认中英互译，也可选择译成日、韩、法、德文；译完自动复制到剪贴板',
    rank: 30,
    autoCopy: true,
    param: {
      kind: 'select',
      label: '译成',
      default: 'auto',
      options: [
        { value: 'auto', label: '自动（中英互译）' },
        { value: 'zh', label: '简体中文' },
        { value: 'en', label: '英文 (English)' },
        { value: 'ja', label: '日文 (日本語)' },
        { value: 'ko', label: '韩文 (한국어)' },
        { value: 'fr', label: '法文 (Français)' },
        { value: 'de', label: '德文 (Deutsch)' },
      ],
    },
    applies: (ctx) => hasText(ctx) && Boolean(ctx.has?.model),
    async run(ctx, env) {
      const { text, cut } = modelSnippet(ctx.text);
      const TARGETS = {
        zh: '简体中文',
        en: '英文（English）',
        ja: '日文（日本語）',
        ko: '韩文（한국어）',
        fr: '法文（Français）',
        de: '德文（Deutsch）',
      };
      const targetName = TARGETS[String(env?.param ?? 'auto')];
      const prompt = targetName
        ? `把下面这段文字准确翻译成${targetName}。只输出译文，不要解释：\n\n${text}`
        : `把下面这段文字翻译出来：原文是中文就译成英文，是其他语言就译成中文。只输出译文：\n\n${text}`;
      return { kind: 'ask', question: prompt, autoCopy: true, ...(cut ? { note: `只处理了前 ${MODEL_TEXT_LIMIT} 字` } : {}) };
    },
  },
];
