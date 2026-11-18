// The sheet actions inside the real app, on tables made here: a CSV into an Excel workbook, a
// workbook into CSV, several tables into one workbook, a table as Markdown. Every result is
// checked by opening it again, and against a real spreadsheet program: what the app writes is
// opened by LibreOffice (which must find the same cells in it), and what LibreOffice writes is
// read by the app. Without LibreOffice on this machine those parts are skipped, and said so.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e/office-sheet.mjs
//
// KEEP=1 leaves the results in the temporary folder (its path is printed) to look at.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { parseCsv, plainNumber, readXlsx, toCsv } from '../../src/main/office/sheet.js';
import { launchOffice } from './office-harness.mjs';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---- LibreOffice, with a profile of its own, away from the folder the app works in
const loDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-sheet-lo-'));
let loRuns = 0;
/** Convert `file`; returns the folder the results are in. Sheet names become file names, hence the UTF-8 locale. */
function soffice(file, convertTo, inFilter) {
  const out = path.join(loDir, `run-${++loRuns}`);
  fs.mkdirSync(out);
  const args = [`-env:UserInstallation=file://${path.join(loDir, 'profile')}`, '--headless', '--norestore', ...(inFilter ? [`--infilter=${inFilter}`] : []), '--convert-to', convertTo, '--outdir', out, file];
  const r = spawnSync('soffice', args, { timeout: 180_000, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8' } });
  assert.ok(fs.readdirSync(out).length > 0, `LibreOffice made nothing of ${path.basename(file)}: ${r.stdout}${r.stderr}${r.error ?? ''}`);
  return out;
}
// Comma, double quote, UTF-8, from line 1; on the way out: cells as they are shown, every sheet (-1).
const CSV_OUT = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1';
// On the way in: also recognise dates and times ("detect special numbers").
const CSV_IN = 'CSV:44,34,76,1,,0,false,true';

/** The sheets of a workbook as LibreOffice shows them: { sheet name: rows }. */
function sheetsByLibreOffice(file) {
  const out = soffice(file, CSV_OUT);
  const stem = path.basename(file).replace(/\.xlsx$/, '');
  const sheets = {};
  for (const name of fs.readdirSync(out)) {
    assert.ok(name.startsWith(`${stem}-`) && name.endsWith('.csv'), name);
    sheets[name.slice(stem.length + 1, -4)] = parseCsv(fs.readFileSync(path.join(out, name), 'utf8'), ',');
  }
  return sheets;
}

/** Rows as a spreadsheet shows them once the workbook is written: numbers the short way, one kind of line break. */
const shown = (rows) => rows.map((row) => row.map((v) => (plainNumber(v) !== null ? String(plainNumber(v)) : String(v ?? '').replace(/\r\n?/g, '\n'))));
/** Every row as wide as the widest, so that tables from different readers can be compared. */
function square(rows) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_x, i) => r[i] ?? ''));
}
const sameTable = (actual, expected, what) => assert.deepEqual(square(actual), square(expected), what);

let failed = null;
const office = await launchOffice();
const work = office.work;
const fx = (name) => path.join(work, name);

try {
  const hasSoffice = ['soffice'].some((bin) => spawnSync(bin, ['--version'], { timeout: 30_000 }).status === 0);
  if (!hasSoffice) console.log('  (LibreOffice is not installed here: the checks against it are skipped)');

  // ---- fixtures
  const ORDERS = [
    ['订单号', '客户', '金额', '手机', '证件号', '条码', '下单日期', '备注'],
    ['00123', '张三', '1280.50', '13800138000', '110101199003071234', '6901234567892', '2024-03-05', '加急, 上午送'],
    ['00124', "O'Brien & <Sons>", '-99', '+8613900139000', '', '0', '2024/3/6', '他说"行"\r\n第二行'],
    ['00125', '王五', '0.1', '', '1234567890123456', '123456789012345', '', '  前后有空格  '],
    ['A-7', '', '1e5', '0755-1234567', '', '', '3月8日', '=1+1'],
  ];
  const orders = fx('三月订单.csv');
  fs.writeFileSync(orders, toCsv(ORDERS));
  const originals = { [orders]: sha(orders) };

  console.log('▸ what is offered for tables');
  const forCsv = await office.offers({ files: [orders] });
  console.log(`  one CSV: ${forCsv.join(', ')}`);
  assert.equal(forCsv[0], 'sheet.xlsx', 'a CSV: into Excel comes first');
  assert.ok(forCsv.includes('sheet.markdown') && !forCsv.includes('sheet.csv') && !forCsv.includes('sheets.merge'));

  console.log('▸ sheet.xlsx: a CSV becomes a workbook next to it');
  const made = await office.ok('sheet.xlsx', { files: [orders] });
  assert.equal(made.result.kind, 'file');
  assert.equal(made.result.path, fx('三月订单.xlsx'), 'next to the original, under its name');
  const book = await readXlsx(fs.readFileSync(made.result.path));
  assert.deepEqual(book.map((s) => s.name), ['三月订单']);
  sameTable(book[0].rows, shown(ORDERS), 'every cell of the CSV is in the workbook');
  const sheetXml = await (await JSZip.loadAsync(fs.readFileSync(made.result.path))).file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheetXml, /<c r="C2"><v>1280\.5<\/v><\/c>/, 'an amount is a number');
  assert.match(sheetXml, /<c r="A2" t="inlineStr"><is><t>00123<\/t>/, 'an order number keeps its zeros, as text');
  assert.match(sheetXml, /<c r="E2" t="inlineStr"><is><t>110101199003071234<\/t>/, 'an 18-digit number is text');
  assert.match(sheetXml, /<c r="H5" t="inlineStr"><is><t>=1\+1<\/t>/, 'text that looks like a formula is text');
  assert.match(sheetXml, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(made.result.message, /^已转成 Excel：5 行 × 8 列（按逗号分列），首行加粗并冻结。7 个单元格是数字，写成了数值；5 个以 0 开头或超过 15 位的数字/);
  console.log(`  ${path.basename(made.result.path)}. ${made.result.message}`);

  const again = await office.ok('sheet.xlsx', { files: [orders] });
  assert.equal(again.result.path, fx('三月订单 (2).xlsx'), 'a second time: a second file, nothing overwritten');

  if (hasSoffice) {
    console.log('▸ LibreOffice opens that workbook and finds the same cells');
    const seen = sheetsByLibreOffice(made.result.path);
    assert.deepEqual(Object.keys(seen), ['三月订单']);
    sameTable(seen['三月订单'], shown(ORDERS), 'cell for cell what was in the CSV');
    console.log(`  ${seen['三月订单'].length} rows × ${seen['三月订单'][0].length} columns agree, among them ${seen['三月订单'][1][0]}, ${seen['三月订单'][1][4]} and ${seen['三月订单'][1][5]}`);
  }

  let loBook = null;
  const LEDGER = [
    ['品名', '数量', '单价', '日期', '时间', '时刻', '备注', '已付'],
    ['苹果, 红富士', '12', '3.5', '2024-03-05', '2024-03-05 14:30:00', '08:15:30', '他说："好"\n第二行', 'TRUE'],
    ['梨', '-7', '0.1', '1999-12-31', '2000-01-01 00:00:01', '23:59:59', '', 'FALSE'],
    ['橙子 "脐橙"', '1000000', '1234567.891', '2030-02-28', '1900-03-01 12:00:00', '12:00:00', '尾巴', 'TRUE'],
  ];
  if (hasSoffice) {
    console.log('▸ sheet.csv: a workbook written by LibreOffice (numbers, dates, times, quotes, line breaks, Chinese)');
    const ledgerCsv = path.join(loDir, '台账.csv');
    fs.writeFileSync(ledgerCsv, toCsv(LEDGER));
    loBook = fx('台账.xlsx');
    fs.copyFileSync(path.join(soffice(ledgerCsv, 'xlsx:Calc MS Excel 2007 XML', CSV_IN), '台账.xlsx'), loBook);
    originals[loBook] = sha(loBook);
    // LibreOffice really made dates and numbers of them, not text.
    const loXml = await (await JSZip.loadAsync(fs.readFileSync(loBook))).file('xl/worksheets/sheet1.xml').async('string');
    assert.match(loXml, /<c r="D2"[^>]*t="n"[^>]*><v>45356<\/v>/, 'the date is stored as a day count');
    assert.match(loXml, /<c r="B2"[^>]*t="n"[^>]*><v>12<\/v>/);
    assert.match(loXml, /t="s"/, 'text is in the shared string table');
    const direct = await readXlsx(fs.readFileSync(loBook));
    sameTable(direct[0].rows, LEDGER, 'read directly');
    assert.equal(direct[0].dates, 9, 'three dates, three dates with a time, three times of day');

    const forBook = await office.offers({ files: [loBook] });
    console.log(`  one workbook: ${forBook.join(', ')}`);
    assert.equal(forBook[0], 'sheet.csv', 'a workbook: into CSV comes first');
    assert.ok(forBook.includes('sheet.markdown') && !forBook.includes('sheet.xlsx'));
    const csv = await office.ok('sheet.csv', { files: [loBook] });
    assert.equal(csv.result.kind, 'file');
    assert.equal(csv.result.path, fx('台账.csv'));
    const bytes = fs.readFileSync(csv.result.path);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with the mark Excel needs');
    sameTable(parseCsv(bytes.toString('utf8'), ','), LEDGER, 'the CSV holds what went into LibreOffice');
    assert.match(csv.result.message, /^已转成 CSV：4 行 × 8 列（UTF-8 编码，带 BOM，Excel 直接打开不乱码）。9 个日期、时间单元格写成/);
    console.log(`  ${path.basename(csv.result.path)}. ${csv.result.message}`);
  }

  console.log('▸ sheets.merge: tables with the same header into one workbook, stacked on a first sheet');
  const HEAD = ['日期', '门店', '金额', '单号'];
  const jan = fx('一月.csv'), feb = fx('二月.tsv');
  fs.writeFileSync(jan, toCsv([HEAD, ['2024-01-05', '东城', '120.5', '0001'], ['2024-01-09', '西城, 二店', '80', '0002']]));
  fs.writeFileSync(feb, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(toCsv([HEAD, ['2024-02-03', '东城', '200', '0003'], ['2024-02-11', '南城', '15', '0004']], { delimiter: '\t' }), 'utf16le')]));
  const inputs = [jan, feb];
  const MARCH = [HEAD, ['2024-03-05', '北城 "旗舰"', '300', '5'], ['2024-03-06', '东城', '0.5', '6']];
  if (hasSoffice) {
    // The third table is a workbook by LibreOffice, with real dates in its first column.
    const marCsv = path.join(loDir, '三月.csv');
    fs.writeFileSync(marCsv, toCsv(MARCH));
    fs.copyFileSync(path.join(soffice(marCsv, 'xlsx:Calc MS Excel 2007 XML', CSV_IN), '三月.xlsx'), fx('三月.xlsx'));
    inputs.push(fx('三月.xlsx'));
  }
  for (const file of inputs) originals[file] = sha(file);
  const forMany = await office.offers({ files: inputs });
  console.log(`  ${inputs.length} tables: ${forMany.join(', ')}`);
  assert.equal(forMany[0], 'sheets.merge', 'several tables: one workbook comes first');
  assert.ok(!forMany.some((id) => /^sheet\./.test(id)), 'the actions for one table are not offered');
  const merged = await office.ok('sheets.merge', { files: inputs });
  assert.equal(merged.result.kind, 'file');
  assert.equal(merged.result.path, fx(`一月 等 ${inputs.length} 个文件 合并.xlsx`));
  const parts = [
    ['一月', '一月.csv', [HEAD, ['2024-01-05', '东城', '120.5', '0001'], ['2024-01-09', '西城, 二店', '80', '0002']]],
    ['二月', '二月.tsv', [HEAD, ['2024-02-03', '东城', '200', '0003'], ['2024-02-11', '南城', '15', '0004']]],
    ...(hasSoffice ? [['三月', '三月.xlsx', MARCH]] : []),
  ];
  const STACK = [[...HEAD, '来源'], ...parts.flatMap(([, file, rows]) => rows.slice(1).map((row) => [...row, file]))];
  const mergedBook = await readXlsx(fs.readFileSync(merged.result.path));
  assert.deepEqual(mergedBook.map((s) => s.name), ['合并', ...parts.map(([name]) => name)]);
  sameTable(mergedBook[0].rows, STACK, 'the header once, every row, and where it came from');
  parts.forEach(([name, , rows], i) => sameTable(mergedBook[i + 1].rows, rows, name));
  assert.match(merged.result.message, new RegExp(`^合并了 ${inputs.length} 个文件里的 ${inputs.length} 张表，共 ${inputs.length * 3} 行，每张表在新工作簿里各占一个工作表。各表的表头相同，所以最前面多了一张“合并”表：表头只留一次，${inputs.length * 2} 行数据叠在一起，最后一列“来源”写着每一行出自哪个文件。`));
  if (hasSoffice) assert.match(merged.result.message, /2 个日期、时间单元格写成“2024-03-05 14:30:00”这种样子的文字。原表的字体、颜色、合并单元格等格式没有带过来。$/);
  console.log(`  ${path.basename(merged.result.path)}. ${merged.result.message}`);

  if (hasSoffice) {
    console.log('▸ LibreOffice opens the merged workbook: every sheet, cell for cell');
    const seen = sheetsByLibreOffice(merged.result.path);
    assert.deepEqual(Object.keys(seen).sort(), ['合并', ...parts.map(([name]) => name)].sort());
    sameTable(seen['合并'], shown(STACK), '合并');
    for (const [name, , rows] of parts) sameTable(seen[name], shown(rows), name);
    console.log(`  ${Object.keys(seen).length} sheets agree; the stacked one has ${seen['合并'].length} rows, the last from ${seen['合并'].at(-1).at(-1)}`);
  }

  console.log('▸ sheet.csv on a workbook with several tables: a folder with one CSV for each');
  const split = await office.ok('sheet.csv', { files: [merged.result.path] });
  assert.equal(split.result.kind, 'folder');
  assert.equal(split.result.path, fx(`一月 等 ${inputs.length} 个文件 合并 CSV`), 'a new folder next to the workbook');
  assert.deepEqual(fs.readdirSync(split.result.path).sort(), ['合并.csv', ...parts.map(([name]) => `${name}.csv`)].sort());
  const csvRows = (name) => parseCsv(fs.readFileSync(path.join(split.result.path, `${name}.csv`), 'utf8'), ',');
  sameTable(csvRows('合并'), shown(STACK), '合并.csv');
  for (const [name, , rows] of parts) sameTable(csvRows(name), shown(rows), `${name}.csv`);
  assert.match(split.result.message, new RegExp(`^这个工作簿有 ${inputs.length + 1} 张有数据的表，每张存成了一个 CSV，放在一个新文件夹里：合并（${inputs.length * 2 + 1} 行）、一月（3 行）`));
  console.log(`  ${fs.readdirSync(split.result.path).length} files. ${split.result.message}`);

  console.log('▸ sheet.markdown: a table for the clipboard, cut at 200 rows');
  const md = await office.ok('sheet.markdown', { files: [jan] });
  assert.equal(md.result.kind, 'clipboard');
  assert.equal(md.result.text, '| 日期 | 门店 | 金额 | 单号 |\n| --- | --- | ---: | --- |\n| 2024-01-05 | 东城 | 120.5 | 0001 |\n| 2024-01-09 | 西城, 二店 | 80 | 0002 |\n');
  assert.equal(md.result.message, '已把这张表做成 Markdown 表格：3 行 × 4 列，第一行是表头');
  const mdBook = await office.ok('sheet.markdown', { files: [merged.result.path] });
  assert.equal(mdBook.result.text.split('\n')[0], '| 日期 | 门店 | 金额 | 单号 | 来源 |');
  assert.match(mdBook.result.message, new RegExp(`^已把“合并”这张表做成 Markdown 表格：${inputs.length * 2 + 1} 行 × 5 列，第一行是表头；工作簿里另外 ${inputs.length} 张有数据的表没有取$`));
  const long = fx('流水.csv');
  fs.writeFileSync(long, toCsv([['序号', '金额'], ...Array.from({ length: 999 }, (_x, i) => [String(i + 1), String((i + 1) * 1.5)])]));
  originals[long] = sha(long);
  const mdLong = await office.ok('sheet.markdown', { files: [long] });
  assert.equal(mdLong.result.text.trimEnd().split('\n').length, 201, '200 rows and the line under the header');
  assert.equal(mdLong.result.message, '这张表有 1000 行，只取了前 200 行做成 Markdown 表格（第一行是表头），共 2 列');
  console.log(`  ${mdLong.result.message}`);

  console.log('▸ what cannot be done says so, and leaves nothing behind');
  fs.writeFileSync(fx('empty.csv'), '');
  fs.writeFileSync(fx('broken.xlsx'), 'this is not a workbook');
  const listing = fs.readdirSync(work).sort();
  const refusals = [
    ['sheet.xlsx', [fx('empty.csv')], /这个文件是空的/],
    ['sheet.markdown', [fx('empty.csv')], /这个文件是空的/],
    ['sheet.csv', [fx('broken.xlsx')], /打不开这个 Excel 文件/],
    ['sheet.markdown', [fx('broken.xlsx')], /打不开这个 Excel 文件/],
    ['sheets.merge', [fx('empty.csv'), fx('broken.xlsx')], /选中的文件都没有读出数据/],
    ['sheets.merge', [jan, fx('broken.xlsx')], /只有 一月\.csv 读出了数据，没有可以合并的。没能处理：broken\.xlsx/],
    ['sheet.csv', [orders], /not offered/],
    ['sheet.xlsx', [made.result.path], /not offered/],
    ['sheets.merge', [orders], /not offered/],
  ];
  for (const [id, files, why] of refusals) {
    const r = await office.run(id, { files });
    assert.match(r.error ?? '', why, `${id} on ${files.map((f) => path.basename(f)).join(' + ')}: ${r.error ?? JSON.stringify(r.result)}`);
    console.log(`  ${id} on ${files.map((f) => path.basename(f)).join(' + ')}: ${r.error}`);
  }
  assert.deepEqual(fs.readdirSync(work).sort(), listing, 'a refusal leaves nothing behind');
  for (const [file, hash] of Object.entries(originals)) assert.equal(sha(file), hash, `${path.basename(file)} is untouched by all of this`);

  console.log(`\n✔ office-sheet checks passed${hasSoffice ? '' : ' (without LibreOffice)'}${process.env.KEEP ? `. Results in ${work}` : ''}`);
} catch (err) {
  failed = err;
  console.error('\n✘ ' + (err.stack ?? err));
  console.error(`Results so far are in ${work}`);
} finally {
  await office.close();
}
fs.rmSync(loDir, { recursive: true, force: true });
if (!failed && !process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
