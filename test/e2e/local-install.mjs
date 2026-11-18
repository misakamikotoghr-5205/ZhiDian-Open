// Advanced model downloads through the real packaged UI, IPC and downloader.
// Network fixtures exercise progress, cancellation and retry without downloading large weights.
// node test/e2e/local-install.mjs
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
const runDir = fs.mkdtempSync(path.join(outputRoot, 'model-download-'));
const userData = path.join(runDir, 'userdata');
fs.mkdirSync(userData);
// Avoid writing the user's MCP discovery file or reacting to unrelated desktop selections.
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ mcp: { enabled: false }, actions: { ambient: false }, local: { mode: 'managed', modelId: 'qwen3.5-4b' },
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

const testTimeout = 180000;
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

  const ui = expression => renderer(expression, true);
  const setSelect = (id, value) => ui(`(() => { const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  const openSettings = async (section = 'general') => {
    await renderer(`window.zhidian.openSettings(${JSON.stringify(section)});true`);
    await waitFor(() => ui("Boolean(document.getElementById('downloadmodel')?.options.length)").catch(() => false), 'settings render');
  };
  const cardState = () => ui(`(() => {
    const d=id=>document.getElementById(id), visible=id=>!d(id).closest('details:not([open])')&&d(id).getClientRects().length>0;
    return { advanced:d('advancedSettings').open, downloads:visible('modeldownloads'),
      nested:Boolean(d('modeldownloads').closest('#advancedSettings')),
      selected:d('downloadmodel').value, choices:[...d('downloadmodel').options].map(o=>o.value),
      disabled:d('install').disabled, progress:visible('progress'), cancel:visible('cancel'),
      usage:d('modelchoice').value, overflow:document.documentElement.scrollWidth>innerWidth };
  })()`);

  await openSettings();
  await check('download entry lives in advanced settings and stays out of the compact view', async () => {
    const state=await cardState();
    assert.equal(state.advanced,false); assert.equal(state.downloads,false); assert.equal(state.nested,true);
    assert.deepEqual(state.choices,['qwen3.5-0.8b','qwen3.5-4b']); assert.equal(state.overflow,false);
  });
  await check('advanced downloads remain visible when both bundled models are installed', async () => {
    await ui("document.getElementById('advancedSettings').open=true;document.documentElement.style.scrollBehavior='auto';document.getElementById('modeldownloads').scrollIntoView({behavior:'instant',block:'start'});true");
    const state=await cardState(); assert.equal(state.downloads,true); assert.equal(state.disabled,true);
    assert.equal(state.usage,'qwen3.5-4b'); assert.equal(state.overflow,false);
    await setSelect('downloadmodel','qwen3.5-0.8b');
    assert.equal((await cardState()).disabled,true);
  });
  await check('successful install IPC reuses bundled files and preserves the saved model and mode', async () => {
    await evaluate("__zhidian.runtime.fetchImpl=async()=>{throw new Error('Unexpected network access with complete bundle')};true");
    const result=await ui("window.zhidian.settings.install({modelId:'qwen3.5-0.8b',source:'huggingface'})");
    assert.equal(result.ok,true,result.error);
    assert.deepEqual(await evaluate("({id:__zhidian.settings.load().local.modelId,mode:__zhidian.settings.load().local.mode})"),{id:'qwen3.5-4b',mode:'managed'});
    assert.equal((await cardState()).downloads,true);
  });
  await check('choosing a download survives unrelated settings updates without switching the active model', async () => {
    await setSelect('downloadmodel','qwen3.5-4b');
    await ui("window.zhidian.settings.update({local:{source:'hfmirror'}})");
    const state=await cardState(); assert.equal(state.selected,'qwen3.5-4b'); assert.equal(state.usage,'qwen3.5-4b');
  });
  const localDir=path.join(runDir,'download-storage');
  await check('an unsaved download directory locks controls until the selected path is saved', async () => {
    await ui(`(()=>{const e=document.getElementById('localdir');e.value=${JSON.stringify(localDir)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const controls=await ui("['install','downloadmodel','source','modelchoice'].map(id=>document.getElementById(id).disabled)");
    assert.deepEqual(controls,[true,true,true,true]);
    await ui("document.getElementById('savedir').click();true");
    await waitFor(()=>evaluate(`__zhidian.runtime.baseDir === ${JSON.stringify(localDir)}`),'saved directory');
    await waitFor(()=>ui("!document.getElementById('downloadmodel').disabled"),'directory controls unlocked');
    assert.equal((await cardState()).selected,'qwen3.5-4b');
    assert.equal(await evaluate('__zhidian.settings.load().local.modelId'),'qwen3.5-4b');
  });

  // Simulate the lightweight distribution in the isolated test process. No real bundle files
  // or user settings are removed. All subsequent fetches use the explicit local fixture below.
  await evaluate(`(() => {
    const r=__zhidian.runtime; r.bundleDir=null; r.hardware.recommended='qwen3.5-0.8b';
    globalThis.__downloadMode='hold';globalThis.__downloadCalls=[];
    r.fetchImpl=async(url,{signal,headers})=>{
      __downloadCalls.push({url,range:headers?.Range||''});
      if(__downloadMode==='fail')throw new Error('Intentional offline fixture');
      return new Response(new ReadableStream({start(controller){
        if(signal.aborted){controller.error(new Error('Fixture cancelled'));return;}
        signal.addEventListener('abort',()=>controller.error(new Error('Fixture cancelled')),{once:true});
        controller.enqueue(new Uint8Array(128));
      }}),{status:headers?.Range?206:200});
    };
    r.emit('change');return true;
  })()`);
  await waitFor(()=>ui("!document.getElementById('install').disabled"),'missing-model install button');
  await check('lightweight package offers both model downloads inside advanced settings', async () => {
    const st=await evaluate('__zhidian.runtime.status()');
    assert.equal(st.runtimeInstalled,false); assert.deepEqual(st.installedModels,[]);
    const state=await cardState();assert.equal(state.downloads,true);assert.equal(state.disabled,false);
    assert.equal(state.selected,'qwen3.5-4b'); assert.equal(state.overflow,false);
    await ui("document.documentElement.style.scrollBehavior='auto';document.getElementById('modeldownloads').scrollIntoView({behavior:'instant',block:'start'});true");
    await capture('downloads-available.png',true);
  });
  await check('download starts the selected 4B model despite the automatic 0.8B recommendation', async () => {
    await ui("document.getElementById('install').click();true");
    await waitFor(()=>evaluate("__zhidian.runtime.installing?.progress.steps.some(s=>s.received>0)"),'download progress');
    const state=await cardState();assert.equal(state.disabled,true);assert.equal(state.progress,true);assert.equal(state.cancel,true);
    assert.equal(state.selected,'qwen3.5-4b');
    assert.equal(await evaluate('__zhidian.runtime.installing.progress.modelId'),'qwen3.5-4b');
    const calls=await evaluate('__downloadCalls');assert.equal(calls.length,1);assert.match(calls[0].url,/llama.*\.(zip|tar\.gz)$/);
    await capture('downloads-in-progress.png',true);
  });
  await check('closing and reopening settings retains background progress and cancellation controls', async () => {
    await evaluate(`${windowExpression(true)}.close();true`);
    await waitFor(()=>evaluate(`!${windowExpression(true)}`),'settings closed');
    await openSettings('local');
    await waitFor(()=>ui("!document.getElementById('cancel').hidden"),'restored download controls');
    const state=await cardState();assert.equal(state.downloads,true);assert.equal(state.progress,true);assert.equal(state.cancel,true);
    assert.equal(state.disabled,true);assert.equal(state.selected,'qwen3.5-4b');
    await ui("document.getElementById('cancel').click();true");
    await waitFor(()=>evaluate('__zhidian.runtime.installing === null'),'download cancellation');
    await waitFor(()=>ui("!document.getElementById('install').disabled && document.getElementById('cancel').hidden"),'cancel completion');
    assert.equal((await cardState()).downloads,true);
    assert.equal(await evaluate('__zhidian.settings.load().local.modelId'),'qwen3.5-4b');
  });
  await check('download failures show an actionable error and keep the entry available for retry', async () => {
    await evaluate("__downloadMode='fail';true");
    await ui("document.getElementById('install').click();true");
    await waitFor(()=>ui("!document.getElementById('lerror').hidden && document.getElementById('lerror').textContent.includes('Intentional offline fixture')"),'download error');
    await waitFor(()=>ui("!document.getElementById('install').disabled"),'retry enabled');
    assert.equal((await cardState()).downloads,true);
    assert.equal(await evaluate('__downloadCalls.length'),2);
    await evaluate("__downloadMode='hold';true");
    await ui("document.getElementById('install').click();true");
    await waitFor(()=>evaluate('__downloadCalls.length===3 && Boolean(__zhidian.runtime.installing)'),'retry started');
    assert.equal(await ui("document.getElementById('lerror').hidden"),true);
    await ui("document.getElementById('cancel').click();true");
    await waitFor(()=>evaluate('__zhidian.runtime.installing === null'),'retry cancellation');
  });
  await check('download visibility and saved selection survive another settings reopen', async () => {
    await evaluate(`${windowExpression(true)}.close();true`);
    await waitFor(()=>evaluate(`!${windowExpression(true)}`),'settings closed again');
    await openSettings('local');
    const state=await cardState();assert.equal(state.downloads,true);assert.equal(state.disabled,false);
    assert.equal(state.usage,'qwen3.5-4b');assert.equal(state.overflow,false);
  });
  outcome='passed';
} finally {
  fs.writeFileSync(path.join(runDir,'result.json'),JSON.stringify({outcome,checks,scope:'Real packaged settings UI, IPC and downloader; isolated settings; blocked/error network fixtures; no model inference or live downloads'},null,2));
  if(socket?.readyState===WebSocket.OPEN){await evaluate("__zhidian.runtime.cancelInstall();__zhidian.runtime.stop();__zhidian.watcher.stop();setTimeout(()=>__testElectron.app.exit(0),100);true").catch(()=>{});socket.close();}
  if(child && child.exitCode===null)await waitFor(()=>child.exitCode!==null,'exit',10000).catch(()=>child.kill());
  clearTimeout(deadline);console.log('Artifacts: '+runDir);
}
