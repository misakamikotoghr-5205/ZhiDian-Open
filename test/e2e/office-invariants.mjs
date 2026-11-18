// Three promises every office action makes, checked for every action on every kind of
// selection, including hostile ones (empty files, broken files, awkward names):
//
//   1. the selected files are never changed (same bytes before and after)
//   2. a result never replaces a file that was already there (doing it twice gives two results)
//   3. when it cannot be done, the person gets a sentence, not a stack trace
//
//   xvfb-run -a node test/e2e/office-invariants.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launchOffice } from './office-harness.mjs';

const office = await launchOffice();
const dir = office.work;
const at = (name) => path.join(dir, name);

// ---- fixtures, made here so the script runs anywhere
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgba(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function pdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`Page ${i} of ${pages}`, { x: 60, y: 760, size: 22, font });
  return Buffer.from(await doc.save());
}
async function docx() {
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('年度报告')}${p('一、基本情况')}${p('今年完成了全部既定目标,客户满意度达到历史最高.')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const write = (name, data) => {
  fs.writeFileSync(at(name), data);
  return at(name);
};
const F = {
  docx: write('年度 报告 v1.2.docx', await docx()),
  pdf: write('合同 (终版) 📄.pdf', await pdf(3)),
  pdf1: write('single.pdf', await pdf(1)),
  png: write('截图 1.png', png(320, 200, (x, y) => [x % 256, y % 256, 160, 255])),
  png2: write('b.png', png(200, 300, (x) => [255, x % 256, 0, x < 100 ? 255 : 120])),
  md: write('笔记.md', '# 计划\n\n## 目标\n\n- 十二月上线\n- 覆盖三个市场\n'),
  txt: write('memo.txt', '会议纪要\n\n今天讨论了Q3的数据,合计1,284和1,902.\n'),
  csv: write('订单.csv', '﻿名称,数量,金额\n"笔记本, 14 寸",2,8598\n手机,10,29990\n'),
  other: write('data.xyz', 'not a document'),
  empty_pdf: write('empty.pdf', ''),
  empty_docx: write('empty.docx', ''),
  empty_png: write('empty.png', ''),
  empty_csv: write('empty.csv', ''),
  bad_pdf: write('bad.pdf', 'this is not a pdf'),
  bad_docx: write('bad.docx', 'PK\u0003\u0004 not really a zip'),
  bad_png: write('bad.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
  bad_xlsx: write('bad.xlsx', 'not a workbook'),
};
// A real workbook, made by the app itself from the CSV.
F.xlsx = (await office.ok('sheet.xlsx', { files: [F.csv] })).result.path;
F.xlsx2 = write('二月.xlsx', fs.readFileSync(F.xlsx));

const SELECTIONS = {
  'one Word document': { files: [F.docx] },
  'one PDF': { files: [F.pdf] },
  'a one-page PDF': { files: [F.pdf1] },
  'one picture': { files: [F.png] },
  'two pictures': { files: [F.png, F.png2] },
  'one Markdown file': { files: [F.md] },
  'one text file': { files: [F.txt] },
  'one CSV': { files: [F.csv] },
  'one workbook': { files: [F.xlsx] },
  'two workbooks': { files: [F.xlsx, F.xlsx2] },
  'mixed files, one of an unknown kind': { files: [F.docx, F.pdf, F.png, F.md, F.other] },
  'the same file twice': { files: [F.pdf, F.pdf] },
  'only an unknown kind': { files: [F.other, F.other.replace('data', 'data2')] },
  'selected text': { text: '今天讨论了Q3的数据,合计 1,284 和 1,902.\n第二行内容在这里,继续说明情况并给出下一步的安排与分工,确保每个人都清楚自己的任务.\n' },
  'an empty PDF': { files: [F.empty_pdf] },
  'an empty Word file': { files: [F.empty_docx] },
  'an empty picture': { files: [F.empty_png] },
  'an empty CSV': { files: [F.empty_csv] },
  'a broken PDF': { files: [F.bad_pdf] },
  'a broken Word file': { files: [F.bad_docx] },
  'a broken picture': { files: [F.bad_png] },
  'a broken workbook': { files: [F.bad_xlsx] },
  'good and broken together': { files: [F.pdf, F.bad_pdf, F.png, F.bad_png, F.bad_docx] },
};
fs.writeFileSync(at('data2.xyz'), 'another');

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const snapshot = () => {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, hash(p));
    }
  };
  walk(dir);
  return out;
};
const looksLikeASentence = (msg) => /[一-鿿]/.test(msg) && !/\bat .+:\d+:\d+|TypeError|ReferenceError|undefined|\[object |ENOENT|EACCES|Cannot read/.test(msg);

let ran = 0, refused = 0;
const problems = [];
try {
  for (const [what, input] of Object.entries(SELECTIONS)) {
    const offers = await office.offers(input);
    console.log(`▸ ${what}: ${offers.join(', ') || '(nothing offered)'}`);
    for (const id of offers) {
      const before = snapshot();
      const results = [];
      for (let round = 0; round < 2; round++) {
        const r = await office.run(id, input);
        ran++;
        if (r.error) {
          refused++;
          if (!looksLikeASentence(r.error)) problems.push(`${what} / ${id}: the error is not a sentence for a person: ${r.error.slice(0, 200)}`);
          break;
        }
        const res = r.result;
        if (!['file', 'folder', 'clipboard', 'info', 'ask'].includes(res?.kind)) problems.push(`${what} / ${id}: unknown result kind ${JSON.stringify(res).slice(0, 120)}`);
        if (res.kind !== 'ask' && !(typeof res.message === 'string' && res.message.trim())) problems.push(`${what} / ${id}: no message`);
        if (res.kind === 'file' || res.kind === 'folder') {
          if (!fs.existsSync(res.path)) problems.push(`${what} / ${id}: says it wrote ${res.path}, which is not there`);
          else if (before.has(res.path)) problems.push(`${what} / ${id}: wrote over ${res.path}, which was already there`);
          if (results.includes(res.path)) problems.push(`${what} / ${id}: the second run gave the same path as the first`);
          results.push(res.path);
        }
      }
      // Whatever happened, nothing that was there before may have changed or gone.
      const after = snapshot();
      for (const [file, was] of before) {
        if (!after.has(file)) problems.push(`${what} / ${id}: ${path.basename(file)} disappeared`);
        else if (after.get(file) !== was) problems.push(`${what} / ${id}: ${path.basename(file)} was changed`);
      }
    }
  }
} finally {
  await office.close();
}
console.log(`\n${ran} runs of ${Object.keys(SELECTIONS).length} selections; ${refused} refused with a message.`);
if (problems.length) {
  console.error(`✘ ${problems.length} problem(s):\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log('✔ office-invariants checks passed');
