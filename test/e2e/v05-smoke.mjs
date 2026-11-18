// Packaged v0.5 UI/IPC smoke test. No GPU inference, replacement handlers, or fake success data.
// node test/e2e/v05-smoke.mjs
// Optional: ZHIDIAN_EXE=/absolute/path/to/Zhidian.exe ZHIDIAN_EXPECT_BUNDLED=1
// On a developer desktop with a running copy, ZHIDIAN_SMOKE_HOTKEY can avoid a real conflict.
// ZHIDIAN_NATIVE_FIXTURE enables the positive Explorer test with the three file-regions fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const productPath = base => process.platform === 'darwin'
  ? path.join(base, 'Zhidian.app', 'Contents', 'MacOS', 'Zhidian')
  : path.join(base, process.platform === 'win32' ? 'Zhidian.exe' : 'Zhidian');
const candidates = process.env.ZHIDIAN_EXE ? [path.resolve(process.env.ZHIDIAN_EXE)] : [
  productPath(path.join(appRoot, 'dist', `Zhidian-${process.platform}-${process.arch}`)),
  productPath(path.resolve(appRoot, '../..')),
  // Running this harness from within an unpacked .app bundle.
  ...(process.platform === 'darwin' ? [path.resolve(appRoot, '../../MacOS/Zhidian')] : []),
];
const executable = candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
assert.ok(executable, 'No packaged app found. Run npm run package or set ZHIDIAN_EXE to its executable.');
const outputRoot = path.resolve(process.env.ZHIDIAN_SMOKE_OUT || path.join(appRoot, 'test', 'e2e', 'out'));
fs.mkdirSync(outputRoot, { recursive: true });
const runDir = fs.mkdtempSync(path.join(outputRoot, 'v05-'));
const userData = path.join(runDir, 'userdata');
fs.mkdirSync(userData);
// Avoid writing the user's MCP discovery file or reacting to unrelated desktop selections.
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ mcp: { enabled: false }, actions: { ambient: false },
  ...(process.env.ZHIDIAN_SMOKE_HOTKEY ? { hotkeys: { point: process.env.ZHIDIAN_SMOKE_HOTKEY, pointAlt: '' } } : {}),
}));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], pending = new Map();
let child, socket, sequence = 0, stderr = '', outcome = 'failed';
async function waitFor(fn, label, timeout = 25000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`App exited (${child.exitCode}) while waiting for ${label}: ${stderr.slice(-1500)}`);
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function evaluate(expression) {
  const id = ++sequence;
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector request timed out')); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const result = await reply;
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const windowExpression = settings => settings
  ? "__testElectron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('settings.html'))"
  : '__zhidian.overlay';
const renderer = (expression, settings = false) => evaluate(`(async () => {
  const win = ${windowExpression(settings)};
  return win.webContents.executeJavaScript(${JSON.stringify(expression)});
})()`);
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function capture(filename, settings = false, selector = '') {
  await evaluate(`(async () => {
    const win = ${windowExpression(settings)};
    const rect = ${selector ? `await win.webContents.executeJavaScript(${JSON.stringify(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)};})()`)})` : 'undefined'};
    let captureError;
    for (let attempt=0;attempt<8;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,300));
      try {
        const image=await win.webContents.capturePage(rect);
        if (!image.isEmpty()) { process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(path.join(runDir, filename))},image.toPNG()); return; }
      } catch (error) { captureError=error; }
    }
    throw captureError || new Error('Screenshot remained empty');
  })()`);
}

const testTimeout = process.env.ZHIDIAN_NATIVE_FOCUS_GATE ? 600000 : 120000;
const deadline = setTimeout(() => { console.error('Smoke test exceeded its time limit'); child?.kill(); process.exit(2); }, testTimeout);
try {
  const env = { ...process.env, ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ZHIDIAN_LOCAL_DIR;
  delete env.ZHIDIAN_BRAIN;
  child = spawn(executable, ['--inspect=127.0.0.1:0', '--rehearse'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.once('error', error => { stderr += String(error); });
  child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-20000); });
  child.stdout.resume();
  const url = await waitFor(() => stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0], 'main-process inspector');
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const callback = pending.get(message.id); pending.delete(message.id);
    if (message.error) callback?.reject(new Error(message.error.message)); else callback?.resolve(message.result);
  });
  socket.addEventListener('close', () => { for (const request of pending.values()) request.reject(new Error('Inspector disconnected')); pending.clear(); });
  await waitFor(() => evaluate('Boolean(globalThis.__zhidian)'), 'application initialization', 60000);
  await evaluate("globalThis.__testElectron=process.getBuiltinModule('module').createRequire(process.execPath)('electron'); true");
  await waitFor(() => renderer("Boolean(window.zhidian && document.getElementById('ask'))"), 'overlay preload');

  await check('normal startup registers a hotkey and does not open settings', async () => {
    const view = await evaluate("({keys:__zhidian.state.hotkeys,settings:__testElectron.BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('settings.html'))})");
    assert.ok(Object.values(view.keys).some(Boolean), `No hotkey registered: ${JSON.stringify(view.keys)}`);
    assert.equal(view.settings, false);
  });
  await check('local mode is managed without cloud credentials or automatic server inference', async () => {
    const view = await evaluate("({mode:__zhidian.settings.load().local.mode,cloud:__zhidian.settings.load().cloud.enabled,key:__zhidian.settings.load().cloud.key,server:__zhidian.runtime.server.state})");
    assert.equal(view.mode, 'managed'); assert.equal(view.cloud, false); assert.equal(view.key, ''); assert.equal(view.server, 'stopped');
  });
  if (process.env.ZHIDIAN_EXPECT_BUNDLED === '1') await check('packaged small/large models and runtime are ready entirely from the bundle', async () => {
    const view = await evaluate("({ready:__zhidian.runtime.ready(),status:__zhidian.runtime.status()})");
    assert.equal(view.ready, true); assert.equal(view.status.runtimeInstalled, true); assert.equal(view.status.bundled, true);
    assert.deepEqual([...view.status.installedModels].sort(), ['qwen3.5-0.8b', 'qwen3.5-4b']);
    assert.ok(['qwen3.5-0.8b', 'qwen3.5-4b'].includes(view.status.activeModel));
  });

  await renderer("window.zhidian.openSettings('general'); true");
  await waitFor(async () => { try { return await renderer("Boolean(document.getElementById('basicstatus')?.textContent)", true); } catch { return false; } }, 'settings page');
  await check('settings shows voice/basic controls with advanced settings collapsed', async () => {
    const view = await renderer("(() => {const visible=id=>!document.getElementById(id).closest('details:not([open])')&&document.getElementById(id).getClientRects().length>0;return {advanced:document.getElementById('advancedSettings').open,voice:visible('venabled'),try:visible('try'),models:visible('modelchoice'),downloads:visible('modeldownloads'),width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};})()", true);
    assert.equal(view.advanced, false); assert.equal(view.voice, true); assert.equal(view.try, true);
    assert.equal(view.models, false); assert.equal(view.downloads, false); assert.equal(view.overflow, false); assert.ok(view.width <= 520);
  });
  await capture('settings-basic.png', true);
  await check('advanced directory controls fit within the settings window', async () => {
    await renderer("document.getElementById('advancedSettings').open=true; document.getElementById('sec-local').scrollIntoView(); true", true);
    assert.equal(await renderer("document.getElementById('localdir').getClientRects().length>0 && document.documentElement.scrollWidth<=innerWidth", true), true);
  });
  await check('real IPC denies wrong-window requests and file crops outside pointing mode', async () => {
    assert.equal((await renderer('window.zhidian.voiceToggle(false)', true)).ok, false);
    assert.equal((await renderer('window.zhidian.resolveFiles({box:{x:0,y:0,w:100,h:100}})', true)).ok, false);
    assert.equal((await renderer('window.zhidian.resolveFiles({box:{x:0,y:0,w:100,h:100}})')).ok, false);
    assert.equal((await renderer('window.zhidian.voiceToggle(false)')).ok, true);
  });
  await evaluate(`${windowExpression(true)}.hide(); true`);
  await check('F8 command opens a compact card with advanced controls collapsed', async () => {
    assert.equal((await evaluate('__zhidian.enterPointing()')).ok, true);
    await waitFor(() => renderer("!document.getElementById('ask').hidden"), 'F8 card');
    const view = await renderer("({width:document.getElementById('ask').offsetWidth,advanced:document.getElementById('quickadvanced').open,settings:[...document.querySelectorAll('dialog[open]')].length})");
    assert.ok(view.width <= 360 && view.width > 0, JSON.stringify(view));
    assert.equal(view.advanced, false); assert.equal(view.settings, 0);
  });
  await capture('f8-card.png', false, '#ask');
  await check('file-crop IPC rejects invalid rectangles and forged native snapshots', async () => {
    assert.equal((await renderer('window.zhidian.resolveFiles({box:{x:-1,y:0,w:100,h:100}})')).ok, false);
    assert.equal((await renderer('window.zhidian.resolveFiles({box:{x:0,y:0,w:0,h:100}})')).ok, false);
    const result = await evaluate(`(async()=>{
      const saved=__zhidian.state.fileSnapshot;
      try {
        __zhidian.state.fileSnapshot={id:'untrusted',files:[],visibleFiles:[{name:'fictional.txt',path:'C:\\\\fictional.txt',status:'resolved',bounds:{x:0,y:0,w:100,h:100}}]};
        return await __zhidian.overlay.webContents.executeJavaScript('window.zhidian.resolveFiles({box:{x:0,y:0,w:100,h:100}})');
      } finally {__zhidian.state.fileSnapshot=saved;}
    })()`);
    assert.equal(result.ok, false); assert.equal(result.matched, 0); assert.ok(result.warnings.length > 0);
    assert.equal(await evaluate('__zhidian.desktopContext.view().files.length'), 0);
  });
  await check('leaving F8 mode discards the file-region snapshot', async () => {
    await evaluate('__zhidian.exitPointing(); true');
    assert.equal(await evaluate('__zhidian.state.fileSnapshot'), null);
    assert.equal((await renderer('window.zhidian.resolveFiles({box:{x:0,y:0,w:100,h:100}})')).ok, false);
  });
  if (process.env.ZHIDIAN_NATIVE_FIXTURE) await check('actual Explorer capture resolves two files through physical-to-DIP-to-IPC coordinates', async () => {
    assert.equal(process.platform, 'win32', 'The native Explorer fixture requires Windows.');
    const fixture = path.resolve(process.env.ZHIDIAN_NATIVE_FIXTURE);
    for (const name of ['报价清单.csv', '季度报告.txt', 'do-not-select.txt']) assert.ok(fs.existsSync(path.join(fixture, name)), `Missing fixture ${name}`);
    // The foreground app may hand focus to its child setup helper. An idle background app
    // cannot legitimately steal focus on Windows, so activate our own overlay first.
    if (process.env.ZHIDIAN_NATIVE_FOCUS_GATE) {
      console.log(`WAIT_FOR_NATIVE_FOCUS ${process.env.ZHIDIAN_NATIVE_FOCUS_GATE}`);
      await waitFor(() => fs.existsSync(process.env.ZHIDIAN_NATIVE_FOCUS_GATE), 'external native fixture activation', 300000);
    } else assert.equal((await evaluate('__zhidian.enterPointing()')).ok, true);
    // Test setup only: activate this exact fixture folder and place the cursor on its monitor.
    // No OS file selection is performed; the product must capture and bind its real file view.
    const focusScript = String.raw`
$shell = New-Object -ComObject Shell.Application
$window = $null
foreach ($candidate in $shell.Windows()) {
  try { if ([string]$candidate.Document.Folder.Self.Path -eq $env:ZHIDIAN_NATIVE_FIXTURE) { $window=$candidate; break } } catch {}
}
if (-not $window) { throw 'Open the native fixture folder in Explorer before running this check.' }
Add-Type -Namespace Smoke -Name Native -MemberDefinition @'
public struct Rect { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
'@
[void][Smoke.Native]::SetThreadDpiAwarenessContext([IntPtr](-4))
$hwnd=[IntPtr][long]$window.HWND
[void][Smoke.Native]::ShowWindow($hwnd,9)
[void][Smoke.Native]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 150
if ([Smoke.Native]::GetForegroundWindow() -ne $hwnd) { throw 'The fixture could not receive foreground focus.' }
$rect=New-Object Smoke.Native+Rect
[void][Smoke.Native]::GetWindowRect($hwnd,[ref]$rect)
[void][Smoke.Native]::SetCursorPos($rect.Left+100,$rect.Top+100)
`;
    await evaluate(`(()=>{
      const path=process.getBuiltinModule('path');
      const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
      process.getBuiltinModule('child_process').execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-STA','-Command',${JSON.stringify(focusScript)}],{windowsHide:true,timeout:15000,env:{...process.env,ZHIDIAN_NATIVE_FIXTURE:${JSON.stringify(fixture)}}});
      return true;
    })()`);
    await evaluate('__zhidian.exitPointing(); true');
    assert.equal((await evaluate('__zhidian.enterPointing()')).ok, true);
    const result = await evaluate(`(async()=>{
      const snapshot=__zhidian.state.fileSnapshot;
      const names=['报价清单.csv','季度报告.txt'];
      if(snapshot.fileSurface?.kind!=='explorer')throw new Error('The captured surface is not Explorer');
      const rows=names.map(name=>snapshot.visibleFiles.find(item=>item.name===name));
      if(rows.some(row=>!row))throw new Error('Fixture file icons are not visible');
      const physical={x:Math.min(...rows.map(row=>row.bounds.x)),y:Math.min(...rows.map(row=>row.bounds.y)),width:200,height:Math.max(...rows.map(row=>row.bounds.y+row.bounds.h))-Math.min(...rows.map(row=>row.bounds.y))};
      const dip=__testElectron.screen.screenToDipRect(null,physical);
      const display=__zhidian.state.display;
      const box={x:dip.x-display.bounds.x,y:dip.y-display.bounds.y,w:dip.width,h:dip.height};
      const reply=await __zhidian.overlay.webContents.executeJavaScript('window.zhidian.resolveFiles('+JSON.stringify({box})+')');
      return {reply,files:__zhidian.desktopContext.view().files.map(file=>file.name),originalPreserved:snapshot===__zhidian.state.fileSnapshot,osSelected:snapshot.files.length,scaleFactor:display.scaleFactor,physical,box};
    })()`);
    assert.equal(result.osSelected, 0, 'The test must not depend on OS multiselection');
    assert.equal(result.originalPreserved, true);
    assert.equal(result.reply.ok, true, JSON.stringify(result));
    assert.equal(result.reply.matched, 2);
    assert.deepEqual([...result.files].sort(), ['报价清单.csv', '季度报告.txt'].sort());
    assert.ok(!result.files.includes('do-not-select.txt'));
    fs.writeFileSync(path.join(runDir, 'native-region.json'), JSON.stringify(result, null, 2));
    await waitFor(() => renderer("document.getElementById('contextcard').textContent.includes('报价清单.csv')"), 'actual file cards');
    await capture('actual-explorer-files.png', false, '#ask');
    await evaluate('__zhidian.exitPointing(); true');
  });
  await check('cancelling a pending native capture cannot reopen the overlay', async () => {
    const result = await evaluate(`(async()=>{
      const capture=__zhidian.enterPointing();
      await Promise.resolve();
      __zhidian.exitPointing();
      const reply=await capture;
      return {reply,mode:__zhidian.state.mode,entering:__zhidian.state.entering,snapshot:__zhidian.state.fileSnapshot};
    })()`);
    assert.equal(result.reply.ok, false); assert.equal(result.reply.reason, 'cancelled');
    assert.equal(result.mode, 'idle'); assert.equal(result.entering, false); assert.equal(result.snapshot, null);
  });
  outcome = 'passed';
} finally {
  if (outcome !== 'passed') {
    fs.writeFileSync(path.join(runDir, 'stderr.log'), stderr);
    console.error(stderr.slice(-3000));
  }
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ outcome, platform: process.platform, packagedExecutable: executable, hotkeyOverride: process.env.ZHIDIAN_SMOKE_HOTKEY || null, expectsBundled: process.env.ZHIDIAN_EXPECT_BUNDLED === '1', nativeExplorer: Boolean(process.env.ZHIDIAN_NATIVE_FIXTURE), passed: checks.length, checks, scope: 'Packaged renderer + actual IPC; F8 command invoked through test API. Native Explorer positive path only when explicitly enabled. No GPU inference claim.' }, null, 2));
  if (socket?.readyState === WebSocket.OPEN) {
    await evaluate("__zhidian.exitPointing(); __zhidian.runtime.stop(); __zhidian.watcher.stop(); setTimeout(()=>__testElectron.app.exit(0),100); true").catch(() => {});
    socket.close();
  }
  if (child && child.exitCode === null) await waitFor(() => child.exitCode !== null, 'application exit', 10000).catch(() => child.kill());
  clearTimeout(deadline);
  console.log(`Artifacts: ${runDir}`);
}
