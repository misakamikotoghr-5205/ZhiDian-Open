// Runs every office action inside the real app, on real files, and checks what comes out by
// opening it again: page counts of the PDFs, slides inside the .pptx, the words of the Word
// document before and after. No model is involved in any of this.
//
//   xvfb-run -a node test/e2e/office.mjs [folder with fixtures]
//
// Without a folder it makes its own small set of files.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

// ---- fixtures
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-office-'));
const given = process.argv[2];
const fx = (name) => path.join(work, name);
if (given) for (const n of fs.readdirSync(given)) fs.copyFileSync(path.join(given, n), fx(n));

async function makePdf(file, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`Sample page ${i} of ${pages}`, { x: 60, y: 760, size: 24, font });
  fs.writeFileSync(file, await doc.save());
}
// A 2x2 red PNG, enough to be a picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8DAwMDAxMAAAAYIAQMd3rB0AAAAAElFTkSuQmCC', 'base64');
async function makeDocx(file) {
  // The smallest valid Word document: a title, a numbered heading, body text with a hand-made
  // indent and odd fonts, an empty paragraph, and a table.
  const run = (text, props = '') => `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const para = (inner, pPr = '') => `<w:p><w:pPr>${pPr}</w:pPr>${inner}</w:p>`;
  const cell = (text) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(run(text, '<w:sz w:val="18"/>'))}</w:tc>`;
  const body = [
    para(run('年度工作报告', '<w:rFonts w:ascii="Comic Sans MS" w:eastAsia="楷体"/><w:color w:val="C00000"/><w:sz w:val="40"/>'), '<w:jc w:val="center"/>'),
    para(''),
    para(run('一、基本情况', '<w:b/><w:sz w:val="28"/>')),
    para(run('　　今年完成了全部既定目标，', '<w:rFonts w:eastAsia="仿宋"/><w:sz w:val="30"/><w:highlight w:val="yellow"/>') + run('客户满意度', '<w:i/>') + run('达到历史最高。', '<w:sz w:val="18"/>'), '<w:spacing w:line="200" w:lineRule="exact"/>'),
    para(''),
    para(''),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tr>${cell('指标')}${cell('数值')}</w:tr><w:tr>${cell('收入')}${cell('1,902')}</w:tr></w:tbl>`,
    para(run('二、下一步', '<w:b/>')),
    para(run('继续扩大市场份额。')),
  ].join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}
if (!given) {
  await makePdf(fx('a.pdf'), 2);
  await makePdf(fx('b.pdf'), 3);
  fs.writeFileSync(fx('pic.png'), PNG);
  await makeDocx(fx('report.docx'));
  fs.writeFileSync(fx('notes.md'), '# 发布计划\n\n## 目标\n\n- 十二月上线\n- 覆盖三个市场\n\n## 风险\n\n供应链交付存在不确定性，需要提前两周锁定备选供应商，并且每周同步一次进度，出现延误时立即启动应急方案，由项目经理直接向管理层汇报。\n');
  fs.writeFileSync(fx('memo.txt'), '会议纪要\n\n今天讨论了Q3的数据,大家认为华东区最好(同比增长31%).\n');
}
const first = (re) => fs.readdirSync(work).find((n) => re.test(n));
const docx = fx(first(/\.docx$/)), md = fx(first(/\.md$/)), txt = fx(first(/\.txt$/)), png = fx(first(/\.png$/));
const pdfs = fs.readdirSync(work).filter((n) => /\.pdf$/.test(n)).map(fx);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-office-ud-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ seenIntro: true, mcp: { enabled: false } }));
const app = await electron.launch({
  executablePath: require('electron'), // in plain Node this is the path of the Electron binary
  args: ['--no-sandbox', repo, '--rehearse'],
  env: { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData, ZHIDIAN_LOCAL_DIR: path.join(userData, 'local') },
});
await (await app.firstWindow()).waitForLoadState('domcontentloaded');
const run = (id, input) =>
  app.evaluate(async (_e, [actionId, given]) => {
    const office = globalThis.__zhidian.office;
    const context = office.context(given);
    const offers = office.offers(context).map((o) => o.id);
    if (!offers.includes(actionId)) return { error: `"${actionId}" is not offered for this selection; offered: ${offers.join(', ')}` };
    try {
      return { offers, result: await office.run(actionId, context) };
    } catch (err) {
      return { offers, error: String(err?.message ?? err) };
    }
  }, [id, input]);
const ok = async (id, input) => {
  const r = await run(id, input);
  assert.ok(!r.error, `${id}: ${r.error}`);
  return r;
};
const pagesOf = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPageCount();
const slidesOf = async (file) => Object.keys((await JSZip.loadAsync(fs.readFileSync(file))).files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
const words = (s) => s.replace(/[\s　 ]+/g, '');

let failed = null;
const made = [];
try {
  console.log('▸ several files into one PDF: pages of the PDFs, one page per picture, the documents printed');
  const expectPdfPages = (await Promise.all(pdfs.map(pagesOf))).reduce((a, b) => a + b, 0);
  const merged = await ok('files.pdf', { files: [...pdfs, png, docx, md, txt] });
  assert.equal(merged.result.kind, 'file');
  made.push(merged.result.path);
  const mergedPages = await pagesOf(merged.result.path);
  assert.ok(mergedPages >= expectPdfPages + 4, `${mergedPages} pages: the ${expectPdfPages} PDF pages, 1 picture and at least one page per document`);
  assert.equal(path.dirname(merged.result.path), work, 'the result is written next to the originals');
  assert.deepEqual(merged.offers.slice(0, 2), ['files.pdf', 'files.pptx'], 'several files: merge or make slides come first');
  console.log(`  ${path.basename(merged.result.path)}: ${mergedPages} pages. ${merged.result.message}`);

  console.log('▸ nothing is overwritten: doing it again gives a second file');
  const again = await ok('files.pdf', { files: [...pdfs, png, docx, md, txt] });
  made.push(again.result.path);
  assert.notEqual(again.result.path, merged.result.path);

  console.log('▸ several files into slides: every PDF page and picture is a slide, documents are split by headings');
  const deck = await ok('files.pptx', { files: [...pdfs, png, docx, md] });
  made.push(deck.result.path);
  const slides = await slidesOf(deck.result.path);
  assert.ok(slides >= expectPdfPages + 1 + 4, `${slides} slides`);
  console.log(`  ${path.basename(deck.result.path)}: ${slides} slides. ${deck.result.message}`);

  console.log('▸ one Word document: the offers, and "一键排版" keeps every word while replacing the formatting');
  const restyled = await ok('word.restyle', { files: [docx] });
  made.push(restyled.result.path);
  assert.deepEqual(restyled.offers.slice(0, 2), ['files.pdf', 'word.restyle'], 'a Word document: to PDF and restyle come first');
  for (const id of ['word.markdown', 'files.pptx']) assert.ok(restyled.offers.includes(id), id);
  const before = (await mammoth.extractRawText({ path: docx })).value;
  const after = (await mammoth.extractRawText({ path: restyled.result.path })).value;
  assert.equal(words(after), words(before), 'the text is the same');
  const zip = await JSZip.loadAsync(fs.readFileSync(restyled.result.path));
  const docXml = await zip.file('word/document.xml').async('string');
  const stylesXml = await zip.file('word/styles.xml').async('string');
  assert.ok(!/Comic Sans|w:highlight|w:color w:val="C00000"/.test(docXml), 'stray fonts, colours and highlights are gone');
  assert.ok(/w:eastAsia="宋体"/.test(stylesXml) && /w:eastAsia="黑体"/.test(stylesXml), 'body and heading fonts are set in the styles');
  assert.ok(/w:pgSz w:w="11906" w:h="16838"/.test(docXml), 'the page is A4');
  assert.notEqual(restyled.result.path, docx);
  assert.equal(words((await mammoth.extractRawText({ path: docx })).value), words(before), 'the original file is untouched');
  console.log(`  ${restyled.result.message}`);

  console.log('▸ one Word document to PDF, to Markdown and to slides');
  const wordPdf = await ok('files.pdf', { files: [docx] });
  made.push(wordPdf.result.path);
  assert.ok((await pagesOf(wordPdf.result.path)) >= 1);
  const wordMd = await ok('word.markdown', { files: [docx] });
  made.push(wordMd.result.path);
  const mdText = fs.readFileSync(wordMd.result.path, 'utf8');
  assert.match(mdText, /^# /m, 'the title became a heading');
  assert.match(mdText, /\| --- \|/, 'the table became a Markdown table');
  const wordDeck = await ok('files.pptx', { files: [docx] });
  made.push(wordDeck.result.path);
  assert.ok((await slidesOf(wordDeck.result.path)) >= 3);

  console.log('▸ one PDF: slides, and its text');
  const pdfDeck = await ok('files.pptx', { files: [pdfs[0]] });
  made.push(pdfDeck.result.path);
  assert.equal(await slidesOf(pdfDeck.result.path), (await pagesOf(pdfs[0])) + 1, 'a cover and one slide per page');
  const pdfText = await ok('pdf.text', { files: [pdfs[0]] });
  made.push(pdfText.result.path);
  assert.ok(fs.readFileSync(pdfText.result.path, 'utf8').trim().length > 10);

  console.log('▸ a text file and selected text: "自动排版" changes spacing and punctuation only');
  const tidied = await ok('file.typeset', { files: [txt] });
  made.push(tidied.result.path);
  const tidy = fs.readFileSync(tidied.result.path, 'utf8');
  assert.ok(!/,大家|\(同比/.test(tidy) && /，/.test(tidy), tidy);
  const sel = await ok('text.typeset', { text: '我们用Python训练了一个LoRA,速度提升50 %.' });
  assert.equal(sel.result.kind, 'clipboard');
  assert.equal(sel.result.text, '我们用 Python 训练了一个 LoRA，速度提升 50%。');

  console.log('▸ what cannot be handled says so');
  fs.writeFileSync(fx('thing.xyz'), 'x');
  const none = await run('files.pdf', { files: [fx('thing.xyz')] });
  assert.match(none.error, /not offered/);
  fs.writeFileSync(fx('broken.pdf'), 'this is not a pdf');
  const mixed = await ok('files.pdf', { files: [pdfs[0], fx('broken.pdf')] });
  made.push(mixed.result.path);
  assert.match(mixed.result.message, /broken\.pdf/, 'the file that could not be read is named: ' + mixed.result.message);

  console.log(`\n✔ office checks passed. Results in ${work}`);
} catch (err) {
  failed = err;
  console.error('\n✘ ' + (err.stack ?? err));
} finally {
  await app.close().catch(() => {});
}
if (process.env.OFFICE_OUT) {
  fs.mkdirSync(process.env.OFFICE_OUT, { recursive: true });
  for (const f of made) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(process.env.OFFICE_OUT, path.basename(f)));
}
process.exit(failed ? 1 : 0);
