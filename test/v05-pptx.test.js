import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { filesToPptx } from '../src/main/office/pptx.js';
import { outlineFromText, outlineOf } from '../src/main/office/convert.js';
import { actions } from '../src/main/office/tools-basic.js';
import { documentTheme } from '../src/core/document-themes.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-v05-pptx-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const EMU = 914400;
const nodes = (node, ns, name) => Array.from(node.getElementsByTagNameNS(ns, name));
const text = (node) => nodes(node, A, 't').map((n) => n.textContent).join('\n');
const normalize = (value) => value.replace(/\s/g, '');
const fakePdf = { name: '会议材料.pdf', path: '/fixture/会议材料.pdf', kind: 'pdf', ext: 'pdf' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const image = { dataUrl: PNG, w: 400, h: 600 };
async function inspect(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (pattern) => Promise.all(Object.keys(zip.files).filter((name) => pattern.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(async (name) => new DOMParser().parseFromString(await zip.file(name).async('string'), 'text/xml')));
  const slides = await read(/^ppt\/slides\/slide\d+\.xml$/);
  const notes = await read(/^ppt\/notesSlides\/notesSlide\d+\.xml$/);
  return { zip, slides, notes, visible: slides.map(text).join('\n'), noteText: notes.map(text).join('\n') };
}

test('PDF text uses editable native template shapes and never calls page rasterization', async () => {
  const pageText = [
    '季度复盘\n一、已完成\n- 完成三个客户交付\n- 回款120万元\n二、下周安排\n- 验证第二版方案',
    '交付计划\n\n负责人确认交付日期。\n\n- 验收时间为周五\n- 客户签字后归档',
  ];
  const calls = [], closed = [];
  const result = await filesToPptx([fakePdf], { openPdf: async () => ({ pages: pageText.length, text: async (p) => { calls.push(p); return pageText[p - 1]; }, render: () => { throw new Error('Text PDFs must not render a page image'); }, close: async () => closed.push(true) }) }, { template: 'warm' });
  assert.deepEqual(calls, [1, 2]); assert.equal(closed.length, 1);
  assert.equal(result.pdfTextPages, 2); assert.equal(result.pdfImagePages, 0); assert.deepEqual(result.warnings, []); assert.deepEqual(result.skipped, []);
  const deck = await inspect(result.buffer);
  assert.equal(deck.slides.length, result.slides);
  assert.equal(deck.slides.flatMap((s) => nodes(s, P, 'pic')).length, 0);
  for (const phrase of ['季度复盘', '一、已完成', '完成三个客户交付', '回款120万元', '二、下周安排', '验证第二版方案', '交付计划', '负责人确认交付日期。', '验收时间为周五']) assert.ok(deck.visible.includes(phrase), phrase);
  for (const source of pageText) assert.ok(deck.noteText.includes(source), 'full extracted source is preserved in notes');
  const contentXml = await deck.zip.file('ppt/slides/slide2.xml').async('string');
  assert.ok(contentXml.includes(documentTheme('warm').surface));
  assert.ok(nodes(deck.slides[1], P, 'sp').length >= 3, 'title and points are separate editable native objects');
});

test('mixed scanned pages have visible image-only labels and user-facing warnings', async () => {
  const rendered = [], closed = [];
  const tools = { openPdf: async () => ({ pages: 3, text: async (p) => p === 2 ? '' : `第${p}页标题\n\n这是一段可以编辑的正文。`, render: async (p) => { rendered.push(p); return image; }, close: async () => closed.push(true) }) };
  const result = await filesToPptx([fakePdf], tools);
  assert.deepEqual(rendered, [2]); assert.equal(closed.length, 1);
  assert.equal(result.pdfTextPages, 2); assert.equal(result.pdfImagePages, 1); assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].page, 2); assert.match(result.warnings[0].why, /扫描件.*不可编辑/);
  const deck = await inspect(result.buffer);
  assert.equal(deck.slides.flatMap((s) => nodes(s, P, 'pic')).length, 1);
  assert.match(deck.visible, /第 2 页.*页面图片（文字不可编辑）/);
  assert.match(deck.noteText, /扫描件.*不可编辑/);
  let saved;
  const action = await actions.find((a) => a.id === 'files.pptx').run({ kind: 'files', files: [fakePdf] }, { tools, save: (name, buffer) => { saved = buffer; return path.join(root, name); }, step: () => {} });
  assert.ok(saved.length > 1000); assert.match(action.message, /可编辑模板/); assert.match(action.message, /第 2 页.*不可编辑/);
});

test('older PDF image providers and extraction failures fall back with explicit limitations', async () => {
  for (const extra of [{}, { text: async () => { throw new Error('font decoding failed'); } }]) {
    let closed = false;
    const result = await filesToPptx([fakePdf], { openPdf: async () => ({ pages: 1, ...extra, render: async () => image, close: async () => { closed = true; } }) });
    assert.equal(closed, true); assert.equal(result.pdfImagePages, 1); assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].why, /未提供文字提取|文字提取失败/);
    assert.match((await inspect(result.buffer)).visible, /文字不可编辑/);
  }
});

test('recognized PDF page footers stay in notes without becoming presentation body text', async () => {
  const source = '交付会议\n确认客户验收。\n会议材料\n1 / 1';
  const result = await filesToPptx([fakePdf], { openPdf: async () => ({ pages: 1, text: async () => source, close: async () => {} }) });
  const deck = await inspect(result.buffer);
  assert.match(deck.visible, /确认客户验收/); assert.doesNotMatch(deck.visible, /1 \/ 1/);
  assert.ok(deck.noteText.includes(source));
});

test('PDF cancellation closes the source and does not return a partial deck', async () => {
  const controller = new AbortController(); let closed = false;
  await assert.rejects(filesToPptx([fakePdf], { openPdf: async () => ({ pages: 2, text: async () => { controller.abort(); return '内容'; }, close: async () => { closed = true; } }) }, { signal: controller.signal }), /已取消/);
  assert.equal(closed, true);
});

test('long and wide tables keep all cells native with repeated headers inside slide bounds', async () => {
  const rows = [['ID', ...Array.from({ length: 10 }, (_, c) => `指标${c + 1}`)], ...Array.from({ length: 27 }, (_, r) => [`项目${r + 1}`, ...Array.from({ length: 10 }, (_, c) => `值${r + 1}-${c + 1}`)])];
  const result = await filesToPptx([{ name: 'table.md', path: '/fixture/table.md', kind: 'markdown' }], { outlineOf: async () => ({ title: '数据报告', sections: [{ title: '全部数据', blocks: [{ type: 'table', rows }] }] }) });
  const deck = await inspect(result.buffer);
  assert.equal(result.paginatedTables, 1); assert.equal(result.shortened, 0);
  const tables = deck.slides.flatMap((s) => nodes(s, A, 'tbl'));
  assert.ok(tables.length >= 6, 'both rows and columns span additional native table slides');
  assert.equal(deck.slides.flatMap((s) => nodes(s, P, 'pic')).length, 0);
  const visible = normalize(deck.visible);
  for (const row of rows) for (const cell of row) { assert.ok(visible.includes(normalize(cell)), `visible cell ${cell}`); assert.ok(deck.noteText.includes(cell), `original note cell ${cell}`); }
  for (const table of tables) {
    const tableRows = nodes(table, A, 'tr');
    assert.equal(text(nodes(tableRows[0], A, 'tc')[0]), 'ID', 'key column header repeats on every continuation');
    const height = tableRows.reduce((sum, r) => sum + Number(r.getAttribute('h')), 0) / EMU;
    assert.ok(height <= 4.451 && height > 0, `bounded native row height ${height}`);
    const frame = table.parentNode.parentNode.parentNode;
    const xfrm = nodes(frame, P, 'xfrm')[0];
    const offset = nodes(xfrm, A, 'off')[0]; const extent = nodes(xfrm, A, 'ext')[0];
    assert.ok(Number(offset.getAttribute('x')) / EMU >= 0.79);
    assert.ok((Number(offset.getAttribute('x')) + Number(extent.getAttribute('cx'))) / EMU <= 13.334);
    assert.ok(Number(offset.getAttribute('y')) / EMU + height <= 6.44, 'table ends above the note/footer area');
  }
});

test('one oversized table cell continues as native text without losing its tail', async () => {
  const long = Array.from({ length: 180 }, (_, i) => `细项${String(i + 1).padStart(3, '0')}完整说明`).join('；');
  const rows = [['编号', '详细内容'], ['R1', long]];
  const result = await filesToPptx([{ name: 'long.md', path: '/fixture/long.md', kind: 'markdown' }], { outlineOf: async () => ({ title: '长单元格', sections: [{ title: '内容', blocks: [{ type: 'table', rows }] }] }) });
  const deck = await inspect(result.buffer);
  const cells = deck.slides.flatMap((s) => nodes(s, A, 'tbl')).flatMap((tbl) => nodes(tbl, A, 'tr').slice(1).map((r) => text(nodes(r, A, 'tc')[1])));
  assert.equal(normalize(cells.join('')), normalize(long));
  assert.ok(deck.noteText.includes(long)); assert.ok(result.paginatedTables > 0);
});

test('single-newline text headings and bullet rules are shared by PDF and text files', async () => {
  const source = '项目周报\n一、进展\n- 已完成接口对接\n- 已确认交付时间\n二、下一步\n继续完成验收说明。';
  const expected = outlineFromText(source, 'fallback');
  assert.equal(expected.title, '项目周报'); assert.deepEqual(expected.sections.map((s) => s.title), ['一、进展', '二、下一步']);
  assert.equal(expected.sections[0].blocks.length, 2); assert.equal(expected.sections[0].blocks[0].type, 'bullet');
  const file = path.join(root, 'rules.txt'); fs.writeFileSync(file, source);
  assert.deepEqual(await outlineOf(file), expected);
  const numbered = outlineFromText('行动列表\n1. 核对文件\n2. 提交验收');
  assert.deepEqual(numbered.sections[0].blocks.map((b) => b.type), ['bullet', 'bullet']);
});
