// The picture actions (src/main/office/tools-image.js) with a hand-made env: results go into a
// temporary folder, and the hidden page that does the drawing (env.tools.canvas) is played by a
// stand-in that answers from a table and notes what it was asked. The "pictures" are a few
// right first bytes and padding. The same actions on real pictures inside the real app:
// test/e2e/office-image.mjs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeFiles } from '../src/core/office-kinds.js';
import { actions as basic } from '../src/main/office/tools-basic.js';
import { LONG_HEIGHT, LONG_WIDTH, SHRINK_EDGE, SHRINK_QUALITY, actions, describeConvert, describeShrink, freeName, savedText, sizeText, sniff, stackLayout } from '../src/main/office/tools-image.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-image-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const action = (id) => actions.find((a) => a.id === id);
const MINE = ['images.long', 'images.shrink', 'image.ocr', 'image.jpg', 'image.webp', 'image.png'];
let folders = 0;
const freshDir = () => {
  const dir = path.join(root, `case-${++folders}`);
  fs.mkdirSync(dir);
  return dir;
};
const filesCtx = (paths, has = {}) => ({ kind: 'files', files: describeFiles(paths), text: '', has: { office: false, model: true, ...has } });
const textCtx = (text) => ({ kind: 'text', files: [], text, has: { office: false, model: true } });
const applying = (ctx) => MINE.filter((id) => action(id).applies(ctx));
/** What the panel shows without "更多": the four lowest ranks among these actions and the basic ones. */
const visible = (ctx) => [...basic, ...actions].filter((a) => a.applies(ctx)).sort((a, b) => a.rank - b.rank).slice(0, 4).map((a) => a.id);

// ---- bytes that begin like pictures

const pad = (head, size) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x11)]);
const jpegBytes = (size = 64) => pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), size);
function pngChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // the checksum is not looked at
}
const PNG_SIGN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = (size = 64, { animated = false } = {}) =>
  pad(Buffer.concat([PNG_SIGN, pngChunk('IHDR', Buffer.alloc(13)), ...(animated ? [pngChunk('acTL', Buffer.alloc(8))] : []), pngChunk('IDAT', Buffer.alloc(10)), pngChunk('IEND')]), size);
/** A real 1x1 GIF with this many frames; `localTable` gives each frame its own colours. */
function gifBytes(frames = 1, { localTable = false, version = 'GIF89a' } = {}) {
  const parts = [Buffer.from(version, 'latin1'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])];
  if (frames > 1) parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0])); // "loop for ever"
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0])); // how long the frame is shown
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, localTable ? 0x80 : 0]));
    if (localTable) parts.push(Buffer.from([0, 0, 0, 255, 0, 0]));
    parts.push(Buffer.from([2, 2, 0x4c, 0x01, 0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
function webpBytes({ animated = false, extended = animated, size = 64 } = {}) {
  const body = extended ? Buffer.concat([Buffer.from('VP8X', 'latin1'), Buffer.from([10, 0, 0, 0, animated ? 0x02 : 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0])]) : Buffer.concat([Buffer.from('VP8 ', 'latin1'), Buffer.alloc(14)]);
  return pad(Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([56, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), body]), size);
}
const bmpBytes = (size = 64) => pad(Buffer.from('BM', 'latin1'), size);

/** Write "pictures" into a new folder: { 'a.jpg': bytes, ... } -> their paths, in that order. */
function put(named, dir = freshDir()) {
  return Object.entries(named).map(([name, bytes]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  });
}

// ---- stand-ins for what the app provides

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
function makeEnv(dir, canvas, signal) {
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
    tools: { canvas },
  };
  return { env, log };
}

/**
 * The hidden page's canvas, answering from a table: { 'a.png': { w, h, alpha?, out?, fail? } }.
 * `out` is how many bytes the picture comes to when it is encoded again; `fail` is the reason
 * it cannot be read. Encoded pictures are bytes of 'J' (a JPEG) or 'P' (a PNG).
 */
function fakeCanvas(table = {}) {
  const calls = [];
  const lookUp = (file) => {
    const spec = table[path.basename(file)];
    assert.ok(spec, `the canvas was asked about ${file}`);
    if (spec.fail) throw Object.assign(new Error(`这张图片${spec.fail}`), { why: spec.fail });
    return spec;
  };
  return {
    calls,
    of: (fn) => calls.filter((c) => c.fn === fn),
    async measure(file, o = {}) {
      calls.push({ fn: 'measure', file, o });
      const spec = lookUp(file);
      return { w: spec.w, h: spec.h, alpha: Boolean(spec.alpha) };
    },
    async encode(file, o = {}) {
      calls.push({ fn: 'encode', file, o });
      const spec = lookUp(file);
      const type = o.type === 'auto' ? (spec.alpha ? 'png' : 'jpeg') : o.type;
      const scale = o.maxEdge ? Math.min(1, o.maxEdge / Math.max(spec.w, spec.h)) : 1;
      return { buffer: Buffer.alloc(spec.out, type === 'png' ? 'P' : 'J'), w: Math.round(spec.w * scale), h: Math.round(spec.h * scale), type, srcW: spec.w, srcH: spec.h, alpha: Boolean(spec.alpha) };
    },
    async stack(files, o) {
      calls.push({ fn: 'stack', files, o });
      return { buffer: Buffer.alloc(table.stacked ?? 5000, 'S'), w: o.width, h: o.heights.reduce((a, b) => a + b, 0), type: o.type };
    },
  };
}
const names = (dir) => fs.readdirSync(dir).sort();
const snapshot = (files) => files.map((f) => fs.readFileSync(f).toString('base64'));

// ---------------------------------------------------------------- when each action is offered

test('offered for pictures only, and only where it changes something', () => {
  const dir = freshDir();
  const at = (...list) => filesCtx(list.map((n) => path.join(dir, n)));
  assert.deepEqual(applying(at('a.jpg')), ['images.shrink', 'image.ocr', 'image.webp', 'image.png'], 'a JPG is not offered "转成 JPG"');
  assert.deepEqual(applying(at('a.JPEG')), ['images.shrink', 'image.ocr', 'image.webp', 'image.png'], '.jpeg is a JPG too, whatever the case');
  assert.deepEqual(applying(at('a.png')), ['images.shrink', 'image.ocr', 'image.jpg', 'image.webp'], 'a PNG is not offered "转成 PNG"');
  assert.deepEqual(applying(at('a.webp')), ['images.shrink', 'image.ocr', 'image.jpg', 'image.png'], 'a WebP is not offered "转成 WebP"');
  for (const name of ['a.gif', 'a.bmp', 'a.avif', 'a.svg', 'a.ico']) assert.deepEqual(applying(at(name)), ['images.shrink', 'image.ocr', 'image.jpg', 'image.webp', 'image.png'], name);
  assert.deepEqual(applying(at('a.jpg', 'b.jpeg')), ['images.long', 'images.shrink', 'image.webp', 'image.png'], 'all JPGs: to WebP or PNG');
  assert.deepEqual(applying(at('a.png', 'b.png', 'c.PNG')), ['images.long', 'images.shrink', 'image.jpg', 'image.webp'], 'all PNGs: to JPG or WebP');
  assert.deepEqual(applying(at('a.jpg', 'b.png')), ['images.long', 'images.shrink', 'image.jpg', 'image.webp', 'image.png'], 'mixed: either way changes something');
  assert.deepEqual(applying(at('a.jpg', 'b.webp')), ['images.long', 'images.shrink', 'image.jpg', 'image.webp', 'image.png']);
});

test('not offered when the selection is not all pictures', () => {
  const dir = freshDir();
  const at = (...list) => filesCtx(list.map((n) => path.join(dir, n)));
  assert.deepEqual(applying(at('a.jpg', 'b.pdf')), [], 'a picture and a PDF');
  assert.deepEqual(applying(at('a.png', 'b.png', 'notes.txt')), [], 'pictures and a text file');
  assert.deepEqual(applying(at('report.docx')), []);
  assert.deepEqual(applying(at('a.pdf')), []);
  assert.deepEqual(applying(filesCtx([])), [], 'nothing selected');
  assert.deepEqual(applying(textCtx('a.png and b.png')), [], 'selected text');
});

test('"识别文字" needs exactly one picture and a local model', () => {
  const dir = freshDir();
  const one = [path.join(dir, 'scan.png')];
  assert.equal(action('image.ocr').applies(filesCtx(one)), true);
  assert.equal(action('image.ocr').applies(filesCtx(one, { model: false })), false, 'no model on this machine');
  assert.equal(action('image.ocr').applies(filesCtx([...one, path.join(dir, 'b.png')])), false, 'two pictures');
  assert.equal(action('image.ocr').applies({ kind: 'files', files: describeFiles(one), text: '' }), false, 'nothing known about the machine');
});

test('the four actions that show: one picture, several pictures', () => {
  const dir = freshDir();
  const at = (list, has) => filesCtx(list.map((n) => path.join(dir, n)), has);
  assert.deepEqual(visible(at(['a.png'])), ['files.pdf', 'images.shrink', 'image.ocr', 'files.pptx']);
  assert.deepEqual(visible(at(['a.jpg'])), ['files.pdf', 'images.shrink', 'image.ocr', 'files.pptx']);
  assert.deepEqual(visible(at(['a.jpg', 'b.png', 'c.webp'])), ['files.pdf', 'images.long', 'images.shrink', 'files.pptx']);
  assert.deepEqual(visible(at(['a.png'], { model: false })), ['files.pdf', 'images.shrink', 'files.pptx', 'image.jpg'], 'without a model a conversion moves up');
  const ids = actions.map((a) => a.id);
  assert.deepEqual([...ids].sort(), [...MINE].sort());
  assert.equal(new Set(actions.map((a) => a.rank)).size, actions.length, 'no two of them share a rank');
  for (const a of actions) assert.ok(a.label && a.hint && typeof a.applies === 'function' && typeof a.run === 'function', a.id);
});

// ---------------------------------------------------------------- the helpers that only compute

test('sizeText: bytes, KB, MB', () => {
  assert.equal(sizeText(0), '0 字节');
  assert.equal(sizeText(812), '812 字节');
  assert.equal(sizeText(1024), '1.0 KB');
  assert.equal(sizeText(3481), '3.4 KB');
  assert.equal(sizeText(10 * 1024), '10 KB');
  assert.equal(sizeText(122_880), '120 KB');
  assert.equal(sizeText(1023 * 1024), '1.0 MB', 'never "1023 KB" rounded up to "1024 KB"');
  assert.equal(sizeText(1024 * 1024), '1.0 MB');
  assert.equal(sizeText(2_621_440), '2.5 MB');
  assert.equal(sizeText(250 * 1024 * 1024), '250 MB');
});

test('savedText: a share of the original, never 0% or 100%', () => {
  assert.equal(savedText(1000, 210), '小了 79%');
  assert.equal(savedText(1000, 500), '小了 50%');
  assert.equal(savedText(1000, 995), '小了不到 1%');
  assert.equal(savedText(100_000, 1), '小了 99%');
  assert.equal(savedText(0, 0), '小了不到 1%');
});

test('sniff: the format is read from the bytes', () => {
  assert.deepEqual(sniff(jpegBytes()), { type: 'jpeg', animated: false });
  assert.deepEqual(sniff(pngBytes()), { type: 'png', animated: false });
  assert.deepEqual(sniff(gifBytes(1)), { type: 'gif', animated: false });
  assert.deepEqual(sniff(gifBytes(1, { version: 'GIF87a' })), { type: 'gif', animated: false });
  assert.deepEqual(sniff(webpBytes()), { type: 'webp', animated: false });
  assert.deepEqual(sniff(bmpBytes()), { type: 'bmp', animated: false });
  assert.deepEqual(sniff(Buffer.from('just some text, not a picture')), { type: '', animated: false });
  assert.deepEqual(sniff(Buffer.alloc(0)), { type: '', animated: false });
  // A plain Uint8Array, and one that is a window into a larger buffer.
  assert.equal(sniff(new Uint8Array(jpegBytes())).type, 'jpeg');
  const framed = Buffer.concat([Buffer.from('xxxx'), pngBytes(), Buffer.from('yyyy')]);
  assert.equal(sniff(new Uint8Array(framed.buffer, framed.byteOffset + 4, framed.length - 8)).type, 'png');
});

test('sniff: pictures that move', () => {
  assert.deepEqual(sniff(gifBytes(2)), { type: 'gif', animated: true });
  assert.deepEqual(sniff(gifBytes(5, { localTable: true })), { type: 'gif', animated: true }, 'frames with their own colour tables');
  assert.deepEqual(sniff(gifBytes(1, { localTable: true })), { type: 'gif', animated: false });
  assert.deepEqual(sniff(pngBytes(200, { animated: true })), { type: 'png', animated: true });
  assert.deepEqual(sniff(webpBytes({ animated: true })), { type: 'webp', animated: true });
  assert.deepEqual(sniff(webpBytes({ extended: true })), { type: 'webp', animated: false }, 'an extended WebP that only has transparency');
  // Cut short: still told apart, and nothing is thrown.
  assert.deepEqual(sniff(gifBytes(3).subarray(0, 30)), { type: 'gif', animated: false });
  assert.deepEqual(sniff(pngBytes().subarray(0, 14)), { type: 'png', animated: false });
  assert.deepEqual(sniff(webpBytes({ animated: true }).subarray(0, 18)), { type: 'webp', animated: false });
});

test('stackLayout: one width for all, heights that keep the shapes', () => {
  assert.equal(LONG_WIDTH, 1600);
  assert.deepEqual(stackLayout([{ w: 800, h: 400 }, { w: 1200, h: 300 }, { w: 2000, h: 1000 }]), { width: 1600, heights: [800, 400, 800], height: 2000, reduced: 1, enlarged: 2 });
  assert.deepEqual(stackLayout([{ w: 1080, h: 2340 }, { w: 1080, h: 1920 }]), { width: 1080, heights: [2340, 1920], height: 4260, reduced: 0, enlarged: 0 }, 'the widest is under the cap: its width is used');
  assert.deepEqual(stackLayout([{ w: 750, h: 1334 }, { w: 1125, h: 2436 }]), { width: 1125, heights: [2001, 2436], height: 4437, reduced: 0, enlarged: 1 }, 'the narrower one is enlarged');
  assert.deepEqual(stackLayout([{ w: 4000, h: 3000 }, { w: 3000, h: 4000 }]), { width: 1600, heights: [1200, 2133], height: 3333, reduced: 2, enlarged: 0 }, 'heights are rounded to whole pixels');
  assert.deepEqual(stackLayout([{ w: 5000, h: 1 }, { w: 1600, h: 10 }]).heights, [1, 10], 'never thinner than one pixel');
  assert.deepEqual(stackLayout([{ w: 300, h: 100 }, { w: 600, h: 100 }], 400), { width: 400, heights: [133, 67], height: 200, reduced: 1, enlarged: 1 });
});

test('freeName: no two files in a folder get the same name', () => {
  const taken = new Set();
  assert.equal(freeName(taken, 'a.jpg'), 'a.jpg');
  assert.equal(freeName(taken, 'a.jpg'), 'a (2).jpg');
  assert.equal(freeName(taken, 'A.JPG'), 'A (3).JPG', 'names that differ only in case are the same file on some disks');
  assert.equal(freeName(taken, 'b.jpg'), 'b.jpg');
  assert.equal(freeName(taken, 'a (2).jpg'), 'a (2) (2).jpg');
});

test('describeShrink: how many, and the bytes before and after', () => {
  const jpeg = (before, after, more = {}) => ({ before, after, how: 'jpeg', resized: false, w: 800, h: 600, srcW: 800, srcH: 600, ...more });
  const kept = (bytes, how = 'small') => ({ before: bytes, after: bytes, how });
  assert.equal(
    describeShrink([jpeg(2_516_582, 317_440, { resized: true, w: 1920, h: 1440, srcW: 4000, srcH: 3000 })]),
    '压缩了 1 张图片：2.4 MB → 310 KB，小了 87%。尺寸 4000×3000 → 1920×1440 像素，存成 JPEG。原图没有改动。',
  );
  assert.equal(describeShrink([jpeg(1_153_434, 245_760)]), '压缩了 1 张图片：1.1 MB → 240 KB，小了 79%。尺寸没变（800×600 像素），存成 JPEG。原图没有改动。');
  assert.equal(
    describeShrink([{ before: 900_000, after: 600_000, how: 'png', resized: true, w: 1920, h: 960, srcW: 2400, srcH: 1200 }]),
    '压缩了 1 张图片：879 KB → 586 KB，小了 33%。尺寸 2400×1200 → 1920×960 像素，有透明的地方，所以存成 PNG。原图没有改动。',
  );
  assert.equal(describeShrink([kept(86_016)]), '这张图片已经很小（84 KB），再压缩反而会变大，所以原样存了一份副本。');
  assert.equal(describeShrink([kept(1_258_291, 'animated')]), '这是一张动图（1.2 MB），压缩会丢掉动画，所以没有压缩，原样存了一份副本。');
  // Several: the totals are sums over everything that was written.
  assert.equal(
    describeShrink([jpeg(3_000_000, 400_000, { resized: true }), jpeg(2_000_000, 300_000, { resized: true }), jpeg(452_608, 100_000)]),
    `压缩了 3 张图片：共 ${sizeText(5_452_608)} → ${sizeText(800_000)}，小了 85%。2 张长边缩到了 1920 像素；存成 JPEG。原图没有改动。`,
  );
  assert.equal(
    describeShrink([jpeg(3_000_000, 400_000, { resized: true }), { before: 2_000_000, after: 1_500_000, how: 'png', resized: true }]),
    '压缩了 2 张图片：共 4.8 MB → 1.8 MB，小了 62%。长边都缩到了 1920 像素；1 张有透明的地方，存成 PNG，其余存成 JPEG。原图没有改动。',
  );
  assert.equal(
    describeShrink([jpeg(4_000_000, 1_000_000), kept(50_000), kept(30_000), kept(920_000, 'animated')]),
    '压缩了 1 张图片，另外 3 张原样复制（2 张已经很小，再压缩反而会变大；1 张是动图，压缩会丢掉动画）。4 张共 4.8 MB → 1.9 MB，小了 60%。压缩的 1 张：尺寸没变；存成 JPEG。原图没有改动。',
  );
  assert.equal(
    describeShrink([jpeg(4_000_000, 1_000_000, { resized: true }), jpeg(4_000_000, 1_000_000), kept(1_000_000)]),
    '压缩了 2 张图片，另外 1 张已经很小（再压缩反而会变大），原样复制。3 张共 8.6 MB → 2.9 MB，小了 67%。压缩的 2 张：1 张长边缩到了 1920 像素；存成 JPEG。原图没有改动。',
  );
  assert.equal(describeShrink([kept(2048), kept(4096), kept(1024, 'animated')]), '3 张图片都没有压缩，原样各存了一份副本（共 7.0 KB）：2 张已经很小，再压缩反而会变大；1 张是动图，压缩会丢掉动画。');
});

test('describeConvert: what was made, what was only copied, what was lost', () => {
  const made = (before, after, more = {}) => ({ before, after, how: 'made', w: 1200, h: 800, alpha: false, animated: false, ...more });
  const same = (bytes) => ({ before: bytes, after: bytes, how: 'same' });
  assert.equal(describeConvert('JPG', [made(1_153_434, 245_760)]), '已转成 JPG：1200×800 像素，240 KB（原图 1.1 MB）。原图没有改动。');
  assert.equal(describeConvert('JPG', [made(14_336, 44_032, { alpha: true })]), '已转成 JPG：1200×800 像素，43 KB（原图 14 KB）。透明的地方填成了白色。原图没有改动。');
  assert.equal(describeConvert('PNG', [made(245_760, 3_565_158, { alpha: true })]), '已转成 PNG：1200×800 像素，3.4 MB（原图 240 KB）。原图没有改动。', 'a PNG keeps what is transparent');
  assert.equal(describeConvert('PNG', [made(1203, 5000, { animated: true })]), '已转成 PNG：1200×800 像素，4.9 KB（原图 1.2 KB）。原图是动图，只取了第一帧。原图没有改动。');
  assert.equal(describeConvert('JPG', [same(300_000)]), '这个文件的内容本来就是 JPG，只是扩展名不同，所以原样另存了一份（293 KB）。');
  assert.equal(
    describeConvert('JPG', [made(1_000_000, 200_000, { alpha: true }), made(500_000, 100_000, { animated: true }), made(2_000_000, 700_000), same(1_048_576)]),
    '把 3 张图片转成了 JPG，另外 1 张本来就是 JPG，原样复制。4 张共 2.0 MB（原图共 4.3 MB）。1 张有透明的地方，填成了白色。1 张是动图，只取了第一帧。原图没有改动。',
  );
  assert.equal(describeConvert('PNG', [made(100_000, 900_000), made(100_000, 124_000)]), '把 2 张图片转成了 PNG。2 张共 1.0 MB（原图共 195 KB）。原图没有改动。');
  assert.equal(describeConvert('JPG', [same(1024), same(1024)]), '2 张图片的内容本来就是 JPG，原样各存了一份（共 2.0 KB）。');
});

// ---------------------------------------------------------------- 压缩图片

test('shrink, one picture: a new JPEG next to it, the original as it was', async () => {
  const [file] = put({ '旅行.jpg': jpegBytes(5000) });
  const before = snapshot([file]);
  const canvas = fakeCanvas({ '旅行.jpg': { w: 4000, h: 3000, out: 1200 } });
  const { env, log } = makeEnv(path.dirname(file), canvas);
  const r = await action('images.shrink').run(filesCtx([file]), env);
  assert.equal(r.kind, 'file');
  assert.equal(path.basename(r.path), '旅行（已压缩）.jpg');
  assert.deepEqual(fs.readFileSync(r.path), Buffer.alloc(1200, 'J'), 'what the canvas made is what was written');
  assert.equal(r.message, '压缩了 1 张图片：4.9 KB → 1.2 KB，小了 76%。尺寸 4000×3000 → 1920×1440 像素，存成 JPEG。原图没有改动。');
  assert.deepEqual(canvas.calls, [{ fn: 'encode', file, o: { maxEdge: 1920, type: 'auto', quality: 0.82, opaque: true } }], 'longest edge 1920, JPEG quality 0.82; a JPEG is known to have no transparency');
  assert.equal(SHRINK_EDGE, 1920);
  assert.equal(SHRINK_QUALITY, 0.82);
  assert.deepEqual(snapshot([file]), before);
  assert.deepEqual(log.steps.at(-1), { done: 1, total: 1, name: '' });
});

test('shrink: a PNG with transparency stays a PNG, one without becomes a JPEG', async () => {
  const [glass, flat] = put({ 'glass.png': pngBytes(9000), 'flat.png': pngBytes(9000) });
  const canvas = fakeCanvas({ 'glass.png': { w: 2400, h: 1200, alpha: true, out: 6000 }, 'flat.png': { w: 1000, h: 700, out: 2000 } });
  const dir = path.dirname(glass);
  const a = await action('images.shrink').run(filesCtx([glass]), makeEnv(dir, canvas).env);
  assert.equal(path.basename(a.path), 'glass（已压缩）.png');
  assert.deepEqual(fs.readFileSync(a.path), Buffer.alloc(6000, 'P'));
  assert.equal(a.message, '压缩了 1 张图片：8.8 KB → 5.9 KB，小了 33%。尺寸 2400×1200 → 1920×960 像素，有透明的地方，所以存成 PNG。原图没有改动。');
  const b = await action('images.shrink').run(filesCtx([flat]), makeEnv(dir, canvas).env);
  assert.equal(path.basename(b.path), 'flat（已压缩）.jpg');
  assert.match(b.message, /尺寸没变（1000×700 像素），存成 JPEG/);
  assert.deepEqual(canvas.of('encode').map((c) => c.o.opaque), [false, false], 'a PNG is looked at for transparency');
});

test('shrink: a result that would be larger is not kept; the original bytes are copied instead', async () => {
  const original = jpegBytes(3000);
  for (const [out, expectKept] of [[3001, true], [3000, true], [2999, false], [90_000, true]]) {
    const [file] = put({ 'IMG_0001.JPG': original });
    const { env } = makeEnv(path.dirname(file), fakeCanvas({ 'IMG_0001.JPG': { w: 640, h: 480, out } }));
    const r = await action('images.shrink').run(filesCtx([file]), env);
    if (expectKept) {
      assert.equal(path.basename(r.path), 'IMG_0001（已压缩）.JPG', `${out} bytes: the copy keeps the original's extension`);
      assert.deepEqual(fs.readFileSync(r.path), original, `${out} bytes: the very bytes of the original`);
      assert.equal(r.message, '这张图片已经很小（2.9 KB），再压缩反而会变大，所以原样存了一份副本。');
    } else {
      assert.equal(path.basename(r.path), 'IMG_0001（已压缩）.jpg');
      assert.equal(fs.statSync(r.path).size, out);
      assert.match(r.message, /^压缩了 1 张图片：2\.9 KB → 2\.9 KB，小了不到 1%。/);
    }
    assert.deepEqual(fs.readFileSync(file), original);
  }
});

test('shrink, several pictures: a folder, and the sums in the message', async () => {
  const dir = freshDir();
  const files = put({ 'a.jpg': jpegBytes(400_000), 'b.png': pngBytes(300_000), 'c.png': pngBytes(250_000), 'd.jpg': jpegBytes(10_000), 'e.gif': gifBytes(3), 'f.webp': webpBytes({ size: 50_000 }) }, dir);
  const before = snapshot(files);
  const canvas = fakeCanvas({
    'a.jpg': { w: 4000, h: 3000, out: 90_000 },
    'b.png': { w: 3000, h: 1000, alpha: true, out: 120_000 },
    'c.png': { w: 1000, h: 800, out: 40_000 },
    'd.jpg': { w: 300, h: 200, out: 12_000 }, // would be larger
    'f.webp': { w: 1920, h: 1080, out: 30_000 },
  });
  const { env, log } = makeEnv(dir, canvas);
  const r = await action('images.shrink').run(filesCtx(files), env);
  assert.equal(r.kind, 'folder');
  assert.equal(path.basename(r.path), 'a 等 6 张图片（已压缩）');
  assert.equal(path.dirname(r.path), dir);
  assert.deepEqual(names(r.path), ['a.jpg', 'b.png', 'c.jpg', 'd.jpg', 'e.gif', 'f.jpg']);
  const size = (n) => fs.statSync(path.join(r.path, n)).size;
  assert.deepEqual(['a.jpg', 'b.png', 'c.jpg', 'f.jpg'].map(size), [90_000, 120_000, 40_000, 30_000]);
  assert.deepEqual(fs.readFileSync(path.join(r.path, 'd.jpg')), jpegBytes(10_000), 'already small: the original bytes');
  assert.deepEqual(fs.readFileSync(path.join(r.path, 'e.gif')), gifBytes(3), 'a moving picture: the original bytes');
  const gif = gifBytes(3).length;
  const sumBefore = 400_000 + 300_000 + 250_000 + 10_000 + gif + 50_000;
  const sumAfter = 90_000 + 120_000 + 40_000 + 10_000 + gif + 30_000;
  assert.equal(
    r.message,
    `压缩了 4 张图片，另外 2 张原样复制（1 张已经很小，再压缩反而会变大；1 张是动图，压缩会丢掉动画）。6 张共 ${sizeText(sumBefore)} → ${sizeText(sumAfter)}，${savedText(sumBefore, sumAfter)}。压缩的 4 张：2 张长边缩到了 1920 像素；1 张有透明的地方，存成 PNG，其余存成 JPEG。原图没有改动。`,
  );
  assert.match(r.message, /6 张共 986 KB → 283 KB，小了 71%/);
  assert.deepEqual(canvas.of('encode').map((c) => path.basename(c.file)), ['a.jpg', 'b.png', 'c.png', 'd.jpg', 'f.webp'], 'in the order given; the moving one is not drawn at all');
  assert.deepEqual(snapshot(files), before, 'no original was touched');
  assert.deepEqual(names(dir), ['a 等 6 张图片（已压缩）', 'a.jpg', 'b.png', 'c.png', 'd.jpg', 'e.gif', 'f.webp'], 'nothing else was written');
  assert.deepEqual(log.steps.map((s) => s.done), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(log.steps.every((s) => s.total === 6));
});

test('shrink, several: pictures that would get the same name are both kept', async () => {
  const files = put({ 'pic.png': pngBytes(8000), 'pic.jpg': jpegBytes(8000), 'PIC.webp': webpBytes({ size: 8000 }) });
  const canvas = fakeCanvas({ 'pic.png': { w: 10, h: 10, out: 100 }, 'pic.jpg': { w: 10, h: 10, out: 200 }, 'PIC.webp': { w: 10, h: 10, out: 300 } });
  const r = await action('images.shrink').run(filesCtx(files), makeEnv(path.dirname(files[0]), canvas).env);
  assert.deepEqual(names(r.path), ['PIC (3).jpg', 'pic (2).jpg', 'pic.jpg']);
  assert.deepEqual(['pic.jpg', 'pic (2).jpg', 'PIC (3).jpg'].map((n) => fs.statSync(path.join(r.path, n)).size), [100, 200, 300]);
});

test('shrink, several: a picture that cannot be read is left out and named', async () => {
  const files = put({ 'ok.jpg': jpegBytes(9000), 'bad.png': Buffer.from('not a picture at all'), 'fine.png': pngBytes(9000) });
  const canvas = fakeCanvas({ 'ok.jpg': { w: 100, h: 100, out: 3000 }, 'bad.png': { fail: '读不出来，可能不是图片或文件已损坏' }, 'fine.png': { w: 100, h: 100, out: 3000 } });
  const r = await action('images.shrink').run(filesCtx(files), makeEnv(path.dirname(files[0]), canvas).env);
  assert.deepEqual(names(r.path), ['fine.jpg', 'ok.jpg']);
  assert.match(r.message, /^压缩了 2 张图片：共 18 KB → 5\.9 KB，小了 67%。/);
  assert.match(r.message, /没能处理：bad\.png（读不出来，可能不是图片或文件已损坏）。$/);
});

test('shrink: when nothing can be done, an error and nothing left behind', async () => {
  const dir = freshDir();
  const files = put({ 'x.png': Buffer.from('junk'), 'y.png': Buffer.from('junk') }, dir);
  const canvas = fakeCanvas({ 'x.png': { fail: '读不出来，可能不是图片或文件已损坏' }, 'y.png': { fail: '有 70000×70000 像素，太大了，处理不了' } });
  await assert.rejects(action('images.shrink').run(filesCtx(files), makeEnv(dir, canvas).env), { message: '2 张图片都没能处理：x.png（读不出来，可能不是图片或文件已损坏）；y.png（有 70000×70000 像素，太大了，处理不了）。' });
  assert.deepEqual(names(dir), ['x.png', 'y.png'], 'the empty folder was taken away again');
  // One picture: the reason is the whole message.
  await assert.rejects(action('images.shrink').run(filesCtx([files[0]]), makeEnv(dir, canvas).env), { message: '这张图片读不出来，可能不是图片或文件已损坏' });
  assert.deepEqual(names(dir), ['x.png', 'y.png']);
  // A file that has gone since it was selected.
  const gone = path.join(dir, 'gone.jpg');
  await assert.rejects(action('images.shrink').run(filesCtx([gone]), makeEnv(dir, canvas).env), { message: '读不了这个文件：gone.jpg' });
});

test('shrink: stopping part-way leaves nothing behind', async () => {
  const dir = freshDir();
  const files = put({ 'a.jpg': jpegBytes(9000), 'b.jpg': jpegBytes(9000), 'c.jpg': jpegBytes(9000) }, dir);
  const stop = new AbortController();
  const canvas = fakeCanvas({ 'a.jpg': { w: 10, h: 10, out: 100 }, 'b.jpg': { w: 10, h: 10, out: 100 }, 'c.jpg': { w: 10, h: 10, out: 100 } });
  const encode = canvas.encode;
  canvas.encode = async (file, o) => {
    if (path.basename(file) === 'b.jpg') stop.abort(); // the person presses stop while the second one is drawn
    return encode(file, o);
  };
  await assert.rejects(action('images.shrink').run(filesCtx(files), makeEnv(dir, canvas, stop.signal).env), { message: '已取消' });
  assert.deepEqual(names(dir), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.deepEqual(canvas.of('encode').length, 2, 'the third was never started');
});

test('shrink: doing it twice gives a second file, never writes over the first', async () => {
  const [file] = put({ 'a.jpg': jpegBytes(9000) });
  const dir = path.dirname(file);
  const canvas = fakeCanvas({ 'a.jpg': { w: 10, h: 10, out: 100 } });
  const first = await action('images.shrink').run(filesCtx([file]), makeEnv(dir, canvas).env);
  const second = await action('images.shrink').run(filesCtx([file]), makeEnv(dir, canvas).env);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(names(dir), ['a.jpg', 'a（已压缩） (2).jpg', 'a（已压缩）.jpg']);
});

// ---------------------------------------------------------------- 拼成长图

test('long picture: measured, laid out to one width, drawn in the order given', async () => {
  const dir = freshDir();
  const files = put({ 'c.png': pngBytes(), 'a.jpg': jpegBytes(), 'b.webp': webpBytes() }, dir);
  const before = snapshot(files);
  const canvas = fakeCanvas({ 'c.png': { w: 800, h: 400 }, 'a.jpg': { w: 1200, h: 300 }, 'b.webp': { w: 2000, h: 1000 }, stacked: 123_456 });
  const { env, log } = makeEnv(dir, canvas);
  const r = await action('images.long').run(filesCtx(files), env);
  assert.equal(r.kind, 'file');
  assert.equal(path.basename(r.path), 'c 等 3 个文件 长图.jpg');
  assert.deepEqual(fs.readFileSync(r.path), Buffer.alloc(123_456, 'S'));
  assert.deepEqual(canvas.of('stack'), [{ fn: 'stack', files, o: { width: 1600, heights: [800, 400, 800], type: 'jpeg', quality: 0.9 } }]);
  assert.deepEqual(canvas.of('measure').map((c) => [path.basename(c.file), c.o.opaque]), [['c.png', false], ['a.jpg', true], ['b.webp', false]]);
  assert.equal(r.message, '把 3 张图片按选中的顺序拼成了一张长图：1600×2000 像素，JPEG，121 KB。宽度统一成 1600 像素：1 张缩小，2 张放大。');
  assert.deepEqual(snapshot(files), before);
  assert.deepEqual(log.steps.at(-1), { done: 4, total: 4, name: '' });
});

test('long picture: same widths are not scaled; transparency makes it a PNG', async () => {
  const files = put({ '1.png': pngBytes(), '2.png': pngBytes(), '3.gif': gifBytes(4) });
  const dir = path.dirname(files[0]);
  const plain = fakeCanvas({ '1.png': { w: 1080, h: 2000 }, '2.png': { w: 1080, h: 1500 }, '3.gif': { w: 1080, h: 500 } });
  const a = await action('images.long').run(filesCtx(files.slice(0, 2)), makeEnv(dir, plain).env);
  assert.equal(a.message, '把 2 张图片按选中的顺序拼成了一张长图：1080×3500 像素，JPEG，4.9 KB。每张都是 1080 像素宽，没有缩放。');
  const glass = fakeCanvas({ '1.png': { w: 1080, h: 2000 }, '2.png': { w: 1080, h: 1500, alpha: true }, '3.gif': { w: 540, h: 500 } });
  const b = await action('images.long').run(filesCtx(files), makeEnv(dir, glass).env);
  assert.equal(path.basename(b.path), '1 等 3 个文件 长图.png');
  assert.equal(glass.of('stack')[0].o.type, 'png');
  assert.equal(b.message, '把 3 张图片按选中的顺序拼成了一张长图：1080×4500 像素，PNG，4.9 KB。宽度统一成 1080 像素：1 张放大。有透明的地方，所以存成 PNG。1 张是动图，只用了第一帧。');
});

test('long picture: refused when it would be taller than 30000 pixels', async () => {
  assert.equal(LONG_HEIGHT, 30000);
  const dir = freshDir();
  const files = put({ 'a.png': pngBytes(), 'b.png': pngBytes(), 'c.png': pngBytes() }, dir);
  const tooTall = fakeCanvas({ 'a.png': { w: 1600, h: 10_000 }, 'b.png': { w: 1600, h: 10_000 }, 'c.png': { w: 1600, h: 10_001 } });
  await assert.rejects(action('images.long').run(filesCtx(files), makeEnv(dir, tooTall).env), { message: '拼起来会有 1600×30001 像素，高度超过了 30000 像素的上限。少选几张再拼。' });
  assert.equal(tooTall.of('stack').length, 0, 'nothing was drawn');
  assert.deepEqual(names(dir), ['a.png', 'b.png', 'c.png'], 'nothing was written');
  // Scaling counts: narrow pictures are enlarged to the common width, which makes them taller.
  const enlarged = fakeCanvas({ 'a.png': { w: 1600, h: 100 }, 'b.png': { w: 400, h: 7500 }, 'c.png': { w: 1600, h: 100 } });
  await assert.rejects(action('images.long').run(filesCtx(files), makeEnv(dir, enlarged).env), /1600×30200 像素/);
  // Exactly at the limit is allowed.
  const justFits = fakeCanvas({ 'a.png': { w: 1600, h: 10_000 }, 'b.png': { w: 1600, h: 10_000 }, 'c.png': { w: 3200, h: 20_000 } });
  const r = await action('images.long').run(filesCtx(files), makeEnv(dir, justFits).env);
  assert.match(r.message, /1600×30000 像素/);
});

test('long picture: what cannot be read is left out and named; fewer than two cannot be joined', async () => {
  const dir = freshDir();
  const files = put({ 'a.png': pngBytes(), 'bad.png': Buffer.from('junk'), 'c.png': pngBytes() }, dir);
  const fail = '读不出来，可能不是图片或文件已损坏';
  const canvas = fakeCanvas({ 'a.png': { w: 500, h: 100 }, 'bad.png': { fail }, 'c.png': { w: 500, h: 200 } });
  const r = await action('images.long').run(filesCtx(files), makeEnv(dir, canvas).env);
  assert.equal(path.basename(r.path), 'a 等 2 个文件 长图.jpg');
  assert.deepEqual(canvas.of('stack')[0].files, [files[0], files[2]]);
  assert.match(r.message, /^把 2 张图片按选中的顺序拼成了一张长图：500×300 像素/);
  assert.match(r.message, /没能处理：bad\.png（读不出来，可能不是图片或文件已损坏）。$/);
  const oneLeft = fakeCanvas({ 'a.png': { w: 500, h: 100 }, 'bad.png': { fail }, 'c.png': { fail } });
  await assert.rejects(action('images.long').run(filesCtx(files), makeEnv(dir, oneLeft).env), { message: `只有 1 张图片读得出来，拼不成长图。没能处理：bad.png（${fail}）；c.png（${fail}）。` });
  const noneLeft = fakeCanvas({ 'a.png': { fail }, 'bad.png': { fail }, 'c.png': { fail } });
  await assert.rejects(action('images.long').run(filesCtx(files), makeEnv(dir, noneLeft).env), /^Error: 选中的图片都读不出来，拼不成长图。/);
  assert.equal(oneLeft.of('stack').length + noneLeft.of('stack').length, 0);
});

// ---------------------------------------------------------------- 转成 JPG / 转成 PNG

test('to JPG, one picture: drawn again as a JPEG, transparency said to be white', async () => {
  const [file] = put({ 'logo.png': pngBytes(14_336) });
  const before = snapshot([file]);
  const canvas = fakeCanvas({ 'logo.png': { w: 2400, h: 1200, alpha: true, out: 44_032 } });
  const r = await action('image.jpg').run(filesCtx([file]), makeEnv(path.dirname(file), canvas).env);
  assert.equal(r.kind, 'file');
  assert.equal(path.basename(r.path), 'logo.jpg');
  assert.deepEqual(fs.readFileSync(r.path), Buffer.alloc(44_032, 'J'));
  assert.deepEqual(canvas.calls, [{ fn: 'encode', file, o: { type: 'jpeg', quality: 0.92, opaque: false } }], 'not resized');
  assert.equal(r.message, '已转成 JPG：2400×1200 像素，43 KB（原图 14 KB）。透明的地方填成了白色。原图没有改动。');
  assert.deepEqual(snapshot([file]), before);
});

test('to PNG, one picture', async () => {
  const [file] = put({ '照片.jpeg': jpegBytes(245_760) });
  const canvas = fakeCanvas({ '照片.jpeg': { w: 1200, h: 800, out: 3_565_158 } });
  const r = await action('image.png').run(filesCtx([file]), makeEnv(path.dirname(file), canvas).env);
  assert.equal(path.basename(r.path), '照片.png');
  assert.deepEqual(canvas.calls[0].o, { type: 'png', quality: 0.92, opaque: true });
  assert.equal(r.message, '已转成 PNG：1200×800 像素，3.4 MB（原图 240 KB）。原图没有改动。');
});

test('to JPG, several: a folder with all of them as JPG; those that are JPG already are copied', async () => {
  const dir = freshDir();
  const files = put({ 'a.png': pngBytes(1_000_000), 'b.jpg': jpegBytes(1_048_576), 'c.gif': gifBytes(2), 'd.webp': webpBytes({ size: 2_000_000 }) }, dir);
  const before = snapshot(files);
  const canvas = fakeCanvas({ 'a.png': { w: 10, h: 10, alpha: true, out: 200_000 }, 'c.gif': { w: 1, h: 1, out: 100_000 }, 'd.webp': { w: 10, h: 10, out: 700_000 } });
  const r = await action('image.jpg').run(filesCtx(files), makeEnv(dir, canvas).env);
  assert.equal(r.kind, 'folder');
  assert.equal(path.basename(r.path), 'a 等 4 张图片（JPG）');
  assert.deepEqual(names(r.path), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
  assert.deepEqual(fs.readFileSync(path.join(r.path, 'b.jpg')), jpegBytes(1_048_576), 'already a JPG: copied byte for byte, not encoded again');
  assert.deepEqual(canvas.of('encode').map((c) => path.basename(c.file)), ['a.png', 'c.gif', 'd.webp']);
  const sumBefore = 1_000_000 + 1_048_576 + gifBytes(2).length + 2_000_000;
  assert.equal(r.message, `把 3 张图片转成了 JPG，另外 1 张本来就是 JPG，原样复制。4 张共 ${sizeText(200_000 + 1_048_576 + 100_000 + 700_000)}（原图共 ${sizeText(sumBefore)}）。1 张有透明的地方，填成了白色。1 张是动图，只取了第一帧。原图没有改动。`);
  assert.deepEqual(snapshot(files), before);
});

test('conversion goes by what the file is inside, not by its name', async () => {
  const dir = freshDir();
  const [disguised] = put({ 'shot.png': jpegBytes(300_000) }, dir); // a JPEG that someone named .png
  const canvas = fakeCanvas({});
  assert.equal(action('image.jpg').applies(filesCtx([disguised])), true, 'by its name it is not a JPG');
  const r = await action('image.jpg').run(filesCtx([disguised]), makeEnv(dir, canvas).env);
  assert.equal(path.basename(r.path), 'shot.jpg');
  assert.deepEqual(fs.readFileSync(r.path), jpegBytes(300_000), 'the bytes are right as they are: not encoded a second time');
  assert.equal(canvas.calls.length, 0);
  assert.equal(r.message, '这个文件的内容本来就是 JPG，只是扩展名不同，所以原样另存了一份（293 KB）。');
});

test('conversion: a picture that cannot be read', async () => {
  const dir = freshDir();
  const files = put({ 'bad.gif': Buffer.from('junk'), 'ok.gif': gifBytes(1) }, dir);
  const canvas = fakeCanvas({ 'bad.gif': { fail: '读不出来，可能不是图片或文件已损坏' }, 'ok.gif': { w: 1, h: 1, out: 900 } });
  await assert.rejects(action('image.png').run(filesCtx([files[0]]), makeEnv(dir, canvas).env), { message: '这张图片读不出来，可能不是图片或文件已损坏' });
  const r = await action('image.png').run(filesCtx(files), makeEnv(dir, canvas).env);
  assert.deepEqual(names(r.path), ['ok.png']);
  assert.equal(r.message, `已转成 PNG：1×1 像素，900 字节（原图 ${gifBytes(1).length} 字节）。原图没有改动。没能处理：bad.gif（读不出来，可能不是图片或文件已损坏）。`);
});

// ---------------------------------------------------------------- 识别文字

test('"识别文字" hands the picture to the local model with an exact instruction', async () => {
  const [file] = put({ '扫描件.png': pngBytes() });
  const r = await action('image.ocr').run(filesCtx([file]), makeEnv(path.dirname(file), fakeCanvas()).env);
  assert.equal(r.kind, 'ask');
  assert.deepEqual(r.images, [file]);
  assert.match(r.question, /所有文字/);
  assert.match(r.question, /原样/);
  assert.match(r.question, /换行/);
  assert.match(r.question, /没有文字/);
  assert.deepEqual(names(path.dirname(file)), ['扫描件.png'], 'nothing is written');
});

test('sniff and freeName handle truncated GIF/PNG chunks and dotfile names safely', async () => {
  // A 1-frame GIF followed by a truncated 0x2c image descriptor at EOF is still 1 frame, not animated.
  const oneFramePlusTrunc = Buffer.concat([gifBytes(1).subarray(0, -1), Buffer.from([0x2c, 0x00, 0x00])]);
  assert.deepEqual(sniff(oneFramePlusTrunc), { type: 'gif', animated: false });

  // A PNG whose acTL chunk declares more bytes than remain in the file is not trusted as complete acTL.
  const truncApng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x08, 0x61, 0x63, 0x54, 0x4c, 0x00, 0x00]);
  assert.deepEqual(sniff(truncApng), { type: 'png', animated: false });

  // Dotfiles keep their extension when deduplicated or converted.
  const taken = new Set();
  assert.equal(freeName(taken, '.jpg'), '图片.jpg');
  assert.equal(freeName(taken, '.jpg'), '图片 (2).jpg');

  const dir = freshDir();
  const dot = path.join(dir, '.png');
  fs.writeFileSync(dot, pngBytes());
  const canvas = fakeCanvas({ '.png': { w: 10, h: 10, out: 120 } });
  const converted = await action('image.jpg').run(filesCtx([dot]), makeEnv(dir, canvas).env);
  assert.equal(path.basename(converted.path), '结果.jpg');
});
