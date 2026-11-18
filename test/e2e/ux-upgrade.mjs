// End-to-end verification of the upgraded UX & new office/settings capabilities inside the real
// Electron application (overlay window + settings window + main process), running on Xvfb without
// needing xdotool.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e/ux-upgrade.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-ux-e2e-')));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-ux-ud-'));
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    seenIntro: true,
    mcp: { enabled: false },
    actions: { ambient: true, compact: true, ignoredApps: '', translateTo: 'auto' },
  }),
);

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['--no-sandbox', repo, '--rehearse'],
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    ZHIDIAN_TEST: '1',
    ZHIDIAN_USER_DATA: userData,
    ZHIDIAN_LOCAL_DIR: path.join(userData, 'local'),
  },
});

const main = (fn, arg) => app.evaluate(fn, arg);
const overlay = await app.firstWindow();
await overlay.waitForLoadState('domcontentloaded');
const ui = (fn, arg) => overlay.evaluate(fn, arg);
const waitUI = (fn, arg = null, timeout = 5000) => overlay.waitForFunction(fn, arg, { timeout, polling: 50 });
await sleep(500);
// Synthetic Playwright CDP events do not move the X11 root cursor (real X11 click-through is
// verified by test/e2e/run.mjs via xdotool). Keep the overlay receptive to CDP pointer/key input.
await main(() => {
  globalThis.__zhidian.state.forceInteractive = true;
  globalThis.__zhidian.setClickThrough(false);
});

let failed = null;
try {
  console.log('▸ 1. Compact #actpill on ambient selection, expanding into #act on hover, with attached language selector & Esc dismiss');
  await main(() => globalThis.__zhidian.onSelection({ files: [], text: 'Hello world from Zhidian desktop assistant.', app: 'Google Chrome' }));
  await waitUI(() => window.__overlay.S.act?.state === 'pill' && !document.getElementById('actpill').hidden);
  assert.equal(await ui(() => document.getElementById('act').hidden), true, 'full #act stays hidden while compact #actpill is shown');

  // Hovering #actpill expands into #act
  await main(() => {
    globalThis.__zhidian.setClickThrough(false);
    globalThis.__zhidian.overlay.focus();
  });
  await overlay.hover('#actpill');
  await ui(() => document.getElementById('actpill').dispatchEvent(new PointerEvent('pointerenter', { bubbles: true })));
  await waitUI(() => window.__overlay.S.act?.state === 'offer' && !document.getElementById('act').hidden);
  const trSelect = await ui(() => {
    const sel = document.querySelector('#actbtns select.actselect');
    return sel ? { value: sel.value, opts: [...sel.options].map((o) => o.value) } : null;
  });
  assert.ok(trSelect, 'translation button carries an attached target-language <select>');
  assert.equal(trSelect.value, 'auto');
  assert.ok(trSelect.opts.includes('ja') && trSelect.opts.includes('en') && trSelect.opts.includes('zh'));

  // Idle Esc dismisses #act cleanly
  await overlay.keyboard.press('Escape');
  await waitUI(() => window.__overlay.S.act === null && document.getElementById('act').hidden, null, 4000);

  console.log('▸ 2. Foreground ignoredApps suppresses ambient selection popups');
  await main(() => globalThis.__zhidian.settings.update({ actions: { ignoredApps: 'Code, Terminal' } }));
  await main(() => globalThis.__zhidian.onSelection({ files: [], text: 'const x = 42; // selected in IDE', app: 'Visual Studio Code' }));
  await sleep(250);
  assert.equal(await ui(() => window.__overlay.S.act), null, 'ignored foreground app never triggers #actpill or #act');

  console.log('▸ 3. Inline #actparam for pdf.extract runs parameterized extraction end-to-end');
  const pdfPath = path.join(work, '合同.pdf');
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([200, 400]);
  pdfDoc.addPage([300, 500]);
  pdfDoc.addPage([400, 600]);
  fs.writeFileSync(pdfPath, await pdfDoc.save());

  await main((_e, f) => globalThis.__zhidian.onSelection({ files: [f], text: '', app: 'Files' }), pdfPath);
  await waitUI(() => window.__overlay.S.act?.state === 'pill');
  await main(() => {
    globalThis.__zhidian.setClickThrough(false);
    globalThis.__zhidian.overlay.focus();
  });
  await overlay.click('#actpill');
  await waitUI(() => window.__overlay.S.act?.state === 'offer');

  // Click 提取指定页 -> opens inline #actparam input
  await overlay.locator('#actbtns button', { hasText: '提取指定页' }).click();
  await waitUI(() => !document.getElementById('actparam').hidden, null, 3000);
  await overlay.fill('#actparam input', '3, 1');
  await overlay.click('#actparam button.main');
  await waitUI(() => window.__overlay.S.act?.state === 'done', null, 10000);
  const doneMsg = await ui(() => document.getElementById('actdone').textContent);
  assert.match(doneMsg, /提取了第 3、1 页/);
  const extractedFile = fs.readdirSync(work).find((n) => n.includes('提取 2 页') && n.endsWith('.pdf'));
  assert.ok(extractedFile, 'parameterized pdf.extract wrote output PDF');
  assert.equal((await PDFDocument.load(fs.readFileSync(path.join(work, extractedFile)))).getPageCount(), 2);
  await main(() => globalThis.__zhidian.onSelection({ files: [], text: '' }));

  console.log('▸ 4. Pointing mode: left-click captures, right-click/Escape cancel, quick tools copy screenshot');
  await main(() => globalThis.__zhidian.enterPointing());
  await waitUI(() => window.__overlay.S.mode === 'pointing', null, 8000);

  // Move mouse to (320, 260) and left-click to capture the selected region as @1.
  await overlay.mouse.move(320, 260);
  await sleep(120);
  await overlay.mouse.click(320, 260, { button: 'left' });
  await waitUI(() => window.__overlay.S.phase === 'fixed' && window.__overlay.S.fresh.length === 1 && !document.getElementById('ask').classList.contains('quiet'), null, 4000);
  assert.equal(await ui(() => window.__overlay.S.refs.length), 1, 'left-click captured the current region');

  // Scope buttons inside #asktools step S.index cleanly even while hovering #ask
  const idxBefore = await ui(() => ({ idx: window.__overlay.S.index, n: window.__overlay.S.ladder?.boxes?.length ?? 0 }));
  if (idxBefore.n > 1 && idxBefore.idx < idxBefore.n - 1) {
    await overlay.click('#asktools button[data-scope="1"]');
    assert.equal(await ui(() => window.__overlay.S.index), idxBefore.idx + 1, 'clicking + inside #asktools stepped scope up');
    await overlay.click('#asktools button[data-scope="-1"]');
    assert.equal(await ui(() => window.__overlay.S.index), idxBefore.idx, 'clicking 范围 − inside #asktools stepped scope back');
  }

  // Quick toolbar: 复制截图 copies non-empty PNG image onto clipboard and leaves pointing mode
  await overlay.click('#asktools button[data-qact="copy"]');
  await waitUI(() => window.__overlay.S.mode === 'idle', null, 5000);
  const copiedBytes = await main(async () => (await globalThis.__zhidian.readClipboardImage())?.buffer?.length ?? 0);
  assert.ok(copiedBytes > 100, `clipboard holds captured PNG image (${copiedBytes} bytes)`);

  // Re-enter pointing mode: right-click cancels without creating another capture.
  await main(() => globalThis.__zhidian.enterPointing());
  await waitUI(() => window.__overlay.S.mode === 'pointing', null, 8000);
  await overlay.mouse.move(400, 300);
  await sleep(150);
  const capturesBeforeCancel = await ui(() => window.__overlay.S.refs.length);
  await overlay.mouse.click(400, 300, { button: 'right' });
  await waitUI(() => window.__overlay.S.mode === 'idle', null, 4000);
  assert.equal(await ui(() => window.__overlay.S.refs.length), capturesBeforeCancel, 'right-click only cancels the screenshot session');
  await main(() => globalThis.__zhidian.enterPointing());
  await waitUI(() => window.__overlay.S.mode === 'pointing', null, 8000);
  await overlay.keyboard.press('Escape');
  await waitUI(() => window.__overlay.S.mode === 'idle', null, 4000);

  console.log('▸ 5. Answer bubble: autoCopy clipboard + badge, safe Markdown rendering, collapsible #bhistory, and panel dragging');
  await main(() => globalThis.__zhidian.enterPointing());
  await waitUI(() => window.__overlay.S.mode === 'pointing', null, 8000);
  const h1 = await main(() => globalThis.__zhidian.pin({ box: { x: 200, y: 150, w: 300, h: 180 }, kind: 'region' }));
  await main((_e, h) => void globalThis.__zhidian.ask({ question: '请翻译这段文字', handles: [h], autoCopy: true }), h1);
  await waitUI(() => window.__overlay.S.answer?.done === true, null, 15000);
  await sleep(300);
  const bState = await ui(() => ({
    md: document.getElementById('btext').classList.contains('md'),
    foot: document.getElementById('bfoot').textContent,
    text: window.__overlay.S.answer.text,
  }));
  assert.equal(bState.md, true);
  assert.match(bState.foot, /已自动复制结果/);
  assert.equal(await main(() => globalThis.__zhidian.clipboard.readText()), bState.text.trim(), 'autoCopy placed clean answer text on clipboard');

  // Dragging #bubble header moves #bubble and sets dataset.moved = '1'
  const beforeBox = await overlay.locator('#bubble').boundingBox();
  const hdrBox = await overlay.locator('#bubble header').boundingBox();
  await overlay.mouse.move(hdrBox.x + 40, hdrBox.y + 8);
  await overlay.mouse.down();
  await overlay.mouse.move(hdrBox.x + 120, hdrBox.y + 58, { steps: 5 });
  await overlay.mouse.up();
  const afterBox = await overlay.locator('#bubble').boundingBox();
  assert.equal(await ui(() => document.getElementById('bubble').dataset.moved), '1');
  assert.ok(Math.abs(afterBox.x - beforeBox.x - 80) <= 15, `bubble moved horizontally: ${beforeBox.x} -> ${afterBox.x}`);

  // Follow-up preserves previous turn in collapsible #bhistory
  await main(() => void globalThis.__zhidian.ask({ question: '再详细一点', handles: [] }));
  await waitUI(() => window.__overlay.S.answer?.id === 2 && window.__overlay.S.answer.done, null, 15000);
  assert.equal(await ui(() => document.querySelectorAll('#bhistory details.bturn').length), 1);
  await main(() => globalThis.__zhidian.exitPointing());

  console.log('▸ 6. Settings window: interactive hotkey recorder, new preferences, and clipboard action trigger');
  const [settingsPage] = await Promise.all([app.waitForEvent('window'), ui(() => window.zhidian.openSettings('general'))]);
  await settingsPage.waitForLoadState('domcontentloaded');
  await sleep(300);

  // Interactive hotkey recorder on #hk1: focus and press Ctrl+Shift+Y -> Control+Shift+Y
  await settingsPage.click('#hk1');
  await settingsPage.keyboard.down('Control');
  await settingsPage.keyboard.down('Shift');
  await settingsPage.keyboard.press('KeyY');
  await settingsPage.keyboard.up('Shift');
  await settingsPage.keyboard.up('Control');
  await sleep(250);
  assert.equal(await settingsPage.inputValue('#hk1'), 'Control+Shift+Y');
  assert.equal(await main(() => globalThis.__zhidian.state.hotkeyDetail['Control+Shift+Y']), 'ok');

  // Quick-add ignored app chip (+ 编辑器) updates #ignoredapps
  await settingsPage.click('button[data-ignore*="Code"]');
  await sleep(200);
  assert.match(await settingsPage.inputValue('#ignoredapps'), /Code/);

  // Toggle naturalWheel and translateTo -> persisted in main settings
  await settingsPage.check('#naturalwheel');
  await settingsPage.selectOption('#translateto', 'ja');
  await sleep(200);
  const savedCfg = await main(() => globalThis.__zhidian.settings.load());
  assert.equal(savedCfg.naturalWheel, true);
  assert.equal(savedCfg.actions.translateTo, 'ja');

  // Triggering actClipboard from settings opens direct #act offer on overlay
  await main(async () => {
    globalThis.__zhidian.clipboard.clear();
    await globalThis.__zhidian.clipboard.writeText('会议纪要:今天讨论了Q4的目标,同比增长42%.');
  });
  await settingsPage.click('#actclip');
  await waitUI(() => window.__overlay.S.act?.state === 'offer' && !document.getElementById('act').hidden, null, 5000);
  assert.match(await ui(() => document.getElementById('actwhat').textContent), /选中的文字/);

  console.log('\n✔ ux-upgrade end-to-end checks passed');
} catch (err) {
  failed = err;
  console.error('\n✘ ' + (err.stack ?? err));
} finally {
  await app.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
