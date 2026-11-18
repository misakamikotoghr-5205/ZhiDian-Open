import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { DOCUMENT_THEMES, documentTheme } from '../src/core/document-themes.js';
import { describeFiles } from '../src/core/office-kinds.js';
import { pageHtml, outlineOf } from '../src/main/office/convert.js';
import { filesToPptx } from '../src/main/office/pptx.js';
import { restyleDocx } from '../src/main/office/restyle.js';
import { readXlsx, writeXlsx } from '../src/main/office/sheet.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-templates-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const parse = (xml) => new DOMParser().parseFromString(xml, 'text/xml');
const words = (xml) => Array.from(parse(xml).getElementsByTagNameNS(W, 't'), (n) => n.textContent);

test('template selection is bounded and report layout preserves content and a single title', () => {
  assert.equal(documentTheme('<style>bad</style>').id, 'business');
  for (const theme of DOCUMENT_THEMES) {
    const html = pageHtml('<h1>Report &amp; results</h1><p>All original words.</p><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>Final value</td></tr></tbody></table>', 'source', { template: theme.id });
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.ok(html.includes('Report &amp; results'));
    assert.ok(html.includes('Final value'));
    assert.ok(html.includes(`data-document-theme="${theme.id}"`));
    assert.ok(html.includes(`#${theme.accent}`));
    assert.match(html, /thead \{ display: table-header-group; \}/, 'long tables repeat their heading');
    assert.match(html, /break-inside: auto/, 'a long table may paginate instead of overflowing one page');
  }
});

test('each slide template has a distinct cover, consistent colors and all source points', async () => {
  const source = path.join(root, 'report.md');
  const points = Array.from({ length: 9 }, (_, i) => `Original point ${i + 1}`);
  fs.writeFileSync(source, `# Project review\n\n## Priorities\n\n${points.map((p) => `- ${p}`).join('\n')}\n`);
  for (const theme of DOCUMENT_THEMES) {
    const result = await filesToPptx(describeFiles([source]), { outlineOf }, { template: theme.id });
    assert.equal(result.slides, 3, 'cover plus two pages of points');
    assert.equal(result.shortened, 0);
    const zip = await JSZip.loadAsync(result.buffer);
    const cover = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(cover.includes(theme.cover));
    const content = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.ok(content.includes(theme.surface), 'points have readable card backgrounds');
    assert.ok(content.includes(theme.accent), 'point numbering follows the selected theme');
    const allSlides = (await Promise.all(Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map((n) => zip.file(n).async('string')))).join('\n');
    for (const point of points) assert.ok(allSlides.includes(point));
    const layouts = (await Promise.all(Object.keys(zip.files).filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).map((n) => zip.file(n).async('string')))).join('\n');
    assert.ok(layouts.includes(theme.line), 'slide layouts contain the restrained footer rule');
  }
});

test('Word templates retain every word and apply heading hierarchy and repeating table headers', async () => {
  const original = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Project report</w:t></w:r></w:p><w:p><w:r><w:t>一、进度</w:t></w:r></w:p><w:p><w:r><w:t>All original body words.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Heading</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`;
  const source = new JSZip();
  source.file('word/document.xml', original);
  source.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const bytes = await source.generateAsync({ type: 'nodebuffer' });
  for (const theme of DOCUMENT_THEMES) {
    const result = await restyleDocx(bytes, { template: theme.id });
    const zip = await JSZip.loadAsync(result.buffer);
    const document = await zip.file('word/document.xml').async('string');
    const styles = await zip.file('word/styles.xml').async('string');
    assert.deepEqual(words(document), words(original));
    assert.ok(document.includes(`w:fill="${theme.accent}"`));
    assert.ok(document.includes('<w:tblHeader/>'));
    assert.ok(styles.includes(`w:color w:val="${theme.accent}"`));
    assert.equal(result.counts.tables, 1);
  }
});

test('Excel themes retain values and identifiers while adding a filter and clear header', async () => {
  const rows = [['ID', 'Revenue'], ['00123', '2500'], ['987654321098765432', '12.5']];
  for (const theme of DOCUMENT_THEMES) {
    const buffer = await writeXlsx([{ name: 'Data', rows }], { template: theme.id });
    const read = await readXlsx(buffer);
    assert.deepEqual(read[0].rows, rows);
    const zip = await JSZip.loadAsync(buffer);
    const styles = await zip.file('xl/styles.xml').async('string');
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.ok(styles.includes(`FF${theme.accent}`));
    assert.match(sheet, /<autoFilter ref="A1:B3"\/>/);
    assert.match(sheet, /ySplit="1"/);
    assert.match(sheet, /showGridLines="0"/);
  }
});
