// Packaged screenshot click regression checks with actual renderer handlers and capture IPC.
// node test/e2e/capture-clicks.mjs
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
const runDir = fs.mkdtempSync(path.join(outputRoot, 'capture-clicks-'));
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


  const box = { x: 24, y: 24, w: 160, h: 100, kind: 'window' };
  const state = () => renderer("({mode:window.__overlay.S.mode,phase:window.__overlay.S.phase,fresh:[...window.__overlay.S.fresh],drag:window.__overlay.S.drag,askHidden:document.getElementById('ask').hidden,resolving:window.__overlay.S.resolvingFiles})");
  const batch = (events, target = 'document.body') => renderer(
    '(function(){const target=' + target + ';for(const e of ' + JSON.stringify(events) + '){const EventType=e[0].startsWith("mouse")?MouseEvent:PointerEvent;target.dispatchEvent(new EventType(e[0],{bubbles:true,cancelable:true,clientX:e[1],clientY:e[2],button:e[3],buttons:e[4],pointerId:1,pointerType:"mouse"}))}return true})()');
  const setBox = () => renderer(
    '(function(){const s=window.__overlay.S;clearTimeout(s.dwellTimer);s.phase="track";s.target=null;s.box=' + JSON.stringify(box) + ';s.overPanel=false;return true})()');
  const begin = async () => {
    await evaluate('__zhidian.exitPointing(); __zhidian.store.clear(); true');
    await waitFor(() => renderer("window.__overlay.S.mode === 'idle'"), 'previous capture closed');
    // Windows DXGI can transiently reject a frame between rapid capture/exit cycles.
    // Only retry that environmental setup failure; gesture assertions are never retried.
    let entered;
    for (let attempt=0;attempt<3;attempt++) {
      entered=await evaluate('__zhidian.enterPointing()');
      if (entered.ok || entered.reason !== 'capture') break;
      await delay(500);
    }
    assert.equal(entered.ok, true, JSON.stringify(entered));
    await waitFor(() => renderer("window.__overlay.S.mode === 'pointing' && Boolean(window.__overlay.S.bitmap)"), 'screenshot mode');
    await renderer("document.getElementById('screenmode').click();true");
    await setBox();
    await waitFor(() => evaluate('__zhidian.store.view().length === 0'), 'empty referents');
  };
  const assertExited = async () => {
    await waitFor(() => evaluate("__zhidian.state.mode === 'idle'"), 'main-process cancellation');
    const ui=await state();
    assert.equal(ui.mode, 'idle');
    assert.equal(ui.askHidden, true);
    assert.equal(ui.drag, null);
    assert.equal(await evaluate('__zhidian.state.fileSnapshot'), null);
  };
  const clickEvents = [['pointerdown',30,40,0,1],['pointerup',30,40,0,0]];
  const dragEvents = [['pointerdown',30,40,0,1],['pointermove',230,190,-1,1],['pointerup',230,190,0,0]];

  await check('left click captures the boxed screenshot through actual pin IPC', async () => {
    await begin();
    await batch(clickEvents);
    await waitFor(() => renderer("window.__overlay.S.fresh.length === 1 && window.__overlay.S.phase === 'fixed'"), 'left-click capture');
    const refs=await evaluate('__zhidian.store.view()');
    assert.equal(refs.length,1);
    assert.deepEqual(refs[0].box,{x:24,y:24,w:160,h:100});
    assert.ok(refs[0].bytes>0,'actual screenshot image bytes are retained');
    assert.equal((await state()).askHidden,false);
    await capture('left-click-captured.png',false,'#ask');
  });
  await check('clicking an already selected screenshot keeps it selected without duplicate captures', async () => {
    const before=await state();
    await setBox();
    await batch(clickEvents);
    await delay(100);
    assert.deepEqual((await state()).fresh,before.fresh);
    assert.equal(await evaluate('__zhidian.store.view().length'),1);
    assert.equal((await state()).mode,'pointing');
  });
  await check('left clicks on panel controls do not capture another screenshot', async () => {
    await batch(clickEvents,"document.getElementById('q')");
    assert.equal(await evaluate('__zhidian.store.view().length'),1);
    assert.equal((await state()).mode,'pointing');
  });
  await check('right click cancels without capturing or toggling an existing screenshot', async () => {
    const before=await evaluate('__zhidian.store.view().map(r=>r.handle)');
    await batch([['pointerdown',30,40,2,2]]);
    assert.equal((await state()).mode,'idle');
    await assertExited();
    assert.deepEqual(await evaluate('__zhidian.store.view().map(r=>r.handle)'),before);
  });
  await check('right click over the question panel also cancels screenshot mode', async () => {
    await begin();
    await batch([['pointerdown',30,40,2,2]],"document.getElementById('q')");
    await assertExited();
    assert.equal(await evaluate('__zhidian.store.view().length'),0);
  });
  await check('right click while dragging discards the drag before a later left release', async () => {
    await begin();
    await renderer("document.getElementById('ask').style.left='300px';document.getElementById('ask').style.top='300px';window.__gestureEvents=[];for(const type of ['pointerdown','pointermove','mousedown'])window.addEventListener(type,e=>window.__gestureEvents.push({type,button:e.button,buttons:e.buttons,pointerType:e.pointerType}),{capture:true});true");
    // Chromium generates the actual mouse/pointer event sequence. The cancelled initial
    // pointerdown suppresses compatibility mouse events, so the right chord is pointermove.
    await evaluate("__zhidian.overlay.focus();__zhidian.overlay.webContents.focus();__zhidian.overlay.webContents.sendInputEvent({type:'mouseDown',x:30,y:40,button:'left',clickCount:1});__zhidian.overlay.webContents.sendInputEvent({type:'mouseMove',x:230,y:190,modifiers:['leftbuttondown']});true");
    await waitFor(()=>renderer('Boolean(window.__overlay.S.drag?.active)'),'actual Chromium drag');
    await evaluate("__zhidian.overlay.webContents.sendInputEvent({type:'mouseDown',x:230,y:190,button:'right',clickCount:1,modifiers:['leftbuttondown','rightbuttondown']});true");
    await delay(100);
    fs.writeFileSync(path.join(runDir,'chromium-drag-chord.json'),JSON.stringify(await renderer('window.__gestureEvents'),null,2));
    await assertExited();
    await evaluate("__zhidian.overlay.webContents.sendInputEvent({type:'mouseUp',x:230,y:190,button:'left',modifiers:['rightbuttondown']});__zhidian.overlay.webContents.sendInputEvent({type:'mouseUp',x:230,y:190,button:'right'});true");
    await delay(150);
    const mouseEvents=await renderer('window.__gestureEvents');
    assert.ok(mouseEvents.some(e=>['mousedown','pointermove'].includes(e.type)&&e.button===2&&(e.buttons&1)),JSON.stringify(mouseEvents));
    assert.equal(await evaluate('__zhidian.store.view().length'),0);
    assert.equal(await renderer("document.getElementById('drag').style.display"),'none');
  });
  await check('left dragging still captures a selected region when no desktop files match', async () => {
    await begin();
    // Isolate region selection from whichever native desktop window is behind the app.
    // The actual IPC denies missing snapshots and the renderer falls back to a screenshot.
    await evaluate('__zhidian.state.fileSnapshot=null;true');
    await batch(dragEvents);
    await waitFor(()=>renderer("window.__overlay.S.fresh.length===1 && !window.__overlay.S.resolvingFiles"),'drag capture');
    const refs=await evaluate('__zhidian.store.view()');
    assert.equal(refs.length,1);assert.equal(refs[0].kind,'region');
    assert.deepEqual(refs[0].box,{x:30,y:40,w:200,h:150});
  });
  await check('Escape still cancels an empty screenshot session', async () => {
    await begin();
    await renderer("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));true");
    await assertExited();
    assert.equal(await evaluate('__zhidian.store.view().length'),0);
  });
  await check('a pending left-click capture cannot reopen the UI after immediate right cancellation', async () => {
    await begin();
    await batch([...clickEvents,['pointerdown',30,40,2,2]]);
    await assertExited();
    await delay(200);
    const ui=await state();assert.equal(ui.mode,'idle');assert.equal(ui.askHidden,true);assert.deepEqual(ui.fresh,[]);
  });
  await check('a pending region-resolution reply cannot pin a screenshot after right cancellation', async () => {
    await begin();
    await evaluate('__zhidian.state.fileSnapshot=null;true');
    await batch([...dragEvents,['pointerdown',230,190,2,2]]);
    await assertExited();
    await delay(200);
    const ui=await state();assert.equal(ui.mode,'idle');assert.equal(ui.askHidden,true);assert.deepEqual(ui.fresh,[]);
    assert.equal(await evaluate('__zhidian.store.view().length'),0);
  });
  outcome = 'passed';
} finally {
  if (outcome !== 'passed') {
    fs.writeFileSync(path.join(runDir, 'stderr.log'), stderr);
    console.error(stderr.slice(-3000));
  }
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ outcome, platform: process.platform, packagedExecutable: executable, passed: checks.length, checks,
    scope: 'Packaged screenshot renderer and actual capture/exit IPC, with actual frozen screen pixels and controlled selection geometry. DOM pointer events exercise real handlers; Chromium sendInputEvent verifies the two-button drag chord. A file-snapshot fixture prevents unrelated native desktop files from affecting region tests. No model inference.' }, null, 2));
  if (socket?.readyState === WebSocket.OPEN) {
    await evaluate("__zhidian.exitPointing(); __zhidian.runtime.stop(); __zhidian.watcher.stop(); setTimeout(()=>__testElectron.app.exit(0),100); true").catch(() => {});
    socket.close();
  }
  if (child && child.exitCode === null) await waitFor(() => child.exitCode !== null, 'application exit', 10000).catch(() => child.kill());
  clearTimeout(deadline);
  console.log('Artifacts: ' + runDir);
}

