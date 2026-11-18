// Checks the real local-model client (src/main/local/brain-local.js) inside the running app,
// against a stand-in server that speaks llama-server's wire format: an OpenAI-style
// /v1/chat/completions endpoint with server-sent events. The stand-in returns canned text, so
// this verifies the protocol and the plumbing (streaming, the hidden JSON line, the separate
// "where is it" request, coordinate mapping), not what a model would say.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e/local-brain.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stand-in for llama-server
const seen = [];
const stub = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'stub-vlm' }] }));
  }
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
  const last = body.messages.at(-1);
  const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
  const images = parts.filter((p) => p.type === 'image_url');
  const allImages = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length;
  const handle = parts.find((p) => p.type === 'text' && /^@\d+/.test(p.text))?.text.match(/^@\d+/)[0] ?? '@1';
  seen.push({ stream: Boolean(body.stream), pointer: system.includes('point_2d'), images: images.length, allImages, turns: body.messages.length, lastRole: body.messages.at(-2)?.role, format: body.response_format?.type ?? null, auth: req.headers.authorization, thinking: body.chat_template_kwargs?.enable_thinking, okImage: images.every((p) => /^data:image\/(png|jpeg);base64,/.test(p.image_url.url)) });
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"point_2d": [250, 750], "label": "左下角"}' }, finish_reason: 'stop' }] }));
  }
  const question = parts.filter((p) => p.type === 'text').at(-1)?.text ?? '';
  const slow = question.includes('慢');
  const text = slow
    ? '这个回答故意说得很慢，好让测试有时间在中途把它停下来。'.repeat(4)
    : system.includes('point_2d') ? `这是一趟出的回答。\n第二行。\n{"ref": "${handle}", "point_2d": [500, 500], "label": "正中间"}\n` : '这是分两趟的回答。\n第二行。';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  send({ role: 'assistant', content: null });
  for (let i = 0; i < text.length && !res.destroyed; i += 4) {
    send({ content: text.slice(i, i + 4) });
    await sleep(slow ? 60 : 8);
  }
  send({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-local-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ seenIntro: true, mcp: { enabled: false }, local: { mode: 'external', externalUrl: stubUrl, externalModel: 'stub-vlm', locate: 'fast' } }));
const app = await electron.launch({
  executablePath: path.join(repo, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', repo],
  env: { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData, ZHIDIAN_LOCAL_DIR: path.join(userData, 'local') },
});
const main = (fn, arg) => app.evaluate(fn, arg);
const overlay = await app.firstWindow();
await overlay.waitForLoadState('domcontentloaded');
const ui = (fn, arg) => overlay.evaluate(fn, arg);
const answered = (id) => overlay.waitForFunction((n) => window.__overlay.S.answer?.id === n && window.__overlay.S.answer.done, id, { timeout: 15000 });
await sleep(600);

let failed = null;
try {
  console.log('▸ the brain is the local client, not the rehearsal script');
  const cfg = await main(() => ({ name: globalThis.__zhidian.brain().name, ok: globalThis.__zhidian.brain().available() }));
  assert.match(cfg.name, /本地/);
  assert.equal(cfg.ok, true);

  console.log('▸ two passes without the adapter: a streamed answer, then a follow-up "where is it" in the same conversation');
  await main(() => globalThis.__zhidian.enterPointing());
  await overlay.waitForFunction(() => window.__overlay.S.mode === 'pointing', null, { timeout: 8000 });
  const h1 = await main(() => globalThis.__zhidian.pin({ box: { x: 200, y: 150, w: 400, h: 200 }, kind: 'region' }));
  assert.equal(h1, '@1');
  await main(() => void globalThis.__zhidian.ask({ question: '这是什么？', handles: ['@1'] }));
  await answered(1);
  await sleep(1400);
  const a1 = await ui(() => ({ text: window.__overlay.S.answer.text, marks: window.__overlay.S.marks.map((m) => m.mark), error: document.getElementById('btext').classList.contains('error') }));
  assert.equal(a1.error, false, a1.text);
  assert.equal(a1.text, '这是分两趟的回答。\n第二行。');
  assert.equal(seen.length, 2, 'one streamed answer and one grounding request');
  assert.deepEqual([seen[0].stream, seen[0].pointer, seen[0].images, seen[0].okImage, seen[0].thinking], [true, false, 1, true, false]);
  // The "where" request is a follow-up in the same conversation: system, the question with its
  // image, the answer just given, then the locate prompt. No image is sent a second time.
  assert.deepEqual([seen[1].stream, seen[1].format, seen[1].turns, seen[1].lastRole, seen[1].images, seen[1].allImages], [false, 'json_schema', 4, 'assistant', 0, 1]);
  assert.equal(a1.marks.length, 1);
  // The stand-in answered (250, 750) on the 0-1000 grid of the crop: lower left of the pinned box.
  const m1 = a1.marks[0];
  assert.equal(m1.where, 'screen');
  assert.ok(m1.x > 190 && m1.x < 400 && m1.y > 250 && m1.y < 365, `mark at ${m1.x},${m1.y} is in the lower-left part of the box`);

  console.log('▸ the default way of locating: a request of its own with an enlarged copy of the screenshot');
  await main(() => globalThis.__zhidian.settings.update({ local: { locate: 'precise' } }));
  await main(() => globalThis.__zhidian.newThread());
  seen.length = 0;
  await main(() => void globalThis.__zhidian.ask({ question: '这是什么？', handles: ['@1'] }));
  await answered(2);
  await sleep(1400);
  assert.equal(seen.length, 2);
  assert.deepEqual([seen[1].stream, seen[1].format, seen[1].turns, seen[1].images, seen[1].okImage], [false, 'json_schema', 1, 1, true], 'one message: the enlarged image and the question about where');
  const mp = await ui(() => window.__overlay.S.marks.map((m) => m.mark).filter((m) => m.answerId === 2));
  assert.equal(mp.length, 1);
  assert.ok(mp[0].x > 190 && mp[0].x < 400 && mp[0].y > 250 && mp[0].y < 365, `mark at ${mp[0].x},${mp[0].y} is in the lower-left part of the box`);
  await main(() => globalThis.__zhidian.newThread());

  console.log('▸ one pass with the adapter: a single request, the JSON line never shown, the point taken from it');
  await main(() => globalThis.__zhidian.settings.update({ local: { adapter: 'force' } }));
  seen.length = 0;
  const h2 = await main(() => globalThis.__zhidian.pin({ box: { x: 700, y: 300, w: 300, h: 300 }, kind: 'region' }));
  assert.equal(h2, '@2');
  await main(() => void globalThis.__zhidian.ask({ question: '那这个呢？', handles: ['@2'] }));
  await answered(3);
  await sleep(1400);
  const a2 = await ui(() => ({ text: window.__overlay.S.answer.text, bubble: document.getElementById('btext').textContent, marks: window.__overlay.S.marks.map((m) => m.mark) }));
  assert.equal(seen.length, 1, 'no second request');
  assert.equal(seen[0].pointer, true, 'the pointer system prompt was used');
  assert.equal(a2.text, '这是一趟出的回答。\n第二行。');
  assert.ok(!a2.bubble.includes('point_2d') && !a2.bubble.includes('{'), 'the JSON line stays out of the bubble: ' + a2.bubble);
  // (This test calls ask() directly, so the mark of the previous answer is still on screen.)
  const m2 = a2.marks.filter((m) => m.handle === '@2');
  assert.equal(m2.length, 1);
  assert.ok(Math.abs(m2[0].x - 850) < 60 && Math.abs(m2[0].y - 450) < 60, `mark at ${m2[0].x},${m2[0].y} is at the centre of @2`);

  console.log('▸ follow-ups reuse the conversation: no new image is sent, and the screenshot never drops out');
  let n = 3;
  for (const q of ['再详细一点', '为什么？', '那我该怎么做？', '还有呢？', '最后一个问题']) {
    seen.length = 0;
    await main((_electron, question) => void globalThis.__zhidian.ask({ question, handles: [] }), q);
    await answered(++n);
    assert.ok(seen[0].allImages >= 1, `"${q}" was sent with the screenshot it is about (images in the request: ${seen[0].allImages})`);
    if (n === 4) assert.equal(seen[0].images, 0, 'the first follow-up attaches nothing new');
  }
  const afterFollowUps = await ui(() => document.getElementById('btext').textContent);
  assert.ok(!afterFollowUps.includes('point_2d'), 'a line break after the JSON line does not let it into the bubble');

  console.log('▸ a stopped answer: the next question carries the screenshot the model never got to use');
  const h3 = await main(() => globalThis.__zhidian.pin({ box: { x: 300, y: 500, w: 300, h: 200 }, kind: 'region' }));
  assert.equal(h3, '@3');
  seen.length = 0;
  await main(() => void globalThis.__zhidian.ask({ question: '慢慢说', handles: ['@3'] }));
  await overlay.waitForFunction(() => window.__overlay.S.answer?.id === 9 && window.__overlay.S.answer.text.length > 4, null, { timeout: 8000 });
  await main(() => globalThis.__zhidian.state.ask.abort.abort());
  await answered(9);
  assert.equal(await ui(() => document.getElementById('bfoot').textContent), '已停止');
  assert.equal(seen[0].images, 1);
  seen.length = 0;
  await main(() => void globalThis.__zhidian.ask({ question: '那换个说法', handles: [] }));
  await answered(10);
  assert.equal(seen[0].images, 1, 'the follow-up to a stopped answer is sent with the screenshot of @3 again');

  console.log('▸ a new topic while an answer is streaming: the answer is dropped and leaves nothing behind');
  await main(() => void globalThis.__zhidian.ask({ question: '慢慢说第二次', handles: ['@3'] }));
  await overlay.waitForFunction(() => window.__overlay.S.answer?.id === 11 && window.__overlay.S.answer.text.length > 4, null, { timeout: 8000 });
  await main(() => globalThis.__zhidian.newThread());
  await answered(11);
  seen.length = 0;
  await main(() => void globalThis.__zhidian.ask({ question: '新话题', handles: ['@3'] }));
  await answered(12);
  assert.deepEqual([seen[0].turns, seen[0].images], [2, 1], 'only the system prompt and this question, with its screenshot');

  console.log('▸ a server that is not there gives a readable error, not a hang');
  await main(() => globalThis.__zhidian.settings.update({ local: { externalUrl: 'http://127.0.0.1:9/v1' } }));
  await main(() => void globalThis.__zhidian.ask({ question: '还在吗', handles: [] }));
  await answered(13);
  const err = await ui(() => document.getElementById('btext').textContent);
  assert.match(err, /连不上本地模型服务/);

  console.log('\n✔ local-brain checks passed');
} catch (err) {
  failed = err;
  console.error('\n✘ ' + (err.stack ?? err));
  console.error('requests seen:', JSON.stringify(seen));
} finally {
  await app.close().catch(() => {});
  stub.close();
}
process.exit(failed ? 1 : 0);
