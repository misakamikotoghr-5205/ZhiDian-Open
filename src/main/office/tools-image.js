// Office actions, set "image": what can be done with pictures. Make them smaller, join them
// into one tall picture, save them as JPG or PNG, and have the local model read the text in
// one. The shape of an action is described at the top of tools-basic.js.
//
// The pixels are worked on in the hidden page (env.tools.canvas, see render.js); what is here
// decides what to make, writes it, and says what was made. The helpers that only compute are
// exported for the unit tests.
import fs from 'node:fs';
import path from 'node:path';
import { resultName } from '../../core/office-kinds.js';

export const SHRINK_EDGE = 1920; // pixels: the longer edge of a compressed picture is at most this
export const SHRINK_QUALITY = 0.82; // JPEG quality of a compressed picture
export const LONG_WIDTH = 1600; // pixels: a long picture is at most this wide ...
export const LONG_HEIGHT = 30000; // ... and at most this tall
const LONG_QUALITY = 0.9;
const CONVERT_QUALITY = 0.92;

const pictures = (ctx) => ctx.kind === 'files' && ctx.files.length > 0 && ctx.files.every((f) => f.kind === 'image');
const stemOf = (file) => file.name.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || '图片';
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const whyOf = (err) => String(err?.why ?? err?.message ?? err);
const skippedNote = (skipped) => (skipped.length ? `没能处理：${skipped.map((s) => `${s.name}（${s.why}）`).join('；')}。` : '');

function checkStop(env) {
  if (env.signal?.aborted) throw new Error('已取消');
}

/** 812 字节, 3.4 KB, 120 KB, 2.5 MB */
export function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} 字节`;
  const kb = bytes / 1024;
  if (kb < 9.95) return `${kb.toFixed(1)} KB`;
  if (kb < 999.5) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 99.95 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "小了 79%": never 0% or 100% for something that did get smaller. */
export function savedText(before, after) {
  const percent = before > 0 ? ((before - after) / before) * 100 : 0;
  return percent < 1 ? '小了不到 1%' : `小了 ${Math.min(99, Math.round(percent))}%`;
}

/** How many pictures a GIF holds, counted up to `atMost`. */
function gifFrames(b, atMost) {
  let o = 13; // the header and the screen descriptor
  if (b[10] & 0x80) o += 3 * (2 << (b[10] & 7)); // the global colour table
  const skipBlocks = () => {
    while (o < b.length && b[o] !== 0) o += 1 + b[o];
    o += 1;
  };
  let frames = 0;
  while (o < b.length && frames < atMost) {
    if (b[o] === 0x2c) {
      // A picture: its descriptor, perhaps its own colour table, the code size, the data.
      if (o + 10 >= b.length) break;
      const packed = b[o + 9];
      o += 10;
      if (packed & 0x80) o += 3 * (2 << (packed & 7));
      if (o >= b.length) break;
      frames++;
      o += 1;
      skipBlocks();
    } else if (b[o] === 0x21) {
      if (o + 2 > b.length) break;
      o += 2; // an extension: its label, then its data
      skipBlocks();
    } else {
      break; // the end, or not a GIF any further
    }
  }
  return frames;
}

/**
 * What a picture file really is, going by its bytes (its name may say otherwise), and whether
 * it moves: of an animated GIF, WebP or PNG only the first frame can be drawn.
 * @param {Uint8Array} bytes
 * @returns {{ type: 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | '', animated: boolean }}
 */
export function sniff(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (from, to) => b.toString('latin1', from, to);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'jpeg', animated: false };
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    // An animated PNG says so in a chunk that comes before the picture data.
    for (let o = 8; o + 12 <= b.length; ) {
      const len = b.readUInt32BE(o);
      if (o + 12 + len > b.length) break;
      const chunk = tag(o + 4, o + 8);
      if (chunk === 'acTL') return { type: 'png', animated: true };
      if (chunk === 'IDAT' || chunk === 'IEND') break;
      o += 12 + len;
    }
    return { type: 'png', animated: false };
  }
  if (b.length >= 13 && (tag(0, 6) === 'GIF89a' || tag(0, 6) === 'GIF87a')) return { type: 'gif', animated: gifFrames(b, 2) > 1 };
  if (b.length >= 16 && tag(0, 4) === 'RIFF' && tag(8, 12) === 'WEBP') return { type: 'webp', animated: tag(12, 16) === 'VP8X' && b.length > 20 && (b[20] & 0x02) !== 0 };
  if (b.length >= 2 && tag(0, 2) === 'BM') return { type: 'bmp', animated: false };
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return { type: 'ico', animated: false };
  if (b.length >= 12 && tag(4, 8) === 'ftyp') {
    const brand = tag(8, 12);
    if (brand === 'avif' || brand === 'avis') return { type: 'avif', animated: brand === 'avis' };
  }
  if (b.length >= 5) {
    const head = b.subarray(0, Math.min(b.length, 512)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<\?xml[\s\S]*?)?<svg[\s>]/i.test(head)) return { type: 'svg', animated: false };
  }
  return { type: '', animated: false };
}

/**
 * How pictures sit one under another in a long picture: all as wide as the widest of them
 * (but no wider than `maxWidth`), each as tall as keeps its shape.
 * @param {Array<{ w: number, h: number }>} sizes
 * @returns {{ width: number, heights: number[], height: number, reduced: number, enlarged: number }}
 *   reduced / enlarged: how many of the pictures are drawn smaller / larger than they are
 */
export function stackLayout(sizes, maxWidth = LONG_WIDTH) {
  const width = Math.min(maxWidth, Math.max(...sizes.map((s) => s.w)));
  const heights = sizes.map((s) => Math.max(1, Math.round((s.h * width) / s.w)));
  return {
    width,
    heights,
    height: sum(heights, (h) => h),
    reduced: sizes.filter((s) => s.w > width).length,
    enlarged: sizes.filter((s) => s.w < width).length,
  };
}

/** `name`, or "name (2)", "name (3)" ... if it is in `taken` already (whatever the case of the letters). */
export function freeName(taken, name) {
  const str = String(name ?? '');
  const ext = path.extname(str) || (/^\.[A-Za-z0-9]{1,8}$/.test(str) ? str : '');
  const stem = ext === str ? '图片' : str.slice(0, str.length - ext.length);
  const first = ext === str ? `${stem}${ext}` : str;
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? first : `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/**
 * What "压缩图片" did, in words.
 * @param {Array<{ before: number, after: number, how: 'jpeg' | 'png' | 'small' | 'animated',
 *   resized?: boolean, w?: number, h?: number, srcW?: number, srcH?: number }>} items
 *   one entry per picture written. 'jpeg' and 'png' were encoded again; 'small' (encoding it
 *   again would have made it larger) and 'animated' were copied as they are
 */
export function describeShrink(items) {
  const n = items.length;
  const before = sum(items, (it) => it.before), after = sum(items, (it) => it.after);
  const count = (how) => items.filter((it) => it.how === how).length;
  const small = count('small'), moving = count('animated'), png = count('png');
  const pressed = n - small - moving;
  if (!pressed) {
    if (n === 1) return small ? `这张图片已经很小（${sizeText(before)}），再压缩反而会变大，所以原样存了一份副本。` : `这是一张动图（${sizeText(before)}），压缩会丢掉动画，所以没有压缩，原样存了一份副本。`;
    const why = [small ? `${small} 张已经很小，再压缩反而会变大` : '', moving ? `${moving} 张是动图，压缩会丢掉动画` : ''].filter(Boolean).join('；');
    return `${n} 张图片都没有压缩，原样各存了一份副本（共 ${sizeText(before)}）：${why}。`;
  }
  if (n === 1) {
    const it = items[0];
    const size = it.resized ? `尺寸 ${it.srcW}×${it.srcH} → ${it.w}×${it.h} 像素` : `尺寸没变（${it.w}×${it.h} 像素）`;
    return `压缩了 1 张图片：${sizeText(before)} → ${sizeText(after)}，${savedText(before, after)}。${size}，${png ? '有透明的地方，所以存成 PNG' : '存成 JPEG'}。原图没有改动。`;
  }
  const asIs = small && moving ? `${small + moving} 张原样复制（${small} 张已经很小，再压缩反而会变大；${moving} 张是动图，压缩会丢掉动画）` : small ? `${small} 张已经很小（再压缩反而会变大），原样复制` : `${moving} 张是动图（压缩会丢掉动画），原样复制`;
  const head = pressed === n ? `压缩了 ${n} 张图片：共` : `压缩了 ${pressed} 张图片，另外 ${asIs}。${n} 张共`;
  // How the compressed ones were made: their size, then their format.
  const resized = items.filter((it) => it.resized).length;
  const size = !resized ? '尺寸没变' : resized < pressed ? `${resized} 张长边缩到了 ${SHRINK_EDGE} 像素` : `长边${pressed > 1 ? '都' : ''}缩到了 ${SHRINK_EDGE} 像素`;
  const format = !png ? '存成 JPEG' : png < pressed ? `${png} 张有透明的地方，存成 PNG，其余存成 JPEG` : '有透明的地方，存成 PNG';
  return `${head} ${sizeText(before)} → ${sizeText(after)}，${savedText(before, after)}。${pressed === n ? '' : `压缩的 ${pressed} 张：`}${size}；${format}。原图没有改动。`;
}

/**
 * What "转成 JPG" / "转成 PNG" did, in words.
 * @param {'JPG' | 'PNG'} label
 * @param {Array<{ before: number, after: number, how: 'made' | 'same', w?: number, h?: number,
 *   alpha?: boolean, animated?: boolean }>} items
 *   one entry per picture written. 'same': the file already was of that format inside and was copied
 */
export function describeConvert(label, items) {
  const n = items.length;
  const before = sum(items, (it) => it.before), after = sum(items, (it) => it.after);
  const made = items.filter((it) => it.how === 'made');
  const same = n - made.length;
  // Only a JPG loses transparency; only a picture that was drawn again loses its animation.
  const flattened = label === 'JPG' ? made.filter((it) => it.alpha).length : 0;
  const moving = made.filter((it) => it.animated).length;
  if (n === 1) {
    if (same) return `这个文件的内容本来就是 ${label}，只是扩展名不同，所以原样另存了一份（${sizeText(after)}）。`;
    return `已转成 ${label}：${made[0].w}×${made[0].h} 像素，${sizeText(after)}（原图 ${sizeText(before)}）。${flattened ? '透明的地方填成了白色。' : ''}${moving ? '原图是动图，只取了第一帧。' : ''}原图没有改动。`;
  }
  if (!made.length) return `${n} 张图片的内容本来就是 ${label}，原样各存了一份（共 ${sizeText(after)}）。`;
  const notes = [flattened ? `${flattened} 张有透明的地方，填成了白色。` : '', moving ? `${moving} 张是动图，只取了第一帧。` : ''].join('');
  return `把 ${made.length} 张图片转成了 ${label}${same ? `，另外 ${same} 张本来就是 ${label}，原样复制` : ''}。${n} 张共 ${sizeText(after)}（原图共 ${sizeText(before)}）。${notes}原图没有改动。`;
}

function readBytes(file) {
  try {
    return fs.readFileSync(file.path);
  } catch {
    throw Object.assign(new Error(`读不了这个文件：${file.name}`), { why: '文件读不了' });
  }
}

/**
 * Many results into a new folder next to the originals. If the work fails part-way, what it
 * wrote is taken away again, so no half-finished folder is left behind.
 * @param {(write: (name: string, data: Uint8Array) => string, dir: string) => Promise<object>} work
 *   write() gives the file a name that is free in the folder and returns its path
 */
async function intoFolder(env, name, work) {
  const dir = env.folder(name);
  const taken = new Set();
  const written = [];
  const write = (fileName, data) => {
    const file = path.join(dir, freeName(taken, fileName));
    fs.writeFileSync(file, data, { flag: 'wx' }); // never over a file
    written.push(file);
    return file;
  };
  try {
    return await work(write, dir);
  } catch (err) {
    for (const file of written) fs.rmSync(file, { force: true });
    try {
      fs.rmdirSync(dir); // only if nothing else is in it
    } catch {}
    throw err;
  }
}

/**
 * One picture after another through `one`, each result written into a new folder. A picture
 * that cannot be worked on is left out and named in the message.
 * @param {(file) => Promise<{ name: string, data: Uint8Array }>} one  name: what to call the result
 * @param {(done: object[]) => string} describe
 */
function eachIntoFolder(env, files, folderName, one, describe) {
  const n = files.length;
  return intoFolder(env, folderName, async (write, dir) => {
    const done = [];
    const skipped = [];
    for (const [i, file] of files.entries()) {
      checkStop(env);
      env.step(i, n, file.name);
      let made;
      try {
        made = await one(file);
      } catch (err) {
        skipped.push({ name: file.name, why: whyOf(err) });
        continue;
      }
      const { name, data, ...facts } = made;
      write(name, data);
      done.push(facts);
    }
    env.step(n, n, '');
    if (!done.length) throw new Error(`${n} 张图片都${skippedNote(skipped)}`);
    return { kind: 'folder', path: dir, message: describe(done) + skippedNote(skipped) };
  });
}

/** One picture made smaller, or its own bytes if that is the smaller of the two. */
async function shrinkOne(file, env) {
  const bytes = readBytes(file);
  const before = bytes.length;
  const kind = sniff(bytes);
  const asItIs = (how) => ({ name: file.name, ext: file.name.slice(stemOf(file).length + 1), data: bytes, before, after: before, how });
  if (kind.animated) return asItIs('animated');
  const made = await env.tools.canvas.encode(file.path, { maxEdge: SHRINK_EDGE, type: 'auto', quality: SHRINK_QUALITY, opaque: kind.type === 'jpeg' });
  if (made.buffer.length >= before) return asItIs('small');
  const ext = made.type === 'png' ? 'png' : 'jpg';
  return { name: `${stemOf(file)}.${ext}`, ext, data: made.buffer, before, after: made.buffer.length, how: made.type === 'png' ? 'png' : 'jpeg', resized: made.w < made.srcW || made.h < made.srcH, w: made.w, h: made.h, srcW: made.srcW, srcH: made.srcH };
}

/** The action that saves pictures in another format. */
function convertAction({ id, ext, type, label, hint, rank }) {
  const same = (file) => (ext === 'jpg' ? file.ext === 'jpg' || file.ext === 'jpeg' : file.ext === ext);
  const one = async (file, env) => {
    const bytes = readBytes(file);
    const kind = sniff(bytes);
    const name = `${stemOf(file)}.${ext}`;
    // Named as something else but already this format inside: the bytes are right as they are.
    if (kind.type === type) return { name, data: bytes, before: bytes.length, after: bytes.length, how: 'same' };
    const made = await env.tools.canvas.encode(file.path, { type, quality: CONVERT_QUALITY, opaque: kind.type === 'jpeg' });
    return { name, data: made.buffer, before: bytes.length, after: made.buffer.length, how: 'made', w: made.w, h: made.h, alpha: made.alpha, animated: kind.animated };
  };
  return {
    id,
    label: `转成 ${label}`,
    hint,
    rank,
    // Only if it changes something: not for pictures that all are of this format already.
    applies: (ctx) => pictures(ctx) && !ctx.files.every(same),
    async run(ctx, env) {
      const files = ctx.files;
      if (files.length === 1) {
        env.step(0, 1, files[0].name);
        const { data, ...facts } = await one(files[0], env);
        const out = env.save(resultName(files, '', ext), data);
        env.step(1, 1, '');
        return { kind: 'file', path: out, message: describeConvert(label, [facts]) };
      }
      return eachIntoFolder(env, files, `${stemOf(files[0])} 等 ${files.length} 张图片（${label}）`, (file) => one(file, env), (done) => describeConvert(label, done));
    },
  };
}

export const actions = [
  {
    id: 'images.long',
    label: '拼成长图',
    hint: `按选中的顺序上下拼成一张，宽度统一（最宽 ${LONG_WIDTH} 像素），中间不留缝`,
    rank: 12,
    applies: (ctx) => pictures(ctx) && ctx.files.length >= 2,
    async run(ctx, env) {
      const steps = ctx.files.length + 1; // every picture is measured, then all are drawn
      const used = [];
      const skipped = [];
      for (const [i, file] of ctx.files.entries()) {
        checkStop(env);
        env.step(i, steps, file.name);
        try {
          const kind = sniff(readBytes(file));
          const size = await env.tools.canvas.measure(file.path, { opaque: kind.type === 'jpeg' });
          used.push({ file, w: size.w, h: size.h, alpha: Boolean(size.alpha), animated: kind.animated });
        } catch (err) {
          skipped.push({ name: file.name, why: whyOf(err) });
        }
      }
      if (used.length < 2) throw new Error(`${used.length ? '只有 1 张图片读得出来' : '选中的图片都读不出来'}，拼不成长图。${skippedNote(skipped)}`);
      const layout = stackLayout(used);
      if (layout.height > LONG_HEIGHT) throw new Error(`拼起来会有 ${layout.width}×${layout.height} 像素，高度超过了 ${LONG_HEIGHT} 像素的上限。少选几张再拼。`);
      checkStop(env);
      env.step(ctx.files.length, steps, '拼接');
      // A JPEG cannot be transparent: if any picture is, the result is a PNG and stays transparent there.
      const type = used.some((u) => u.alpha) ? 'png' : 'jpeg';
      const made = await env.tools.canvas.stack(used.map((u) => u.file.path), { width: layout.width, heights: layout.heights, type, quality: LONG_QUALITY });
      const out = env.save(resultName(used.map((u) => u.file), ' 长图', type === 'png' ? 'png' : 'jpg'), made.buffer);
      env.step(steps, steps, '');
      const scaled = [layout.reduced ? `${layout.reduced} 张缩小` : '', layout.enlarged ? `${layout.enlarged} 张放大` : ''].filter(Boolean).join('，');
      const moving = used.filter((u) => u.animated).length;
      return {
        kind: 'file',
        path: out,
        message: [
          `把 ${used.length} 张图片按选中的顺序拼成了一张长图：${made.w}×${made.h} 像素，${type === 'png' ? 'PNG' : 'JPEG'}，${sizeText(made.buffer.length)}。`,
          scaled ? `宽度统一成 ${layout.width} 像素：${scaled}。` : `每张都是 ${layout.width} 像素宽，没有缩放。`,
          type === 'png' ? '有透明的地方，所以存成 PNG。' : '',
          moving ? `${moving} 张是动图，只用了第一帧。` : '',
          skippedNote(skipped),
        ].join(''),
      };
    },
  },
  {
    id: 'images.shrink',
    label: '压缩图片',
    hint: `长边缩到 ${SHRINK_EDGE} 像素以内，存成 JPEG（有透明的存成 PNG）；多张放进一个新文件夹`,
    rank: 14,
    applies: pictures,
    async run(ctx, env) {
      const files = ctx.files;
      if (files.length === 1) {
        env.step(0, 1, files[0].name);
        const { data, ext, ...facts } = await shrinkOne(files[0], env);
        const out = env.save(resultName(files, '（已压缩）', ext), data);
        env.step(1, 1, '');
        return { kind: 'file', path: out, message: describeShrink([facts]) };
      }
      return eachIntoFolder(env, files, `${stemOf(files[0])} 等 ${files.length} 张图片（已压缩）`, (file) => shrinkOne(file, env), describeShrink);
    },
  },
  {
    id: 'image.ocr',
    label: '识别文字',
    hint: '让本地模型把图片里的文字原样抄出来，完成后自动复制到剪贴板',
    rank: 16,
    autoCopy: true,
    applies: (ctx) => pictures(ctx) && ctx.files.length === 1 && Boolean(ctx.has?.model),
    run: async (ctx) => ({
      kind: 'ask',
      autoCopy: true,
      question: '请把这张图片里的所有文字原样抄写出来：一个字都不要改，不要翻译，不要解释，不要补充，按原来的顺序，保留原来的换行。如果图片里没有文字，就直接回答“图片里没有文字”。',
      images: [ctx.files[0].path],
    }),
  },
  convertAction({ id: 'image.jpg', ext: 'jpg', type: 'jpeg', label: 'JPG', hint: '另存一份 JPG（质量 92%），透明的地方填成白色；多张放进一个新文件夹', rank: 24 }),
  convertAction({ id: 'image.webp', ext: 'webp', type: 'webp', label: 'WebP', hint: '另存一份 WebP（质量 92%，保留透明通道），体积更小；多张放进一个新文件夹', rank: 25 }),
  convertAction({ id: 'image.png', ext: 'png', type: 'png', label: 'PNG', hint: '另存一份 PNG，画面不变；多张放进一个新文件夹', rank: 26 }),
];
