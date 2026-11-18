// Office actions: what can be done with the files or the text the person has selected, and
// doing it. Everything runs on this machine; results are written next to the originals (never
// over them) or put on the clipboard. The actions themselves live in tools-*.js; this file
// gathers them and gives them what they need.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeFiles, summarize } from '../../core/office-kinds.js';
import { fileToHtml } from './convert.js';
import { actions as basic } from './tools-basic.js';
import { actions as docs } from './tools-docs.js';
import { actions as image } from './tools-image.js';
import { actions as pdf } from './tools-pdf.js';
import { actions as sheet } from './tools-sheet.js';
import { actions as text } from './tools-text.js';
import { documentTheme } from '../../core/document-themes.js';
import { officeActionAllowed } from './policy.js';

export const ACTIONS = [...basic, ...pdf, ...image, ...sheet, ...text, ...docs];

let officeBinary; // undefined: not looked for yet; null: not installed

/** LibreOffice, if this machine has it: it reads formats the built-in converters do not. */
export function findOffice() {
  if (officeBinary !== undefined) return officeBinary;
  const names = process.platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice'];
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/Applications/LibreOffice.app/Contents/MacOS',
    'C:\\Program Files\\LibreOffice\\program',
    'C:\\Program Files (x86)\\LibreOffice\\program',
    '/usr/lib/libreoffice/program',
    '/opt/libreoffice/program',
  ];
  officeBinary = null;
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir && path.join(dir, name);
      if (candidate && fs.existsSync(candidate)) {
        officeBinary = candidate;
        return officeBinary;
      }
    }
  }
  return officeBinary;
}

/**
 * Convert with LibreOffice into a temporary folder.
 * @param {string} file
 * @param {string} format   "pdf", "docx", "csv" ... or "docx:MS Word 2007 XML" (format:filter)
 * @param {{ signal?: AbortSignal, inFilter?: string }} [o]
 * @returns {Promise<{ path: string, cleanup(): void }>}
 */
export function officeConvert(file, format, { signal, inFilter } = {}) {
  const bin = findOffice();
  if (!bin) return Promise.reject(new Error('需要安装 LibreOffice 才能读这种文件'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-lo-'));
  // Its own profile folder, so a LibreOffice the person has open is neither needed nor disturbed.
  const profile = 'file:///' + path.join(outDir, 'profile').replace(/\\/g, '/').replace(/^\//, '');
  const args = [`-env:UserInstallation=${profile}`, '--headless', '--norestore', ...(inFilter ? [`--infilter=${inFilter}`] : []), '--convert-to', format, '--outdir', outDir, file];
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 180_000, windowsHide: true, signal }, (err) => {
      const made = fs.readdirSync(outDir).find((n) => n.toLowerCase().endsWith('.' + format.split(':')[0]));
      if (made) resolve({ path: path.join(outDir, made), cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }) });
      else {
        fs.rmSync(outDir, { recursive: true, force: true });
        reject(new Error(err?.killed ? 'LibreOffice 转换超时' : 'LibreOffice 没能转换这个文件'));
      }
    });
  });
}

function clean(name, fallback = '结果') {
  let s = [...String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '').trim()].slice(0, 120).join('').replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') s = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s;
}

/** A path in `dir` that does not exist yet: "name.pdf", "name (2).pdf", ... */
export function freePath(dir, name) {
  const str = String(name ?? '');
  const ext = path.extname(str) || (/^\.[A-Za-z0-9]{1,8}$/.test(str) ? str : '');
  const rawStem = ext === str ? '' : str.slice(0, str.length - ext.length);
  const stem = clean(rawStem, '结果');
  const safeExt = ext ? '.' + clean(ext.slice(1), 'out') : '';
  for (let i = 1; i < 500; i++) {
    const candidate = path.join(dir, i === 1 ? `${stem}${safeExt}` : `${stem} (${i})${safeExt}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${safeExt}`);
}

/** Where results go: beside the first input, or the documents folder if that is not writable. */
function outputDir(files, fallback) {
  const dir = files.length ? path.dirname(files[0].path) : fallback;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function usesModel(action, ctx) {
  if (!ctx.has?.model) return false;
  try {
    return !action.applies({ ...ctx, has: { ...ctx.has, model: false } });
  } catch {
    return false;
  }
}

export class Office {
  /**
   * @param {object} o
   * @param {string} o.documentsDir
   * @param {object} o.tools   what needs a browser engine: { openPdf, decodeImage, htmlToPdf, canvas }
   * @param {object[]} [o.actions]
   */
  constructor({ documentsDir, tools = {}, actions = ACTIONS, getTier = null }) {
    this.fallbackDir = path.join(documentsDir, 'Zhidian');
    this.actions = actions;
    this.tools = tools;
    this.getTier = getTier;
  }

  capabilities() {
    return { office: Boolean(findOffice()) };
  }

  /** Turn raw paths or text into a context, or null if there is nothing to act on. */
  context({ files, text }) {
    const list = describeFiles((files ?? []).filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }));
    if (list.length) return { kind: 'files', files: list };
    const t = String(text ?? '');
    if (t.trim().length >= 2) {
      const cut = t.length > 200_000 ? t.slice(0, t.charCodeAt(199_999) >= 0xd800 && t.charCodeAt(199_999) <= 0xdbff ? 199_999 : 200_000) : t;
      return { kind: 'text', text: cut };
    }
    return null;
  }

  /** The context as the actions see it: only readable files, and what this machine has. */
  #ctx(context, has = {}) {
    const caps = { model: true, ...this.capabilities(), ...has };
    const all = context.kind === 'files' ? context.files : [];
    const files = all.filter((f) => f.kind !== 'other' && (f.kind !== 'office' || caps.office));
    // `files`: what the converters can read. `all`: everything selected, for actions that do
    // not look inside (packing, listing names).
    return { kind: context.kind, files, all, text: context.kind === 'text' ? context.text : '', has: caps };
  }

  /** The actions to offer, most likely first: [{ id, label, hint }]. */
  offers(context, has = {}) {
    if (!context) return [];
    const ctx = this.#ctx(context, has);
    if (ctx.kind === 'files' && !ctx.all.length) return [];
    const rank = (a) => a.rankFor?.(ctx) ?? a.rank;
    return this.actions
      .filter((a) => {
        try {
          return (!this.getTier || officeActionAllowed(a.id, this.getTier())) && a.applies(ctx);
        } catch {
          return false;
        }
      })
      .sort((a, b) => rank(a) - rank(b))
      // An action that is only offered when a model is there is a job for the model: what is
      // selected is given to it, where every other action is a program on this computer.
      .map((a) => ({
        id: a.id,
        label: a.labelFor?.(ctx) ?? a.label,
        hint: a.hint,
        usesModel: usesModel(a, ctx),
        ...(a.param ? { param: typeof a.param === 'function' ? a.param(ctx) : a.param } : {}),
        ...(a.autoCopy ? { autoCopy: true } : {}),
      }));
  }

  summary(context) {
    return summarize(context);
  }

  async run(id, context, { onProgress, signal, has, param, template } = {}) {
    const ctx = this.#ctx(context, has);
    const action = this.actions.find((a) => a.id === id);
    if (!action || (this.getTier && !officeActionAllowed(id, this.getTier())) || !action.applies(ctx)) throw new Error('这个动作不适用于当前模型档位或选中的内容');
    const dir = outputDir(ctx.all.length ? ctx.all : ctx.files, this.fallbackDir);
    const office = ctx.has.office;
    const env = {
      signal,
      param,
      template: documentTheme(template).id,
      step: (done, total, name) => onProgress?.({ done, total, name }),
      save: (name, data) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const file = freePath(dir, name);
          try {
            fs.writeFileSync(file, data, { flag: 'wx' });
            return file;
          } catch (err) {
            if (err?.code !== 'EEXIST') throw err;
          }
        }
        const file = path.join(dir, `${clean(name)}-${Date.now()}`);
        fs.writeFileSync(file, data, { flag: 'wx' });
        return file;
      },
      folder: (name) => {
        // (Not freePath: a folder name has no extension, whatever dots it contains.)
        const stem = clean(name, '新建文件夹');
        let made = path.join(dir, stem);
        for (let i = 2; fs.existsSync(made) && i < 500; i++) made = path.join(dir, `${stem} (${i})`);
        if (fs.existsSync(made)) made = path.join(dir, `${stem}-${Date.now()}`);
        fs.mkdirSync(made);
        return made;
      },
      tools: {
        ...this.tools,
        hasOffice: office,
        officeConvert: (file, format, o = {}) => officeConvert(file, format, { signal, ...o }),
        // One document to PDF bytes: with LibreOffice when there is one (it keeps the layout),
        // otherwise the built-in way (text, tables and pictures in a clean standard layout).
        documentPdf: async (file) => {
          if (office && (file.kind === 'office' || file.kind === 'word' || file.kind === 'sheet')) {
            const made = await officeConvert(file.path, 'pdf', { signal });
            try {
              return { buffer: fs.readFileSync(made.path), viaOffice: true };
            } finally {
              made.cleanup();
            }
          }
          if (file.kind === 'office') throw new Error('需要安装 LibreOffice 才能把这种文件转成 PDF');
          const { html, baseDir } = await fileToHtml(file.path, { template });
          return { buffer: await this.tools.htmlToPdf(html, { baseDir, template, title: file.name.replace(/\.[^.]+$/, '') }), viaOffice: false };
        },
      },
    };
    return action.run(ctx, env);
  }
}
