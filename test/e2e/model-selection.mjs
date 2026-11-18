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
const fixture = path.resolve(process.env.ZHIDIAN_MODEL_FIXTURE || path.join(path.dirname(executable), 'resources/app/models'));
const outputRoot = path.resolve(process.env.ZHIDIAN_SMOKE_OUT || path.join(appRoot, 'test', 'e2e', 'out'));
fs.mkdirSync(outputRoot, { recursive: true });
const runDir = fs.mkdtempSync(path.join(outputRoot, 'v05-'));
const userData = path.join(runDir, 'userdata');
fs.mkdirSync(userData);
// Avoid writing the user's MCP discovery file or reacting to unrelated desktop selections.
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ mcp: { enabled: false }, actions: { ambient: false }, local: { mode: 'managed', directory: fixture, modelId: 'qwen3.5-4b' },
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector request timed out')); }, 180000);
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


  const expectedFile=path.join(fixture,'Qwen3.5-4B-Q4_K_M.gguf');
  await evaluate("__zhidian.runtime.hardware.recommended='qwen3.5-0.8b'; true");
  await check('saved4B overrides automatic0.8 and resolves the actual existing directory',async()=>{
    const status=await evaluate('__zhidian.runtime.status()');
    assert.equal(status.activeModel,'qwen3.5-4b');assert.equal(status.selectionMode,'manual');
    assert.equal(status.modelPath,expectedFile);
  });
  await renderer("window.zhidian.openSettings('local');true");
  await waitFor(()=>renderer("Boolean(document.getElementById('modelchoice'))",true).catch(()=>false),'model selector');
  await check('advanced settings expose the saved model choice and effective filename',async()=>{
    const ui=await renderer("({choice:document.getElementById('modelchoice').value,path:document.getElementById('loadedmodelpath').textContent})",true);
    assert.equal(ui.choice,'qwen3.5-4b');assert.ok(ui.path.includes(expectedFile));
  });
  await check('saving the direct weights folder preserves explicit4B',async()=>{
    const result=await renderer(`window.zhidian.settings.setLocalDir(${JSON.stringify(fixture)})`,true);
    assert.equal(result.ok,true,result.error);assert.equal(result.view.local.modelId,'qwen3.5-4b');
    assert.equal(result.view.local.status.activeModel,'qwen3.5-4b');assert.equal(result.view.local.status.modelPath,expectedFile);
  });
  await check('selecting automatic and then4B through the actual UI changes policy',async()=>{
    await renderer("document.getElementById('modelchoice').value='';document.getElementById('modelchoice').dispatchEvent(new Event('change',{bubbles:true}));true",true);
    await waitFor(()=>evaluate("__zhidian.settings.load().local.modelId === ''"),'automatic');
    assert.equal(await evaluate('__zhidian.runtime.activeModel().id'),'qwen3.5-0.8b');
    await renderer("document.getElementById('modelchoice').value='qwen3.5-4b';document.getElementById('modelchoice').dispatchEvent(new Event('change',{bubbles:true}));true",true);
    await waitFor(()=>evaluate("__zhidian.settings.load().local.modelId === 'qwen3.5-4b'"),'manual');
    assert.equal(await evaluate('__zhidian.runtime.activeModel().id'),'qwen3.5-4b');
  });
  await check('actual runtime loads4B from the selected G drive file',async()=>{
    const loaded=await evaluate(`(async()=>{await __zhidian.runtime.ensureStarted();const r=__zhidian.runtime;return {state:r.server.state,model:r.server.modelId,file:r.modelPath(r.activeModel(),'model'),tier:r.tier()};})()`);
    assert.deepEqual(loaded,{state:'ready',model:'qwen3.5-4b',file:expectedFile,tier:'large'});
    fs.writeFileSync(path.join(runDir,'loaded-model.json'),JSON.stringify(loaded,null,2));
  });
  await renderer("document.getElementById('advancedSettings').open=true;document.getElementById('sec-local').scrollIntoView();true",true);
  await capture('manual4b.png',true);
  outcome='passed';
} finally {
  fs.writeFileSync(path.join(runDir,'result.json'),JSON.stringify({outcome,checks,fixture,scope:'Real packaged settings IPC and native4B runtime; isolated settings; memory recommendation forced small to reproduce the reported conflict'},null,2));
  if(socket?.readyState===WebSocket.OPEN){await evaluate("__zhidian.runtime.stop();__zhidian.watcher.stop();setTimeout(()=>__testElectron.app.exit(0),100);true").catch(()=>{});socket.close();}
  if(child && child.exitCode===null)await waitFor(()=>child.exitCode!==null,'exit',10000).catch(()=>child.kill());
  clearTimeout(deadline);console.log('Artifacts: '+runDir);
}
