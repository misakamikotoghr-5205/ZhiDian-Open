// The picture actions inside the real app, on pictures made here (PNG, JPEG, WebP, GIF, BMP;
// with and without transparency; one that moves; one that is stored lying on its side): make
// them smaller, join them into a long picture, save them as JPG or PNG, hand one to the model
// to read. Every result is checked by opening it again: its format from its bytes, its size in
// pixels from its header, and the very pixels as ImageMagick decodes them.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e/office-image.mjs
//
// Needs ImageMagick (`convert`) to make the fixtures and to read the results back.
// KEEP=1 leaves the fixtures and results in the temporary folder (its path is printed).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { savedText, sizeText, sniff } from '../../src/main/office/tools-image.js';
import { launchOffice } from './office-harness.mjs';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const magick = (args, input) => execFileSync('convert', args, { input, maxBuffer: 2 ** 31 - 1, stdio: ['pipe', 'pipe', 'pipe'] });

// ---- making pictures

/** A source of numbers 0..255 that gives the same ones every time. */
function dice(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24;
}

/**
 * A picture file from pixels worked out here. `at(x, y)` gives 0xRRGGBB, or 0xRRGGBBAA when
 * `alpha` is set. The format is the one the file name asks for.
 */
function draw(file, w, h, at, { alpha = false, args = [] } = {}) {
  const n = alpha ? 4 : 3;
  const raw = Buffer.alloc(w * h * n);
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = at(x, y);
      if (alpha) raw[o++] = c >>> 24;
      raw[o++] = (c >>> 16) & 255;
      raw[o++] = (c >>> 8) & 255;
      raw[o++] = c & 255;
    }
  }
  magick(['-size', `${w}x${h}`, '-depth', '8', `${alpha ? 'rgba' : 'rgb'}:-`, ...args, file], raw);
  return file;
}
const solid = (file, w, h, colour) => (magick(['-size', `${w}x${h}`, `xc:${colour}`, file]), file);

/** Colours that change smoothly across a picture of this size, with a little grain on top. */
function scene(w, h, grain = 0, seed = 1) {
  const roll = dice(seed);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  return (x, y) => {
    const g = grain ? ((roll() * grain) >> 7) - grain : 0; // -grain .. +grain
    return (clamp(Math.round((x * 255) / (w - 1)) + g) << 16) | (clamp(Math.round((y * 255) / (h - 1)) + g) << 8) | clamp(128 + g);
  };
}
/** What scene() has at a place, without the grain: [r, g, b]. */
const sceneAt = (w, h, x, y) => [Math.round((x * 255) / (w - 1)), Math.round((y * 255) / (h - 1)), 128];

/** The same JPEG with a note in it that says which way up it is to be shown (EXIF orientation). */
function withOrientation(jpeg, orientation) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body, jpeg.subarray(2)]);
}

// ---- reading results back

/** Width and height from the header of a PNG or a JPEG; throws if the file is not a whole one. */
function sizeOf(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) {
    assert.equal(b.toString('latin1', 12, 16), 'IHDR');
    assert.equal(b.toString('latin1', b.length - 8, b.length - 4), 'IEND', 'the PNG is whole');
    // Colour types 4 and 6 carry transparency for every pixel.
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alphaChannel: b[25] === 4 || b[25] === 6 };
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), alphaChannel: Boolean(b[20] & 0x10) };
    }
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff), alphaChannel: Boolean((bits >>> 28) & 1) };
    }
    if (chunk === 'VP8 ') {
      return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, alphaChannel: false };
    }
  }
  assert.ok(b[0] === 0xff && b[1] === 0xd8, `${path.basename(file)} starts like a JPEG`);
  assert.ok(b.at(-2) === 0xff && b.at(-1) === 0xd9, 'the JPEG is whole');
  for (let o = 2; o + 9 < b.length; ) {
    assert.equal(b[o], 0xff, 'a JPEG segment');
    const marker = b[o + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5), alphaChannel: false };
    o += 2 + b.readUInt16BE(o + 2);
  }
  throw new Error('no frame header in this JPEG');
}
const typeOf = (file) => sniff(fs.readFileSync(file)).type;
const isA = (file, type, w, h, what = path.basename(file)) => {
  assert.equal(typeOf(file), type, `${what}: its bytes are those of a ${type}`);
  const size = sizeOf(file);
  assert.deepEqual([size.w, size.h], [w, h], `${what}: ${size.w}×${size.h}, expected ${w}×${h}`);
  return size;
};

/**
 * The pixels of a picture (its first frame), or of a part of it, as ImageMagick decodes them.
 * @returns {(x: number, y: number) => [number, number, number, number]}  r, g, b, a at a place in the part
 */
function pixels(file, part) {
  const w = part?.w ?? Number(execFileSync('identify', ['-format', '%w\n', `${file}[0]`]).toString().trim().split('\n')[0]);
  const raw = magick([`${file}[0]`, ...(part ? ['-crop', `${part.w}x${part.h}+${part.x}+${part.y}`, '+repage'] : []), '-depth', '8', 'rgba:-']);
  return (x, y) => [...raw.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
}
function near(got, want, tolerance, what) {
  const off = Math.max(...want.map((v, i) => Math.abs(v - got[i])));
  assert.ok(off <= tolerance, `${what}: got ${got.join(',')}, expected about ${want.join(',')}`);
}
const RED = [255, 0, 0], GREEN = [0, 160, 0], BLUE = [0, 0, 255], WHITE = [255, 255, 255];

// ---------------------------------------------------------------- the run

const h = await launchOffice();
const fx = (name) => path.join(h.work, name);
const made = (r) => path.basename(r.result.path);
let failed = null;
try {
  console.log('▸ fixtures: pictures of every kind, made here');
  draw(fx('photo.jpg'), 3000, 2000, scene(3000, 2000, 6), { args: ['-quality', '93'] });
  draw(fx('tiny.jpg'), 400, 300, scene(400, 300, 20, 2), { args: ['-quality', '12'] });
  // Transparent on the left quarter, grainy (so it is a large file) and opaque elsewhere.
  draw(fx('glass.png'), 2400, 1200, ((roll) => (x) => (x < 600 ? 0 : ((roll() << 24) | (roll() << 16) | (roll() << 8) | 255) >>> 0))(dice(3)), { alpha: true });
  draw(fx('flat.png'), 1000, 700, scene(1000, 700, 30, 4));
  // Stored lying on its side: left half red, right half blue, to be shown turned a quarter clockwise.
  draw(fx('turned-raw.jpg'), 2400, 1600, (x) => (x < 1200 ? 0xff0000 : 0x0000ff), { args: ['-quality', '90'] });
  fs.writeFileSync(fx('turned.jpg'), withOrientation(fs.readFileSync(fx('turned-raw.jpg')), 6));
  fs.rmSync(fx('turned-raw.jpg'));
  magick(['-delay', '20', '-size', '300x200', 'xc:red', 'xc:lime', 'xc:blue', '-loop', '0', fx('anim.gif')]);
  draw(fx('pic.webp'), 640, 480, scene(640, 480, 4, 5), { args: ['-define', 'webp:lossless=true'] });
  // A sticker: an opaque green disc on nothing.
  draw(fx('sticker.webp'), 400, 400, (x, y) => ((x - 200) ** 2 + (y - 200) ** 2 < 150 ** 2 ? 0x00a000ff : 0), { alpha: true, args: ['-define', 'webp:lossless=true'] });
  draw(fx('bitmap.bmp'), 500, 400, scene(500, 400));
  // All grain: as a PNG it is tens of megabytes.
  draw(fx('big.jpg'), 4000, 2500, ((roll) => () => (roll() << 16) | (roll() << 8) | roll())(dice(6)), { args: ['-quality', '90'] });
  solid(fx('red.png'), 800, 400, 'rgb(255,0,0)');
  solid(fx('green.jpg'), 1200, 300, 'rgb(0,160,0)');
  solid(fx('blue.webp'), 2000, 1000, 'rgb(0,0,255)');
  ['rgb(255,0,0)', 'rgb(0,160,0)', 'rgb(0,0,255)'].forEach((colour, i) => solid(fx(`tall${i + 1}.png`), 1600, 10000, colour));
  solid(fx('tall4.png'), 1600, 1, 'rgb(255,0,0)'); // the one pixel too many
  fs.writeFileSync(fx('broken.png'), 'this is not a picture');
  fs.copyFileSync(fx('photo.jpg'), fx('disguised.png')); // a JPEG that someone named .png
  fs.copyFileSync(fx('glass.png'), fx('mislabeled.jpg')); // and a PNG named .jpg
  const originals = fs.readdirSync(h.work).sort();
  const before = Object.fromEntries(originals.map((n) => [n, sha(fx(n))]));
  const bytes = (file) => fs.statSync(file).size;
  assert.deepEqual([typeOf(fx('photo.jpg')), typeOf(fx('glass.png')), typeOf(fx('pic.webp')), typeOf(fx('anim.gif')), typeOf(fx('bitmap.bmp'))], ['jpeg', 'png', 'webp', 'gif', 'bmp']);
  assert.deepEqual(sniff(fs.readFileSync(fx('anim.gif'))), { type: 'gif', animated: true });
  assert.equal(execFileSync('identify', ['-format', '%[EXIF:Orientation]', fx('turned.jpg')]).toString().trim(), '6');
  console.log(`  ${originals.length} files, ${sizeText(originals.reduce((sum, n) => sum + bytes(fx(n)), 0))}`);

  console.log('▸ what is offered: the four that show for one picture and for several; conversions only where they change something');
  assert.deepEqual((await h.offers({ files: [fx('glass.png')] })).slice(0, 4), ['files.pdf', 'images.shrink', 'image.ocr', 'files.pptx']);
  assert.deepEqual((await h.offers({ files: [fx('photo.jpg'), fx('glass.png'), fx('pic.webp')] })).slice(0, 4), ['files.pdf', 'images.long', 'images.shrink', 'files.pptx']);
  const offered = async (...list) => (await h.offers({ files: list.map(fx) })).filter((id) => /^images?\./.test(id));
  assert.deepEqual(await offered('photo.jpg'), ['images.shrink', 'image.ocr', 'image.webp', 'image.png']);
  assert.deepEqual(await offered('glass.png'), ['images.shrink', 'image.ocr', 'image.jpg', 'image.webp']);
  assert.deepEqual(await offered('pic.webp'), ['images.shrink', 'image.ocr', 'image.jpg', 'image.png']);
  assert.deepEqual(await offered('photo.jpg', 'tiny.jpg'), ['images.long', 'images.shrink', 'image.webp', 'image.png']);
  assert.deepEqual(await offered('photo.jpg', 'glass.png'), ['images.long', 'images.shrink', 'image.jpg', 'image.webp', 'image.png']);
  fs.writeFileSync(fx('notes.txt'), 'not a picture\n');
  assert.deepEqual(await offered('photo.jpg', 'notes.txt'), [], 'a picture and a text file: no picture actions');
  fs.rmSync(fx('notes.txt'));

  console.log('▸ 压缩图片, one photo: longest edge 1920, a JPEG, smaller, the same picture');
  const photo = await h.ok('images.shrink', { files: [fx('photo.jpg')] });
  assert.equal(photo.result.kind, 'file');
  assert.equal(made(photo), 'photo（已压缩）.jpg');
  assert.equal(path.dirname(photo.result.path), h.work, 'written next to the original');
  isA(photo.result.path, 'jpeg', 1920, 1280);
  assert.ok(bytes(photo.result.path) < bytes(fx('photo.jpg')));
  assert.equal(photo.result.message, `压缩了 1 张图片：${sizeText(bytes(fx('photo.jpg')))} → ${sizeText(bytes(photo.result.path))}，${savedText(bytes(fx('photo.jpg')), bytes(photo.result.path))}。尺寸 3000×2000 → 1920×1280 像素，存成 JPEG。原图没有改动。`);
  const small = pixels(photo.result.path);
  for (const [x, y] of [[100, 100], [960, 640], [1800, 200], [300, 1200], [1900, 1270]]) near(small(x, y), sceneAt(1920, 1280, x, y), 12, `the photo at ${x},${y}`);
  console.log(`  ${photo.result.message}`);

  console.log('▸ 压缩图片: a picture that would come out larger is copied as it is');
  const tiny = await h.ok('images.shrink', { files: [fx('tiny.jpg')] });
  assert.equal(made(tiny), 'tiny（已压缩）.jpg');
  assert.equal(sha(tiny.result.path), before['tiny.jpg'], 'the very bytes of the original');
  assert.equal(tiny.result.message, `这张图片已经很小（${sizeText(bytes(fx('tiny.jpg')))}），再压缩反而会变大，所以原样存了一份副本。`);
  console.log(`  ${tiny.result.message}`);

  console.log('▸ 压缩图片: a PNG with transparency stays a PNG and stays transparent; one without becomes a JPEG');
  const glass = await h.ok('images.shrink', { files: [fx('glass.png')] });
  assert.equal(made(glass), 'glass（已压缩）.png');
  assert.equal(isA(glass.result.path, 'png', 1920, 960).alphaChannel, true);
  assert.ok(bytes(glass.result.path) < bytes(fx('glass.png')));
  const glassPx = pixels(glass.result.path);
  assert.equal(glassPx(100, 480)[3], 0, 'transparent where the original is');
  assert.equal(glassPx(470, 900)[3], 0);
  assert.equal(glassPx(1000, 480)[3], 255, 'opaque where the original is');
  assert.match(glass.result.message, /尺寸 2400×1200 → 1920×960 像素，有透明的地方，所以存成 PNG。/);
  const mislabeled = await h.ok('images.shrink', { files: [fx('mislabeled.jpg')] });
  assert.equal(made(mislabeled), 'mislabeled（已压缩）.png', 'a PNG named .jpg is treated as the PNG it is');
  assert.equal(isA(mislabeled.result.path, 'png', 1920, 960).alphaChannel, true);
  assert.equal(pixels(mislabeled.result.path)(100, 480)[3], 0);
  const flat = await h.ok('images.shrink', { files: [fx('flat.png')] });
  assert.equal(made(flat), 'flat（已压缩）.jpg');
  isA(flat.result.path, 'jpeg', 1000, 700);
  assert.match(flat.result.message, /尺寸没变（1000×700 像素），存成 JPEG。/);
  console.log(`  ${glass.result.message}\n  ${flat.result.message}`);

  console.log('▸ 压缩图片: a photo stored lying on its side comes out the right way up');
  const turned = await h.ok('images.shrink', { files: [fx('turned.jpg')] });
  isA(turned.result.path, 'jpeg', 1280, 1920);
  const turnedPx = pixels(turned.result.path);
  near(turnedPx(640, 300), RED, 12, 'the top half');
  near(turnedPx(640, 1600), BLUE, 12, 'the bottom half');
  assert.match(turned.result.message, /尺寸 1600×2400 → 1280×1920 像素/);

  console.log('▸ 压缩图片, several: a folder; the small one and the moving one are copies; the sums in the message are those of the files');
  const group = ['photo.jpg', 'tiny.jpg', 'glass.png', 'anim.gif', 'flat.png', 'pic.webp', 'bitmap.bmp'];
  const many = await h.ok('images.shrink', { files: group.map(fx) });
  assert.equal(many.result.kind, 'folder');
  assert.equal(made(many), 'photo 等 7 张图片（已压缩）');
  assert.equal(path.dirname(many.result.path), h.work);
  const inFolder = (name) => path.join(many.result.path, name);
  assert.deepEqual(fs.readdirSync(many.result.path).sort(), ['anim.gif', 'bitmap.jpg', 'flat.jpg', 'glass.png', 'photo.jpg', 'pic.jpg', 'tiny.jpg']);
  isA(inFolder('photo.jpg'), 'jpeg', 1920, 1280);
  isA(inFolder('glass.png'), 'png', 1920, 960);
  isA(inFolder('flat.jpg'), 'jpeg', 1000, 700);
  isA(inFolder('pic.jpg'), 'jpeg', 640, 480);
  isA(inFolder('bitmap.jpg'), 'jpeg', 500, 400);
  assert.equal(sha(inFolder('tiny.jpg')), before['tiny.jpg']);
  assert.equal(sha(inFolder('anim.gif')), before['anim.gif'], 'the moving picture still moves: it is a copy');
  const sumBefore = group.reduce((sum, n) => sum + bytes(fx(n)), 0);
  const sumAfter = fs.readdirSync(many.result.path).reduce((sum, n) => sum + bytes(inFolder(n)), 0);
  assert.equal(
    many.result.message,
    `压缩了 5 张图片，另外 2 张原样复制（1 张已经很小，再压缩反而会变大；1 张是动图，压缩会丢掉动画）。7 张共 ${sizeText(sumBefore)} → ${sizeText(sumAfter)}，${savedText(sumBefore, sumAfter)}。压缩的 5 张：2 张长边缩到了 1920 像素；1 张有透明的地方，存成 PNG，其余存成 JPEG。原图没有改动。`,
  );
  console.log(`  ${many.result.message}`);

  console.log('▸ nothing is overwritten: doing it again gives a second file and a second folder');
  const again = await h.ok('images.shrink', { files: [fx('photo.jpg')] });
  assert.equal(made(again), 'photo（已压缩） (2).jpg');
  const manyAgain = await h.ok('images.shrink', { files: group.map(fx) });
  assert.equal(made(manyAgain), 'photo 等 7 张图片（已压缩） (2)');

  console.log('▸ 拼成长图: three pictures of three widths, one under another in the order given, 1600 wide, no gap');
  const long = await h.ok('images.long', { files: [fx('red.png'), fx('green.jpg'), fx('blue.webp')] });
  assert.equal(long.result.kind, 'file');
  assert.equal(made(long), 'red 等 3 个文件 长图.jpg');
  isA(long.result.path, 'jpeg', 1600, 2000); // 800×400 -> 1600×800, 1200×300 -> 1600×400, 2000×1000 -> 1600×800
  for (const x of [0, 800, 1599]) {
    const column = pixels(long.result.path, { x, y: 0, w: 1, h: 2000 });
    for (let y = 0; y < 2000; y++) {
      // Within a few pixels of a seam the JPEG blends the two colours; a gap would be white.
      const seam = Math.min(Math.abs(y - 800), Math.abs(y - 1200)) < 8;
      if (!seam) near(column(0, y), y < 800 ? RED : y < 1200 ? GREEN : BLUE, 10, `column ${x}, row ${y}`);
      else assert.ok(Math.min(...column(0, y).slice(0, 3)) < 120, `no white at the seam (column ${x}, row ${y}: ${column(0, y)})`);
    }
  }
  assert.equal(long.result.message, `把 3 张图片按选中的顺序拼成了一张长图：1600×2000 像素，JPEG，${sizeText(bytes(long.result.path))}。宽度统一成 1600 像素：1 张缩小，2 张放大。`);
  const reversed = await h.ok('images.long', { files: [fx('blue.webp'), fx('red.png')] });
  isA(reversed.result.path, 'jpeg', 1600, 1600);
  const reversedPx = pixels(reversed.result.path, { x: 800, y: 0, w: 1, h: 1600 });
  near(reversedPx(0, 400), BLUE, 10, 'the first one given is on top');
  near(reversedPx(0, 1200), RED, 10, 'the second one below it');
  console.log(`  ${long.result.message}`);

  console.log('▸ 拼成长图: with a transparent picture the result is a PNG and stays transparent; of a moving picture, the first frame');
  const sticker = await h.ok('images.long', { files: [fx('sticker.webp'), fx('anim.gif')] });
  assert.equal(made(sticker), 'sticker 等 2 个文件 长图.png');
  assert.equal(isA(sticker.result.path, 'png', 400, 400 + 267).alphaChannel, true); // 300×200 -> 400×267
  const stickerPx = pixels(sticker.result.path);
  assert.equal(stickerPx(5, 5)[3], 0, 'transparent around the disc');
  near(stickerPx(200, 200), [0, 160, 0, 255], 4, 'the disc');
  near(stickerPx(200, 500), [...RED, 255], 4, 'the first frame of the moving picture');
  assert.match(sticker.result.message, /400×667 像素，PNG，/);
  assert.match(sticker.result.message, /宽度统一成 400 像素：1 张放大。有透明的地方，所以存成 PNG。1 张是动图，只用了第一帧。$/);
  console.log(`  ${sticker.result.message}`);

  console.log('▸ 拼成长图: 30000 pixels tall is the limit');
  const listing = fs.readdirSync(h.work).sort();
  const tooTall = await h.run('images.long', { files: [1, 2, 3, 4].map((n) => fx(`tall${n}.png`)) });
  assert.equal(tooTall.error, '拼起来会有 1600×30001 像素，高度超过了 30000 像素的上限。少选几张再拼。');
  assert.deepEqual(fs.readdirSync(h.work).sort(), listing, 'nothing was written');
  const tallest = await h.ok('images.long', { files: [1, 2, 3].map((n) => fx(`tall${n}.png`)) });
  isA(tallest.result.path, 'jpeg', 1600, 30000);
  assert.match(tallest.result.message, /1600×30000 像素，JPEG，.*每张都是 1600 像素宽，没有缩放。$/);
  try {
    const column = pixels(tallest.result.path, { x: 800, y: 0, w: 1, h: 30000 });
    near(column(0, 5000), RED, 10, 'the first third');
    near(column(0, 15000), GREEN, 10, 'the second third');
    near(column(0, 29990), BLUE, 10, 'the last third');
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    console.log('  (its pixels were not looked at: ImageMagick here refuses a picture this tall)');
  }
  console.log(`  ${tooTall.error}\n  ${tallest.result.message}`);

  console.log('▸ 转成 JPG: transparent becomes white; a WebP; a file that is a JPEG inside is only copied');
  const glassJpg = await h.ok('image.jpg', { files: [fx('glass.png')] });
  assert.equal(made(glassJpg), 'glass.jpg');
  isA(glassJpg.result.path, 'jpeg', 2400, 1200);
  const glassJpgPx = pixels(glassJpg.result.path);
  near(glassJpgPx(100, 600), WHITE, 3, 'what was transparent');
  near(glassJpgPx(590, 1100), WHITE, 12, 'what was transparent, close to the edge');
  assert.equal(glassJpg.result.message, `已转成 JPG：2400×1200 像素，${sizeText(bytes(glassJpg.result.path))}（原图 ${sizeText(bytes(fx('glass.png')))}）。透明的地方填成了白色。原图没有改动。`);
  const webpJpg = await h.ok('image.jpg', { files: [fx('pic.webp')] });
  isA(webpJpg.result.path, 'jpeg', 640, 480);
  near(pixels(webpJpg.result.path)(320, 240), sceneAt(640, 480, 320, 240), 12, 'the WebP as a JPEG');
  assert.doesNotMatch(webpJpg.result.message, /透明|动图/);
  const disguised = await h.ok('image.jpg', { files: [fx('disguised.png')] });
  assert.equal(made(disguised), 'disguised.jpg');
  assert.equal(sha(disguised.result.path), before['photo.jpg'], 'not encoded a second time');
  assert.match(disguised.result.message, /本来就是 JPG/);
  console.log(`  ${glassJpg.result.message}\n  ${disguised.result.message}`);

  console.log('▸ 转成 PNG: pixel for pixel; a large one arrives whole; transparency is kept; of a moving picture, the first frame');
  const photoPng = await h.ok('image.png', { files: [fx('photo.jpg')] });
  assert.equal(made(photoPng), 'photo.png');
  assert.equal(isA(photoPng.result.path, 'png', 3000, 2000).alphaChannel, false, 'no transparency in, none out');
  const [photoIn, photoOut] = [pixels(fx('photo.jpg')), pixels(photoPng.result.path)];
  for (const [x, y] of [[0, 0], [1500, 1000], [2999, 1999], [17, 1234], [2500, 40]]) near(photoOut(x, y), photoIn(x, y), 3, `the photo at ${x},${y}`);
  const big = await h.ok('image.png', { files: [fx('big.jpg')] });
  isA(big.result.path, 'png', 4000, 2500);
  assert.ok(bytes(big.result.path) > 20 * 1024 * 1024, `large enough to have crossed in several pieces: ${sizeText(bytes(big.result.path))}`);
  const [bigIn, bigOut] = [pixels(fx('big.jpg')), pixels(big.result.path)]; // decoding it all also shows that no byte is missing
  for (const [x, y] of [[0, 0], [1234, 567], [3999, 2499], [2000, 2400], [3990, 5]]) near(bigOut(x, y), bigIn(x, y), 3, `the large picture at ${x},${y}`);
  const stickerPng = await h.ok('image.png', { files: [fx('sticker.webp')] });
  assert.equal(isA(stickerPng.result.path, 'png', 400, 400).alphaChannel, true);
  assert.equal(pixels(stickerPng.result.path)(5, 5)[3], 0);
  near(pixels(stickerPng.result.path)(200, 200), [0, 160, 0, 255], 2, 'the disc');
  const gifPng = await h.ok('image.png', { files: [fx('anim.gif')] });
  isA(gifPng.result.path, 'png', 300, 200);
  near(pixels(gifPng.result.path)(150, 100), [...RED, 255], 2, 'the first frame');
  assert.match(gifPng.result.message, /原图是动图，只取了第一帧。/);
  const bmpPng = await h.ok('image.png', { files: [fx('bitmap.bmp')] });
  isA(bmpPng.result.path, 'png', 500, 400);
  near(pixels(bmpPng.result.path)(250, 200), sceneAt(500, 400, 250, 200), 1, 'the BMP as a PNG');
  console.log(`  ${photoPng.result.message}\n  ${big.result.message}\n  ${gifPng.result.message}`);

  console.log('▸ 转成 JPG, several: a folder with every one as a JPG; the one that is a JPG already is a copy');
  const toJpg = await h.ok('image.jpg', { files: [fx('flat.png'), fx('photo.jpg'), fx('sticker.webp'), fx('anim.gif')] });
  assert.equal(toJpg.result.kind, 'folder');
  assert.equal(made(toJpg), 'flat 等 4 张图片（JPG）');
  assert.deepEqual(fs.readdirSync(toJpg.result.path).sort(), ['anim.jpg', 'flat.jpg', 'photo.jpg', 'sticker.jpg']);
  isA(path.join(toJpg.result.path, 'flat.jpg'), 'jpeg', 1000, 700);
  isA(path.join(toJpg.result.path, 'sticker.jpg'), 'jpeg', 400, 400);
  isA(path.join(toJpg.result.path, 'anim.jpg'), 'jpeg', 300, 200);
  assert.equal(sha(path.join(toJpg.result.path, 'photo.jpg')), before['photo.jpg']);
  near(pixels(path.join(toJpg.result.path, 'sticker.jpg'))(5, 5), WHITE, 3, 'around the disc');
  assert.match(toJpg.result.message, /^把 3 张图片转成了 JPG，另外 1 张本来就是 JPG，原样复制。4 张共 .+（原图共 .+）。1 张有透明的地方，填成了白色。1 张是动图，只取了第一帧。原图没有改动。$/);
  console.log(`  ${toJpg.result.message}`);

  console.log('▸ 转成 WebP: preserves transparency and dimensions');
  const glassWebp = await h.ok('image.webp', { files: [fx('glass.png')] });
  assert.equal(made(glassWebp), 'glass.webp');
  assert.equal(isA(glassWebp.result.path, 'webp', 2400, 1200).alphaChannel, true);
  assert.equal(pixels(glassWebp.result.path)(100, 600)[3], 0, 'transparent where the PNG was');
  console.log(`  ${glassWebp.result.message}`);

  console.log('▸ a file that is not a picture inside: said so; among others it is left out and named');
  const broken = await h.run('images.shrink', { files: [fx('broken.png')] });
  assert.equal(broken.error, '这张图片读不出来，可能不是图片或文件已损坏');
  assert.equal((await h.run('image.jpg', { files: [fx('broken.png')] })).error, '这张图片读不出来，可能不是图片或文件已损坏');
  const withBroken = await h.ok('images.shrink', { files: [fx('flat.png'), fx('broken.png'), fx('pic.webp')] });
  assert.deepEqual(fs.readdirSync(withBroken.result.path).sort(), ['flat.jpg', 'pic.jpg']);
  assert.match(withBroken.result.message, /^压缩了 2 张图片：.*没能处理：broken\.png（读不出来，可能不是图片或文件已损坏）。$/);
  const longBroken = await h.ok('images.long', { files: [fx('red.png'), fx('broken.png'), fx('green.jpg')] });
  isA(longBroken.result.path, 'jpeg', 1200, 600 + 300);
  assert.match(longBroken.result.message, /^把 2 张图片.*没能处理：broken\.png（读不出来，可能不是图片或文件已损坏）。$/);
  const onlyBroken = await h.run('images.long', { files: [fx('red.png'), fx('broken.png')] });
  assert.match(onlyBroken.error, /^只有 1 张图片读得出来，拼不成长图。/);
  console.log(`  ${broken.error}\n  ${withBroken.result.message}`);

  console.log('▸ 识别文字: the picture goes to the local model with the instruction to copy out its text');
  const ocr = await h.ok('image.ocr', { files: [fx('flat.png')] });
  assert.equal(ocr.result.kind, 'ask');
  assert.deepEqual(ocr.result.images, [fx('flat.png')]);
  assert.match(ocr.result.question, /所有文字原样抄写出来/);
  assert.match(ocr.result.question, /换行/);
  assert.match(ocr.result.question, /没有文字/);
  assert.equal((await h.run('image.ocr', { files: [fx('flat.png'), fx('red.png')] })).error.includes('not offered'), true, 'not for two pictures');

  console.log('▸ after all of it, every original is byte for byte what it was');
  for (const n of originals) assert.equal(sha(fx(n)), before[n], n);

  console.log(`\n✔ office-image checks passed${process.env.KEEP ? `. Results in ${h.work}` : ''}`);
} catch (err) {
  failed = err;
  console.error('\n✘ ' + (err.stack ?? err));
} finally {
  await h.close();
  if (!process.env.KEEP) fs.rmSync(h.work, { recursive: true, force: true });
  else console.log(`Kept: ${h.work}`);
}
process.exit(failed ? 1 : 0);
