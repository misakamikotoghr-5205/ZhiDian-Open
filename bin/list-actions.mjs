#!/usr/bin/env node
// Prints the table of office actions in the README from the actions themselves, so the
// documentation cannot drift from what the panel really offers:
//
//   node bin/list-actions.mjs            print the table
//   node bin/list-actions.mjs --write    replace the table in README.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Office } from '../src/main/office/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-actions-'));
const file = (name) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  return p;
};
const office = new Office({ documentsDir: dir });
const SELECTIONS = [
  ['一段文字', { text: '今天讨论了Q3的数据,合计 1,284 和 1,902.\n第二行' }],
  ['几个文件（类型不限）', { files: [file('a.pdf'), file('b.png'), file('c.docx')] }],
  ['一个 Word 文档', { files: [file('报告.docx')] }],
  ['一个 PDF', { files: [file('合同.pdf')] }],
  ['一张图片', { files: [file('截图.png')] }],
  ['几张图片', { files: [file('1.png'), file('2.jpg')] }],
  ['一个表格（CSV / Excel）', { files: [file('数据.csv')] }],
  ['几个表格', { files: [file('一月.xlsx'), file('二月.xlsx')] }],
  ['一个 Markdown 或文本文件', { files: [file('笔记.md')] }],
];
const lines = ['| 选中了什么 | 面板直接显示 | 点"更多"还有 |', '|---|---|---|'];
for (const [what, input] of SELECTIONS) {
  // With an office suite and the model present, so that every action shows.
  const offers = office.offers(office.context(input), { office: true, model: true });
  if (!offers.length) continue;
  const shown = offers.length > 5 ? offers.slice(0, 4) : offers;
  const rest = offers.slice(shown.length);
  lines.push(`| ${what} | ${shown.map((o) => `**${o.label}**`).join('、')} | ${rest.map((o) => o.label).join('、') || '—'} |`);
}
const table = lines.join('\n');
fs.rmSync(dir, { recursive: true, force: true });
if (process.argv.includes('--write')) {
  const readme = path.join(repo, 'README.md');
  const text = fs.readFileSync(readme, 'utf8');
  const next = text.replace(/<!-- ACTIONS:BEGIN -->[\s\S]*?<!-- ACTIONS:END -->/, `<!-- ACTIONS:BEGIN -->\n${table}\n<!-- ACTIONS:END -->`);
  if (next === text && !text.includes(table)) throw new Error('README.md has no ACTIONS markers');
  fs.writeFileSync(readme, next);
  console.log('README.md updated');
} else {
  console.log(table);
}
