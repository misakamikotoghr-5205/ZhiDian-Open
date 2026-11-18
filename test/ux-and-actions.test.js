import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import { badgeToken, renderMarkdown } from '../src/core/markdown.js';
import { parsePageSpec } from '../src/core/page-range.js';
import { describeFiles, kindOf } from '../src/core/office-kinds.js';
import { isAppIgnored } from '../src/main/context/watch.js';
import * as settings from '../src/main/settings.js';
import { LocalRuntime } from '../src/main/local/runtime.js';
import { MODELS } from '../src/main/local/catalog.js';
import { Office } from '../src/main/office/index.js';
import { sniff, actions as imageActions } from '../src/main/office/tools-image.js';
import { actions as pdfActions } from '../src/main/office/tools-pdf.js';
import { actions as basicActions } from '../src/main/office/tools-basic.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-ux-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** Minimal DOM stand-in for testing renderMarkdown in pure Node without a browser. */
function fakeDoc() {
  class FakeNode {
    constructor(tag) {
      this.tag = tag;
      this.className = '';
      this.textContent = '';
      this.children = [];
      this.attrs = {};
      this.listeners = {};
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    append(...items) {
      for (const item of items) {
        if (item == null) continue;
        if (typeof item === 'string') {
          const t = new FakeNode('#text');
          t.textContent = item;
          this.children.push(t);
        } else if (item.tag === '#fragment') {
          this.children.push(...item.children);
        } else {
          this.children.push(item);
        }
      }
    }
    text() {
      if (this.tag === '#text') return this.textContent;
      return this.textContent + this.children.map((c) => c.text()).join('');
    }
    findAll(pred, out = []) {
      if (pred(this)) out.push(this);
      for (const c of this.children) c.findAll(pred, out);
      return out;
    }
  }
  return {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (s) => {
      const n = new FakeNode('#text');
      n.textContent = String(s);
      return n;
    },
    createDocumentFragment: () => new FakeNode('#fragment'),
  };
}

test('renderMarkdown: headings, inline formatting, lists, tables, code copy, @n refs, badges, and XSS safety', () => {
  const copied = [];
  const doc = fakeDoc();
  const src = [
    '## 对比结论',
    '',
    '看 @1 和 @99，建议选 **甲方案**（`v2.0`），~~旧版~~已停用。' + badgeToken(1),
    '',
    '- 第一点',
    '- 第二点',
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    '| 耗时 | 12ms |',
    '',
    '```js',
    'const x = "<script>alert(1)</script>";',
    '```',
    '',
    '<img src=x onerror=alert(1)>',
  ].join('\n');

  const frag = renderMarkdown(
    src,
    {
      isRef: (h) => h === '@1',
      onCopyCode: (code) => copied.push(code),
    },
    doc,
  );
  const rootWrap = doc.createElement('div');
  rootWrap.append(frag);

  assert.equal(rootWrap.findAll((n) => n.tag === 'h2').length, 1);
  assert.equal(rootWrap.findAll((n) => n.tag === 'strong')[0].text(), '甲方案');
  assert.equal(rootWrap.findAll((n) => n.tag === 'del')[0].text(), '旧版');
  assert.equal(rootWrap.findAll((n) => n.tag === 'code' && n.className === 'md-code')[0].text(), 'v2.0');
  assert.deepEqual(rootWrap.findAll((n) => n.className === 'ref').map((n) => n.text()), ['@1'], 'only active @n refs are highlighted');
  assert.deepEqual(rootWrap.findAll((n) => n.className === 'badge').map((n) => n.text()), ['1']);
  assert.equal(rootWrap.findAll((n) => n.tag === 'li').length, 2);
  assert.equal(rootWrap.findAll((n) => n.tag === 'table').length, 1);
  assert.equal(rootWrap.findAll((n) => n.tag === 'script' || n.tag === 'img').length, 0, 'raw HTML tags never become DOM elements');
  assert.match(rootWrap.text(), /<img src=x onerror=alert\(1\)>/);

  const copyBtn = rootWrap.findAll((n) => n.className === 'md-copy')[0];
  assert.ok(copyBtn);
  copyBtn.listeners.click();
  assert.deepEqual(copied, ['const x = "<script>alert(1)</script>";']);
});

test('parsePageSpec: ranges, reverse ranges, Chinese punctuation, 末页, deduplication, and errors', () => {
  assert.deepEqual(parsePageSpec('1-3, 5', 6), [1, 2, 3, 5]);
  assert.deepEqual(parsePageSpec('２、４～末页', 5), [2, 4, 5]);
  assert.deepEqual(parsePageSpec('4-2, 3', 5), [4, 3, 2], 'preserves order while deduplicating');
  assert.throws(() => parsePageSpec('', 5), /请填写要提取的页码/);
  assert.throws(() => parsePageSpec('1-8', 5), /超出了总页数.*共 5 页/);
  assert.throws(() => parsePageSpec('abc', 5), /看不懂页码/);
});

test('kindOf & sniff: newly supported modern image formats', () => {
  for (const ext of ['a.avif', 'b.svg', 'c.ico', 'd.jfif']) assert.equal(kindOf(ext), 'image', ext);
  assert.equal(kindOf('photo.HEIC', 'darwin'), 'image');
  assert.equal(kindOf('photo.HEIC', 'linux'), 'other');

  const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 16, 16, 0, 0, 1, 0, 32, 0]);
  assert.deepEqual(sniff(ico), { type: 'ico', animated: false });
  const avif = Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual(sniff(avif), { type: 'avif', animated: false });
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
  assert.deepEqual(sniff(svg), { type: 'svg', animated: false });
});

test('isAppIgnored: matches foreground app names against comma/Chinese-comma/newline ignore lists', () => {
  assert.equal(isAppIgnored('Visual Studio Code', 'Code, Terminal'), true);
  assert.equal(isAppIgnored('WindowsTerminal.exe', 'Code，windowsterminal\niTerm2'), true);
  assert.equal(isAppIgnored('Google Chrome', 'Code, Terminal'), false);
  assert.equal(isAppIgnored('', 'Code, Terminal'), false);
  assert.equal(isAppIgnored('Code', ''), false);
});

test('Settings & LocalRuntime.removeModel: new defaults persist and installed models can be cleanly deleted', () => {
  const dir = path.join(root, 'settings-and-models');
  process.env.ZHIDIAN_USER_DATA = dir;
  settings.resetForTest();
  const loaded = settings.load();
  assert.equal(loaded.naturalWheel, false);
  assert.equal(loaded.launchAtLogin, false);
  assert.equal(loaded.actions.compact, true);
  assert.equal(loaded.actions.ignoredApps, '');
  assert.equal(loaded.actions.translateTo, 'auto');

  settings.update({ naturalWheel: true, actions: { compact: false, ignoredApps: 'Code, Warp', translateTo: 'ja' } });
  settings.resetForTest();
  const reloaded = settings.load();
  assert.equal(reloaded.naturalWheel, true);
  assert.equal(reloaded.actions.compact, false);
  assert.equal(reloaded.actions.ignoredApps, 'Code, Warp');
  assert.equal(reloaded.actions.translateTo, 'ja');

  const localDir = path.join(dir, 'local');
  const modelsDir = path.join(localDir, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const m = MODELS[0];
  for (const f of m.files) {
    const p = path.join(modelsDir, f.saveAs ?? f.name);
    fs.closeSync(fs.openSync(p, 'w'));
    fs.truncateSync(p, f.size);
  }
  const rt = new LocalRuntime({ baseDir: localDir, getConfig: () => reloaded.local });
  assert.equal(rt.modelInstalled(m), true);
  const res = rt.removeModel(m.id);
  assert.equal(res.ok, true);
  assert.equal(res.removedBytes, m.files.reduce((s, f) => s + f.size, 0));
  assert.equal(rt.modelInstalled(m), false);
  assert.throws(() => rt.removeModel('no-such-model'), /没有找到这个模型/);
});

test('pdf.extract, pdf.rotate, and pdf.compress work on real PDFs and preserve input files', async () => {
  const dir = path.join(root, 'pdfs');
  fs.mkdirSync(dir, { recursive: true });
  const srcPath = path.join(dir, '报告.pdf');
  const doc = await PDFDocument.create();
  doc.addPage([200, 400]);
  doc.addPage([300, 500]);
  const p3 = doc.addPage([400, 600]);
  p3.setRotation(degrees(90));
  const rawBytes = await doc.save();
  fs.writeFileSync(srcPath, rawBytes);

  const tinyJpegB64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
  const office = new Office({
    documentsDir: dir,
    tools: {
      openPdf: async () => ({
        pages: 1,
        render: async () => ({ dataUrl: `data:image/jpeg;base64,${tinyJpegB64}`, w: 100, h: 100, points: { w: 595, h: 842 } }),
        close: async () => {},
      }),
    },
  });
  const ctx = office.context({ files: [srcPath] });

  const extracted = await office.run('pdf.extract', ctx, { param: '3, 1' });
  assert.equal(extracted.kind, 'file');
  const extDoc = await PDFDocument.load(fs.readFileSync(extracted.path));
  assert.equal(extDoc.getPageCount(), 2);
  assert.equal(extDoc.getPage(0).getWidth(), 400, 'page 3 came first as requested');
  assert.equal(extDoc.getPage(1).getWidth(), 200, 'page 1 came second');

  const rotated = await office.run('pdf.rotate', ctx);
  assert.equal(rotated.kind, 'file');
  const rotDoc = await PDFDocument.load(fs.readFileSync(rotated.path));
  assert.equal(rotDoc.getPage(0).getRotation().angle, 90);
  assert.equal(rotDoc.getPage(2).getRotation().angle, 180, 'existing 90° became 180°');

  // When compressed bytes are larger than tiny vector PDF, pdf.compress refuses cleanly and writes nothing.
  const fatOffice = new Office({
    documentsDir: dir,
    tools: {
      openPdf: async () => ({
        pages: 3,
        render: async () => ({ dataUrl: `data:image/jpeg;base64,${tinyJpegB64}`, w: 800, h: 1000, points: { w: 595, h: 842 } }),
        close: async () => {},
      }),
    },
  });
  await assert.rejects(() => fatOffice.run('pdf.compress', ctx), /已经很紧凑/);

  // On a bloated PDF, pdf.compress writes a smaller PDF next to the original.
  const bloatedPath = path.join(dir, '扫描件.pdf');
  const bloatedDoc = await PDFDocument.create();
  bloatedDoc.addPage([595, 842]);
  // Pad unused metadata/bytes so the file is > 30 KB while rendered JPEG is tiny.
  bloatedDoc.setKeywords(['pad-' + 'x'.repeat(40_000)]);
  fs.writeFileSync(bloatedPath, await bloatedDoc.save({ useObjectStreams: false }));
  const compRes = await office.run('pdf.compress', office.context({ files: [bloatedPath] }));
  assert.equal(compRes.kind, 'file');
  assert.ok(fs.statSync(compRes.path).size < fs.statSync(bloatedPath).size);
  assert.deepEqual(fs.readFileSync(srcPath), Buffer.from(rawBytes), 'original PDF untouched');
});

test('image.webp & text.translate with target language parameter', async () => {
  const dir = path.join(root, 'webp');
  fs.mkdirSync(dir, { recursive: true });
  const pngPath = path.join(dir, 'icon.png');
  const PNG_SIGN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...Buffer.alloc(17), 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);
  fs.writeFileSync(pngPath, PNG_SIGN);
  let calledType = '';
  const office = new Office({
    documentsDir: dir,
    tools: {
      canvas: {
        encode: async (_path, opts) => {
          calledType = opts.type;
          return { buffer: Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), w: 10, h: 10, alpha: true, type: 'webp' };
        },
      },
    },
  });
  const res = await office.run('image.webp', office.context({ files: [pngPath] }));
  assert.equal(calledType, 'webp');
  assert.equal(res.kind, 'file');
  assert.match(res.path, /icon\.webp$/);

  const trAct = basicActions.find((a) => a.id === 'text.translate');
  assert.equal(trAct.autoCopy, true);
  assert.equal(trAct.param.kind, 'select');
  const ja = await office.run('text.translate', office.context({ text: '你好世界' }), { param: 'ja' });
  assert.match(ja.question, /日文/);
  const auto = await office.run('text.translate', office.context({ text: 'Hello world' }), { param: 'auto' });
  assert.match(auto.question, /中文就译成英文/);

  // Office.offers surfaces param and autoCopy metadata
  const offered = office.offers(office.context({ text: 'Hello world' }));
  const trOffer = offered.find((o) => o.id === 'text.translate');
  assert.equal(trOffer.autoCopy, true);
  assert.equal(trOffer.param.kind, 'select');
});
