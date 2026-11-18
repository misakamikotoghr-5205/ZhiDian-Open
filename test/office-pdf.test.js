// The PDF actions (src/main/office/tools-pdf.js) on PDFs made here with pdf-lib, with a hand-made
// env: results go into a temporary folder, and what needs the hidden page or LibreOffice is
// played by small stand-ins. The same actions inside the real app: test/e2e/office-pdf.mjs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPageLeaf, PDFRef, PDFStream, StandardFonts, decodePDFRawStream, degrees } from 'pdf-lib';
import { describeFiles } from '../src/core/office-kinds.js';
import { actions, bottomCentre, docxChars, numberStyle, pageFileName, quarterTurn, sizeText, visibleBox } from '../src/main/office/tools-pdf.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-pdf-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const action = (id) => actions.find((a) => a.id === id);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let folders = 0;
const freshDir = () => {
  const dir = path.join(root, `case-${++folders}`);
  fs.mkdirSync(dir);
  return dir;
};
const filesCtx = (paths, has = {}) => ({ kind: 'files', files: describeFiles(paths), text: '', has: { office: false, model: true, ...has } });

/** A name in `dir` that is not taken, the way the app picks one. */
function free(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** An env like the one src/main/office/index.js hands to an action, writing into `dir`. */
function makeEnv(dir, tools = {}, signal) {
  const log = { steps: [], saved: [], folders: [] };
  const env = {
    signal,
    step: (done, total, name) => log.steps.push({ done, total, name }),
    save: (name, data) => {
      const file = free(dir, name);
      fs.writeFileSync(file, data);
      log.saved.push(name);
      return file;
    },
    folder: (name) => {
      const made = free(dir, name);
      fs.mkdirSync(made);
      log.folders.push(name);
      return made;
    },
    tools,
  };
  return { env, log };
}

/**
 * @param {string} file
 * @param {Array<{ size?: [number, number], rotate?: number, crop?: [number, number, number, number], text?: string }>} pages
 */
async function makePdf(file, pages, { title } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  if (title) doc.setTitle(title);
  pages.forEach((spec, i) => {
    const page = doc.addPage(spec.size ?? [595, 842]);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (spec.crop) page.setCropBox(...spec.crop);
    page.drawText(spec.text ?? `Body of page ${i + 1}`, { x: 60, y: page.getHeight() - 90, size: 18, font });
  });
  fs.writeFileSync(file, await doc.save());
  return file;
}
const plainPages = (n) => Array.from({ length: n }, () => ({}));

/** A PDF that says it is encrypted (pdf-lib cannot really encrypt; the marker is what is checked). */
async function makeEncryptedPdf(file) {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  const zeros = PDFHexString.of('00'.repeat(32));
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: zeros, U: zeros, P: -44 }));
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

/** Every piece of text drawn on a page, in drawing order: [{ text, size, grey, matrix }]. */
function shown(page) {
  const contents = page.node.Contents();
  let code = '';
  for (let i = 0; i < contents.size(); i++) code += Buffer.from(decodePDFRawStream(contents.lookup(i)).decode()).toString('latin1') + '\n';
  const out = [];
  const re = /([\d.-]+) ([\d.-]+) ([\d.-]+) rg\n\/\S+ ([\d.]+) Tf\n[\d.]+ TL\n((?:[\d.-]+ ){6})Tm\n<([0-9A-Fa-f]*)> Tj/g;
  for (const m of code.matchAll(re)) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    out.push({ text: Buffer.from(m[6], 'hex').toString('latin1'), size: Number(m[4]), grey: r === g && g === b ? r : null, matrix: m[5].trim().split(' ').map(Number) });
  }
  return out;
}
const open = async (file) => PDFDocument.load(fs.readFileSync(file));

/**
 * Where a point of a page lands when the page is displayed: x from the left edge, y from the
 * TOP edge, and the displayed size. This is the transform viewers apply for /Rotate (the one
 * pdf.js builds its viewport from), written out here independently of the code under test.
 */
function displayed(box, angle, x, y) {
  const X = x - box.x, Y = y - box.y;
  if (angle === 90) return { x: Y, y: X, W: box.height, H: box.width };
  if (angle === 180) return { x: box.width - X, y: Y, W: box.width, H: box.height };
  if (angle === 270) return { x: box.height - Y, y: box.width - X, W: box.height, H: box.width };
  return { x: X, y: box.height - Y, W: box.width, H: box.height };
}
/** A direction on the page as it points on the display (y down). */
function displayedDirection(angle, dx, dy) {
  if (angle === 90) return [dy, dx];
  if (angle === 180) return [-dx, dy];
  if (angle === 270) return [-dy, -dx];
  return [dx, -dy];
}
const near = (a, b, tolerance, what) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} is not within ${tolerance} of ${b}`);

// ---------------------------------------------------------------- when they are offered

test('the PDF actions are offered for exactly one PDF, and Word only where LibreOffice is', async () => {
  const dir = freshDir();
  const a = await makePdf(path.join(dir, 'a.pdf'), plainPages(2));
  const b = await makePdf(path.join(dir, 'b.pdf'), plainPages(2));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
  const offered = (ctx) => actions.filter((x) => x.applies(ctx)).sort((x, y) => x.rank - y.rank).map((x) => x.id);

  assert.deepEqual(offered(filesCtx([a])), ['pdf.split', 'pdf.extract', 'pdf.images', 'pdf.rotate', 'pdf.compress', 'pdf.number']);
  assert.deepEqual(offered(filesCtx([a], { office: true })), ['pdf.word', 'pdf.split', 'pdf.extract', 'pdf.images', 'pdf.rotate', 'pdf.compress', 'pdf.number']);
  assert.deepEqual(offered(filesCtx([a, b], { office: true })), [], 'several PDFs are for merging, not for these');
  assert.deepEqual(offered(filesCtx([path.join(dir, 'note.txt')], { office: true })), []);
  assert.deepEqual(offered({ kind: 'text', files: [], text: 'report.pdf', has: { office: true, model: true } }), []);

  for (const x of actions) {
    assert.match(x.id, /^pdf\.[a-z]+$/);
    assert.ok(x.label && x.hint && Number.isFinite(x.rank), x.id);
    assert.equal(typeof x.run, 'function');
  }
  assert.equal(new Set(actions.map((x) => x.id)).size, actions.length);
  assert.equal(new Set(actions.map((x) => x.rank)).size, actions.length, 'no two share a rank, so the order is fixed');
});

// ---------------------------------------------------------------- small pieces

test('page file names are padded to the page count, at least two digits', () => {
  assert.equal(pageFileName('报告', 1, 3, 'pdf'), '报告 第 01 页.pdf');
  assert.equal(pageFileName('报告', 12, 12, 'pdf'), '报告 第 12 页.pdf');
  assert.equal(pageFileName('报告', 7, 120, 'jpg'), '报告 第 007 页.jpg');
  assert.equal(pageFileName('scan.v2', 99, 1000, 'pdf'), 'scan.v2 第 0099 页.pdf');
  const long = pageFileName('长'.repeat(200), 5, 10, 'pdf');
  assert.ok(Buffer.byteLength(long) <= 255, 'a very long name still fits in a file name');
  assert.match(long, / 第 05 页\.pdf$/);
});

test('sizes are told in the unit that fits', () => {
  assert.equal(sizeText(812), '812 字节');
  assert.equal(sizeText(3500), '3.4 KB');
  assert.equal(sizeText(123_456), '121 KB');
  assert.equal(sizeText(2_621_440), '2.5 MB');
});

test('bottomCentre: the start of the baseline for each way a page can be turned', () => {
  const a4 = { x: 0, y: 0, width: 600, height: 800 };
  assert.deepEqual(bottomCentre(a4, 0, 40, 24), { x: 280, y: 24, rotate: 0 });
  assert.deepEqual(bottomCentre(a4, 90, 40, 24), { x: 576, y: 380, rotate: 90 });
  assert.deepEqual(bottomCentre(a4, 180, 40, 24), { x: 320, y: 776, rotate: 180 });
  assert.deepEqual(bottomCentre(a4, 270, 40, 24), { x: 24, y: 420, rotate: 270 });
  // The same angles written differently, and a box that does not start at the origin.
  assert.deepEqual(bottomCentre(a4, -90, 40, 24), bottomCentre(a4, 270, 40, 24));
  assert.deepEqual(bottomCentre(a4, 450, 40, 24), bottomCentre(a4, 90, 40, 24));
  assert.deepEqual(bottomCentre(a4, 360, 40, 24), bottomCentre(a4, 0, 40, 24));
  assert.deepEqual(bottomCentre({ x: 50, y: 60, width: 500, height: 700 }, 0, 40, 24), { x: 280, y: 84, rotate: 0 });
  assert.deepEqual([0, 90, 180, 270, 360, -90, 450, 89, undefined].map(quarterTurn), [0, 90, 180, 270, 0, 270, 90, 90, 0]);
  // Wherever it is put, a viewer shows it centred, the same distance above the bottom edge.
  for (const box of [a4, { x: 50, y: 60, width: 500, height: 700 }]) {
    for (const angle of [0, 90, 180, 270]) {
      const at = bottomCentre(box, angle, 40, 24);
      const d = displayed(box, angle, at.x, at.y);
      near(d.x + 20, d.W / 2, 1e-9, `centred at ${angle}`);
      near(d.H - d.y, 24, 1e-9, `lifted at ${angle}`);
    }
  }
});

test('visibleBox: the crop box as far as it lies on the page', () => {
  const media = { x: 0, y: 0, width: 700, height: 900 };
  assert.deepEqual(visibleBox(media), media);
  assert.deepEqual(visibleBox(media, { x: 50, y: 60, width: 500, height: 700 }), { x: 50, y: 60, width: 500, height: 700 });
  assert.deepEqual(visibleBox(media, { x: 550, y: 760, width: -500, height: -700 }), { x: 50, y: 60, width: 500, height: 700 }, 'corners the wrong way round');
  assert.deepEqual(visibleBox(media, { x: -20, y: 400, width: 2000, height: 2000 }), { x: 0, y: 400, width: 700, height: 500 }, 'what sticks out of the page is not shown');
  assert.deepEqual(visibleBox(media, { x: 5000, y: 5000, width: 10, height: 10 }), media, 'a crop box off the page is ignored');
  assert.deepEqual(visibleBox({ x: 700, y: 900, width: -700, height: -900 }), media);
});

test('numberStyle: 10 pt on ordinary paper, larger in proportion on very large pages', () => {
  assert.deepEqual(numberStyle(595, 842), { size: 10, lift: 24 });
  assert.deepEqual(numberStyle(842, 595), { size: 10, lift: 24 });
  assert.deepEqual(numberStyle(842, 1191), { size: 10, lift: 24 }, 'A3');
  assert.deepEqual(numberStyle(1684, 2384), { size: 20, lift: 48 }, 'A1');
  assert.equal(numberStyle(300, 200).lift, 10, 'on a small page the number stays inside the bottom twentieth');
});

// ---------------------------------------------------------------- pdf.split

test('split: one PDF per page in a new folder, each page as it was', async () => {
  const dir = freshDir();
  const sizes = [[595, 842], [842, 595], [420, 595], [612, 792]];
  const specs = Array.from({ length: 12 }, (_x, i) => ({ size: sizes[i % 4], rotate: i === 5 ? 90 : 0, text: `Body of page ${i + 1}` }));
  const src = await makePdf(path.join(dir, '报告.pdf'), specs);
  const before = sha(src);
  const { env, log } = makeEnv(dir);

  const result = await action('pdf.split').run(filesCtx([src]), env);

  assert.equal(result.kind, 'folder');
  assert.deepEqual(log.folders, ['报告 单页']);
  assert.equal(path.dirname(result.path), dir, 'the folder is next to the original');
  const names = fs.readdirSync(result.path).sort();
  assert.deepEqual(names, Array.from({ length: 12 }, (_x, i) => `报告 第 ${String(i + 1).padStart(2, '0')} 页.pdf`));
  let bytes = 0;
  for (const [i, name] of names.entries()) {
    const one = await open(path.join(result.path, name));
    assert.equal(one.getPageCount(), 1, name);
    const page = one.getPage(0);
    assert.deepEqual([page.getWidth(), page.getHeight()], sizes[i % 4], `${name} keeps its size`);
    assert.equal(page.getRotation().angle, i === 5 ? 90 : 0, `${name} keeps its rotation`);
    assert.deepEqual(shown(page).map((t) => t.text), [`Body of page ${i + 1}`], `${name} holds its own page`);
    bytes += fs.statSync(path.join(result.path, name)).size;
  }
  assert.match(result.message, /拆成了 12 个单页 PDF/);
  assert.ok(result.message.includes(sizeText(bytes)), `the message tells the real size: ${result.message}`);
  assert.deepEqual(log.steps[0], { done: 0, total: 12, name: '第 1 页' });
  assert.deepEqual(log.steps.at(-1), { done: 12, total: 12, name: '' });
  assert.equal(log.steps.length, 13);
  assert.equal(sha(src), before, 'the original is untouched');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['报告 单页', '报告.pdf'].sort(), 'nothing else was written');

  // Again: a second folder, nothing overwritten.
  const again = await action('pdf.split').run(filesCtx([src]), env);
  assert.notEqual(again.path, result.path);
  assert.equal(fs.readdirSync(again.path).length, 12);
  assert.equal(fs.readdirSync(result.path).length, 12);
});

/** Every pointer inside a document that points at nothing. */
function danglingRefs(doc) {
  const missing = [];
  const walk = (object) => {
    if (object instanceof PDFRef) {
      if (doc.context.lookup(object) === undefined) missing.push(object.toString());
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) walk(object.get(i));
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) walk(value);
    } else if (object instanceof PDFStream) {
      walk(object.dict);
    }
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) walk(object);
  return missing;
}

test('split: pages that link to each other do not drag each other along', async () => {
  const dir = freshDir();
  // Four pages, each with 60 KB of its own, each linked to the next page and back to the first;
  // a web link and a note are there too.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const N = (text) => PDFName.of(text);
  const pages = Array.from({ length: 4 }, (_x, i) => {
    const page = doc.addPage([595, 842]);
    page.drawText(`Chapter ${i + 1}`, { x: 60, y: 760, size: 18, font });
    const picture = doc.context.stream(crypto.randomBytes(60_000), { Type: 'XObject', Subtype: 'Image', Width: 300, Height: 200, ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
    page.node.setXObject(N(`Im${i}`), doc.context.register(picture));
    return page;
  });
  const annotate = (page, entries) => page.node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Rect: [50, 50, 150, 70], P: page.ref, ...entries })));
  pages.forEach((page, i) => {
    if (i + 1 < pages.length) annotate(page, { Subtype: 'Link', Dest: [pages[i + 1].ref, 'Fit'] });
    if (i > 0) annotate(page, { Subtype: 'Link', A: { S: 'GoTo', D: [pages[0].ref, 'Fit'] } });
  });
  annotate(pages[0], { Subtype: 'Link', A: { S: 'URI', URI: PDFHexString.fromText('https://example.com/') } });
  annotate(pages[1], { Subtype: 'Text', Contents: PDFHexString.fromText('a note') });
  const src = path.join(dir, 'book.pdf');
  fs.writeFileSync(src, await doc.save());
  const before = sha(src);
  const { env } = makeEnv(dir);

  const result = await action('pdf.split').run(filesCtx([src]), env);

  const names = fs.readdirSync(result.path).sort();
  assert.equal(names.length, 4);
  const kept = [];
  for (const [i, name] of names.entries()) {
    const size = fs.statSync(path.join(result.path, name)).size;
    assert.ok(size > 60_000 && size < 70_000, `${name} holds its own page and no other: ${size} bytes`);
    const one = await open(path.join(result.path, name));
    const leaves = one.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFPageLeaf);
    assert.equal(leaves.length, 1, `${name}: one page object`);
    assert.deepEqual(danglingRefs(one), [], `${name}: no pointer to nothing`);
    const page = one.getPage(0);
    assert.deepEqual(shown(page).map((t) => t.text), [`Chapter ${i + 1}`]);
    const annots = page.node.Annots();
    for (let k = 0; k < (annots?.size() ?? 0); k++) {
      const annot = annots.lookup(k);
      kept.push(`${i + 1}:${annot.get(N('Subtype')).toString()}`);
      assert.equal(annot.get(N('P')), page.ref, `${name}: what stays on the page knows its page`);
      assert.ok(!annot.has(N('Dest')));
    }
  }
  assert.deepEqual(kept, ['1:/Link', '2:/Text'], 'the web link and the note stay, the six jumps are gone');
  assert.match(result.message, /^拆成了 4 个单页 PDF，共 .+。有 6 个跳到文档内其他位置的链接，在单页里无处可跳，去掉了。原文件没有改动。$/);
  assert.equal(sha(src), before);
});

test('split: when every file has to carry what the pages shared, the message says why they are larger', async () => {
  const dir = freshDir();
  // One picture of 400 KB that all three pages use.
  const doc = await PDFDocument.create();
  const shared = doc.context.register(doc.context.stream(crypto.randomBytes(400_000), { Type: 'XObject', Subtype: 'Image', Width: 800, Height: 500, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  for (let i = 0; i < 3; i++) doc.addPage([595, 842]).node.setXObject(PDFName.of('Logo'), shared);
  const src = path.join(dir, 'shared.pdf');
  fs.writeFileSync(src, await doc.save());

  const result = await action('pdf.split').run(filesCtx([src]), makeEnv(dir).env);

  const bytes = fs.readdirSync(result.path).reduce((sum, name) => sum + fs.statSync(path.join(result.path, name)).size, 0);
  assert.ok(bytes > 1_200_000, `three files of 400 KB each: ${bytes}`);
  assert.equal(result.message, `拆成了 3 个单页 PDF，共 ${sizeText(bytes)}。加起来比原文件（${sizeText(fs.statSync(src).size)}）大，因为各页共用的字体和图片现在每个文件里都有一份。原文件没有改动。`);
});

test('split refuses what cannot be split, in plain words, and writes nothing', async () => {
  const dir = freshDir();
  const single = await makePdf(path.join(dir, 'single.pdf'), plainPages(1));
  const locked = await makeEncryptedPdf(path.join(dir, 'locked.pdf'));
  const broken = path.join(dir, 'broken.pdf');
  fs.writeFileSync(broken, 'this is not a pdf');
  const listing = fs.readdirSync(dir).sort();
  const { env, log } = makeEnv(dir);

  await assert.rejects(action('pdf.split').run(filesCtx([single]), env), /只有 1 页/);
  await assert.rejects(action('pdf.split').run(filesCtx([locked]), env), /加了密/);
  await assert.rejects(action('pdf.split').run(filesCtx([broken]), env), /打不开这个 PDF/);
  const gone = { kind: 'files', files: describeFiles([path.join(dir, 'gone.pdf')]), text: '', has: {} };
  await assert.rejects(action('pdf.split').run(gone, env), /读不了这个文件：gone\.pdf/);

  assert.deepEqual(log.folders, [], 'no folder was asked for');
  assert.deepEqual(fs.readdirSync(dir).sort(), listing);
});

test('split: stopped part-way, the half-made folder is taken away', async () => {
  const dir = freshDir();
  const src = await makePdf(path.join(dir, 'long.pdf'), plainPages(6));
  const stopper = new AbortController();
  const { env, log } = makeEnv(dir, {}, stopper.signal);
  const step = env.step;
  env.step = (done, total, name) => {
    step(done, total, name);
    if (done === 2) stopper.abort(); // while the third page is being written
  };

  await assert.rejects(action('pdf.split').run(filesCtx([src]), env), /已取消/);

  assert.deepEqual(log.folders, ['long 单页']);
  assert.deepEqual(fs.readdirSync(dir), ['long.pdf'], 'the folder and the pages already written are gone');
});

// ---------------------------------------------------------------- pdf.images

/** Stands in for the hidden page: "draws" a page as a few bytes that name it. */
function fakeOpenPdf({ pages, sizes = [], fail = [] }) {
  const seen = { opened: [], rendered: [], closed: 0 };
  const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`page ${n}`), Buffer.from([0xff, 0xd9])]);
  const openPdf = async (file) => {
    seen.opened.push(file);
    return {
      pages,
      render: async (n, maxEdge) => {
        seen.rendered.push([n, maxEdge]);
        if (fail.includes(n)) throw new Error('render failed');
        const [w, h] = sizes[n - 1] ?? [1413, 2000];
        return { dataUrl: `data:image/jpeg;base64,${jpeg(n).toString('base64')}`, w, h };
      },
      text: async () => '',
      close: async () => {
        seen.closed++;
      },
    };
  };
  return { openPdf, seen, jpeg };
}

test('images: every page drawn 2000 px along its longer edge and saved as a JPEG in a new folder', async () => {
  const dir = freshDir();
  const src = await makePdf(path.join(dir, '图纸.pdf'), plainPages(3));
  const before = sha(src);
  const fake = fakeOpenPdf({ pages: 3, sizes: [[1413, 2000], [2000, 1413], [1413, 2000]] });
  const { env, log } = makeEnv(dir, { openPdf: fake.openPdf });

  const result = await action('pdf.images').run(filesCtx([src]), env);

  assert.equal(result.kind, 'folder');
  assert.deepEqual(log.folders, ['图纸 图片']);
  assert.deepEqual(fake.seen.opened, [src]);
  assert.deepEqual(fake.seen.rendered, [[1, 2000], [2, 2000], [3, 2000]]);
  assert.equal(fake.seen.closed, 1, 'the PDF is closed afterwards');
  const names = fs.readdirSync(result.path).sort();
  assert.deepEqual(names, ['图纸 第 01 页.jpg', '图纸 第 02 页.jpg', '图纸 第 03 页.jpg']);
  names.forEach((name, i) => assert.deepEqual(fs.readFileSync(path.join(result.path, name)), fake.jpeg(i + 1), `${name} holds the bytes of its page`));
  const bytes = names.reduce((sum, name) => sum + fs.statSync(path.join(result.path, name)).size, 0);
  assert.equal(result.message, `把 3 页存成了 3 张 JPEG 图片，长边 2000 像素，共 ${sizeText(bytes)}。`);
  assert.deepEqual(log.steps, [
    { done: 0, total: 3, name: '第 1 页' },
    { done: 1, total: 3, name: '第 2 页' },
    { done: 2, total: 3, name: '第 3 页' },
    { done: 3, total: 3, name: '' },
  ]);
  assert.equal(sha(src), before);
});

test('images: a page that cannot be drawn is skipped and named; small pages are reported at their real size', async () => {
  const dir = freshDir();
  const src = await makePdf(path.join(dir, 'mixed.pdf'), plainPages(4));
  const fake = fakeOpenPdf({ pages: 4, sizes: [[1413, 2000], [0, 0], [800, 1200], [1413, 2000]], fail: [2] });
  const { env } = makeEnv(dir, { openPdf: fake.openPdf });

  const result = await action('pdf.images').run(filesCtx([src]), env);

  assert.deepEqual(fs.readdirSync(result.path).sort(), ['mixed 第 01 页.jpg', 'mixed 第 03 页.jpg', 'mixed 第 04 页.jpg']);
  assert.match(result.message, /^把 3 页存成了 3 张 JPEG 图片，长边 1200–2000 像素，共 .+。第 2 页没能画出来，跳过了。$/);
  assert.equal(fake.seen.closed, 1);
});

test('images: when nothing can be drawn it fails, closes the PDF and leaves no empty folder', async () => {
  const dir = freshDir();
  const src = await makePdf(path.join(dir, 'bad.pdf'), plainPages(2));
  const fake = fakeOpenPdf({ pages: 2, fail: [1, 2] });
  const { env } = makeEnv(dir, { openPdf: fake.openPdf });

  await assert.rejects(action('pdf.images').run(filesCtx([src]), env), /2 页都没能画成图片/);
  assert.equal(fake.seen.closed, 1);
  assert.deepEqual(fs.readdirSync(dir), ['bad.pdf']);

  // Something that is not a JPEG coming back counts as not drawn.
  const odd = { pages: 2, render: async () => ({ dataUrl: 'data:,', w: 0, h: 0 }), close: async () => {} };
  await assert.rejects(action('pdf.images').run(filesCtx([src]), makeEnv(dir, { openPdf: async () => odd }).env), /都没能画成图片/);
  assert.deepEqual(fs.readdirSync(dir), ['bad.pdf']);

  // A PDF the hidden page cannot open: its own message comes through, nothing is written.
  const refuse = async () => {
    throw new Error('打不开这个 PDF：Invalid PDF structure');
  };
  await assert.rejects(action('pdf.images').run(filesCtx([src]), makeEnv(dir, { openPdf: refuse }).env), /打不开这个 PDF：Invalid PDF structure/);
  // One that wants a password: said the same way as by the other actions.
  const locked = async () => {
    throw new Error('打不开这个 PDF：No password given');
  };
  await assert.rejects(action('pdf.images').run(filesCtx([src]), makeEnv(dir, { openPdf: locked }).env), /^Error: 这个 PDF 加了密/);
  assert.deepEqual(fs.readdirSync(dir), ['bad.pdf']);
});

test('images: a one-page PDF becomes one picture next to it, without a folder', async () => {
  const dir = freshDir();
  const src = await makePdf(path.join(dir, '证书.pdf'), plainPages(1));
  const fake = fakeOpenPdf({ pages: 1, sizes: [[2000, 1413]] });
  const { env, log } = makeEnv(dir, { openPdf: fake.openPdf });

  const result = await action('pdf.images').run(filesCtx([src]), env);

  assert.equal(result.kind, 'file');
  assert.equal(result.path, path.join(dir, '证书.jpg'));
  assert.deepEqual(fs.readFileSync(result.path), fake.jpeg(1));
  assert.deepEqual(log.folders, []);
  assert.match(result.message, /只有 1 页.*2000×1413 像素/);
  assert.equal(fake.seen.closed, 1);
});

// ---------------------------------------------------------------- pdf.number

test('number: "n / N" in grey, centred at the bottom of every page as it is displayed', async () => {
  const dir = freshDir();
  const specs = [
    { size: [595, 842] },
    { size: [842, 595] },
    { size: [595, 842], rotate: 90 },
    { size: [420, 595], rotate: 180 },
    { size: [612, 792], rotate: 270 },
    { size: [700, 900], crop: [50, 60, 500, 700] },
    { size: [700, 900], crop: [50, 60, 500, 700], rotate: 90 },
    { size: [1684, 2384] },
  ];
  const src = await makePdf(path.join(dir, '合同.pdf'), specs, { title: 'The contract' });
  const before = sha(src);
  const { env, log } = makeEnv(dir);

  const result = await action('pdf.number').run(filesCtx([src]), env);

  assert.equal(result.kind, 'file');
  assert.equal(result.path, path.join(dir, '合同（带页码）.pdf'));
  assert.equal(result.message, '给 8 页都加了页码（“1 / 8”到“8 / 8”），灰色小字，在每页底部正中。原文件没有改动。');
  assert.equal(sha(src), before, 'the original is untouched');
  assert.deepEqual(log.steps.at(-1), { done: 8, total: 8, name: '' });

  const original = await open(src);
  const numbered = await open(result.path);
  assert.equal(numbered.getPageCount(), 8);
  assert.equal(numbered.getTitle(), 'The contract', 'the details of the document are kept');
  const font = await numbered.embedFont(StandardFonts.Helvetica);
  numbered.getPages().forEach((page, i) => {
    const was = original.getPage(i);
    const what = `page ${i + 1}`;
    assert.deepEqual(page.getMediaBox(), was.getMediaBox(), `${what} keeps its size`);
    assert.deepEqual(page.getCropBox(), was.getCropBox(), `${what} keeps its visible part`);
    assert.equal(page.getRotation().angle, was.getRotation().angle, `${what} keeps its rotation`);

    const texts = shown(page);
    assert.deepEqual(texts.map((t) => t.text), [`Body of page ${i + 1}`, `${i + 1} / 8`], `${what}: what was there, then the number`);
    const number = texts[1];
    const big = i === 7;
    assert.equal(number.size, big ? 20 : 10, `${what}: size`);
    assert.ok(number.grey > 0.2 && number.grey < 0.7, `${what}: grey, got ${number.grey}`);

    // As a viewer shows it: reading left to right, upright, centred, just above the bottom edge.
    const angle = page.getRotation().angle;
    const box = page.getCropBox();
    const [a, b, c, d, x, y] = number.matrix;
    const along = displayedDirection(angle, a, b);
    const up = displayedDirection(angle, c, d);
    near(along[0], 1, 1e-9, `${what}: reads left to right`);
    near(along[1], 0, 1e-9, `${what}: reads level`);
    near(up[1], -1, 1e-9, `${what}: stands upright`);
    const start = displayed(box, angle, x, y);
    const width = font.widthOfTextAtSize(number.text, number.size);
    near(start.x + width / 2, start.W / 2, 0.02, `${what}: centred`);
    near(start.H - start.y, big ? 48 : 24, 0.02, `${what}: distance from the bottom`);
  });
});

test('number: one page says "1 / 1"; encrypted and broken files are refused and nothing is written', async () => {
  const dir = freshDir();
  const single = await makePdf(path.join(dir, 'one.pdf'), plainPages(1));
  const { env, log } = makeEnv(dir);

  const result = await action('pdf.number').run(filesCtx([single]), env);
  assert.match(result.message, /给 1 页都加了页码（“1 \/ 1”）/);
  assert.deepEqual(shown((await open(result.path)).getPage(0)).map((t) => t.text), ['Body of page 1', '1 / 1']);

  const locked = await makeEncryptedPdf(path.join(dir, 'locked.pdf'));
  const broken = path.join(dir, 'broken.pdf');
  fs.writeFileSync(broken, '%PDF-1.4\nnothing more');
  const listing = fs.readdirSync(dir).sort();
  await assert.rejects(action('pdf.number').run(filesCtx([locked]), env), /加了密/);
  await assert.rejects(action('pdf.number').run(filesCtx([broken]), env), /打不开这个 PDF|没有页面/);
  assert.deepEqual(log.saved, ['one（带页码）.pdf']);
  assert.deepEqual(fs.readdirSync(dir).sort(), listing);
});

// ---------------------------------------------------------------- pdf.word

async function makeDocx(file, bodyXml) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${bodyXml}</w:body></w:document>`);
  const data = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(file, data);
  return data;
}
// A text box the way LibreOffice writes it: once for new Word, once more as a fallback.
const TEXT_BOX = '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:p><w:r><w:t xml:space="preserve">Hello 世界</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t xml:space="preserve">Hello 世界</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:r></w:p><w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p>';

/** Stands in for LibreOffice: "converts" into a temporary folder like the real officeConvert. */
function fakeOffice(bodyXml) {
  const seen = { calls: [], cleaned: 0, made: null };
  const officeConvert = async (file, format, options) => {
    seen.calls.push([file, format, options]);
    const out = fs.mkdtempSync(path.join(root, 'lo-'));
    seen.made = path.join(out, 'converted.docx');
    seen.data = await makeDocx(seen.made, bodyXml);
    return {
      path: seen.made,
      cleanup: () => {
        seen.cleaned++;
        fs.rmSync(out, { recursive: true, force: true });
      },
    };
  };
  return { officeConvert, seen };
}

test('docxChars counts the text of a Word document once, spaces aside', async () => {
  const dir = freshDir();
  assert.equal(await docxChars(await makeDocx(path.join(dir, 'a.docx'), TEXT_BOX)), 7 + 3);
  assert.equal(await docxChars(await makeDocx(path.join(dir, 'b.docx'), '<w:p/>')), 0);
  assert.equal(await docxChars(Buffer.from('not a zip')), null);
});

test('word: converted by LibreOffice with the PDF import filter, saved next to the PDF, and honest about the layout', async () => {
  const dir = freshDir();
  const src = await makePdf(path.join(dir, '通知.pdf'), plainPages(2));
  const before = sha(src);
  const fake = fakeOffice(TEXT_BOX);
  const { env, log } = makeEnv(dir, { officeConvert: fake.officeConvert, hasOffice: true });

  const result = await action('pdf.word').run(filesCtx([src], { office: true }), env);

  assert.deepEqual(fake.seen.calls, [[src, 'docx:MS Word 2007 XML', { inFilter: 'writer_pdf_import' }]]);
  assert.equal(result.kind, 'file');
  assert.equal(result.path, path.join(dir, '通知.docx'));
  assert.deepEqual(log.saved, ['通知.docx']);
  assert.deepEqual(fs.readFileSync(result.path), fake.seen.data, 'what LibreOffice made is what was saved');
  assert.equal(fake.seen.cleaned, 1, 'the temporary folder is cleaned up');
  assert.ok(!fs.existsSync(fake.seen.made));
  assert.equal(result.message, `已转成 Word（${sizeText(fake.seen.data.length)}，10 字）。版式是 LibreOffice 照着 PDF 重建的，文字大多落在一个个文本框里，可能和原件不同。`);
  assert.equal(sha(src), before);
});

test('word: a scan comes out with no text, and the message says so', async () => {
  const dir = freshDir();
  const src = await makePdf(path.join(dir, 'scan.pdf'), plainPages(1));
  const fake = fakeOffice('<w:p><w:r><w:drawing/></w:r></w:p>');
  const { env } = makeEnv(dir, { officeConvert: fake.officeConvert });

  const result = await action('pdf.word').run(filesCtx([src], { office: true }), env);

  assert.match(result.message, /没有可以编辑的文字：这个 PDF 可能是扫描件/);
  assert.match(result.message, /LibreOffice.*可能和原件不同/);
  assert.equal(fake.seen.cleaned, 1);
});

test('word: when LibreOffice gives up, its message comes through, or the password is named', async () => {
  const dir = freshDir();
  const src = await makePdf(path.join(dir, 'a.pdf'), plainPages(1));
  const locked = await makeEncryptedPdf(path.join(dir, 'locked.pdf'));
  const listing = fs.readdirSync(dir).sort();
  const officeConvert = async () => {
    throw new Error('LibreOffice 没能转换这个文件');
  };
  const { env } = makeEnv(dir, { officeConvert });

  await assert.rejects(action('pdf.word').run(filesCtx([src], { office: true }), env), /LibreOffice 没能转换这个文件/);
  await assert.rejects(action('pdf.word').run(filesCtx([locked], { office: true }), env), /加了密/);
  assert.deepEqual(fs.readdirSync(dir).sort(), listing);
});

test('word: real LibreOffice preserves PDF text or explicitly refuses a missing PDF importer', async (t) => {
  // The real converter lives in src/main/office/index.js, next to the other sets of actions.
  let office;
  try {
    office = await import('../src/main/office/index.js');
  } catch (err) {
    t.skip(`src/main/office/index.js could not be loaded: ${String(err?.message ?? err).slice(0, 120)}`);
    return;
  }
  if (!office.findOffice()) {
    t.skip('LibreOffice (soffice) is not installed on this machine');
    return;
  }
  const dir = freshDir();
  const src = await makePdf(path.join(dir, 'letter.pdf'), [{ text: 'Quarterly results improved' }, { text: 'Second page of the letter' }]);
  const { env } = makeEnv(dir, { officeConvert: office.officeConvert, hasOffice: true });

  let result;
  try {
    result = await action('pdf.word').run(filesCtx([src], { office: true }), env);
  } catch (err) {
    if (err.code !== 'LO_PDF_IMPORT_UNAVAILABLE') throw err;
    assert.deepEqual(fs.readdirSync(dir), ['letter.pdf'], 'an unsupported conversion must not leave a corrupt docx');
    t.diagnostic('This LibreOffice lacks PDF import support; verified explicit refusal, not successful PDF-to-Word conversion.');
    return;
  }

  assert.equal(result.path, path.join(dir, 'letter.docx'));
  const zip = await JSZip.loadAsync(fs.readFileSync(result.path));
  const xml = await zip.file('word/document.xml').async('string');
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').replace(/\s+/g, '');
  assert.ok(text.includes('Quarterlyresultsimproved') && text.includes('Secondpageoftheletter'), `the words of both pages are in the document: ${text.slice(0, 200)}`);
  const chars = 'QuarterlyresultsimprovedSecondpageoftheletter'.length;
  assert.match(result.message, new RegExp(`^已转成 Word（.+，${chars} 字）。版式是 LibreOffice 照着 PDF 重建的`), result.message);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['letter.docx', 'letter.pdf']);
});
