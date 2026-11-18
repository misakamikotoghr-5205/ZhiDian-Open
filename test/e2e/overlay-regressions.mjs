// Exercise the real overlay DOM, CSS and input handlers in a headless browser. Only the
// Electron IPC bridge is stubbed, so layout changes and asynchronous rendering still run.
//   node test/e2e/overlay-regressions.mjs
// Set CHROMIUM_PATH to use an already installed compatible Chromium instead of Playwright's.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = http.createServer((req, res) => {
  const file = path.resolve(repo, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(repo + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(() => {
    const events = window.testEvents = {};
    window.testRects = [];
    window.testCaptures = [];
    window.testSnapshots = [];
    const refs = [];
    let seq = 0;
    window.zhidian = {
      on: (name, callback) => { events[name] = callback; },
      idleContent() {},
      rects: (rects) => { window.testRects = rects; },
      beat() {},
      exit() {},
      pin: async ({ box, kind }) => {
        const handle = '@' + ++seq;
        refs.push({ handle, box, kind, displayId: 1, state: 'live', readers: [], imageSize: { w: box.w, h: box.h }, bytes: 100, thumb: '' });
        events.referents([...refs]);
        return handle;
      },
      unpin: (handle) => {
        const i = refs.findIndex((r) => r.handle === handle);
        if (i >= 0) refs.splice(i, 1);
        events.referents([...refs]);
      },
      captureCopy: async (payload) => {
        window.testCaptures.push(payload);
        return { ok: false }; // retain the overlay to inspect it
      },
      captureSave: async (payload) => { window.testCaptures.push(payload); },
      referentImage: () => new Promise((resolve) => window.testSnapshots.push(resolve)),
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/src/renderer/overlay.html`);
  await page.waitForFunction(() => window.__overlay);

  console.log('▸ History expansion updates idle hit regions and keeps the bubble on screen');
  await page.evaluate(() => {
    const { S } = window.__overlay;
    S.anchor = { x: 600, y: 650, w: 200, h: 10 };
    const emit = (name, value) => window.testEvents[name](value);
    emit('answer:start', { id: 1, handles: [], question: 'Previous question', brain: 'test' });
    emit('answer:text', { id: 1, text: 'A long previous answer.\n'.repeat(30) });
    emit('answer:done', { id: 1 });
    emit('answer:start', { id: 2, handles: [], question: 'Current question', brain: 'test' });
    emit('answer:text', { id: 2, text: 'Current answer.' });
    emit('answer:done', { id: 2 });
  });
  const before = await page.locator('#bubble').boundingBox();
  await page.locator('#bhistory summary').click();
  await page.waitForFunction(() => {
    const r = document.getElementById('bubble').getBoundingClientRect();
    return window.testRects.some((sent) => Math.abs(sent.h - r.height) < 1 && Math.abs(sent.y - r.y) < 1);
  });
  const after = await page.locator('#bubble').boundingBox();
  assert.ok(after.height > before.height + 50, 'history actually expanded');
  assert.ok(after.y + after.height <= 900, 'expanded bubble remains fully on screen');

  console.log('▸ Clearing a topic cancels both running and queued pointer animations');
  const cleared = await page.evaluate(async () => {
    const { S, el } = window.__overlay;
    window.testEvents.mark({ n: 1, handle: '@1', x: 100, y: 100 });
    window.testEvents.mark({ n: 2, handle: '@1', x: 200, y: 200 });
    const oldQueue = S.markQueue;
    // Let the first animation start and pause at requestAnimationFrame.
    await Promise.resolve();
    window.testEvents['thread:reset']({});
    await oldQueue;
    return { marks: S.marks.length, nodes: el.marks.childElementCount, aiAt: S.aiAt, aiVisible: el.ai.classList.contains('on') };
  });
  assert.deepEqual(cleared, { marks: 0, nodes: 0, aiAt: null, aiVisible: false });

  console.log('▸ A pending snapshot cannot re-open after clearing, and new marks still work');
  const snapshot = await page.evaluate(async () => {
    const { S, el } = window.__overlay;
    window.testEvents.mark({
      n: 3, handle: '@1', where: 'snapshot', kind: 'point', who: 'test',
      image: { x: 1, y: 1, iw: 10, ih: 10 },
    });
    const oldQueue = S.markQueue;
    await Promise.resolve();
    const resolveImage = window.testSnapshots.shift();
    if (!resolveImage) throw new Error('snapshot request did not start');
    window.testEvents['thread:reset']({});
    window.testEvents.mark({ n: 4, handle: '@2', x: 250, y: 250 });
    const freshQueue = S.markQueue;
    resolveImage('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA9sAAAAASUVORK5CYII=');
    await Promise.all([oldQueue, freshQueue]);
    return { snapshotHidden: el.snapshot.hidden, marks: S.marks.map((m) => m.mark.n), activeMarks: el.marks.querySelectorAll('.mark.on').length };
  });
  assert.deepEqual(snapshot, { snapshotHidden: true, marks: [4], activeMarks: 1 });

  console.log('▸ After unpinning, screenshot shortcuts use the current tracked box');
  await page.evaluate(() => {
    window.testEvents['thread:reset']({});
    const { S } = window.__overlay;
    S.mode = 'pointing';
    S.displayId = 1;
    S.phase = 'track';
    S.box = { x: 10, y: 20, w: 100, h: 100 };
    document.body.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 30, clientY: 40, bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 30, clientY: 40, bubbles: true }));
  });
  await page.waitForFunction(() => window.__overlay.S.fresh.length === 1);
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => window.__overlay.S.phase === 'track' && window.__overlay.S.fresh.length === 0);
  await page.evaluate(() => {
    // Move the tracked box before the next hover dwell fires.
    window.__overlay.S.box = { x: 600, y: 400, w: 150, h: 80 };
  });
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+s');
  assert.deepEqual(await page.evaluate(() => window.testCaptures), [
    { box: { x: 600, y: 400, w: 150, h: 80 } },
    { box: { x: 600, y: 400, w: 150, h: 80 } },
  ]);
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log('✔ Overlay regression checks passed');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
