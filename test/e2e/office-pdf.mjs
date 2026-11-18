// The PDF actions inside the real app, on a PDF made here whose pages differ in size and in the
// way they are turned: split it, save its pages as pictures, number its pages, and (where
// LibreOffice is installed) turn it into Word. Every result is checked by opening it again:
// page counts and sizes, the text pdf.js reads back, and the very pixels of the pictures.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e/office-pdf.mjs
//
// KEEP=1 leaves the results in the temporary folder (its path is printed) to look at.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, PDFHexString, PDFName, StandardFonts, decodePDFRawStream, degrees, rgb } from 'pdf-lib';
import { launchOffice } from './office-harness.mjs';
import { PDF_IMPORT_UNAVAILABLE } from '../../src/main/office/tools-pdf.js';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pad2 = (n) => String(n).padStart(2, '0');

// ---- the pages of the fixture: [width, height, /Rotate]
const PAGES = [
  [595, 842, 0], // A4 upright
  [842, 595, 0], // A4 on its side
  [595, 842, 90], // A4 upright, shown turned to the right
  [612, 792, 270], // Letter, shown turned to the left
  [420, 595, 180], // A5, shown upside down
];
const SQUARE = { x: 80, y: 200, size: 100 }; // a black square at the same place on every page

async function makeFixture(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  PAGES.forEach(([w, h, turn], i) => {
    const page = doc.addPage([w, h]);
    if (turn) page.setRotation(degrees(turn));
    page.drawText(`Sample page ${i + 1} of ${PAGES.length}`, { x: 60, y: h - 90, size: 22, font });
    page.drawRectangle({ x: SQUARE.x, y: SQUARE.y, width: SQUARE.size, height: SQUARE.size, color: rgb(0, 0, 0) });
  });
  fs.writeFileSync(file, await doc.save());
}
async function makePlain(file, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595, 842]).drawText(`Only page ${i}`, { x: 60, y: 760, size: 22, font });
  fs.writeFileSync(file, await doc.save());
}
/** A PDF that carries the mark of an encrypted file (pdf-lib cannot really encrypt one). */
async function makeLocked(file) {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  const zeros = PDFHexString.of('00'.repeat(32));
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: zeros, U: zeros, P: -44 }));
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
}

/** A PDF with an open password, made by LibreOffice (7.4 or later). Returns its path, or null. */
function makeSecretPdf(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'For your eyes only.\n');
  const profile = 'file://' + path.join(dir, 'profile');
  const options = JSON.stringify({ EncryptFile: { type: 'boolean', value: 'true' }, DocumentOpenPassword: { type: 'string', value: 'sesame' } });
  spawnSync('soffice', [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', `pdf:writer_pdf_Export:${options}`, '--outdir', dir, path.join(dir, 'secret.txt')], { timeout: 120_000 });
  const made = path.join(dir, 'secret.pdf');
  // Only if it really is encrypted (an older LibreOffice ignores the options).
  return fs.existsSync(made) && fs.readFileSync(made).includes('/Encrypt') ? made : null;
}

// ---- reading results back

/** Width and height from the frame header of a JPEG; throws if the bytes are not a whole JPEG. */
function jpegSize(buf) {
  assert.ok(buf[0] === 0xff && buf[1] === 0xd8, 'starts like a JPEG');
  assert.ok(buf.at(-2) === 0xff && buf.at(-1) === 0xd9, 'ends like a JPEG');
  for (let o = 2; o + 9 < buf.length; ) {
    assert.equal(buf[o], 0xff, 'a JPEG segment');
    const marker = buf[o + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) };
    o += 2 + buf.readUInt16BE(o + 2);
  }
  throw new Error('no frame header in the JPEG');
}

/** Where a point of a page (in its own coordinates) is on the displayed page: from the left and from the top. */
function displayed([w, h, turn], x, y) {
  if (turn === 90) return { x: y, y: x, W: h, H: w };
  if (turn === 180) return { x: w - x, y, W: w, H: h };
  if (turn === 270) return { x: h - y, y: w - x, W: h, H: w };
  return { x, y: h - y, W: w, H: h };
}

/** A decoded picture: grey level 0..255 of a pixel, and the darkest level in a rectangle. */
function picture(w, h, rgbBytes) {
  const at = (x, y) => {
    const o = (Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))) * 3;
    return (rgbBytes[o] + rgbBytes[o + 1] + rgbBytes[o + 2]) / 3;
  };
  return {
    w,
    h,
    at,
    /** Bounds of the pixels darker than `level` inside a rectangle, or null. */
    dark(x0, y0, x1, y1, level) {
      let box = null;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
          if (at(x, y) >= level) continue;
          box = box ? { x0: Math.min(box.x0, x), x1: Math.max(box.x1, x), y0: Math.min(box.y0, y), y1: Math.max(box.y1, y) } : { x0: x, x1: x, y0: y, y1: y };
        }
      }
      return box;
    },
  };
}

let failed = null;
const office = await launchOffice();
const work = office.work;
const fx = (name) => path.join(work, name);

/**
 * The pixels of JPEG files, decoded by the app itself. Under a name that is not ".jpg" the
 * "files.pdf" action has Chromium decode each picture and stores the plain pixels in the PDF
 * it makes, one picture per page: those are read back out here.
 */
async function decodeInApp(jpegs, tag) {
  const dir = fx(`decode-${tag}`);
  fs.mkdirSync(dir);
  const copies = jpegs.map((file, i) => {
    const copy = path.join(dir, `${pad2(i + 1)}.bmp`);
    fs.copyFileSync(file, copy);
    return copy;
  });
  const merged = await office.ok('files.pdf', { files: copies });
  assert.ok(!/没能处理/.test(merged.result.message), `every picture decodes: ${merged.result.message}`);
  const doc = await PDFDocument.load(fs.readFileSync(merged.result.path));
  assert.equal(doc.getPageCount(), jpegs.length, 'one page per picture');
  return doc.getPages().map((page) => {
    const xobjects = page.node.Resources().lookup(PDFName.of('XObject'));
    const images = xobjects.keys().map((key) => xobjects.lookup(key)).filter((s) => s.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image'));
    assert.equal(images.length, 1, 'one picture on the page');
    const w = images[0].dict.lookup(PDFName.of('Width')).asNumber(), h = images[0].dict.lookup(PDFName.of('Height')).asNumber();
    const bytes = decodePDFRawStream(images[0]).decode();
    assert.equal(bytes.length, w * h * 3, 'three bytes for every pixel');
    return picture(w, h, bytes);
  });
}

try {
  const src = fx('季度计划.pdf');
  await makeFixture(src);
  const before = sha(src);
  const N = PAGES.length;
  const onPath = ['soffice', 'libreoffice'].some((bin) => spawnSync(bin, ['--version'], { timeout: 30_000 }).status === 0);

  console.log('▸ one PDF: what is offered');
  const offers = await office.offers({ files: [src] });
  console.log(`  ${offers.join(', ')}`);
  for (const id of ['pdf.split', 'pdf.extract', 'pdf.images', 'pdf.rotate', 'pdf.compress', 'pdf.number']) assert.ok(offers.includes(id), `${id} is offered`);
  assert.ok(offers.indexOf('pdf.split') < offers.indexOf('pdf.extract') && offers.indexOf('pdf.extract') < offers.indexOf('pdf.images') && offers.indexOf('pdf.images') < offers.indexOf('pdf.rotate') && offers.indexOf('pdf.rotate') < offers.indexOf('pdf.compress') && offers.indexOf('pdf.compress') < offers.indexOf('pdf.number'), 'ordered by rank');
  // The app looks for LibreOffice in a few more places than PATH: what it found decides.
  const hasSoffice = offers.includes('pdf.word');
  if (onPath) assert.ok(hasSoffice, 'to Word is offered where LibreOffice is installed');
  if (hasSoffice) assert.ok(offers.indexOf('pdf.word') < offers.indexOf('pdf.split'), 'to Word comes first');
  const two = fx('other.pdf');
  await makePlain(two, 2);
  assert.ok(!(await office.offers({ files: [src, two] })).some((id) => /^pdf\.(split|extract|images|rotate|compress|number|word)$/.test(id)), 'none of them for two PDFs');

  console.log('▸ pdf.split: a folder with one PDF per page, each page as it was');
  const split = await office.ok('pdf.split', { files: [src] });
  assert.equal(split.result.kind, 'folder');
  assert.equal(split.result.path, fx('季度计划 单页'), 'a new folder next to the original');
  const parts = fs.readdirSync(split.result.path).sort();
  assert.deepEqual(parts, PAGES.map((_p, i) => `季度计划 第 ${pad2(i + 1)} 页.pdf`));
  for (const [i, name] of parts.entries()) {
    const one = await PDFDocument.load(fs.readFileSync(path.join(split.result.path, name)));
    assert.equal(one.getPageCount(), 1, name);
    const page = one.getPage(0);
    assert.deepEqual([page.getWidth(), page.getHeight(), page.getRotation().angle], PAGES[i], `${name}: size and rotation`);
  }
  // The text of one of them, read by pdf.js in the app: its own page and no other.
  const third = await office.ok('pdf.text', { files: [path.join(split.result.path, parts[2])] });
  assert.equal(fs.readFileSync(third.result.path, 'utf8').trim(), `Sample page 3 of ${N}`);
  assert.match(split.result.message, new RegExp(`拆成了 ${N} 个单页 PDF`));
  console.log(`  ${parts.length} files. ${split.result.message}`);
  const splitAgain = await office.ok('pdf.split', { files: [src] });
  assert.notEqual(splitAgain.result.path, split.result.path, 'a second time: a second folder');
  // (The first folder now also holds the .txt just made from its third page.)
  assert.deepEqual(fs.readdirSync(split.result.path).filter((n) => n.endsWith('.pdf')).sort(), parts, 'the first folder is as it was');
  assert.deepEqual(fs.readdirSync(splitAgain.result.path).sort(), parts);

  console.log('▸ pdf.images: a folder with one JPEG per page, 2000 px along the longer edge');
  const images = await office.ok('pdf.images', { files: [src] });
  assert.equal(images.result.kind, 'folder');
  assert.equal(images.result.path, fx('季度计划 图片'));
  const shots = fs.readdirSync(images.result.path).sort();
  assert.deepEqual(shots, PAGES.map((_p, i) => `季度计划 第 ${pad2(i + 1)} 页.jpg`));
  const shotPaths = shots.map((name) => path.join(images.result.path, name));
  const sizes = shotPaths.map((file) => jpegSize(fs.readFileSync(file)));
  sizes.forEach((size, i) => {
    const shownAs = displayed(PAGES[i], 0, 0);
    assert.equal(Math.max(size.w, size.h), 2000, `${shots[i]}: the longer edge`);
    assert.ok(Math.abs(size.w / size.h - shownAs.W / shownAs.H) < 0.002, `${shots[i]}: ${size.w}×${size.h} has the shape of the page as displayed (${shownAs.W}×${shownAs.H})`);
  });
  assert.match(images.result.message, new RegExp(`把 ${N} 页存成了 ${N} 张 JPEG 图片，长边 2000 像素`));
  const totalBytes = shotPaths.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  console.log(`  ${sizes.map((s) => `${s.w}×${s.h}`).join(', ')}; ${totalBytes} bytes. ${images.result.message}`);

  console.log('▸ the pictures decode, and show the page: the black square where it is displayed, white elsewhere');
  const plain = await decodeInApp(shotPaths, 'plain');
  plain.forEach((pic, i) => {
    assert.deepEqual([pic.w, pic.h], [sizes[i].w, sizes[i].h], `${shots[i]}: decoded size`);
    const centre = displayed(PAGES[i], SQUARE.x + SQUARE.size / 2, SQUARE.y + SQUARE.size / 2);
    const scale = pic.w / centre.W;
    assert.ok(pic.at(centre.x * scale, centre.y * scale) < 40, `${shots[i]}: the square is black where the page shows it`);
    // Just outside each side of the square the paper is white.
    for (const [dx, dy] of [[-70, 0], [70, 0], [0, -70], [0, 70]]) assert.ok(pic.at((centre.x + dx) * scale, (centre.y + dy) * scale) > 235, `${shots[i]}: white beside the square`);
    assert.equal(pic.dark(0, pic.h - 44 * scale, pic.w, pic.h, 200), null, `${shots[i]}: nothing along the bottom edge yet`);
  });

  console.log('▸ pdf.number: "n / N" on every page, the pages otherwise unchanged');
  const numbered = await office.ok('pdf.number', { files: [src] });
  assert.equal(numbered.result.kind, 'file');
  assert.equal(numbered.result.path, fx('季度计划（带页码）.pdf'));
  const numberedDoc = await PDFDocument.load(fs.readFileSync(numbered.result.path));
  assert.equal(numberedDoc.getPageCount(), N);
  numberedDoc.getPages().forEach((page, i) => assert.deepEqual([page.getWidth(), page.getHeight(), page.getRotation().angle], PAGES[i], `page ${i + 1}: size and rotation`));
  const numberedText = await office.ok('pdf.text', { files: [numbered.result.path] });
  const perPage = fs.readFileSync(numberedText.result.path, 'utf8').trim().split(/\n\s*\n/);
  assert.equal(perPage.length, N, `text of ${N} pages: ${JSON.stringify(perPage)}`);
  perPage.forEach((text, i) => {
    assert.ok(text.includes(`Sample page ${i + 1} of ${N}`), `page ${i + 1} still has its text: ${JSON.stringify(text)}`);
    assert.ok(text.includes(`${i + 1} / ${N}`), `page ${i + 1} has its number: ${JSON.stringify(text)}`);
  });
  console.log(`  ${JSON.stringify(perPage)}. ${numbered.result.message}`);

  console.log('▸ the numbers as displayed: grey, centred, just above the bottom edge, also on the turned pages');
  const numberedShots = await office.ok('pdf.images', { files: [numbered.result.path] });
  const numberedPaths = fs.readdirSync(numberedShots.result.path).sort().map((name) => path.join(numberedShots.result.path, name));
  assert.equal(numberedPaths.length, N);
  const withNumbers = await decodeInApp(numberedPaths, 'numbered');
  withNumbers.forEach((pic, i) => {
    const shownAs = displayed(PAGES[i], 0, 0);
    const scale = pic.w / shownAs.W; // pixels per point
    const ink = pic.dark(0, pic.h - 44 * scale, pic.w, pic.h, 190);
    assert.ok(ink, `page ${i + 1}: something is written along the bottom edge`);
    const middle = (ink.x0 + ink.x1) / 2 / scale, width = (ink.x1 - ink.x0) / scale, baseline = (pic.h - ink.y1) / scale, top = (pic.h - ink.y0) / scale;
    assert.ok(Math.abs(middle - shownAs.W / 2) < 2, `page ${i + 1}: centred (middle at ${middle.toFixed(1)} of ${shownAs.W} pt)`);
    assert.ok(width > 12 && width < 32, `page ${i + 1}: as wide as "n / N" at 10 pt (${width.toFixed(1)} pt)`);
    assert.ok(Math.abs(baseline - 24) < 2, `page ${i + 1}: baseline 24 pt above the bottom (${baseline.toFixed(1)} pt)`);
    assert.ok(top - baseline > 5 && top - baseline < 10, `page ${i + 1}: as tall as 10 pt digits (${(top - baseline).toFixed(1)} pt)`);
    let darkest = 255;
    for (let y = ink.y0; y <= ink.y1; y++) for (let x = ink.x0; x <= ink.x1; x++) darkest = Math.min(darkest, pic.at(x, y));
    assert.ok(darkest > 60, `page ${i + 1}: grey, not black (darkest ${darkest.toFixed(0)})`);
    // The rest of the page is as it was: the square is still there.
    const centre = displayed(PAGES[i], SQUARE.x + SQUARE.size / 2, SQUARE.y + SQUARE.size / 2);
    assert.ok(pic.at(centre.x * scale, centre.y * scale) < 40, `page ${i + 1}: the square is still there`);
    console.log(`  page ${i + 1} (${shownAs.W}×${shownAs.H} pt as displayed): number ${width.toFixed(1)} pt wide, middle at ${middle.toFixed(1)} pt, baseline ${baseline.toFixed(1)} pt up, darkest ${darkest.toFixed(0)}`);
  });

  if (hasSoffice) {
    console.log('▸ pdf.word: a docx made by LibreOffice, with the words of every page');
    const word = await office.run('pdf.word', { files: [src] });
    if (word.error) {
      assert.equal(word.error, PDF_IMPORT_UNAVAILABLE);
      assert.equal(fs.existsSync(fx('季度计划.docx')), false, 'missing PDF import support must not produce a corrupt Word file');
      console.log('  This LibreOffice lacks PDF import support: verified explicit refusal without writing a Word file.');
    } else {
      assert.equal(word.result.kind, 'file');
      assert.equal(word.result.path, fx('季度计划.docx'));
      const zip = await JSZip.loadAsync(fs.readFileSync(word.result.path));
      const xml = (await zip.file('word/document.xml').async('string')).replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
      const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').replace(/\s+/g, '');
      for (let i = 1; i <= N; i++) assert.ok(text.includes(`Samplepage${i}of${N}`), `the words of page ${i} are in the document: ${text}`);
      assert.match(word.result.message, /LibreOffice/);
      assert.match(word.result.message, /可能和原件不同/);
      assert.ok(word.result.message.includes(`${[...text].length} 字`), `the message counts the characters that are there (${[...text].length}): ${word.result.message}`);
      console.log(`  ${fs.statSync(word.result.path).size} bytes. ${word.result.message}`);
    }

    // LibreOffice can also make what pdf-lib cannot: a PDF that really needs a password.
    const secret = onPath ? makeSecretPdf(fx('secret-src')) : null;
    if (secret) {
      console.log('▸ a PDF that needs a password to open: every action says so and writes nothing');
      fs.renameSync(secret, fx('secret.pdf'));
      fs.rmSync(fx('secret-src'), { recursive: true, force: true });
      const listing = fs.readdirSync(work).sort();
      for (const id of ['pdf.split', 'pdf.number', 'pdf.images', 'pdf.word']) {
        const r = await office.run(id, { files: [fx('secret.pdf')] });
        assert.match(r.error ?? '', /这个 PDF 加了密/, `${id}: ${r.error ?? JSON.stringify(r.result)}`);
        console.log(`  ${id}: ${r.error}`);
      }
      assert.deepEqual(fs.readdirSync(work).sort(), listing);
    } else {
      console.log('▸ a PDF that needs a password: skipped, this LibreOffice could not make one');
    }
  } else {
    console.log('▸ pdf.word: skipped, LibreOffice (soffice) is not installed here; the action is not offered');
  }

  console.log('▸ a PDF printed by the app itself (from Markdown, with links in it) is split and numbered like any other');
  const md = fx('notes.md');
  const pageBreak = '<div style="break-before: page"></div>';
  fs.writeFileSync(md, ['<h1 id="one">Part one</h1>', 'See <a href="#three">part three</a> or <a href="https://example.com/">the web</a>.', pageBreak, '<h1 id="two">Part two</h1>', 'Middle text.', pageBreak, '<h1 id="three">Part three</h1>', 'Closing text.', ''].join('\n\n'));
  const printed = await office.ok('files.pdf', { files: [md] });
  assert.equal((await PDFDocument.load(fs.readFileSync(printed.result.path))).getPageCount(), 3, 'the Markdown file prints on three pages');
  const printedSplit = await office.ok('pdf.split', { files: [printed.result.path] });
  const printedParts = fs.readdirSync(printedSplit.result.path).sort();
  assert.deepEqual(printedParts, [1, 2, 3].map((n) => `notes 第 ${pad2(n)} 页.pdf`));
  const partTexts = [];
  for (const name of printedParts) {
    const file = path.join(printedSplit.result.path, name);
    assert.equal((await PDFDocument.load(fs.readFileSync(file))).getPageCount(), 1, name);
    partTexts.push(fs.readFileSync((await office.ok('pdf.text', { files: [file] })).result.path, 'utf8'));
  }
  assert.match(partTexts[0], /Part one/);
  assert.match(partTexts[1], /Middle text/);
  assert.match(partTexts[2], /Closing text/);
  assert.ok(!/Part two|Part three/.test(partTexts[0]) && !/Part one/.test(partTexts[2]), 'each file has only its own page');
  const partBytes = printedParts.reduce((sum, name) => sum + fs.statSync(path.join(printedSplit.result.path, name)).size, 0);
  console.log(`  printed PDF ${fs.statSync(printed.result.path).size} bytes -> 3 files, ${partBytes} bytes. ${printedSplit.result.message}`);
  const printedNumbered = await office.ok('pdf.number', { files: [printed.result.path] });
  const printedNumberedText = fs.readFileSync((await office.ok('pdf.text', { files: [printedNumbered.result.path] })).result.path, 'utf8');
  for (const n of [1, 2, 3]) assert.ok(printedNumberedText.includes(`${n} / 3`), `"${n} / 3" is on the printed PDF: ${JSON.stringify(printedNumberedText)}`);
  assert.match(printedNumberedText, /Part one[\s\S]*Middle text[\s\S]*Closing text/, 'and its own text is still there');

  console.log('▸ one page: a picture next to the PDF instead of a folder; nothing to split');
  const single = fx('single.pdf');
  await makePlain(single, 1);
  const onePicture = await office.ok('pdf.images', { files: [single] });
  assert.equal(onePicture.result.kind, 'file');
  assert.equal(onePicture.result.path, fx('single.jpg'));
  assert.deepEqual(jpegSize(fs.readFileSync(onePicture.result.path)), { w: 1413, h: 2000 });
  const oneNumber = await office.ok('pdf.number', { files: [single] });
  assert.match(fs.readFileSync((await office.ok('pdf.text', { files: [oneNumber.result.path] })).result.path, 'utf8'), /1 \/ 1/);
  const locked = fx('locked.pdf');
  await makeLocked(locked);
  fs.writeFileSync(fx('broken.pdf'), 'this is not a pdf');
  const listing = fs.readdirSync(work).sort();
  const refusals = [
    ['pdf.split', single, /只有 1 页/],
    ['pdf.split', locked, /加了密/],
    ['pdf.number', locked, /加了密/],
    ['pdf.split', fx('broken.pdf'), /打不开这个 PDF/],
    ['pdf.number', fx('broken.pdf'), /打不开这个 PDF/],
    ['pdf.images', fx('broken.pdf'), /打不开这个 PDF/],
  ];
  for (const [id, file, why] of refusals) {
    const r = await office.run(id, { files: [file] });
    assert.match(r.error ?? '', why, `${id} on ${path.basename(file)}: ${r.error ?? JSON.stringify(r.result)}`);
    console.log(`  ${id} on ${path.basename(file)}: ${r.error}`);
  }
  assert.deepEqual(fs.readdirSync(work).sort(), listing, 'a refusal leaves nothing behind');

  console.log('▸ pdf.extract, pdf.rotate, and pdf.compress inside the real app');
  const extracted = await office.ok('pdf.extract', { files: [src] }, { param: '5, 1-2' });
  const extDoc = await PDFDocument.load(fs.readFileSync(extracted.result.path));
  assert.equal(extDoc.getPageCount(), 3);
  assert.deepEqual([extDoc.getPage(0).getWidth(), extDoc.getPage(0).getRotation().angle], [PAGES[4][0], PAGES[4][2]]);
  assert.deepEqual([extDoc.getPage(1).getWidth(), extDoc.getPage(1).getRotation().angle], [PAGES[0][0], PAGES[0][2]]);
  const rotated = await office.ok('pdf.rotate', { files: [src] });
  const rotDoc = await PDFDocument.load(fs.readFileSync(rotated.result.path));
  assert.deepEqual(rotDoc.getPages().map((p) => p.getRotation().angle), PAGES.map(([, , turn]) => (turn + 90) % 360));
  const bloated = fx('bloated.pdf');
  const bloatedDoc = await PDFDocument.create();
  bloatedDoc.addPage([595, 842]).drawRectangle({ x: 80, y: 200, width: 100, height: 100, color: rgb(0, 0, 0) });
  bloatedDoc.setKeywords(['pad-' + 'x'.repeat(180_000)]);
  fs.writeFileSync(bloated, await bloatedDoc.save({ useObjectStreams: false }));
  const shrunkPdf = await office.ok('pdf.compress', { files: [bloated] });
  assert.ok(fs.statSync(shrunkPdf.result.path).size < fs.statSync(bloated).size, 'bloated PDF compressed smaller');
  console.log(`  ${extracted.result.message}\n  ${rotated.result.message}\n  ${shrunkPdf.result.message}`);

  assert.equal(sha(src), before, 'the original is untouched by all of this');
  console.log(`\n✔ office-pdf checks passed${process.env.KEEP ? `. Results in ${work}` : ''}`);
} catch (err) {
  failed = err;
  console.error('\n✘ ' + (err.stack ?? err));
  console.error(`Results so far are in ${work}`);
} finally {
  await office.close();
}
if (!failed && !process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
