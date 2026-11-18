// The quick actions on documents, on files of any kind and on selected text, inside the real
// app: pack files into a ZIP, copy their names, count a Word document, export its text and its
// pictures, hand a document or a selection to the model. Every result is checked by opening it
// again: the ZIP entry by entry through zlib, the exported picture byte for byte, the numbers
// of a document whose numbers are known. The PDFs are read by the app's hidden page (pdf.js).
// No model is involved: a job for the model is checked up to the question it would be asked.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e/office-docs.mjs
//
// KEEP=1 leaves the results in the temporary folder (its path is printed) to look at.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launchOffice } from './office-harness.mjs';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bodyOf = (question) => question.slice(question.indexOf('\n\n') + 2);

// ---- fixtures

// A 2x2 red PNG, enough to be a picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8DAwMDAxMAAAAYIAQMd3rB0AAAAAElFTkSuQmCC', 'base64');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}"`;
const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (inner) => `<w:p>${inner}</w:p>`;
const cell = (t) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(run(t))}</w:tc>`;
const picture = (rid) =>
  `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture 1"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

/** A Word document with the given body; `media` is { 'image1.png': bytes }, related as rIdM1, rIdM2 ... */
async function makeDocx(file, body, media = {}) {
  const names = Object.keys(media);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((n, i) => `<Relationship Id="rIdM${i + 1}" Type="${REL}/image" Target="media/${n}"/>`).join('')}</Relationships>`);
  for (const n of names) zip.file(`word/media/${n}`, media[n]);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

// The document whose numbers are known: a title, an empty paragraph, a paragraph with a line
// break in it, one with a tab, a 2x2 table, a picture, and a last line.
//   字数 24: 16 Chinese characters, "，" and "。", four words (Hello, world, a, b), two numbers
//   字符 40: 6 + 5 + 9 + 7 ("a", tab, "b 100") + 2 + 2 + 2 + 5 + 2, of which a tab and a space
//   段落 8: title, Hello/world, "a b 100", four cells, 结束
const KNOWN_BODY = [
  para(run('年度工作报告')),
  para(''),
  para(run('Hello') + '<w:r><w:br/></w:r>' + run('world，欢迎。')),
  para(run('a') + '<w:r><w:tab/></w:r>' + run('b 100')),
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tr>${cell('指标')}${cell('数值')}</w:tr><w:tr>${cell('收入')}${cell('1,902')}</w:tr></w:tbl>`,
  para(picture('rIdM1')),
  para(run('结束')),
].join('');
const KNOWN_TEXT = '年度工作报告\n\nHello\nworld，欢迎。\na\tb 100\n指标\t数值\n收入\t1,902\n\n结束';
const KNOWN_COUNT = '字数 24（中文按字算，英文和数字按词算）\n字符 40，不计空格 38\n汉字 16，英文单词 4，数字 2\n段落 8\n表格 1，图片 1\n只算正文，页眉、页脚、脚注和批注不在内';

/** A PDF with real text: `pages` is a list of pages, each a list of lines. */
async function makePdf(file, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line, { x: 50, y: 790 - i * 14, size: 10, font }));
  }
  fs.writeFileSync(file, await doc.save());
}
/** A PDF that is only a picture, as a scan is. */
async function makeScan(file) {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(PNG);
  doc.addPage([595, 842]).drawImage(image, { x: 50, y: 300, width: 400, height: 400 });
  fs.writeFileSync(file, await doc.save());
}

// ---- reading results back

/** The entries of a ZIP read from its central directory, each with read() through zlib. */
function zipEntries(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'the end record of a ZIP');
  const out = [];
  let o = buf.readUInt32LE(end + 16);
  for (let k = 0; k < buf.readUInt16LE(end + 10); k++) {
    assert.equal(buf.readUInt32LE(o), 0x02014b50, 'an entry of the central directory');
    const method = buf.readUInt16LE(o + 10), packed = buf.readUInt32LE(o + 20), size = buf.readUInt32LE(o + 24);
    const nameLength = buf.readUInt16LE(o + 28), extra = buf.readUInt16LE(o + 30), comment = buf.readUInt16LE(o + 32), local = buf.readUInt32LE(o + 42);
    out.push({
      name: buf.toString('utf8', o + 46, o + 46 + nameLength),
      method,
      size,
      read() {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + packed);
        return method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
      },
    });
    o += 46 + nameLength + extra + comment;
  }
  return out;
}

// ---- the run

const office = await launchOffice();
const { work } = office;
const fx = (name) => path.join(work, name);
let failed = null;
try {
  fs.mkdirSync(fx('archive'));
  const docx = fx('年报.docx');
  await makeDocx(docx, KNOWN_BODY, { 'image1.png': PNG });
  const pdf = fx('a.pdf');
  await makePdf(pdf, [['First page of the sample.', 'It has two lines.'], ['Second page.'], ['Third and last page.']]);
  fs.writeFileSync(fx('pic.png'), PNG);
  fs.writeFileSync(fx('notes.md'), '# 发布计划\n\n## 目标\n\n- 十二月上线\n- 覆盖三个市场\n');
  fs.writeFileSync(fx('memo.txt'), '会议纪要\n\n今天讨论了第三季度的数据，大家认为华东区最好。\n'.repeat(40));
  fs.writeFileSync(path.join(fx('archive'), 'memo.txt'), 'An older memo with the same name.\n');
  fs.writeFileSync(fx('data.csv'), 'name,value\na,1\nb,2\n');
  fs.writeFileSync(fx('noise.jpg'), crypto.randomBytes(30_000)); // not a picture anyone can open; it only has to be packed
  const selection = [fx('memo.txt'), path.join(fx('archive'), 'memo.txt'), docx, pdf, fx('pic.png'), fx('notes.md'), fx('data.csv'), fx('noise.jpg')];
  const before = selection.map(sha);

  console.log('▸ several files of any kind: one ZIP next to the first, every file in it byte for byte');
  const zipped = await office.ok('files.zip', { files: selection });
  assert.ok(zipped.offers.indexOf('files.zip') >= 0 && zipped.offers.indexOf('files.zip') < 4, `packing is one of the first four offers: ${zipped.offers.join(', ')}`);
  assert.ok(zipped.offers.includes('files.names'));
  assert.equal(zipped.result.kind, 'file');
  assert.equal(zipped.result.path, fx('memo 等 8 个文件.zip'));
  const zipBytes = fs.readFileSync(zipped.result.path);
  const entries = zipEntries(zipBytes);
  assert.deepEqual(entries.map((e) => e.name), ['memo.txt', 'memo (2).txt', '年报.docx', 'a.pdf', 'pic.png', 'notes.md', 'data.csv', 'noise.jpg'], 'flat, in the order selected, the second memo.txt under a name of its own');
  entries.forEach((e, i) => {
    assert.equal(e.method, 8, `${e.name} is DEFLATE`);
    assert.equal(e.size, fs.statSync(selection[i]).size, e.name);
    assert.ok(e.read().equals(fs.readFileSync(selection[i])), `${e.name}: what zlib gets out of the archive is the file`);
  });
  const viaJszip = await JSZip.loadAsync(zipBytes);
  assert.ok((await viaJszip.file('年报.docx').async('nodebuffer')).equals(fs.readFileSync(docx)), 'JSZip reads the same');
  const total = selection.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  assert.ok(zipBytes.length < total, `${zipBytes.length} < ${total}`);
  assert.match(zipped.result.message, /^把 8 个文件打包成了一个 ZIP：[\d.]+ KB → [\d.]+ KB（小了 \d+%）。有 1 个文件和别的文件重名，在包里的名字后面加了序号。原文件没有改动。$/);
  console.log(`  ${path.basename(zipped.result.path)}: ${total} -> ${zipBytes.length} bytes. ${zipped.result.message}`);
  const zippedAgain = await office.ok('files.zip', { files: selection });
  assert.equal(zippedAgain.result.path, fx('memo 等 8 个文件 (2).zip'), 'nothing is overwritten');
  assert.ok(fs.readFileSync(zipped.result.path).equals(zipBytes));

  console.log('▸ the names of the selected files, one per line');
  const names = await office.ok('files.names', { files: selection });
  assert.deepEqual(names.result, { kind: 'clipboard', text: 'memo.txt\nmemo.txt\n年报.docx\na.pdf\npic.png\nnotes.md\ndata.csv\nnoise.jpg', message: '复制了 8 个文件名，每行一个' });
  assert.ok(!(await office.offers({ files: [pdf] })).some((id) => id === 'files.zip' || id === 'files.names'), 'one file is nothing to pack or list');

  console.log('▸ one Word document: what is offered, and its numbers');
  const counted = await office.ok('word.count', { files: [docx] });
  assert.deepEqual(counted.offers.slice(0, 4), ['files.pdf', 'word.restyle', 'word.count', 'files.pptx'], 'to PDF and restyle stay first, then the count and the slides');
  for (const id of ['doc.summary', 'word.markdown', 'word.text', 'word.images']) assert.ok(counted.offers.indexOf(id) >= 4, `${id} is behind "更多"`);
  assert.deepEqual(counted.result, { kind: 'info', message: KNOWN_COUNT });
  console.log('  ' + counted.result.message.replace(/\n/g, ' / '));

  console.log('▸ its text as a txt: line breaks and tabs kept, the table row by row');
  const texted = await office.ok('word.text', { files: [docx] });
  assert.equal(texted.result.path, fx('年报.txt'));
  assert.equal(fs.readFileSync(texted.result.path, 'utf8'), KNOWN_TEXT + '\n');
  assert.equal(texted.result.message, '导出了 8 段文字，共 38 个字符（不计空格）。1 个表格按行导出，同一行的格子之间用制表符隔开。1 张图片没有带过去。字体和版式没有保留，页眉、页脚和脚注不在内。');
  console.log(`  ${texted.result.message}`);

  console.log('▸ its pictures: the stored file itself, in a new folder');
  const pictures = await office.ok('word.images', { files: [docx] });
  assert.equal(pictures.result.kind, 'folder');
  assert.equal(pictures.result.path, fx('年报 图片'));
  assert.deepEqual(fs.readdirSync(pictures.result.path), ['image1.png']);
  assert.ok(fs.readFileSync(path.join(pictures.result.path, 'image1.png')).equals(PNG), 'byte for byte the picture that was put into the document');
  assert.equal(pictures.result.message, `导出了 1 张图片，共 ${PNG.length} 字节：是文档里存的原件，没有重新压缩，文件名也是文档里的。`);
  console.log(`  ${pictures.result.message}`);
  const plain = fx('plain.docx');
  await makeDocx(plain, para(run('没有图片的文档。')));
  const listing = fs.readdirSync(work).sort();
  const noPictures = await office.run('word.images', { files: [plain] });
  assert.equal(noPictures.error, '这个文档里没有图片');
  fs.writeFileSync(fx('broken.docx'), 'this is not a Word document');
  for (const id of ['word.count', 'word.text', 'word.images', 'doc.summary']) {
    const r = await office.run(id, { files: [fx('broken.docx')] });
    assert.match(r.error ?? '', /^打不开这个 Word 文档：broken\.docx/, `${id}: ${r.error ?? JSON.stringify(r.result)}`);
  }
  assert.deepEqual(fs.readdirSync(work).sort(), [...listing, 'broken.docx'].sort(), 'a refusal leaves nothing behind');
  console.log(`  ${path.basename(plain)}: ${noPictures.error}`);

  console.log('▸ a document for the model: the whole of a short one, the first 4000 characters of a long one');
  const shortPdf = await office.ok('doc.summary', { files: [pdf] });
  assert.deepEqual(Object.keys(shortPdf.result), ['kind', 'question']);
  assert.equal(shortPdf.result.kind, 'ask');
  assert.equal(shortPdf.result.question.split('\n')[0], '下面是文档《a.pdf》的全部文字。用 3 到 5 条简短的要点总结，每条一行，用文档本身的语言；只输出要点，不要开场白。');
  assert.equal(bodyOf(shortPdf.result.question), 'First page of the sample.\nIt has two lines.\nSecond page.\nThird and last page.', 'the text pdf.js reads from the three pages');

  // 30 pages of 50 numbered lines: about 3,400 characters a page
  const longPdf = fx('long.pdf');
  const lineOf = (p, l) => `Page ${p} line ${l}: the quick brown fox jumps over the lazy dog again.`;
  await makePdf(longPdf, Array.from({ length: 30 }, (_p, p) => Array.from({ length: 50 }, (_l, l) => lineOf(p + 1, l + 1))));
  const long = await office.ok('doc.summary', { files: [longPdf] });
  assert.equal(long.result.note, '只读了前 4000 字');
  assert.equal(long.result.question.split('\n')[0], '下面是文档《long.pdf》开头的 4000 字（文档更长，后面的内容没有给你）。只根据这一部分，用 3 到 5 条简短的要点总结，每条一行，用文档本身的语言；最后另起一行写上“（只读了前 4000 字）”。');
  const everyLine = Array.from({ length: 30 }, (_p, p) => Array.from({ length: 50 }, (_l, l) => lineOf(p + 1, l + 1))).flat().join('\n');
  assert.equal(bodyOf(long.result.question), everyLine.slice(0, 4000).trim(), 'exactly the beginning of the text of the PDF, line for line');
  assert.ok(bodyOf(long.result.question).includes('Page 2 line 1:'), 'it runs on into the second page');
  console.log(`  long.pdf: ${long.result.note}; the question has ${long.result.question.length} characters`);

  const scan = fx('scan.pdf');
  await makeScan(scan);
  assert.equal((await office.run('doc.summary', { files: [scan] })).error, '这个 PDF 里没有可以提取的文字（可能是扫描件）');
  fs.writeFileSync(fx('broken.pdf'), 'this is not a pdf');
  assert.match((await office.run('doc.summary', { files: [fx('broken.pdf')] })).error ?? '', /^打不开这个 PDF/);

  const wordQuestion = await office.ok('doc.summary', { files: [docx] });
  assert.equal(wordQuestion.result.note, undefined);
  assert.equal(bodyOf(wordQuestion.result.question), KNOWN_TEXT);
  const mdQuestion = await office.ok('doc.summary', { files: [fx('notes.md')] });
  assert.equal(bodyOf(mdQuestion.result.question), '# 发布计划\n\n## 目标\n\n- 十二月上线\n- 覆盖三个市场');
  const memo = await office.ok('doc.summary', { files: [fx('memo.txt')] });
  assert.deepEqual(memo.offers.slice(0, 4), ['file.typeset', 'files.pdf', 'files.pptx', 'doc.summary'], 'a text file: the summary is the fourth offer');
  assert.equal(memo.result.note, undefined, 'about 1,300 characters: all of it');

  console.log('▸ a PDF printed by the app from Chinese text, read back for the model');
  const chinese = fx('长文.md');
  // 一, 大, 风, 日, 月 and their like are the characters a PDF hands back as look-alike radicals
  const sentence = (i) => `第 ${i} 段：一个大的风险是供应链交付存在不确定性，需要在本月十日前锁定备选供应商。`;
  fs.writeFileSync(chinese, '# 风险报告\n\n' + Array.from({ length: 200 }, (_x, i) => sentence(i + 1)).join('\n\n') + '\n');
  const printed = await office.ok('files.pdf', { files: [chinese] });
  const fromPrinted = await office.ok('doc.summary', { files: [printed.result.path] });
  assert.equal(fromPrinted.result.note, '只读了前 4000 字');
  const printedBody = bodyOf(fromPrinted.result.question);
  assert.ok([...printedBody].length <= 4000 && [...printedBody].length >= 3990, `${[...printedBody].length} characters`);
  const squeezed = printedBody.replace(/\s+/g, '');
  assert.ok(squeezed.startsWith('风险报告第1段：一个大的风险是供应链交付存在不确定性，需要在本月十日前锁定备选供应商。第2段：'), `the Chinese text comes back out of the PDF: ${squeezed.slice(0, 60)}`);
  assert.ok(!/[\u2e80-\u2fdf]/.test(printedBody), 'as ordinary characters, not as the radicals that look like them');
  console.log(`  ${path.basename(printed.result.path)}: ${fromPrinted.result.note}; it begins "${squeezed.slice(0, 24)}…"`);

  console.log('▸ selected text: what is offered, the counts, the sum, the lines joined');
  const passage = "你好，world！这是 2026-11-13 的 Q3 报告 v2。\n\n第二段 don't stop，共 1,234.5 元。";
  const count = await office.ok('text.count', { text: passage });
  assert.deepEqual(count.offers.slice(0, 4), ['text.typeset', 'text.explain', 'text.translate', 'text.count'], 'one number: the count is the fourth offer');
  assert.deepEqual(count.result, { kind: 'info', message: '字数 24（中文按字算，英文和数字按词算）\n字符 61，不计空格 52\n汉字 12，英文单词 5，数字 2\n行 2（另有空行 1），段落 2' });
  assert.ok(!count.offers.includes('text.sum'), 'a date and one amount are nothing to add up');

  const report = '会议 2026-11-13 12:30 开始，电话 13800138000。\n1. 华东区收入 1,902 万元，同比增长 31%；\n2. 华北区收入 1,500.5 万元；\n3. 华南区亏损 -300 万元。';
  const sum = await office.ok('text.sum', { text: report });
  assert.deepEqual(sum.offers.slice(0, 4), ['text.typeset', 'text.explain', 'text.translate', 'text.sum'], 'numbers in a text: the sum is the fourth offer');
  assert.deepEqual(sum.result, { kind: 'info', message: '3 个数，合计 3,102.5 万元\n平均约 1,034.167 万元，最大 1,902 万元，最小 -300 万元\n另有 1 个百分数没有加进去；不算在内：1 个日期、1 个时间、1 个电话号码、3 个序号', copy: '3102.5' });
  console.log('  ' + sum.result.message.replace(/\n/g, ' / '));

  const column = '苹果\t12.5\n香蕉\t15\n橘子\t18';
  const columnSum = await office.ok('text.sum', { text: column });
  assert.equal(columnSum.offers[0], 'text.sum', `mostly numbers: the sum comes first: ${columnSum.offers.join(', ')}`);
  assert.deepEqual(columnSum.offers.slice(1, 4), ['text.typeset', 'text.explain', 'text.translate']);
  assert.deepEqual(columnSum.result, { kind: 'info', message: '3 个数，合计 45.5\n平均约 15.167，最大 18，最小 12.5', copy: '45.5' });
  assert.deepEqual((await office.offers({ text: report })).slice(0, 4), ['text.typeset', 'text.explain', 'text.translate', 'text.sum'], 'and is back in fourth place for the next selection');

  const broken = '这是从 PDF 里复制的，\n每一行都断开了。\nThe exam-\nple continues\nhere.';
  const joined = await office.ok('text.oneline', { text: broken });
  assert.deepEqual(joined.result, { kind: 'clipboard', text: '这是从 PDF 里复制的，每一行都断开了。The example continues here.', message: '把 5 行合并成了一段，接上了 1 个在行尾用连字符断开的单词' });
  assert.ok(!(await office.offers({ text: '只有一行' })).includes('text.oneline'));

  const essay = '我们今天讨论了第三季度的数据，大家都认为华东区的表现是最好的，同比增长了百分之三十一，但是华南区出现了亏损，需要在下个季度重点关注并制定改进的方案。';
  const polish = await office.ok('text.polish', { text: essay });
  assert.deepEqual(Object.keys(polish.result), ['kind', 'question']);
  assert.match(polish.result.question.split('\n')[0], /^润色下面这段文字：.*只输出润色后的文字，不要解释。$/);
  assert.equal(bodyOf(polish.result.question), essay);
  const points = await office.ok('text.summary', { text: essay.repeat(2) });
  assert.match(points.result.question.split('\n')[0], /^用 3 到 5 条简短的要点总结下面这段文字/);
  assert.equal(bodyOf(points.result.question), essay.repeat(2));

  assert.deepEqual(selection.map(sha), before, 'the originals are untouched by all of this');
  console.log(`\n✔ office-docs checks passed${process.env.KEEP ? `. Results in ${work}` : ''}`);
} catch (err) {
  failed = err;
  console.error('\n✘ ' + (err.stack ?? err));
  console.error(`Results so far are in ${work}`);
} finally {
  await office.close();
}
if (!failed && !process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
