// Cross-review regression and coverage suite for:
//   - src/main/office/tools-basic.js (all 9 actions)
//   - src/main/office/{pdf,pptx,restyle,convert,index}.js
//   - src/core/{office-kinds,typeset}.js
//   - macOS NSAppleEventsUsageDescription packaging (--extend-info build/macos-info.plist)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { DOMParser } from '@xmldom/xmldom';
import plist from 'plist';
import { describeFiles, resultName, summarize } from '../src/core/office-kinds.js';
import { typeset } from '../src/core/typeset.js';
import { docxToMarkdown, fileToHtml, injectBaseHref, outlineOf } from '../src/main/office/convert.js';
import { Office, freePath } from '../src/main/office/index.js';
import { filesToPdf } from '../src/main/office/pdf.js';
import { filesToPptx } from '../src/main/office/pptx.js';
import { restyleDocx } from '../src/main/office/restyle.js';
import { writeXlsx } from '../src/main/office/sheet.js';
import { actions as basic } from '../src/main/office/tools-basic.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-basic-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let cases = 0;
const freshDir = () => {
  const dir = path.join(root, `case-${++cases}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const action = (id) => basic.find((a) => a.id === id);

// Valid 2x2 red PNG and valid complete minimal 1x1 JPEG (with SOI FF D8 ... EOI FF D9).
const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8DAwMDAxMAAAAYIAQMd3rB0AAAAAElFTkSuQmCC', 'base64');
const VALID_JPEG = Buffer.concat([
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    'base64',
  ),
  Buffer.from([0xff, 0xd9]),
]);
const ZERO_PAGE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\nxref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n115\n%%EOF\n',
);

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

async function makeSimpleDocx(bodyInner, { withStyles = true, selfClosingRels = false } = {}) {
  const zip = new JSZip();
  if (selfClosingRels) {
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL}"/>`);
  } else {
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL}"></Relationships>`);
  }
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/></Relationships>`);
  if (withStyles) {
    zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}"></w:styles>`);
  }
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:r="${REL_NS}"><w:body>${bodyInner}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeOnePagePdf(text = 'Page') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  page.drawText(text, { x: 40, y: 200, size: 14 });
  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------- filename & path safety

test('freePath, summarize, resultName and Office folder/save resist lone surrogates, dotfiles, device names and traversal', async () => {
  const dir = freshDir();

  // 130 emoji = 260 UTF-16 code units; cutting at 120 must keep code points intact, never lone surrogates.
  const longEmoji = `${'📄'.repeat(130)}.pdf`;
  const p1 = freePath(dir, longEmoji);
  assert.equal(path.basename(p1).isWellFormed(), true);
  assert.equal(path.basename(p1), `${'📄'.repeat(120)}.pdf`);

  // Dotfiles keep their extension on first save and on collision.
  const dot1 = freePath(dir, '.pdf');
  assert.equal(path.basename(dot1), '结果.pdf');
  fs.writeFileSync(dot1, 'a');
  const dot2 = freePath(dir, '.pdf');
  assert.equal(path.basename(dot2), '结果 (2).pdf');
  assert.equal(resultName(describeFiles(['/tmp/.md']), '', 'pdf'), '结果.pdf');
  assert.equal(resultName(describeFiles(['/tmp/.hidden.md']), '', 'pdf'), '.hidden.pdf');

  // Path traversal, control chars, trailing dots/spaces and Windows device names stay inside `dir`.
  for (const unsafe of ['../outside.pdf', '..\\outside.pdf', 'CON.txt', 'lpt1.pdf', 'bad\u0000name\u007f.txt', 'trailing... .pdf', '..']) {
    const target = freePath(dir, unsafe);
    assert.equal(path.dirname(target), dir, unsafe);
    assert.equal(path.basename(target).isWellFormed(), true, unsafe);
    assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(path.basename(target)), unsafe);
  }

  // summarize slices by code points, never splitting astral characters.
  const summary = summarize({ kind: 'text', text: '𠮷'.repeat(30) });
  assert.equal(summary.isWellFormed(), true);
  assert.match(summary, /^选中的文字（30 字）：𠮷{26}…$/u);

  // Office.run folder('..') stays inside `dir` and never reuses an existing directory.
  const customAction = {
    id: 'custom.folder',
    label: '测试',
    hint: '测试文件夹安全性',
    rank: 1,
    applies: () => true,
    async run(_ctx, env) {
      return { kind: 'folder', path: env.folder('..'), message: '完成' };
    },
  };
  const src = path.join(dir, 'note.txt');
  fs.writeFileSync(src, 'hello world');
  const office = new Office({ documentsDir: dir, tools: {}, actions: [customAction] });
  const f1 = await office.run('custom.folder', office.context({ files: [src] }));
  const f2 = await office.run('custom.folder', office.context({ files: [src] }));
  assert.equal(path.dirname(f1.path), dir);
  assert.equal(path.basename(f1.path), '新建文件夹');
  assert.equal(path.basename(f2.path), '新建文件夹 (2)');
});

// ---------------------------------------------------------------- files.pdf & sheet/0-page PDF

test('files.pdf merges PDFs, images, Word and spreadsheets (CSV/XLSX), and rejects 0-page PDFs cleanly', async () => {
  const dir = freshDir();
  const pdf1 = path.join(dir, 'one.pdf');
  const png = path.join(dir, 'pic.png');
  const csv = path.join(dir, 'sales.csv');
  const xlsx = path.join(dir, 'book.xlsx');
  const zeroPdf = path.join(dir, 'zero.pdf');
  fs.writeFileSync(pdf1, await makeOnePagePdf('P1'));
  fs.writeFileSync(png, VALID_PNG);
  fs.writeFileSync(csv, '月份,收入\n1月,100\n2月,200\n');
  fs.writeFileSync(xlsx, await writeXlsx([{ name: '季度', rows: [['项目', '金额'], ['A', 50]] }]));
  fs.writeFileSync(zeroPdf, ZERO_PAGE_PDF);

  const allPaths = [pdf1, png, csv, xlsx, zeroPdf];
  const hashesBefore = allPaths.map(sha);

  const htmlPrinted = [];
  const office = new Office({
    documentsDir: dir,
    tools: {
      htmlToPdf: async (html) => {
        htmlPrinted.push(html);
        return makeOnePagePdf('HTML');
      },
      decodeImage: async () => ({ buffer: VALID_PNG }),
    },
  });

  const ctx = office.context({ files: allPaths });
  const res = await office.run('files.pdf', ctx, { has: { office: false, model: false } });
  assert.equal(res.kind, 'file');
  assert.equal((await PDFDocument.load(fs.readFileSync(res.path))).getPageCount(), 4);
  assert.match(res.message, /合并了 4 个文件，共 4 页/);
  assert.match(res.message, /zero\.pdf（这个 PDF 里没有页面）/);
  assert.equal(htmlPrinted.length, 2, 'both CSV and XLSX rendered through built-in HTML table printer');
  assert.match(htmlPrinted[0], /<table><thead><tr><th>月份<\/th><th>收入<\/th><\/tr><\/thead>/);
  assert.match(htmlPrinted[1], /<th>项目<\/th><th>金额<\/th>/);
  assert.deepEqual(allPaths.map(sha), hashesBefore, 'source files untouched');

  // 0-page PDF alone fails with a specific Chinese message.
  await assert.rejects(
    office.run('files.pdf', office.context({ files: [pdf1, zeroPdf] }), { has: { office: false } }).then(() =>
      filesToPdf(describeFiles([zeroPdf]), { documentPdf: async () => Buffer.alloc(0), decodeImage: async () => ({ buffer: VALID_PNG }) }),
    ),
    /这个 PDF 里没有页面/,
  );
});

// ---------------------------------------------------------------- files.pptx edge cases

test('files.pptx validates PNG/JPEG bytes, handles disguised JPEGs and 0xff fill bytes, rejects empty inputs, and reports exact cover count', async () => {
  const dir = freshDir();
  const emptyPng = path.join(dir, 'empty.png');
  const badPng = path.join(dir, 'bad.png');
  const disguised = path.join(dir, 'disguised.png'); // real JPEG bytes named .png
  const fillJpeg = path.join(dir, 'fill.jpg'); // JPEG with extra 0xff fill bytes before SOF
  const emptyTxt = path.join(dir, 'empty.txt');
  const zeroPdf = path.join(dir, 'zero.pdf');

  fs.writeFileSync(emptyPng, '');
  fs.writeFileSync(badPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  fs.writeFileSync(disguised, VALID_JPEG);
  // Inject two 0xff fill bytes right after SOI (FF D8): valid per ITU T.81 B.1.1.2.
  fs.writeFileSync(fillJpeg, Buffer.concat([VALID_JPEG.subarray(0, 2), Buffer.from([0xff, 0xff]), VALID_JPEG.subarray(2)]));
  fs.writeFileSync(emptyTxt, '   \n\t  ');
  fs.writeFileSync(zeroPdf, 'placeholder');

  const decodeReject = async () => {
    throw new Error('这张图片读不出来：文件是空的、已损坏，或不是图片');
  };

  // Corrupt or 0-byte .png alone must fail cleanly, never write a broken .pptx.
  await assert.rejects(
    filesToPptx(describeFiles([emptyPng]), { outlineOf, openPdf: async () => ({ pages: 0, close: async () => {} }), decodeImage: decodeReject }),
    /没有一个文件能做成幻灯片.*empty\.png/,
  );
  await assert.rejects(
    filesToPptx(describeFiles([badPng]), { outlineOf, openPdf: async () => ({ pages: 0, close: async () => {} }), decodeImage: decodeReject }),
    /bad\.png/,
  );
  await assert.rejects(
    filesToPptx(describeFiles([emptyTxt]), { outlineOf, openPdf: async () => ({ pages: 0, close: async () => {} }), decodeImage: decodeReject }),
    /这个文档里没有内容/,
  );
  await assert.rejects(
    filesToPptx(describeFiles([zeroPdf]), { outlineOf, openPdf: async () => ({ pages: 0, close: async () => {} }), decodeImage: decodeReject }),
    /这个 PDF 里没有页面/,
  );

  // Mixed selection: 2 valid images (disguised JPEG + 0xff-padded JPEG) + 1 broken PNG -> cover subtitle says "2 个文件", not "3 个文件"!
  const deck = await filesToPptx(
    describeFiles([disguised, fillJpeg, badPng]),
    { outlineOf, openPdf: async () => ({ pages: 0, close: async () => {} }), decodeImage: decodeReject },
    { title: '图集' },
  );
  assert.equal(deck.slides, 3); // cover + 2 pictures
  assert.deepEqual(deck.used, ['disguised.png', 'fill.jpg']);
  assert.equal(deck.skipped.length, 1);
  const zip = await JSZip.loadAsync(deck.buffer);
  const slide1Xml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(slide1Xml, /2 个文件/);
  assert.doesNotMatch(slide1Xml, /3 个文件/);
  // Disguised JPEG named .png was embedded as .jpeg media, not mislabeled as .png.
  const mediaNames = Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/') && !zip.files[n].dir);
  assert.equal(mediaNames.length, 2);
  assert.ok(mediaNames.every((n) => /\.jpe?g$/i.test(n)), `media stored with true format: ${mediaNames.join(', ')}`);
});

// ---------------------------------------------------------------- word.restyle, word.markdown & convert.js

test('restyleDocx links styles.xml on self-closing .rels, preserves space after inline drawing, isolates textboxes, and refuses CFB encrypted docs', async () => {
  // 1. Self-closing <Relationships/> and <Types/> without word/styles.xml, plus inline drawing followed by " 图注", plus nested textbox.
  const drawingRun = '<w:r><w:drawing><w:txbxContent><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>框内加粗</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r>';
  const body = [
    '<w:p><w:r><w:t>年度报告</w:t></w:r></w:p>',
    `<w:p>${drawingRun}<w:r><w:t xml:space="preserve"> 图注说明文字。</w:t></w:r></w:p>`,
    '<w:p><w:r><w:t>　　第二段原本手打了两个全角空格。</w:t></w:r></w:p>',
  ].join('');
  const raw = await makeSimpleDocx(body, { withStyles: false, selfClosingRels: true });
  const { buffer, counts } = await restyleDocx(raw);
  assert.equal(counts.title, 1);

  const outZip = await JSZip.loadAsync(buffer);
  assert.ok(outZip.file('word/styles.xml'), 'styles.xml created');
  const relsXml = await outZip.file('word/_rels/document.xml.rels').async('string');
  const relsDoc = new DOMParser().parseFromString(relsXml, 'text/xml');
  const targets = Array.from(relsDoc.getElementsByTagName('Relationship')).map((r) => r.getAttribute('Target'));
  assert.ok(targets.includes('styles.xml'), `styles.xml registered in self-closing rels: ${relsXml}`);

  const typesXml = await outZip.file('[Content_Types].xml').async('string');
  assert.match(typesXml, /PartName="\/word\/styles\.xml"/);

  const docXml = await outZip.file('word/document.xml').async('string');
  assert.match(docXml, /> 图注说明文字。</, 'intentional space right after inline drawing is preserved');
  assert.match(docXml, />第二段原本手打了两个全角空格。</, 'hand-made full-width leading spaces are stripped');
  assert.match(docXml, /<w:txbxContent>[\s\S]*<w:b\/>[\s\S]*框内加粗/, 'bold inside nested textbox is preserved');

  // 2. CFB/OLE2 header (password-encrypted .docx or renamed .doc) gets a specific Chinese message.
  const cfb = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
  await assert.rejects(restyleDocx(cfb), /加了打开密码.*旧版的 \.doc/);
});

test('docxToMarkdown, fileToHtml and injectBaseHref handle links with parentheses, empty docs, CFB files and dollar-sign paths', async () => {
  const dir = freshDir();

  // Link containing parentheses in URL + regular paragraph.
  const linkDoc = path.join(dir, 'links.docx');
  const linkBody =
    '<w:p><w:r><w:t>参考资料</w:t></w:r></w:p>' +
    '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>维基词条</w:t></w:r></w:hyperlink></w:p>';
  const zip = await JSZip.loadAsync(await makeSimpleDocx(linkBody));
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rIdLink" Type="${REL_NS}/hyperlink" Target="https://example.org/wiki/Format_(spec)" TargetMode="External"/></Relationships>`,
  );
  fs.writeFileSync(linkDoc, await zip.generateAsync({ type: 'nodebuffer' }));
  const md = await docxToMarkdown(linkDoc);
  assert.match(md, /\[维基词条\]\(https:\/\/example\.org\/wiki\/Format_%28spec%29\)/);

  // Empty .docx is refused by docxToMarkdown and fileToHtml.
  const blankDoc = path.join(dir, 'blank.docx');
  fs.writeFileSync(blankDoc, await makeSimpleDocx('<w:p><w:r><w:t>   </w:t></w:r></w:p>'));
  await assert.rejects(docxToMarkdown(blankDoc), /没有可以导出的内容/);
  await assert.rejects(fileToHtml(blankDoc), /空的/);

  // CFB .docx is refused with password/.doc explanation.
  const cfbDoc = path.join(dir, 'locked.docx');
  fs.writeFileSync(cfbDoc, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  await assert.rejects(docxToMarkdown(cfbDoc), /加了打开密码.*旧版的 \.doc/);

  // injectBaseHref never expands $', $&, $` replacement patterns from folder names.
  const trickyDir = path.join(dir, "price$'100$&");
  const html = '<!doctype html><html><head><title>T</title></head><body>SECRET_BODY</body></html>';
  const injected = injectBaseHref(html, trickyDir);
  assert.equal((injected.match(/SECRET_BODY/g) ?? []).length, 1, 'body was not duplicated into <base href> by $` / $\'');
  assert.match(injected, /<head><base href="file:\/\/[^"]*">/);
});

// ---------------------------------------------------------------- pdf.text, typeset & model text actions

test('pdf.text, file.typeset, text.typeset, text.explain and text.translate handle edge inputs cleanly', async () => {
  const dir = freshDir();
  const pdfFile = path.join(dir, 'sample.pdf');
  fs.writeFileSync(pdfFile, 'placeholder');
  const ctxPdf = { kind: 'files', files: describeFiles([pdfFile]), text: '', has: { office: false, model: true } };

  let closed = 0;
  await assert.rejects(
    action('pdf.text').run(ctxPdf, {
      step: () => {},
      save: () => '',
      tools: { openPdf: async () => ({ pages: 0, text: async () => '', close: async () => { closed++; } }) },
    }),
    { message: '这个 PDF 里没有页面' },
  );
  assert.equal(closed, 1);

  // Empty .txt refused by file.typeset; non-empty .txt typeset without touching original.
  const emptyTxt = path.join(dir, 'empty.txt');
  fs.writeFileSync(emptyTxt, '  \n ');
  await assert.rejects(
    action('file.typeset').run({ kind: 'files', files: describeFiles([emptyTxt]), text: '', has: {} }, { save: () => '' }),
    /这个文件是空的/,
  );

  // Astral Han character across unwrapped lines in typeset: no space inserted between Han characters.
  const astral = typeset(`${'汉字排版的测试内容'.repeat(3)}𠮷\n𠮷继续接在同一段后面。`);
  assert.match(astral.text, /𠮷𠮷继续/);

  // text.explain and text.translate unify CJK radicals and cut at 6000 code points without lone surrogates.
  const longText = '⻛险' + '好'.repeat(5997) + '𠮷尾巴';
  for (const id of ['text.explain', 'text.translate']) {
    const res = await action(id).run({ kind: 'text', files: [], text: longText, has: { model: true } });
    assert.equal(res.kind, 'ask');
    assert.equal(res.note, '只处理了前 6000 字');
    assert.equal(res.question.isWellFormed(), true);
    const body = res.question.split('\n\n')[1];
    assert.ok(body.startsWith('风险'), `${id} unified CJK radical`);
    assert.ok(body.endsWith('𠮷'), `${id} kept full astral character at code-point 6000`);
  }
});

// ---------------------------------------------------------------- macOS packaging plist

test('package.json wires --extend-info build/macos-info.plist with NSAppleEventsUsageDescription and clean ignore rules', async () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const packagerDist = path.join(repoRoot, 'node_modules/@electron/packager/dist');
  const { parseArgs } = await import(pathToFileURL(path.join(packagerDist, 'cli.js')).href);
  const { MacApp } = await import(pathToFileURL(path.join(packagerDist, 'mac.js')).href);
  const { populateIgnoredPaths, userPathFilter } = await import(pathToFileURL(path.join(packagerDist, 'copy-filter.js')).href);

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const script = pkg.scripts.package;
  assert.match(script, /--extend-info\s+build\/macos-info\.plist/);

  // Parse CLI arguments with @electron/packager's own parser (after shell quote removal).
  const tokens = script.replace(/^electron-packager\s+/, '').match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/"/g, ''));
  const args = parseArgs(tokens);
  assert.equal(args.extendInfo, 'build/macos-info.plist');

  const plistPath = path.join(repoRoot, args.extendInfo);
  assert.ok(fs.existsSync(plistPath), 'build/macos-info.plist exists');
  const parsed = plist.parse(fs.readFileSync(plistPath, 'utf8'));
  assert.equal(typeof parsed.NSAppleEventsUsageDescription, 'string');
  assert.ok(parsed.NSAppleEventsUsageDescription.length >= 10 && /访达/.test(parsed.NSAppleEventsUsageDescription));

  // Verify MacApp.prototype.extendPlist merges NSAppleEventsUsageDescription into Info.plist.
  const appPlist = { CFBundleIdentifier: 'com.zhidian.app', CFBundleName: 'Zhidian' };
  await MacApp.prototype.extendPlist.call(Object.create(MacApp.prototype), appPlist, plistPath);
  assert.equal(appPlist.NSAppleEventsUsageDescription, parsed.NSAppleEventsUsageDescription);

  // Verify --ignore excludes build/test/docs/dist while keeping src/bin/package.json.
  const opts = { dir: repoRoot, name: 'Zhidian', out: path.join(repoRoot, 'dist'), ignore: args.ignore };
  Object.assign(opts, populateIgnoredPaths(opts));
  const filter = await userPathFilter(opts);
  assert.equal(await filter(path.join(repoRoot, 'src/main/main.js')), true);
  assert.equal(await filter(path.join(repoRoot, 'package.json')), true);
  assert.equal(await filter(path.join(repoRoot, 'build/macos-info.plist')), false);
  assert.equal(await filter(path.join(repoRoot, 'test/core.test.js')), false);
  assert.equal(await filter(path.join(repoRoot, 'docs/releases/v0.1.0.md')), false);
});
