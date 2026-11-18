// Functional and layout checks for the desktop assistant workspace, using the real renderer.
// Run with Playwright's installed Chromium, or set CHROMIUM_PATH to an existing browser.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.E2E_OUT || path.join(os.tmpdir(), 'zhidian-workspace-ui');
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  const file = path.resolve(repo, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(repo + path.sep)) return void res.writeHead(403).end();
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const events = window.testEvents = {};
    const calls = window.testCalls = { contexts: [], executions: [], asks: [], pins: [], settings: [], models: [], cancels: 0 };
    window.zhidian = {
      on: (name, fn) => { events[name] = fn; },
      idleContent() {}, rects(r) { window.testRects = r; }, beat() {}, exit() {},
      openSettings: (section) => calls.settings.push(section),
      via: (model) => calls.models.push(model),
      pin: async (p) => {
        calls.pins.push(p);
        const handle = '@' + calls.pins.length;
        events.referents([{ handle, box: p.box, kind: p.kind, displayId: 1, state: 'live', readers: [], imageSize: { w: p.box.w, h: p.box.h }, bytes: 100, thumb: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="28"><rect width="44" height="28" fill="#e3eafb"/><path d="M8 8h28M8 14h22M8 20h16" stroke="#91a7d2" stroke-width="2"/></svg>') }]);
        return handle;
      },
      ask: (request) => calls.asks.push(request),
      contextRun: async (request) => {
        calls.contexts.push(request);
        if (window.holdContext) return new Promise((resolve) => { window.finishContext = resolve; });
        if (request.instruction) return { ok: true, plan: { id: 'plan-1', summary: '将所选文件合并为一份 PDF', steps: [{ label: '读取两个所选文档' }, { label: '生成合并后的 PDF 文件' }], requiresConfirm: true } };
        return { ok: true, message: '已完成所选操作。' };
      },
      contextExecute: async (id) => { calls.executions.push(id); return { ok: true, message: '已生成合并后的 PDF。' }; },
      contextCancel: () => {
        calls.cancels++;
        if (window.__overlay.S.contextBusy) window.finishContext?.({ ok: false, error: '任务已停止。' });
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/src/renderer/overlay.html`);
  await page.waitForFunction(() => window.__overlay);
  await page.evaluate(() => {
    const { S, el } = window.__overlay;
    S.mode = 'pointing'; S.displayId = 1; S.phase = 'fixed';
    S.box = S.target = { x: 130, y: 75, w: 240, h: 90 };
    el.ask.hidden = false; el.ask.classList.remove('quiet');
    el.ask.style.left = '120px'; el.ask.style.top = '100px';
    document.body.style.background = '#edf1f7';
    window.testEvents.config({ brain: 'Qwen 3.5 · 本机', where: 'local', cloud: { name: '联网模型', host: 'api.example.com', on: false } });
  });

  console.log('▸ Grouped screen prompts, custom entry and model/settings controls');
  assert.ok(await page.locator('#presets button').count() >= 10);
  assert.equal(await page.locator('#q').evaluate((el) => el.tagName), 'TEXTAREA');
  await page.locator('#asksettings').click();
  await page.locator('#hud [data-via="cloud"]').click();
  assert.deepEqual(await page.evaluate(() => window.testCalls.settings), ['general']);
  assert.deepEqual(await page.evaluate(() => window.testCalls.models), ['cloud']);
  await page.screenshot({ path: path.join(output, 'screen-workspace.png') });
  console.log('▸ Pinning a card keeps its adjacent comparison target unobscured');
  await page.evaluate(() => {
    const { S } = window.__overlay;
    S.box = S.target = { x: 33, y: 109, w: 479, h: 235 };
    S.phase = 'hover';
    document.body.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 75, clientY: 140, bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 75, clientY: 140, bubbles: true }));
  });
  await page.waitForFunction(() => window.__overlay.S.fresh.length === 1);
  const pinnedDialog = await page.locator('#ask').boundingBox();
  assert.ok(pinnedDialog.y >= 344, 'dialog uses available space below the first card');
  assert.ok(pinnedDialog.y + pinnedDialog.height <= 900, 'scrolling keeps the dialog within the screen');
  assert.ok(!(595 >= pinnedDialog.x && 595 <= pinnedDialog.x + pinnedDialog.width && 225 >= pinnedDialog.y && 225 <= pinnedDialog.y + pinnedDialog.height), 'second card price remains available for left-click capture');
  await page.locator('#presets [data-preset="总结关键要点"]').click();
  await page.waitForFunction(() => window.testCalls.asks.length === 1);
  assert.equal(await page.evaluate(() => window.testCalls.asks[0].question), '总结关键要点');

  const context = {
    app: '文件资源管理器', title: '季度项目资料 · 文档',
    files: [{ name: '项目进展报告.docx', path: 'C:\\Documents\\项目进展报告.docx', kind: 'docx' }, { name: '季度数据汇总.xlsx', path: 'C:\\Documents\\季度数据汇总.xlsx', kind: 'xlsx' }],
    selectedText: '', warnings: [], controls: [],
    availableActions: [
      { id: 'files.pdf', label: '合并成 PDF', hint: '将所选文档合并为 PDF' },
      { id: 'pdf.extract', label: '提取指定页', param: { kind: 'text', placeholder: '例如：1-3, 5', submitLabel: '提取' } },
      { id: 'files.pptx', label: '做成 PPT' }, { id: 'files.zip', label: '打包为 ZIP' },
      { id: 'files.names', label: '复制文件名清单' }, { id: 'files.text', label: '提取文档文字' },
    ],
  };
  await page.evaluate((context) => {
    const { S } = window.__overlay;
    S.fresh = []; S.extra.clear();
    window.testEvents.context(context);
  }, context);
  console.log('▸ Captured file context, direct actions and parameter input');
  await page.waitForFunction(() => document.getElementById('contextmode').getAttribute('aria-selected') === 'true');
  assert.match(await page.locator('#contextcard').innerText(), /项目进展报告\.docx/);
  assert.doesNotMatch(await page.locator('#contextcard').innerText(), /null|undefined/, 'optional context fields do not appear as literal null text');
  await page.locator('[data-context-action="files.pdf"]').click();
  await page.waitForFunction(() => !window.__overlay.S.contextBusy);
  assert.equal(await page.evaluate(() => window.testCalls.contexts.at(-1).actionId), 'files.pdf');
  await page.locator('[data-context-action="pdf.extract"]').click();
  await page.locator('.context-param input').fill('3, 1');
  await page.locator('.context-param input').press('Enter');
  await page.waitForFunction(() => !window.__overlay.S.contextBusy);
  assert.deepEqual(await page.evaluate(() => window.testCalls.contexts.at(-1)), { actionId: 'pdf.extract', param: '3, 1' });
  assert.equal(await page.evaluate(() => window.testCalls.asks.length), 1, 'context parameter Enter never submits a screenshot question');

  console.log('▸ Custom instruction previews a plan and only executes after confirmation');
  const pinsBefore = await page.evaluate(() => window.testCalls.pins.length);
  await page.locator('#q').fill('把这些文件整理成一份 PDF');
  await page.locator('#q').press('Shift+Enter');
  await page.locator('#q').press('Enter');
  await page.waitForFunction(() => Boolean(window.__overlay.S.contextResult?.plan));
  assert.equal(await page.evaluate(() => window.testCalls.pins.length), pinsBefore, 'context typing does not create screen captures');
  assert.deepEqual(await page.evaluate(() => window.testCalls.executions), []);
  assert.match(await page.locator('.context-status').innerText(), /读取两个所选文档/);
  await page.screenshot({ path: path.join(output, 'context-plan.png') });
  await page.locator('[data-execute-plan="plan-1"]').click();
  await page.waitForFunction(() => !window.__overlay.S.contextBusy);
  assert.deepEqual(await page.evaluate(() => window.testCalls.executions), ['plan-1']);

  console.log('▸ Pending execution disables repeated commands and reports failures');
  await page.evaluate(() => { window.holdContext = true; });
  await page.locator('[data-context-action="files.pdf"]').click();
  assert.ok(await page.locator('#qsend').isDisabled());
  assert.ok(await page.locator('[data-context-action="files.pdf"]').isDisabled());
  await page.evaluate(() => window.finishContext({ ok: false, error: '文件正在被其他应用使用，请关闭后重试。' }));
  await page.waitForFunction(() => !window.__overlay.S.contextBusy);
  assert.match(await page.locator('.context-status.error').innerText(), /文件正在被其他应用使用/);
  assert.ok(await page.locator('#qsend').isEnabled());

  console.log('▸ Escape cancels in-flight context work; externally proposed plans still require a click');
  await page.locator('[data-context-action="files.pdf"]').click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__overlay.S.contextBusy);
  assert.equal(await page.evaluate(() => window.testCalls.cancels), 1);
  await page.evaluate(() => window.testEvents['context:plan']({ ok: true, plan: { id: 'external-plan', summary: '提取指定页面', steps: [{ label: '提取指定页', param: '1-3' }], requiresConfirm: true } }));
  assert.match(await page.locator('.plan-param').innerText(), /1-3/);
  assert.deepEqual(await page.evaluate(() => window.testCalls.executions), ['plan-1']);
  await page.locator('.context-plan-buttons button', { hasText: '取消' }).click();
  assert.equal(await page.evaluate(() => window.testCalls.cancels), 2);
  assert.equal(await page.locator('[data-execute-plan]').count(), 0);

  await page.evaluate(() => window.testEvents.context({ app: '编辑器', title: '未命名文档', files: [], selectedText: '', controls: [{ id: 'save', name: '保存', role: 'button', actions: ['invoke'] }], warnings: [], availableActions: [{ id: 'control.save.invoke', label: '点击 保存', category: 'controls' }] }));
  assert.equal(await page.locator('#contextmode').getAttribute('aria-selected'), 'true', 'available window actions select context mode even without files');
  assert.match(await page.locator('#contextcard').innerText(), /已识别 1 个窗口控件/);

  console.log('▸ Context and screen workspaces fit small laptop and narrow viewports');
  for (const size of [{ width: 1280, height: 720 }, { width: 800, height: 600 }, { width: 390, height: 740 }]) {
    await page.setViewportSize(size);
    await page.evaluate(({ width, height }) => {
      window.testEvents.display({ id: 1, w: width, h: height });
      window.__overlay.S.contextResult = null;
      window.testEvents.context({ app: '编辑器', title: '项目会议纪要', files: [], selectedText: '请在周五前整理项目进度，并列出需要协调的事项。', warnings: [], controls: [], availableActions: [] });
    }, size);
    const box = await page.locator('#ask').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height, `context panel fits ${size.width}×${size.height}`);
    assert.equal(await page.locator('#ask').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, 'no horizontal overflow');
    await page.locator('#screenmode').click();
    const screen = await page.locator('#ask').boundingBox();
    assert.ok(screen.x >= 0 && screen.y >= 0 && screen.x + screen.width <= size.width && screen.y + screen.height <= size.height, `screen panel fits ${size.width}×${size.height}`);
    // Layout fixture only; actual capture, permissions and transcription are exercised by
    // voice-input.mjs in Electron. This keeps active recording controls visible on short screens.
    await page.evaluate(() => {
      const { voice } = window.__overlay;
      voice.onState({ state: 'listening', where: 'local', elapsedSeconds: 4, maxSeconds: 60 });
      voice.onAmplitude(.62);
    });
    await page.waitForTimeout(80);
    const mic = await page.locator('#qmic').boundingBox();
    const recording = await page.locator('#ask').boundingBox();
    assert.ok(mic.y >= recording.y && mic.y + mic.height <= recording.y + recording.height, `microphone control remains visible at ${size.width}×${size.height}`);
    assert.equal(await page.locator('#ask').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, 'voice visual introduces no horizontal overflow');
    await page.screenshot({ path: path.join(output, `voice-workspace-${size.width}.png`) });
    await page.evaluate(() => window.__overlay.voice.cancel());
  }
  await page.waitForTimeout(200); // allow the tab color transition to settle for the visual artifact
  await page.screenshot({ path: path.join(output, 'narrow-workspace.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const emit = (name, value) => window.testEvents[name](value);
    emit('display', { id: 1, w: 1440, h: 900 });
    emit('mode', { mode: 'idle' });
    emit('answer:start', { id: 10, handles: [], question: '总结这份项目报告', brain: 'Qwen 3.5 · 本机' });
    emit('answer:text', { id: 10, text: '## 本周项目进展\n\n主要功能已完成，接下来可以按以下顺序推进：\n\n- **验证体验**：检查常用应用中的操作流程\n- **整理资料**：合并本周的项目文档\n- **准备交付**：补充使用说明和演示\n\n| 工作 | 状态 |\n| --- | --- |\n| 功能开发 | 已完成 |\n| 体验检查 | 进行中 |' });
    emit('answer:done', { id: 10, totalMs: 2100 });
    emit('act:offer', { id: 'office-preview', summary: '2 个文件 · 项目资料', at: { x: 100, y: 140 }, offers: [
      { id: 'files.pdf', label: '合并成 PDF' }, { id: 'files.pptx', label: '做成 PPT' },
      { id: 'files.zip', label: '打包成 ZIP' }, { id: 'files.names', label: '复制文件名清单' },
    ] });
  });
  await page.waitForTimeout(200);
  const panels = await page.evaluate(() => ['act', 'bubble'].map((id) => document.getElementById(id).getBoundingClientRect().toJSON()));
  assert.ok(panels[0].right <= panels[1].left || panels[0].left >= panels[1].right || panels[0].bottom <= panels[1].top || panels[0].top >= panels[1].bottom, 'office actions do not obscure the answer when screen space is available');
  await page.screenshot({ path: path.join(output, 'answer-and-office-actions.png') });
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log(`✔ Workspace UI checks passed; screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
