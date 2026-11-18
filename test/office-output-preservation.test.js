// Regression tests for content omitted from a slide and for wrapped plain-text input.
// Inspect the actual PPTX package, including its speaker notes, rather than mocking slides.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { describeFiles } from '../src/core/office-kinds.js';
import { outlineOf } from '../src/main/office/convert.js';
import { filesToPptx } from '../src/main/office/pptx.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-output-preservation-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function write(name, content) {
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
}

async function makeDeck(name, markdown) {
  const file = write(name, markdown);
  const result = await filesToPptx(describeFiles([file]), { outlineOf });
  assert.deepEqual(result.skipped, [], 'the document was converted successfully');
  assert.deepEqual(result.used, [name]);
  const zip = await JSZip.loadAsync(result.buffer);
  const textOfParts = async (pattern) => {
    const entries = Object.keys(zip.files).filter((entry) => pattern.test(entry));
    const parts = await Promise.all(entries.map(async (entry) => {
      const xml = await zip.file(entry).async('string');
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      return Array.from(doc.getElementsByTagNameNS(DRAWING_NS, 't'), (node) => node.textContent).join('\n');
    }));
    return parts.join('\n');
  };
  return {
    ...result,
    notes: await textOfParts(/^ppt\/notesSlides\/notesSlide\d+\.xml$/),
    visible: await textOfParts(/^ppt\/slides\/slide\d+\.xml$/),
  };
}

test('PPTX keeps every line of a shortened code block in speaker notes', async () => {
  const code = Array.from({ length: 24 }, (_, i) => `const line${i + 1} = "<value ${i + 1}> & original";`).join('\n');
  const deck = await makeDeck('long-code.md', '# Example\n\n```js\n' + code + '\n```\n');

  assert.equal(deck.shortened, 1, 'one code block was shortened');
  assert.ok(deck.notes.includes(code), 'speaker notes retain the complete code, including its final lines');
  assert.ok(deck.visible.includes('const line18 ='), 'the displayed preview includes its eighteenth line');
  assert.ok(!deck.visible.includes('const line24 ='), 'the omitted line is preserved in notes instead of the preview');
});

const tableCases = [
  { name: 'rows', rows: 12, cols: 2, longCell: false },
  { name: 'columns', rows: 3, cols: 9, longCell: false },
  { name: 'cell-text', rows: 3, cols: 2, longCell: true },
  { name: 'all-limits', rows: 12, cols: 9, longCell: true },
];

for (const fixture of tableCases) {
  test(`PPTX keeps every ${fixture.name} table cell editable and preserves the source in notes`, async () => {
    const rows = Array.from({ length: fixture.rows }, (_, r) =>
      Array.from({ length: fixture.cols }, (_, c) => `row${r + 1}-column${c + 1}`));
    if (fixture.longCell) rows[1][1] = 'This full original table cell must remain available after the slide preview has shortened its contents.';
    const markdownRow = (row) => `| ${row.join(' | ')} |`;
    const markdown = [
      '# Table example', '', markdownRow(rows[0]),
      markdownRow(Array(fixture.cols).fill('---')),
      ...rows.slice(1).map(markdownRow), '',
    ].join('\n');
    const deck = await makeDeck(`table-${fixture.name}.md`, markdown);

    assert.equal(deck.shortened, 0, 'table cells continue onto additional slides without ellipses');
    const visible = deck.visible.replace(/\s/g, '');
    for (const row of rows) {
      for (const cell of row) {
        assert.ok(deck.notes.includes(cell), `notes retain original cell: ${cell}`);
        assert.ok(visible.includes(cell.replace(/\s/g, '')), `native slide text retains cell: ${cell}`);
      }
    }
    if (fixture.rows > 10 || fixture.cols > 8) assert.equal(deck.paginatedTables, 1, 'long or wide tables paginate');
  });
}

test('plain-text outlines keep spaces between English words across wrapped lines', async () => {
  const lines = [
    'This paragraph contains enough words to remain ordinary body text when it is',
    'wrapped across multiple source lines in an exported document.',
  ];
  const outline = await outlineOf(write('english-wrap.txt', `Document title\n\n${lines.join('\r\n')}\n`));
  assert.equal(outline.sections[0].blocks[0].text, lines.join(' '));
});

test('plain-text outlines join Chinese wrapping without inserting spaces between characters', async () => {
  const lines = [
    '这一段中文说明文档转换需要完整保留原有文字，导出结果中的内容应该保持清楚连贯，不能因为',
    '原文件为了排版而换行就在中文字符之间插入多余空格。',
  ];
  const outline = await outlineOf(write('chinese-wrap.txt', `文档标题\n\n${lines.join('\n')}\n`));
  assert.equal(outline.sections[0].blocks[0].text, lines.join(''));
});

