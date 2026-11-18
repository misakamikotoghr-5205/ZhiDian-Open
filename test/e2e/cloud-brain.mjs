// The optional network model, inside the running app: set up through the real settings window,
// asked through the real overlay, against a stand-in service on this machine that speaks the
// Anthropic Messages format. A second stand-in plays the local model, so that the test can tell
// which of the two a question went to.
//
// What this checks is the plumbing and the promises: nothing goes to the network model until it
// is switched on; the key reaches the service and no window; the overlay says where a question
// goes; only the settings window can change that. What a real model would answer is not checked
// here, and no request leaves this machine.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e/cloud-brain.mjs     (Linux)
//   node test/e2e/cloud-brain.mjs                                             (Windows)
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
const KEY = 'sk-test-e2e-0123456789cdef';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const readJson = async (req) => {
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : null;
};

// ---- stand-in for the local model (llama-server's OpenAI-style endpoint)
const localSeen = [];
const local = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'stub-vlm' }] }));
  const body = await readJson(req);
  localSeen.push({ stream: Boolean(body.stream) });
  if (!body.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"point_2d": [250, 750], "label": "左下"}' }, finish_reason: 'stop' }] }));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const content of ['这是本机', '模型的回答。']) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  res.end();
});

// ---- stand-in for the network service (Anthropic Messages format)
const cloudSeen = [];
let lastHandle = '@1';
const cloud = http.createServer(async (req, res) => {
  const credentials = [req.headers['x-api-key'], String(req.headers.authorization ?? '').replace(/^Bearer /, '')].filter(Boolean);
  const body = req.method === 'POST' ? await readJson(req) : null;
  const images = (body?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'image');
  const lastTurn = body?.messages?.at(-1)?.content;
  const slow = JSON.stringify(lastTurn ?? '').includes('慢');
  cloudSeen.push({ method: req.method, url: req.url, credentials, model: body?.model, images: images.length, imagesInLastTurn: Array.isArray(lastTurn) ? lastTurn.filter((b) => b.type === 'image').length : 0, placeholder: JSON.stringify(body?.messages?.[0] ?? '').includes('截图已省略'), okImage: images.every((b) => b.source?.type === 'base64' && b.source.data.length > 100), system: body?.system ?? '', turns: body?.messages?.length ?? 0 });
  if (!credentials.includes(KEY)) {
    return res.writeHead(401, { 'content-type': 'application/json', 'x-should-retry': 'false' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/models/')) {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: req.url.split('/').pop(), type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }));
  }
  // Point at the screenshot this question came with (or the one before, for a follow-up).
  const named = body.messages.at(-1).content.find?.((b) => b.type === 'text' && /^@\d+/.test(b.text))?.text.match(/^@\d+/)[0];
  if (named) lastHandle = named;
  const text = `这是联网模型的回答。\n{"ref": "${lastHandle}", "point_2d": [750, 250], "label": "右上"}`;
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
    ...Array.from({ length: Math.ceil(text.length / 6) }, (_, i) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(i * 6, i * 6 + 6) } })),
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) {
    if (res.destroyed) break;
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    await sleep(slow ? 150 : 5);
  }
  res.end();
});

await listen(local);
await listen(cloud);
const localUrl = `http://127.0.0.1:${local.address().port}/v1`;
const cloudUrl = `http://127.0.0.1:${cloud.address().port}`;
const cloudHost = `127.0.0.1:${cloud.address().port}`;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-cloud-'));
const settingsFile = path.join(userData, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ seenIntro: true, mcp: { enabled: false }, actions: { ambient: false }, local: { mode: 'external', externalUrl: localUrl, externalModel: 'stub-vlm', adapter: 'force' } }));
// Nothing from this shell's environment may stand in for the key under test.
const env = { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData, ZHIDIAN_LOCAL_DIR: path.join(userData, 'local') };
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[k];
const app = await electron.launch({ executablePath: require('electron') /* in plain Node: the path of the Electron binary */, args: ['--no-sandbox', repo], env });
const main = (fn, arg) => app.evaluate(fn, arg);
const overlay = await app.firstWindow();
await overlay.waitForLoadState('domcontentloaded');
const ui = (fn, arg) => overlay.evaluate(fn, arg);
const config = () => ui(() => window.__overlay.S.config);
const configIs = (fn, arg) => overlay.waitForFunction(fn, arg, { timeout: 8000 });
let asked = 0;
/** Ask through the main process the way the overlay does, and wait for the answer to finish. */
async function ask(question, handles) {
  await main((_e, p) => void globalThis.__zhidian.ask(p), { question, handles });
  asked++;
  await overlay.waitForFunction((n) => window.__overlay.S.answer?.id === n && window.__overlay.S.answer.done, asked, { timeout: 15000 });
  await sleep(300);
  return ui(() => ({ text: window.__overlay.S.answer.text, shown: document.getElementById('btext').textContent, where: window.__overlay.S.answer.where, foot: document.getElementById('bfoot').textContent, who: document.getElementById('bwho').textContent, error: document.getElementById('btext').classList.contains('error'), reask: document.querySelector('#bfoot [data-reask]')?.dataset.reask ?? null }));
}
await sleep(600);
// With E2E_OUT set, pictures of the new interface are kept for a person to look at.
const out = process.env.E2E_OUT;
if (out) fs.mkdirSync(out, { recursive: true });
const shot = async (target, name) => {
  if (out) await target.screenshot({ path: path.join(out, `cloud-${name}.png`) }).catch(() => {});
};

let failed = null;
try {
  console.log('▸ off by default: the overlay offers no network model, and a question touches only the local server');
  let c = await config();
  assert.equal(c.cloud, null);
  assert.equal(c.where, 'local');
  await main(() => globalThis.__zhidian.enterPointing());
  await overlay.waitForFunction(() => window.__overlay.S.mode === 'pointing', null, { timeout: 8000 });
  assert.equal(await main(() => globalThis.__zhidian.pin({ box: { x: 200, y: 150, w: 400, h: 200 }, kind: 'region' })), '@1');
  let a = await ask('这是什么？', ['@1']);
  assert.equal(a.error, false, a.text);
  assert.match(a.text, /本机模型的回答/);
  assert.match(a.foot, /全程在本机/);
  assert.equal(a.reask, null, 'no offer to ask a network model that is not set up');
  assert.equal(cloudSeen.length, 0);
  assert.match(await ui(() => document.getElementById('hud').textContent), /不出本机/);

  console.log('▸ the settings window: an address, a key, a connection test');
  const [page] = await Promise.all([app.waitForEvent('window'), ui(() => window.zhidian.openSettings('cloud'))]);
  await page.waitForSelector('#cprovider option', { state: 'attached' });
  assert.equal(await page.isDisabled('#cenabled'), true, 'cannot be switched on before it is set up');
  await page.fill('#curl', cloudUrl);
  await page.locator('#curl').blur();
  await page.fill('#ckey', KEY);
  await page.click('#cksave');
  await page.waitForFunction(() => document.getElementById('ckeynote').textContent.includes('只用于'));
  assert.equal(await page.inputValue('#ckey'), '', 'the field is emptied once the key is saved');
  assert.match(await page.getAttribute('#ckey', 'placeholder'), /尾号 cdef/);
  assert.match(await page.textContent('#ckeynote'), new RegExp(cloudHost.replace(/\./g, '\\.')));
  const view = await page.evaluate(() => window.zhidian.settings.get());
  assert.deepEqual([view.cloud.hasKey, view.cloud.configured, view.cloud.enabled, view.cloud.host], [true, true, false, cloudHost]);
  assert.equal(JSON.stringify(view).includes(KEY), false, 'the key is not in what a window is given');
  const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).cloud;
  assert.match(stored.key, /^v1:(enc|raw):/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8').includes(KEY), false, 'not written to the settings file as typed');
  assert.equal(stored.keyHost, cloudHost);
  console.log(`  (key protection on this machine: ${view.cloud.protection})`);
  assert.equal((await config()).cloud, null, 'saving a key does not switch anything on');

  await page.click('#ctest');
  await page.waitForFunction(() => /^[✓✗]/.test(document.getElementById('cout').textContent));
  assert.match(await page.textContent('#cout'), /^✓ .*密钥有效/);
  assert.deepEqual([cloudSeen.length, cloudSeen[0].method, cloudSeen[0].url, cloudSeen[0].credentials], [1, 'GET', '/v1/models/claude-opus-5-5', [KEY]], 'the test asked for the model and sent no question');
  cloudSeen.length = 0;

  console.log('▸ switched on: questions still go to the local model, and its answer offers the network one by name');
  await page.check('#cenabled');
  await configIs(() => window.__overlay.S.config.cloud !== null);
  c = await config();
  assert.deepEqual([c.cloud.host, c.cloud.on, c.where], [cloudHost, false, 'local']);
  assert.match(c.cloud.name, /^联网 Claude Opus 5\.5$/);
  // (Opening the settings window ended pointing mode, and that window now covers what @1 was
  // pinned on. Point again, at what is on the screen now.)
  await main(() => globalThis.__zhidian.enterPointing());
  await overlay.waitForFunction(() => window.__overlay.S.mode === 'pointing', null, { timeout: 8000 });
  const H = await main(() => globalThis.__zhidian.pin({ box: { x: 200, y: 150, w: 400, h: 200 }, kind: 'region' }));
  assert.equal(H, '@2');
  await main(() => globalThis.__zhidian.newThread());
  a = await ask('这是什么？', [H]);
  assert.match(a.text, /本机模型的回答/);
  assert.equal(a.reask, 'cloud');
  await shot(overlay.locator('#bubble'), 'local-answer');
  assert.equal(cloudSeen.length, 0, 'nothing went out on its own');
  const offer = await ui(() => { const b = document.querySelector('#bfoot [data-reask]'); return { text: b.textContent, title: b.title }; });
  assert.match(offer.text, /联网 Claude Opus 5\.5 重答/);
  assert.match(offer.title, new RegExp(cloudHost.replace(/\./g, '\\.')), 'the button says where the question would go');

  console.log('▸ "ask again": the same question and its one crop go to the service, with the key; the overlay says so');
  await ui(() => document.querySelector('#bfoot [data-reask]').click());
  asked++;
  await overlay.waitForFunction((n) => window.__overlay.S.answer?.id === n && window.__overlay.S.answer.done, asked, { timeout: 15000 });
  await sleep(1200);
  assert.equal(cloudSeen.length, 1);
  const sent = cloudSeen[0];
  assert.deepEqual([sent.method, sent.url.split('?')[0], sent.credentials, sent.model, sent.images, sent.okImage, sent.turns], ['POST', '/v1/messages', [KEY], 'claude-opus-5-5', 1, true, 1]);
  assert.match(sent.system, /point_2d/);
  a = await ui(() => ({ text: window.__overlay.S.answer.text, where: window.__overlay.S.answer.where, foot: document.getElementById('bfoot').textContent, who: document.getElementById('bwho').textContent, q: document.getElementById('bq').textContent, marks: window.__overlay.S.marks.map((m) => m.mark) }));
  assert.equal(a.text, '这是联网模型的回答。', 'the line for the program is not shown');
  assert.equal(a.where, cloudHost);
  assert.match(a.foot, new RegExp(`已发送到 ${cloudHost.replace(/\./g, '\\.')}`));
  assert.doesNotMatch(a.foot, /全程在本机/);
  assert.match(a.who, /联网/);
  assert.match(a.q, /这是什么/);
  const mark = a.marks.at(-1);
  // (750, 250) of 1000 in the crop is the upper right quarter of the pinned box; the app then
  // snaps the mark to the interface element nearest to it, as it does for every pointer.
  assert.ok(mark && mark.where === 'screen' && mark.handle === H && mark.x > 400 && mark.x < 610 && mark.y > 140 && mark.y < 250, `the mark lands in the upper right of the pinned box: ${JSON.stringify(mark)}`);
  assert.match(mark.who, /联网/);
  await shot(overlay.locator('#bubble'), 'answer');

  console.log('▸ the topic stays with the network model, the dialog says "发送到", and a new topic goes back to this machine');
  c = await config();
  assert.deepEqual([c.where, c.cloud.on], [cloudHost, true]);
  await shot(overlay.locator('#ask'), 'dialog');
  const hud = await ui(() => document.getElementById('hud').textContent);
  assert.match(hud, new RegExp(`发送到 ${cloudHost.replace(/\./g, '\\.')}`));
  assert.doesNotMatch(hud, /不出本机/);
  localSeen.length = 0;
  a = await ask('为什么？', []);
  assert.equal(a.where, cloudHost);
  assert.deepEqual([cloudSeen.length, cloudSeen[1].turns, cloudSeen[1].images, localSeen.length], [2, 3, 1, 0], 'a follow-up: the conversation so far, the screenshot once, nothing to the local server');
  await main(() => globalThis.__zhidian.newThread());
  await configIs(() => window.__overlay.S.config.where === 'local');

  console.log('▸ the switch in the dialog, both ways');
  await ui(() => document.querySelector('#hud [data-via]').click());
  await configIs((h) => window.__overlay.S.config.where === h, cloudHost);
  assert.equal(await ui(() => document.querySelector('#hud [data-via]').dataset.via), 'local');
  await ui(() => document.querySelector('#hud [data-via]').click());
  await configIs(() => window.__overlay.S.config.where === 'local');

  console.log('▸ a follow-up asked again of the network model takes the conversation and the screenshot with it, and the dialog says so first');
  await main(() => globalThis.__zhidian.newThread());
  cloudSeen.length = 0;
  a = await ask('这是什么？', [H]);
  a = await ask('再详细一点', []);
  assert.deepEqual([a.where, cloudSeen.length], ['local', 0]);
  assert.deepEqual((await config()).carry, [], 'the local model has the screenshot already: a follow-up carries nothing');
  await ui(() => document.querySelector('#hud [data-via]').click());
  await configIs((h) => window.__overlay.S.config.where === h && window.__overlay.S.config.carry.length === 1, cloudHost);
  const carry = (await config()).carry;
  assert.deepEqual([carry[0].handle, carry[0].bytes > 1000], [H, true], 'after the switch, the dialog knows the screenshot will go along');
  await ui(() => document.querySelector('#hud [data-via]').click());
  await configIs(() => window.__overlay.S.config.where === 'local' && window.__overlay.S.config.carry.length === 0);
  await ui(() => document.querySelector('#bfoot [data-reask]').click());
  asked++;
  await overlay.waitForFunction((n) => window.__overlay.S.answer?.id === n && window.__overlay.S.answer.done, asked, { timeout: 15000 });
  assert.equal(cloudSeen.length, 1);
  assert.deepEqual([cloudSeen[0].turns, cloudSeen[0].images, cloudSeen[0].imagesInLastTurn, cloudSeen[0].placeholder], [3, 1, 1, true], 'the first exchange as text, then the follow-up with the screenshot; the answer being replaced is left out');
  assert.match(await ui(() => document.getElementById('bfoot').textContent), /发送了/);
  await main(() => globalThis.__zhidian.newThread());
  await configIs(() => window.__overlay.S.config.where === 'local');

  console.log('▸ only the settings window can change where questions go');
  const tried = await ui(() => window.zhidian.settings.cloud.update({ baseUrl: 'http://127.0.0.1:9', byDefault: true, key: 'sk-from-the-overlay-000000' }));
  assert.deepEqual([tried.view.cloud.baseUrl, tried.view.cloud.byDefault, tried.view.cloud.keyHint], [cloudUrl, false, 'cdef']);
  assert.equal((await ui(() => window.zhidian.settings.cloud.test())).ok, false);
  const viaGeneral = await ui(() => window.zhidian.settings.update({ cloud: { byDefault: true, baseUrl: 'http://127.0.0.1:9' } }));
  assert.deepEqual([viaGeneral.cloud.baseUrl, viaGeneral.cloud.byDefault], [cloudUrl, false], 'nor through the general settings call');
  const redirected = await ui(() => window.zhidian.settings.update({ local: { mode: 'external', externalUrl: 'https://elsewhere.example/v1' }, pointBack: false }));
  assert.deepEqual([redirected.local.externalUrl, redirected.pointBack], [localUrl, true], 'the overlay cannot point the "local" model at another host either');
  assert.equal((await ui(() => window.zhidian.settings.probe('https://elsewhere.example/v1'))).ok, false);

  console.log('▸ "by default": every question goes to the service, the local server is left alone');
  await page.check('#cdefault');
  await configIs((h) => window.__overlay.S.config.where === h, cloudHost);
  await shot(page.locator('#sec-cloud'), 'settings');
  localSeen.length = 0;
  cloudSeen.length = 0;
  a = await ask('这是什么？', [H]);
  assert.deepEqual([a.where, cloudSeen.length, localSeen.length], [cloudHost, 1, 0]);
  assert.equal(a.reask, null, 'an answer from the network model does not offer itself again');

  console.log('▸ office actions that are jobs for the model say, before the click, that the selection would leave this computer');
  const offerFor = (text) => main((_e, t) => globalThis.__zhidian.offerActions(globalThis.__zhidian.office.context({ text: t, files: [] })), text);
  const panel = () => ui(() => ({ buttons: [...document.querySelectorAll('#actbtns button[data-act]')].map((b) => ({ text: b.textContent, title: b.title, out: b.classList.contains('out') })), note: document.querySelector('#actbtns .outnote')?.textContent ?? '' }));
  const passage = '人工智能(AI)正在改变办公方式,但很多工具仍然要求用户先学会写提示词.这是一段用来测试的文字。';
  assert.equal(await offerFor(passage), true);
  await overlay.waitForFunction(() => !document.getElementById('act').hidden);
  let p = await panel();
  const jobs = p.buttons.filter((b) => b.out);
  assert.ok(jobs.length >= 2, `the model's jobs are marked: ${JSON.stringify(p.buttons.map((b) => b.text))}`);
  assert.ok(jobs.every((b) => b.text.endsWith('↗') && b.title.includes(cloudHost)));
  assert.ok(p.buttons.some((b) => !b.out && b.text === '自动排版'), 'what a program on this computer does is not marked');
  assert.match(p.note, new RegExp(cloudHost.replace(/\./g, '\\.')));
  await ui(() => document.getElementById('actclose').click());

  console.log('▸ switching the network model off stops the request that is on its way');
  await main(() => globalThis.__zhidian.newThread());
  cloudSeen.length = 0;
  await main((_e, q) => void globalThis.__zhidian.ask(q), { question: '慢慢说', handles: [H] });
  asked++;
  await overlay.waitForFunction((n) => window.__overlay.S.answer?.id === n && window.__overlay.S.answer.text.length > 0, asked, { timeout: 15000 });
  await page.uncheck('#cenabled');
  await overlay.waitForFunction((n) => window.__overlay.S.answer?.id === n && window.__overlay.S.answer.done, asked, { timeout: 8000 });
  assert.match(await ui(() => document.getElementById('bfoot').textContent), /已停止/);
  await configIs(() => window.__overlay.S.config.cloud === null && window.__overlay.S.config.where === 'local');
  await sleep(600);
  assert.equal(cloudSeen.length, 1, 'and nothing more is sent');
  assert.equal(await offerFor(passage), true);
  await overlay.waitForFunction(() => !document.getElementById('act').hidden);
  p = await panel();
  assert.deepEqual([p.buttons.some((b) => b.out), p.note], [false, ''], 'with the network model off, nothing is marked as leaving');
  await ui(() => document.getElementById('actclose').click());
  await page.check('#cenabled');
  await page.check('#cdefault');
  await configIs((h) => window.__overlay.S.config.where === h, cloudHost);

  console.log('▸ a wrong key is said as one, with a way back to the local model');
  await page.fill('#ckey', 'sk-wrong-key-0000000000');
  await page.click('#cksave');
  await page.waitForFunction(() => document.getElementById('ckey').placeholder.includes('0000'));
  await main(() => globalThis.__zhidian.newThread());
  a = await ask('这是什么？', [H]);
  assert.equal(a.error, true);
  assert.match(a.shown, /不接受这把密钥/);
  assert.match(a.shown, /改用本机模型/);
  assert.equal(a.shown.includes('sk-wrong-key'), false, 'an error never repeats the key');
  await ui(() => document.querySelector('#btext [data-reask="local"]').click());
  asked++;
  await overlay.waitForFunction((n) => window.__overlay.S.answer?.id === n && window.__overlay.S.answer.done, asked, { timeout: 15000 });
  assert.match(await ui(() => window.__overlay.S.answer.text), /本机模型的回答/);
  assert.equal(await ui(() => window.__overlay.S.answer.where), 'local');

  console.log('▸ a "local" server that is in fact another machine is not called "this computer"');
  await page.uncheck('#cenabled');
  await configIs(() => window.__overlay.S.config.where === 'local');
  await page.evaluate(() => { document.getElementById('adv').open = true; });
  await page.fill('#exturl', 'http://192.168.77.77:9/v1');
  await page.locator('#exturl').blur();
  await configIs(() => window.__overlay.S.config.where === '192.168.77.77:9');
  const lan = await ui(() => document.getElementById('hud').textContent);
  assert.match(lan, /发送到 192\.168\.77\.77:9/);
  assert.doesNotMatch(lan, /不出本机/);
  await page.fill('#exturl', localUrl);
  await page.locator('#exturl').blur();
  await configIs(() => window.__overlay.S.config.where === 'local');
  assert.match(await ui(() => document.getElementById('hud').textContent), /不出本机/);
  await page.check('#cenabled');

  console.log('▸ another address: the key does not follow, and the network model goes off');
  await page.fill('#curl', 'http://127.0.0.1:9');
  await page.locator('#curl').blur();
  await page.waitForFunction(() => document.getElementById('cenabled').disabled);
  const after = await page.evaluate(() => window.zhidian.settings.get());
  assert.deepEqual([after.cloud.hasKey, after.cloud.enabled, after.cloud.byDefault, after.cloud.configured], [false, false, false, false]);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).cloud.key, '');
  await configIs(() => window.__overlay.S.config.cloud === null && window.__overlay.S.config.where === 'local');
  cloudSeen.length = 0;
  await main(() => globalThis.__zhidian.newThread());
  a = await ask('这是什么？', [H]);
  assert.deepEqual([a.where, cloudSeen.length], ['local', 0]);

  console.log('\n✔ cloud-brain checks passed');
} catch (err) {
  failed = err;
  console.error('\n✘ ' + (err.stack ?? err));
  console.error('network service saw:', JSON.stringify(cloudSeen.map((s) => ({ ...s, credentials: s.credentials.length, system: s.system.length }))));
  const diag = await main(() => ({ mode: globalThis.__zhidian.state.mode, via: globalThis.__zhidian.state.via, refs: globalThis.__zhidian.store.list().map((r) => `${r.handle}:${r.state}`) })).catch(() => null);
  const marks = await ui(() => ({ marks: window.__overlay.S.marks.length, snapshot: !document.getElementById('snapshot').hidden, mode: window.__overlay.S.mode })).catch(() => null);
  console.error('app state:', JSON.stringify(diag), JSON.stringify(marks));
} finally {
  await app.close().catch(() => {});
  local.close();
  cloud.close();
}
process.exit(failed ? 1 : 0);
