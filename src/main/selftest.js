// `electron . --selftest [--real]`: checks that can run unattended on any OS, used by CI.
//
// Without --real it covers what needs no model: the overlay window, a hotkey, the snapping
// pipeline on a rendered page, the local MCP server. With --real it also starts the installed
// local model (run `npm run setup` first) and asks it questions about a known page, reporting
// what it answered, where it pointed, how long it took and how much memory the server used.
// The page is captured from its own window, so this needs no screen-recording permission.
import { BrowserWindow, app, globalShortcut, screen } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from './mcp.js';
import { ReferentStore } from './referents.js';
import { cropImage, dipBitmap, thumbDataUrl } from './capture.js';
import { snapLadder } from '../core/snap.js';
import { expandBox, imageToDisplay } from '../core/geometry.js';
import { signature } from '../core/signature.js';
import { TagStream } from '../core/tags.js';
import { whichIsCheaper } from '../core/judge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = process.argv.includes('--real');

function rssMb(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).toString();
      const kb = Number((out.split('","').at(-1) ?? '').replace(/[^\d]/g, ''));
      return kb ? Math.round(kb / 1024) : null;
    }
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024);
  } catch {
    return null;
  }
}

export async function runSelftest(ctx) {
  const results = [];
  const check = async (name, fn, { required = true } = {}) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
    } catch (err) {
      results.push({ name, ok: false, required, ms: Date.now() - t0, detail: String(err?.message ?? err).slice(0, 400) });
    }
  };

  await check('overlay window exists and starts hidden', () => {
    if (!ctx.overlay || ctx.overlay.isDestroyed()) throw new Error('no overlay');
    if (ctx.overlay.isVisible()) throw new Error('overlay should be hidden while idle and empty');
    return JSON.stringify(ctx.overlay.getBounds());
  });

  await check('a global hotkey can be registered', () => {
    const ok = globalShortcut.register('Control+Alt+Shift+F11', () => {});
    globalShortcut.unregister('Control+Alt+Shift+F11');
    if (!ok) throw new Error('registration refused');
  }, { required: false });

  await check('cursor position is readable', () => JSON.stringify(screen.getCursorScreenPoint()));

  // The real thing, end to end, on whatever desktop this machine has: capture the screen, bring
  // the overlay up over it, pin a region, and give the screen back. Not required to pass,
  // because a build machine may have no capturable screen (or, on macOS, no permission); what
  // happened is in the report either way.
  await check('pointing mode: capture, overlay shown over the whole display, pin, leave', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const entered = await ctx.enterPointing();
    if (!entered.ok) throw new Error(`could not enter pointing mode: ${entered.reason}`);
    try {
      let mode = '';
      for (let i = 0; i < 100 && mode !== 'pointing'; i++) {
        await wait(100);
        mode = await ctx.overlay.webContents.executeJavaScript('window.__overlay?.S.mode').catch(() => '');
      }
      if (mode !== 'pointing') throw new Error('the overlay page never switched to pointing mode');
      const win = ctx.overlay.getBounds();
      const display = ctx.state.display.bounds;
      const handle = ctx.pin({ box: { x: 80, y: 80, w: 320, h: 200 }, kind: 'region' });
      const ref = handle && ctx.store.get(handle);
      if (!ref) throw new Error('pinning a region returned nothing');
      // Same origin, and the same size give or take the one pixel Chromium takes off a
      // screen-sized window on X11 (the frame is drawn at the display's size regardless).
      const covers = win.x === display.x && win.y === display.y && Math.abs(win.width - display.width) <= 1 && Math.abs(win.height - display.height) <= 1;
      const detail = { enter_ms: entered.enterMs, capture_ms: ctx.state.shot?.ms, capture_px: ctx.state.shot?.px, scale: ctx.state.shot?.scale, display, overlay: win, overlay_covers_display: covers, visible: ctx.overlay.isVisible(), focused: ctx.overlay.isFocused(), pinned: `${handle} ${ref.imageSize.w}x${ref.imageSize.h} ${ref.image.bytes} bytes` };
      if (!covers) throw new Error('the overlay does not cover the display exactly: ' + JSON.stringify(detail));
      return JSON.stringify(detail);
    } finally {
      ctx.exitPointing();
      ctx.store.clear();
      await wait(300);
      if (ctx.state.mode !== 'idle') throw new Error('still in pointing mode after leaving');
    }
  }, { required: false });

  // A known page in its own window: capturePage needs no OS permission.
  const stage = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { offscreen: false } });
  // (A packaged app does not carry the test folder: the page is then given from outside.)
  await stage.loadFile(process.env.ZHIDIAN_SELFTEST_PAGE || path.join(here, '../../test/e2e/stage.html'));
  await new Promise((r) => setTimeout(r, 600));
  const rects = await stage.webContents.executeJavaScript(`Object.fromEntries([...document.querySelectorAll('[data-target]')].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.target, { x: r.x, y: r.y, w: r.width, h: r.height }]; }))`);
  // Capturing right after a window appears can fail on a software-rendered display
  // ("UnknownVizError" on a CI machine): try a few times before giving up.
  let image = null;
  for (let i = 0; i < 6 && !image; i++) {
    try {
      image = await stage.webContents.capturePage();
      if (image.isEmpty()) image = null;
    } catch (err) {
      if (i === 5) throw err;
    }
    if (!image) await new Promise((r) => setTimeout(r, 700));
  }
  if (!image) throw new Error('could not capture the test page');
  const px = image.getSize();
  const view = stage.getContentBounds();
  const shot = { image, px: { w: px.width, h: px.height }, dip: { w: view.width, h: view.height }, scale: px.width / view.width, displayId: 0, ms: 0 };
  const bitmap = dipBitmap(shot);

  await check('snapping finds the button, the table cell and the card on a rendered page', () => {
    const near = (a, b, tol) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol * 2 && Math.abs(a.h - b.h) <= tol * 2;
    const want = [['retry', rects.retry], ['q2', rects.q2], ['cardA', rects.cardA]];
    const probes = { retry: [rects.retry.x + rects.retry.w / 2, rects.retry.y + rects.retry.h / 2], q2: [rects.q2.x + 30, rects.q2.y + rects.q2.h / 2], cardA: [rects.nameA.x + 40, rects.nameA.y + rects.nameA.h / 2] };
    const missing = want.filter(([name, r]) => !snapLadder(bitmap, ...probes[name]).boxes.some((b) => near(b, r, 4))).map(([n]) => n);
    if (missing.length) throw new Error(`no box for: ${missing.join(', ')} (capture ${px.width}x${px.height}, scale ${shot.scale})`);
    return `capture ${px.width}x${px.height}, scale ${shot.scale.toFixed(2)}`;
  });

  const store = new ReferentStore();
  const pinBox = (box) => {
    const cropBox = expandBox(box, 10, shot.dip.w, shot.dip.h);
    const img = cropImage(shot, cropBox, { maxEdge: 1024 });
    return store.add({ displayId: 0, box, cropBox, kind: 'snap', image: img, imageSize: { w: img.w, h: img.h }, thumb: thumbDataUrl(img.buffer), signature: signature(bitmap, cropBox), screenFraction: 0 });
  };

  await check('MCP server: token required, tools listed, a referent comes back as an image', async () => {
    const ref = pinBox(rects.dialog);
    const service = { list: () => store.view(), deref: async (h) => ({ handle: ref.handle, label: '', state: 'live', image: ref.image }), point: async () => ({ ok: true, message: 'ok' }) };
    const server = await startMcpServer({ port: 0, token: 'selftest', service, version: app.getVersion() });
    try {
      const denied = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST', body: '{}' });
      if (denied.status !== 401) throw new Error(`expected 401 without a token, got ${denied.status}`);
      const client = new Client({ name: 'selftest', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer selftest' } } }));
      const tools = (await client.listTools()).tools.map((t) => t.name).sort().join(',');
      const got = await client.callTool({ name: 'get_referent', arguments: { handle: '@1' } });
      await client.close();
      if (tools !== 'get_referent,list_referents,point_at') throw new Error(`tools: ${tools}`);
      if (got.content[1]?.type !== 'image') throw new Error('no image in the result');
      return tools;
    } finally {
      await server.close();
    }
  });

  if (REAL) {
    const { runtime, localBrain } = ctx;
    let serverPid = 0;
    await check('local model is installed', () => {
      if (!runtime.ready()) throw new Error('run `npm run setup` first');
      const s = runtime.status();
      return `${s.activeModel}, runtime ${s.runtimeTag} (${s.accel}), adapter ${s.adapter ? 'present' : 'absent'}`;
    });

    const cases = [
      { name: 'dialog', boxes: [rects.dialog], question: '这个提示是什么意思？接下来该点哪个按钮？', expect: /重试|空间|保存/, target: 'retry' },
      // Right only if it says the second one (山岚, ¥3,899) is the cheaper, not merely mentions it.
      { name: 'prices', boxes: [rects.cardA, rects.cardB], question: '哪个更便宜？', expect: { test: (t, refs) => whichIsCheaper(t, new RegExp(`星河|4,?299|${refs[0].handle}(?!\\d)`), new RegExp(`山岚|3,?899|${refs[1].handle}(?!\\d)`)) === 'B' }, target: 'priceB', targetRef: 1 },
      { name: 'table', boxes: [rects.table], question: '哪个季度的销售额最高？', expect: /第二|1,?902/, target: 'q2' },
      { name: 'code', boxes: [rects.code], question: '哪一行有问题？', expect: /括号|\)|第\s*4|四/, target: 'errline' },
      { name: 'cancel', boxes: [rects.dialog], question: '我不想重试了，应该点哪里？', expect: /取消/, target: 'cancel' },
      { name: 'price', boxes: [rects.cardA], question: '这台电脑多少钱？', expect: /4,?299/, target: 'priceA' },
      { name: 'cell', boxes: [rects.table], question: '第二季度的销售额是多少？', expect: /1,?902/, target: 'q2' },
      { name: 'name', boxes: [rects.cardB], question: '这款电脑叫什么名字？', expect: /山岚/, target: 'nameB' },
    ];
    // The same questions can be asked under several configurations in one run, to compare them
    // on the same machine: ZHIDIAN_SELFTEST_VARIANTS=default,min512,precise
    //   default    the app as shipped (with the pointer adapter if it is present)
    //   noadapter  the stock model, even if the adapter is present
    //   fast       stock model, locate as a follow-up in the same conversation
    //   preciseN   stock model, locate with an enlarged copy of N thousand pixels (precise: the model's default)
    //   minN       the server upscales small screenshots to at least N image tokens
    const variants = (process.env.ZHIDIAN_SELFTEST_VARIANTS || 'default').split(',').map((v) => v.trim()).filter(Boolean);
    const cfg0 = ctx.settings.load().local;
    const base = { locate: cfg0.locate, groundPixels: cfg0.groundPixels, adapter: cfg0.adapter, extraArgs: cfg0.extraArgs ?? [] };
    const summaries = [];
    for (const variant of variants) {
      const tag = variants.length > 1 ? ` [${variant}]` : '';
      const min = /^min(\d+)$/.exec(variant)?.[1];
      const precise = /^precise(\d*)$/.exec(variant);
      ctx.settings.update({
        local: {
          ...base,
          adapter: variant === 'default' ? base.adapter : 'off',
          locate: variant === 'fast' || min ? 'fast' : precise ? 'precise' : base.locate,
          groundPixels: precise?.[1] ? Number(precise[1]) * 1000 : base.groundPixels,
          extraArgs: min ? [...base.extraArgs, '--image-min-tokens', min] : base.extraArgs,
        },
      });
      runtime.stop();
      let started = false;
      await check(`llama-server starts and reports ready${tag}`, async () => {
        await runtime.ensureStarted();
        started = true;
        serverPid = runtime.child?.pid ?? 0;
        return `loaded in ${(runtime.server.startedMs / 1000).toFixed(1)} s, idle memory ${rssMb(serverPid)} MB`;
      });
      if (!started) continue;
      const report = [];
      for (const c of cases) {
        await check(`real model${tag}: ${c.name}`, async () => {
          localBrain.resetThread();
          const refs = c.boxes.map(pinBox);
          const tags = new TagStream();
          let text = '', first = null;
          const marks = [];
          const t0 = Date.now();
          const eat = (segs) => {
            for (const s of segs) {
              if (s.type === 'text') text += s.text;
              else if (s.tag.type !== 'name') marks.push(s.tag);
            }
          };
          const res = await localBrain.ask({ question: c.question, refs, resolve: (h) => store.get(h), onText: (d) => { first ??= Date.now() - t0; eat(tags.push(d)); } });
          eat(tags.flush());
          const total = Date.now() - t0;
          // Did the point land inside the element the question is about?
          const wantRef = refs[c.targetRef ?? 0];
          const r = rects[c.target];
          const points = marks.map((m) => {
            const ref = refs.find((x) => x.handle === m.ref);
            const p = ref && imageToDisplay(ref, m.x + (m.w ?? 0) / 2, m.y + (m.h ?? 0) / 2);
            return p ? { ref: m.ref, x: Math.round(p.x), y: Math.round(p.y), right_ref: ref === wantRef } : { ref: m.ref };
          });
          const hit = points.some((p) => p.right_ref && p.x >= r.x - 6 && p.x <= r.x + r.w + 6 && p.y >= r.y - 6 && p.y <= r.y + r.h + 6);
          const row = { case: c.name, answer_matches: c.expect.test(text, refs), pointed: marks.length > 0, point_hit: hit, points, target: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, passes: res.passes, first_ms: first, answer_ms: res.answerMs, locate_ms: res.locateMs, total_ms: total, answer: text.trim().slice(0, 160) };
          report.push(row);
          if (!text.trim()) throw new Error('empty answer');
          return JSON.stringify(row);
        });
      }
      const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1] ?? null;
      const summary = { variant, server_memory_mb_after: serverPid ? rssMb(serverPid) : null, cases: report.length, answers_matching: report.filter((r) => r.answer_matches).length, points_hit: report.filter((r) => r.point_hit).length, median_first_ms: median(report.map((r) => r.first_ms ?? 0)), median_answer_ms: median(report.map((r) => r.answer_ms)), median_locate_ms: median(report.map((r) => r.locate_ms)), median_total_ms: median(report.map((r) => r.total_ms)) };
      summaries.push(summary);
      results.push({ name: `real model${tag}: summary`, ok: true, ms: 0, detail: JSON.stringify(summary) });
    }
    if (summaries.length > 1) results.push({ name: 'real model: comparison', ok: true, ms: 0, detail: JSON.stringify(summaries) });
    ctx.settings.update({ local: base });
    runtime.stop();
  }

  stage.destroy();
  const failed = results.filter((r) => !r.ok && r.required !== false);
  const summary = { platform: process.platform, arch: process.arch, electron: process.versions.electron, real: REAL, passed: results.filter((r) => r.ok).length, failed: failed.length, results };
  console.log('SELFTEST ' + JSON.stringify(summary, null, 1));
  if (process.env.ZHIDIAN_SELFTEST_OUT) fs.writeFileSync(process.env.ZHIDIAN_SELFTEST_OUT, JSON.stringify(summary, null, 1));
  return failed.length ? 1 : 0;
}
