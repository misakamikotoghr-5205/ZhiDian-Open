// Office actions, set "sheet": tables (.csv, .tsv, .xlsx). A CSV into an Excel workbook, a
// workbook into CSV, a table onto the clipboard as Markdown, several tables into one workbook.
// The shape of an action is described at the top of tools-basic.js.
//
// The formats themselves are read and written in sheet.js; here the files are opened, the
// results are named and saved, and the person is told what was done. Only values travel:
// text, numbers, and for a formula the result that was saved with it. Fonts, colours, merged
// cells and formulas stay in the original, which is never changed.
import fs from 'node:fs';
import path from 'node:path';
import { resultName } from '../../core/office-kinds.js';
import { readText } from './convert.js';
import { MAX_COLS, MAX_ROWS, MAX_CELL_CHARS, clipCells, detectDelimiter, fitTable, numberStats, parseCsv, readXlsx, toCsv, toMarkdownTable, writeXlsx } from './sheet.js';

export const MARKDOWN_ROWS = 200; // the most rows a table on the clipboard gets
const MAX_BYTES = 100 * 1024 * 1024; // of a file: it is read into memory whole, and its cells take several times that
const MAX_CSV_CELLS = 50_000_000; // rows times columns of one CSV: more is not written
const STACKED = '合并'; // the sheet that holds all the rows of a merge
const SOURCE = '来源'; // its last column
const DELIMITERS = { ',': '逗号', '\t': '制表符', ';': '分号' };

const isSheet = (f) => f.kind === 'sheet';
const isBook = (f) => f.ext === 'xlsx';
const oneSheet = (ctx) => ctx.kind === 'files' && ctx.files.length === 1 && isSheet(ctx.files[0]);
const stemOf = (file) => file.name.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || '表格';
const blank = (row) => row.every((v) => v === '' || v == null);
const sum = (list, key) => list.reduce((n, item) => n + (item[key] ?? 0), 0);

function checkStop(env) {
  if (env.signal?.aborted) throw new Error('已取消');
}

/**
 * What a sheet file holds: its tables that have something in them, { name, rows, cols, ... },
 * rows without the empty ones at the end. A text file is one table; of a workbook the hidden
 * sheets are left out (`hidden` says how many) and so are the empty ones (`blank`).
 */
async function load(file) {
  let size;
  try {
    size = fs.statSync(file.path).size;
  } catch {
    throw new Error(`读不了这个文件：${file.name}`);
  }
  if (size > MAX_BYTES) throw new Error(`这个文件有 ${Math.round(size / 1024 / 1024)} MB，太大了，这里处理不了`);
  if (isBook(file)) {
    let bytes;
    try {
      bytes = fs.readFileSync(file.path);
    } catch {
      throw new Error(`读不了这个文件：${file.name}`);
    }
    const all = await readXlsx(bytes);
    const shown = all.filter((s) => !s.hidden);
    const sheets = shown.map((s) => ({ ...s, ...fitTable(s.rows) })).filter((s) => s.rows.length);
    return { sheets, hidden: all.length - shown.length, blank: shown.length - sheets.length };
  }
  let text;
  try {
    text = readText(file.path);
  } catch {
    throw new Error(`读不了这个文件：${file.name}`);
  }
  const delimiter = file.ext === 'tsv' ? '\t' : detectDelimiter(text);
  const table = fitTable(parseCsv(text, delimiter));
  // A character that no encoding tried could make sense of is read as U+FFFD.
  return { sheets: table.rows.length ? [{ name: stemOf(file), ...table, dates: 0, formulas: 0, uncached: 0, formatted: 0 }] : [], hidden: 0, blank: 0, delimiter, garbled: text.includes('\ufffd') };
}

/** "另有 1 张空表、2 张隐藏的表没有…" for the sheets of a workbook that were passed over. */
function passedOver(loaded, verb) {
  const parts = [loaded.blank ? `${loaded.blank} 张空表` : '', loaded.hidden ? `${loaded.hidden} 张隐藏的表` : ''].filter(Boolean);
  return parts.length ? `另有 ${parts.join('、')}没有${verb}。` : '';
}

/**
 * What became of the cells that are more than plain values, in sheets read from a workbook.
 * @param {string} carried  "导出的" / "带过来的"
 */
function valueNotes(sheets, carried) {
  const formulas = sum(sheets, 'formulas'), uncached = sum(sheets, 'uncached'), dates = sum(sheets, 'dates'), formatted = sum(sheets, 'formatted');
  const notes = [
    formulas ? `${formulas} 个公式单元格${carried}是算好的结果${uncached ? `（其中 ${uncached} 个在文件里没有存结果，是空的）` : ''}` : '',
    dates ? `${dates} 个日期、时间单元格写成“2024-03-05 14:30:00”这种样子的文字` : '',
    formatted ? `${formatted} 个带显示格式的数字（千分位、百分号、货币符号之类）${carried}是原值` : '',
  ].filter(Boolean);
  return notes.length ? `${notes.join('；')}。` : '';
}

/** Which cells of a table became numbers in the workbook, and which digits stayed text. */
function numberNote(rows) {
  const { numbers, kept } = numberStats(rows);
  const keptNote = `${kept} 个以 0 开头或超过 15 位的数字（编号、证件号、银行卡号之类）保留为文本，一位不少`;
  if (numbers && kept) return `${numbers} 个单元格是数字，写成了数值；${keptNote}；其余（包括日期）是文本。`;
  if (numbers) return `${numbers} 个单元格是数字，写成了数值，其余（包括日期）是文本。`;
  if (kept) return `${keptNote}；其余也都是文本。`;
  return '所有单元格都是文本。';
}

const clippedNote = (clipped) => (clipped ? `有 ${clipped} 个单元格的文字超过 Excel 每格 ${MAX_CELL_CHARS} 字的上限，只留了前 ${MAX_CELL_CHARS} 字。` : '');
const GARBLED = '有些字符认不出来，显示成了“\ufffd”：这个文件可能不是 UTF-8 或 GBK 编码。';

/** Names for files made from sheet names: nothing a file system refuses, no two alike. */
export function fileNames(names) {
  const taken = new Set();
  return names.map((raw, i) => {
    let base = String(raw ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
    base = [...base].slice(0, 80).join('') || `表${i + 1}`;
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`; // names Windows keeps for devices
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base} (${k})`;
    taken.add(name.toLowerCase());
    return name;
  });
}

/** "销售（120 行）、成本（45 行）", the first eight and how many there are. */
function listSheets(sheets) {
  const shown = sheets.slice(0, 8).map((s) => `${s.name}（${s.rows.length} 行）`).join('、');
  return sheets.length > 8 ? `${shown} 等 ${sheets.length} 张` : shown;
}

/** A table as the bytes of a CSV file that Excel opens without garbling: UTF-8 with a mark. */
function csvBytes(sheet) {
  const tooLarge = `“${sheet.name}”这张表占了 ${sheet.rows.length} 行 × ${sheet.cols} 列，太大了，这里转不了`;
  if (sheet.rows.length * sheet.cols > MAX_CSV_CELLS) throw new Error(tooLarge);
  try {
    return Buffer.from(toCsv(sheet.rows, { bom: true, width: sheet.cols }), 'utf8');
  } catch (err) {
    // Longer than a string can be.
    throw err instanceof RangeError ? new Error(tooLarge) : err;
  }
}

/**
 * Many results into a new folder next to the original. If the work fails part-way, what it
 * wrote is taken away again, so no half-finished folder is left behind.
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

/** The name of a sheet in a merged workbook: the file, and the sheet when the file has several. */
function tabName(file, sheet, several) {
  const stem = stemOf(file);
  if (!several) return stem;
  // Room for the sheet's own name within the 31 characters Excel allows, without splitting a surrogate pair.
  const room = Math.max(8, 30 - sheet.name.length);
  const cut = stem.length > room ? stem.slice(0, stem.charCodeAt(room - 1) >= 0xd800 && stem.charCodeAt(room - 1) <= 0xdbff ? room - 1 : room).trim() : stem;
  return `${cut}-${sheet.name}`;
}

/** The first row of a table as a header: its cells trimmed, without the empty ones at the end. */
function headerOf(sheet) {
  const cells = sheet.rows[0].map((v) => String(v ?? '').trim());
  while (cells.length && !cells.at(-1)) cells.pop();
  return cells;
}

export const actions = [
  {
    id: 'sheet.xlsx',
    label: '转成 Excel',
    hint: '另存一份 .xlsx：数字写成数值，以 0 开头的编号和超过 15 位的长数字保留为文本，首行加粗并冻结',
    rank: 10,
    applies: (ctx) => oneSheet(ctx) && !isBook(ctx.files[0]),
    async run(ctx, env) {
      const file = ctx.files[0];
      const loaded = await load(file);
      const sheet = loaded.sheets[0];
      if (!sheet) throw new Error('这个文件是空的，没有可以转的内容');
      if (sheet.rows.length > MAX_ROWS) throw new Error(`这个表有 ${sheet.rows.length} 行，超过了 Excel 一张表最多 ${MAX_ROWS} 行的上限，转不了`);
      if (sheet.cols > MAX_COLS) throw new Error(`这个表有 ${sheet.cols} 列，超过了 Excel 一张表最多 ${MAX_COLS} 列的上限，转不了`);
      checkStop(env);
      const { rows, clipped } = clipCells(sheet.rows);
      const data = await writeXlsx([{ name: sheet.name, rows }], { template: env.template });
      checkStop(env);
      const out = env.save(resultName(ctx.files, '', 'xlsx'), data);
      const split = sheet.cols > 1 ? `（按${DELIMITERS[loaded.delimiter] ?? `“${loaded.delimiter}”`}分列）` : '';
      return { kind: 'file', path: out, message: `已转成 Excel：${rows.length} 行 × ${sheet.cols} 列${split}，首行加粗并冻结。${numberNote(rows)}${clippedNote(clipped)}${loaded.garbled ? GARBLED : ''}` };
    },
  },
  {
    id: 'sheet.csv',
    label: '转成 CSV',
    hint: '另存成 UTF-8 的 CSV（公式存结果）；有多张表时每张一个文件，放进一个新文件夹',
    rank: 10,
    applies: (ctx) => oneSheet(ctx) && isBook(ctx.files[0]),
    async run(ctx, env) {
      const file = ctx.files[0];
      const loaded = await load(file);
      const sheets = loaded.sheets;
      if (!sheets.length) throw new Error(`这个工作簿里没有数据${loaded.hidden ? `（${loaded.hidden} 张隐藏的表没有读）` : ''}`);
      checkStop(env);
      const encoding = 'UTF-8 编码，带 BOM，Excel 直接打开不乱码';
      if (sheets.length === 1) {
        const sheet = sheets[0];
        const data = csvBytes(sheet);
        const out = env.save(resultName(ctx.files, '', 'csv'), data);
        const which = loaded.blank || loaded.hidden ? `已把“${sheet.name}”这张表转成 CSV` : '已转成 CSV';
        return { kind: 'file', path: out, message: `${which}：${sheet.rows.length} 行 × ${sheet.cols} 列（${encoding}）。${valueNotes(sheets, '导出的')}${passedOver(loaded, '导出')}` };
      }
      const names = fileNames(sheets.map((s) => s.name));
      return intoFolder(env, `${stemOf(file)} CSV`, async (write, dir) => {
        for (const [i, sheet] of sheets.entries()) {
          checkStop(env);
          env.step(i, sheets.length, sheet.name);
          write(`${names[i]}.csv`, csvBytes(sheet));
        }
        env.step(sheets.length, sheets.length, '');
        return {
          kind: 'folder',
          path: dir,
          message: `这个工作簿有 ${sheets.length} 张有数据的表，每张存成了一个 CSV，放在一个新文件夹里：${listSheets(sheets)}（${encoding}）。${valueNotes(sheets, '导出的')}${passedOver(loaded, '导出')}`,
        };
      });
    },
  },
  {
    id: 'sheet.markdown',
    label: '复制为 Markdown 表格',
    hint: `把第一张表做成 Markdown 表格放到剪贴板，第一行当表头，最多 ${MARKDOWN_ROWS} 行`,
    rank: 20,
    applies: oneSheet,
    async run(ctx) {
      const file = ctx.files[0];
      const loaded = await load(file);
      const sheet = loaded.sheets[0];
      if (!sheet) throw new Error(isBook(file) ? '这个工作簿里没有数据' : '这个文件是空的');
      // The table starts at its first row with something in it: that row is the header.
      const body = sheet.rows.slice(sheet.rows.findIndex((row) => !blank(row)));
      const used = fitTable(body.slice(0, MARKDOWN_ROWS));
      const text = toMarkdownTable(used.rows.map((row) => row.slice(0, used.cols)));
      const which = isBook(file) && loaded.sheets.length + loaded.blank + loaded.hidden > 1 ? `“${sheet.name}”这张表` : '这张表';
      const others = loaded.sheets.length > 1 ? `；工作簿里另外 ${loaded.sheets.length - 1} 张有数据的表没有取` : '';
      // (No full stop at the end: the app adds what to do with the clipboard.)
      if (body.length > MARKDOWN_ROWS) return { kind: 'clipboard', text, message: `${which}有 ${body.length} 行，只取了前 ${MARKDOWN_ROWS} 行做成 Markdown 表格（第一行是表头），共 ${used.cols} 列${others}` };
      return { kind: 'clipboard', text, message: `已把${which}做成 Markdown 表格：${used.rows.length} 行 × ${used.cols} 列，第一行是表头${others}` };
    },
  },
  {
    id: 'sheets.merge',
    label: '合并成一个 Excel',
    hint: '每张表在新工作簿里各占一个工作表；表头都相同时，再把所有行叠成一张“合并”表',
    rank: 9,
    applies: (ctx) => ctx.kind === 'files' && ctx.files.length >= 2 && ctx.files.every(isSheet),
    async run(ctx, env) {
      const parts = []; // { file, sheet, several }
      const skipped = [];
      let hidden = 0;
      let fromBooks = false;
      for (const [i, file] of ctx.files.entries()) {
        checkStop(env);
        env.step(i, ctx.files.length, file.name);
        try {
          const loaded = await load(file);
          const fits = loaded.sheets.filter((s) => s.rows.length <= MAX_ROWS && s.cols <= MAX_COLS);
          if (!loaded.sheets.length) skipped.push({ name: file.name, why: '里面没有数据' });
          else if (fits.length < loaded.sheets.length) skipped.push({ name: file.name, why: `超过了 Excel 一张表 ${MAX_ROWS} 行 × ${MAX_COLS} 列的上限` });
          else {
            for (const sheet of fits) parts.push({ file, sheet, several: fits.length > 1 });
            hidden += loaded.hidden;
            fromBooks ||= isBook(file);
          }
        } catch (err) {
          skipped.push({ name: file.name, why: String(err?.message ?? err).replace(/[。.]$/, '') });
        }
      }
      const skippedNote = skipped.length ? `没能处理：${skipped.map((s) => `${s.name}（${s.why}）`).join('；')}。` : '';
      const files = new Set(parts.map((p) => p.file.path)).size;
      if (files < 2) throw new Error(`${files ? `只有 ${parts[0].file.name} 读出了数据` : '选中的文件都没有读出数据'}，没有可以合并的。${skippedNote}`);

      let clipped = 0;
      const tabs = parts.map((p) => {
        const cut = clipCells(p.sheet.rows);
        clipped += cut.clipped;
        return { name: tabName(p.file, p.sheet, p.several), rows: cut.rows };
      });
      const total = parts.reduce((n, p) => n + p.sheet.rows.length, 0);

      // The same header on every table: they are parts of one table, so stack them as well.
      const header = headerOf(parts[0].sheet);
      const alike = header.some(Boolean) && parts.every((p) => {
        const h = headerOf(p.sheet);
        return h.length === header.length && h.every((cell, c) => cell === header[c]);
      });
      let stackNote;
      if (alike) {
        const width = Math.max(...parts.map((p) => p.sheet.cols));
        let label = SOURCE;
        for (let k = 2; header.includes(label); k++) label = k === 2 ? `${SOURCE}文件` : `${SOURCE}文件${k - 1}`;
        const top = tabs[0].rows[0].slice();
        top[width] = label;
        const stacked = [top];
        let dropped = 0;
        for (const [i, p] of parts.entries()) {
          const from = p.several ? `${p.file.name} / ${p.sheet.name}` : p.file.name;
          for (const row of tabs[i].rows.slice(1)) {
            if (blank(row)) {
              dropped++;
              continue;
            }
            const line = row.slice();
            line[width] = from; // cells between the end of a short row and this one stay empty
            stacked.push(line);
          }
        }
        if (stacked.length > MAX_ROWS || width + 1 > MAX_COLS) {
          stackNote = `各表的表头相同，但叠在一起有 ${stacked.length} 行 × ${width + 1} 列，超过了 Excel 一张表的上限，所以没有做“${STACKED}”表。`;
        } else {
          tabs.unshift({ name: STACKED, rows: stacked });
          stackNote = `各表的表头相同，所以最前面多了一张“${STACKED}”表：表头只留一次，${stacked.length - 1} 行数据叠在一起，最后一列“${label}”写着每一行出自哪个文件${dropped ? `（${dropped} 个空行没有放进去）` : ''}。`;
        }
      } else {
        stackNote = header.some(Boolean) ? '各表的表头不一样，所以没有把它们叠成一张总表。' : `${parts[0].file.name} 的第一行是空的，看不出表头，所以没有把各表叠成一张总表。`;
      }

      checkStop(env);
      env.step(ctx.files.length, ctx.files.length, '');
      const data = await writeXlsx(tabs, { template: env.template });
      checkStop(env);
      const out = env.save(resultName(ctx.files, ' 合并', 'xlsx'), data);
      const sheets = parts.map((p) => p.sheet);
      const notes = [
        valueNotes(sheets, '带过来的'),
        fromBooks ? '原表的字体、颜色、合并单元格等格式没有带过来。' : '',
        hidden ? `${hidden} 张隐藏的表没有放进去。` : '',
        clippedNote(clipped),
        skippedNote,
      ].join('');
      return { kind: 'file', path: out, message: `合并了 ${files} 个文件里的 ${parts.length} 张表，共 ${total} 行，每张表在新工作簿里各占一个工作表。${stackNote}${notes}` };
    },
  },
];
