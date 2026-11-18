// Native desktop clicks, not CDP synthetic pointer events: proves idle panels accept real
// clicks while the rest of the overlay remains click-through. Windows uses user32; Linux
// uses XTest through Python's stdlib ctypes. No forceInteractive override is used.
//   DISPLAY=:99 node test/e2e/idle-actions-native.mjs
//   node test/e2e/idle-actions-native.mjs  (Windows interactive desktop)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

if (!['linux', 'win32'].includes(process.platform)) {
  console.log('Native action-panel check requires Windows or Linux/X11.');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
// A bare Xvfb server cannot activate windows; CI supplies Openbox. An existing manager
// is left alone (a second Openbox exits). Local desktops can use their current manager.
const windowManager = process.platform === 'linux' ? spawn('openbox', ['--sm-disable'], { stdio: 'ignore' }) : null;
windowManager?.on('error', () => {});
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-native-actions-'));
const userData = path.join(dir, 'user-data');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ seenIntro: true, mcp: { enabled: false }, actions: { ambient: true, compact: true } }));
const source = path.join(dir, 'native-selection.pdf');
const pdf = await PDFDocument.create();
pdf.addPage([200, 300]); pdf.addPage([300, 400]); pdf.addPage([400, 500]);
fs.writeFileSync(source, await pdf.save());
const app = await electron.launch({
  executablePath: require('electron'), args: ['--no-sandbox', repo, '--rehearse'],
  env: { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData, ZHIDIAN_LOCAL_DIR: path.join(dir, 'local') },
});
const overlay = await app.firstWindow();
await overlay.waitForLoadState('domcontentloaded');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pointer(dip, click = false) {
  const point = await app.evaluate(({ screen }, p) => process.platform === 'win32' ? screen.dipToScreenPoint(p) : p, dip);
  const x = Math.round(point.x), y = Math.round(point.y);
  if (process.platform === 'win32') {
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Pointer { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra); }'; [Pointer]::SetProcessDPIAware() | Out-Null; [Pointer]::SetCursorPos(${x},${y}) | Out-Null; Start-Sleep -Milliseconds 100; ${click ? '[Pointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [Pointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero)' : ''}`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
  } else {
    execFileSync('python3', ['-c', `import ctypes,time
x11=ctypes.CDLL('libX11.so.6'); xt=ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype=ctypes.c_void_p
d=x11.XOpenDisplay(None)
if not d: raise RuntimeError('No X11 display')
x11.XFlush.argtypes=[ctypes.c_void_p]; x11.XCloseDisplay.argtypes=[ctypes.c_void_p]
xt.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong]
xt.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
xt.XTestFakeMotionEvent(d,-1,${x},${y},0); x11.XFlush(d); time.sleep(.1)
${click ? 'xt.XTestFakeButtonEvent(d,1,1,0); x11.XFlush(d); time.sleep(.04); xt.XTestFakeButtonEvent(d,1,0,0); x11.XFlush(d)' : ''}
x11.XCloseDisplay(d)`], { timeout: 10000 });
  }
}
async function at(selector, click = false) {
  const rect = await overlay.locator(selector).boundingBox();
  assert.ok(rect, `${selector} is visible`);
  const origin = await app.evaluate(() => globalThis.__zhidian.overlay.getContentBounds());
  const zoom = await app.evaluate(() => globalThis.__zhidian.overlay.webContents.getZoomFactor());
  await pointer({ x: origin.x + (rect.x + rect.width / 2) * zoom, y: origin.y + (rect.y + rect.height / 2) * zoom }, click);
}
try {
  console.log('Native idle panel: present a selected PDF over another window');
  // An actual second window beneath the transparent overlay detects accidental click-through.
  await app.evaluate(async ({ BrowserWindow, screen }) => {
    const d = screen.getPrimaryDisplay().bounds;
    const stage = globalThis.__nativeActionStage = new BrowserWindow({ ...d, frame: false, show: true, webPreferences: { sandbox: true } });
    await stage.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#eef2f7"><button id="under" style="position:absolute;left:40px;top:40px;width:140px;height:70px">Background</button><script>window.clicks=0;document.onclick=()=>window.clicks++</script></body>'));
    stage.focus();
  });
  await pointer({ x: 400, y: 300 });
  await app.evaluate((_e, file) => globalThis.__zhidian.onSelection({ files: [file], text: '', app: 'explorer' }), source);
  await overlay.waitForFunction(() => window.__overlay.S.act?.state === 'pill');
  await at('#actpill');
  await overlay.waitForFunction(() => window.__overlay.S.act?.state === 'offer');
  assert.equal(await app.evaluate(() => globalThis.__zhidian.state.forceInteractive ?? false), false);
  if (!await overlay.locator('[data-act="pdf.extract"]').isVisible()) await at('[data-actmore]', true);
  await at('[data-act="pdf.extract"]');
  console.log('Native idle panel: move to and click the extraction action');
  assert.equal(await app.evaluate(() => globalThis.__zhidian.state.clickThrough), false, 'hovered action is receptive before click');
  assert.equal(await app.evaluate(() => globalThis.__zhidian.overlay.isFocusable()), true, 'native Windows activation is permitted');
  await at('[data-act="pdf.extract"]', true);
  await sleep(150);
  console.log('After native click:', await app.evaluate(() => ({ focused: globalThis.__zhidian.overlay.isFocused(), clickThrough: globalThis.__zhidian.state.clickThrough })), await overlay.evaluate(() => ({ act: window.__overlay.S.act?.state, paramHidden: document.getElementById('actparam').hidden })));
  await overlay.waitForSelector('#actparam input', { state: 'visible' });
  console.log('Native idle panel: enter a page number and preserve selection during activation');
  await at('#actparam input', true);
  assert.equal(await app.evaluate(() => globalThis.__zhidian.overlay.isFocused()), true, 'real click gives the panel keyboard focus');
  await app.evaluate(() => globalThis.__zhidian.onSelection({ files: [], text: '', app: '' }));
  assert.equal(await overlay.locator('#actparam input').isVisible(), true, 'foreground-change deselection does not dismiss the active input');
  await overlay.keyboard.press('ControlOrMeta+a');
  await overlay.keyboard.type('2');
  await at('#actparam button.main', true);
  await overlay.waitForFunction(() => window.__overlay.S.act?.state === 'done', null, { timeout: 20000 });
  const result = await app.evaluate(() => globalThis.__zhidian.state.act.result);
  const made = await PDFDocument.load(fs.readFileSync(result.path));
  assert.equal(made.getPageCount(), 1);
  assert.equal(made.getPage(0).getWidth(), 300, 'the parameter was received and selected page 2');
  const before = await app.evaluate(() => globalThis.__nativeActionStage.webContents.executeJavaScript('window.clicks'));
  const stageBounds = await app.evaluate(() => globalThis.__nativeActionStage.getContentBounds());
  await pointer({ x: stageBounds.x + 90, y: stageBounds.y + 70 });
  await sleep(100);
  assert.equal(await app.evaluate(() => globalThis.__zhidian.state.clickThrough), true, 'outside panels returns to click-through');
  await pointer({ x: stageBounds.x + 90, y: stageBounds.y + 70 }, true);
  await sleep(100);
  assert.equal(await app.evaluate(() => globalThis.__nativeActionStage.webContents.executeJavaScript('window.clicks')), before + 1, 'outside click reaches the underlying application');
  console.log('PASS: native file-panel clicks, parameter input, focus-change selection retention and outside click-through');
} catch (err) {
  console.error('Native idle panel diagnostic:', await app.evaluate(({ screen }) => ({ cursor: screen.getCursorScreenPoint(), clickThrough: globalThis.__zhidian.state.clickThrough, focused: globalThis.__zhidian.overlay.isFocused(), focusable: globalThis.__zhidian.overlay.isFocusable(), rects: globalThis.__zhidian.state.rects, act: globalThis.__zhidian.state.act?.status })));
  console.error('Renderer diagnostic:', await overlay.evaluate(() => ({ act: window.__overlay.S.act?.state, paramHidden: document.getElementById('actparam').hidden, active: document.activeElement?.outerHTML?.slice(0, 300) })));
  await overlay.screenshot({ path: path.join(dir, 'failure.png') });
  console.error('Failure screenshot:', path.join(dir, 'failure.png'));
  throw err;
} finally {
  await app.evaluate(() => globalThis.__nativeActionStage?.destroy()).catch(() => {});
  await app.close();
  windowManager?.kill();
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
}
