// Real app/IPC/file conversion, with two HTTP stand-ins for text-only local 8B and cloud.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-context-e2e-'));
const calls = [];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw); calls.push(body);
  const content = JSON.stringify({ message: '将当前文件排版，结果另存', steps: [{ actionId: 'file.typeset' }] });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ seenIntro: true, mcp: { enabled: false }, actions: { ambient: false }, local: { mode: 'external', externalModel: 'local-8b-text', externalUrl: baseUrl, externalVision: 'text' } }));
const file = path.join(dir, 'budget.txt');
fs.writeFileSync(file, '项目收入是 89642 元,本月继续增长。');
let app;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', repo], env: { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: dir, ZHIDIAN_LOCAL_DIR: path.join(dir, 'local') } });
  const overlay = await app.firstWindow();
  await overlay.waitForLoadState('domcontentloaded');
  for (const via of ['local', 'cloud']) {
    await app.evaluate((_e, { file, via, baseUrl }) => {
      const c = globalThis.__zhidian;
      if (via === 'cloud') c.updateCloud({ provider: 'openai', baseUrl, model: 'cloud-text', vision: 'text', key: 'test-key-for-context', enabled: true, byDefault: true });
      c.setVia(via);
      c.desktopContext.set({ id: via, capturedAt: Date.now(), app: 'Notepad', title: 'budget.txt', files: [file], selectedText: '', controls: [], warnings: [] });
    }, { file, via, baseUrl });
    const before = fs.readdirSync(dir).filter((f) => f.includes('已排版'));
    const result = await overlay.evaluate(() => window.zhidian.contextRun({ instruction: '把当前文件排版' }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.plan.steps[0].actionId, 'file.typeset');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('已排版')), before, 'planning does not execute');
    const request = calls.at(-1);
    assert.match(JSON.stringify(request.messages), /89642/);
    assert.ok(!JSON.stringify(request.messages).includes('image_url'), 'text-only models receive actual file text, no screenshots');
    assert.equal(request.model, via === 'local' ? 'local-8b-text' : 'cloud-text');
    const execution = await overlay.evaluate((id) => window.zhidian.contextExecute(id), result.plan.id);
    assert.equal(execution.ok, true, execution.error);
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('已排版')).length, before.length + 1);
    assert.equal((await overlay.evaluate((id) => window.zhidian.contextExecute(id), result.plan.id)).ok, false);
    console.log(`PASS: ${via} uses real file context, plans before execution and creates a new output`);
  }
  const imageFile = path.join(dir, 'text.png');
  fs.writeFileSync(imageFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  await app.evaluate((_e, file) => {
    const c = globalThis.__zhidian;
    c.settings.update({ local: { externalVision: 'vision' }, pointBack: false });
    c.setVia('local'); // cloud remains enabled by default; this task explicitly uses local
    c.desktopContext.set({ id: 'ocr', capturedAt: Date.now(), app: 'Explorer', title: 'text.png', files: [file], selectedText: '', controls: [], warnings: [] });
  }, imageFile);
  const beforeOcr = calls.length;
  const ocr = await overlay.evaluate(() => window.zhidian.contextRun({ actionId: 'image.ocr' }));
  assert.equal(ocr.ok, true, ocr.error);
  for (let n = 0; n < 100 && calls.length === beforeOcr; n++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, beforeOcr + 1);
  assert.equal(calls.at(-1).model, 'local-8b-text', 'image actions preserve the chosen local destination despite cloud default');
  assert.match(JSON.stringify(calls.at(-1).messages), /image_url/);
  assert.equal(await app.evaluate(() => globalThis.__zhidian.state.lastQuestion.autoCopy), true);
  console.log('PASS: image task preserves selected model and OCR auto-copy');
  assert.equal(fs.readFileSync(file, 'utf8'), '项目收入是 89642 元,本月继续增长。');
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
