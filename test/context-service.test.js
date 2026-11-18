import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopContextService, parseContextPlan } from '../src/main/context/service.js';
import { Office } from '../src/main/office/index.js';

function setup(t, complete) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.txt');
  fs.writeFileSync(file, '实际文件里的独有数据:收入 7531 元。\n');
  const office = new Office({ documentsDir: dir });
  const calls = [];
  const service = new DesktopContextService({ office, modelAvailable: () => true, modelName: () => '8B', where: () => 'local',
    template: () => 'business', complete, copy: async (v) => calls.push(v), showResult: async () => {},
    beforeControl: async () => {}, executeControl: async (...args) => { calls.push(args); return { ok: true, message: 'clicked' }; },
    openFile: async (...args) => calls.push(args),
  });
  const snapshot = { id: 'captured', app: 'Notepad', title: 'report.txt', files: [file], controls: [{ id: 'c1', name: 'Save', role: 'Button', actions: ['invoke'] }], selectedText: '', warnings: [] };
  service.set(snapshot);
  return { service, dir, file, calls, snapshot };
}

test('context plans use actual file text and write only after confirmation; cannot replay', async (t) => {
  let prompt;
  const { service, dir, file } = setup(t, async (args) => { prompt = args.prompt; return JSON.stringify({ message: '给文档排版', steps: [{ actionId: 'file.typeset' }] }); });
  const result = await service.run({ instruction: '把当前文件排版' });
  assert.equal(result.ok, true);
  assert.equal(result.plan.requiresConfirm, true);
  assert.match(prompt, /7531/);
  assert.ok(!prompt.includes(file), 'filesystem execution paths never come from model text');
  assert.deepEqual(fs.readdirSync(dir), ['report.txt']);
  const done = await service.execute(result.plan.id);
  assert.equal(done.ok, true, done.error);
  assert.equal(fs.readdirSync(dir).length, 2);
  assert.equal((await service.execute(result.plan.id)).ok, false);
});

test('a changed file invalidates a previously reviewed plan', async (t) => {
  const { service, file, dir } = setup(t, async () => '{"message":"排版","steps":[{"actionId":"file.typeset"}]}');
  const result = await service.run({ instruction: '排版' });
  fs.writeFileSync(file, 'changed since preview');
  const done = await service.execute(result.plan.id);
  assert.equal(done.ok, false);
  assert.match(done.error, /文件已改变/);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('long Chinese documents produce bounded, valid planning evidence with an explicit excerpt notice', async (t) => {
  let request;
  const { service, file, snapshot } = setup(t, async args => { request = args; return '{"message":"收入是7531元","steps":[]}'; });
  fs.writeFileSync(file, '收入7531元。' + '这是用于验证本地模型上下文上限的中文材料。'.repeat(3000));
  service.set({ ...snapshot, selectedText: '另外选中的长文字。'.repeat(2000) });
  const answer = await service.run({ instruction: '总结收入情况。'.repeat(200) });
  assert.equal(answer.ok, true, answer.error);
  assert.ok(request.prompt.length < 2800, `prompt is ${request.prompt.length} characters`);
  const evidence = JSON.parse(request.prompt.split('当前上下文（数据）：\n')[1]);
  assert.match(evidence.documents[0].content, /7531/);
  assert.match(evidence.note, /截断/);
  assert.ok(evidence.availableActions.length > 0);
});

test('unrecognized model actions are rejected and never executed', async (t) => {
  const { service, calls } = setup(t, async () => '{"message":"执行","steps":[{"actionId":"shell.exec","param":"malicious"}]}');
  const result = await service.run({ instruction: '操作' });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('context answers and direct file actions work independently of screenshot capability', async (t) => {
  const { service, calls, file } = setup(t, async () => '{"message":"收入是7531元","steps":[]}');
  assert.equal((await service.run({ instruction: '收入多少' })).message, '收入是7531元');
  assert.equal((await service.run({ actionId: 'file.open.0' })).ok, true);
  assert.deepEqual(calls, [[file, 'open']], 'file actions use the captured file identity');
});

test('office mode does not expose or execute generic window controls', async (t) => {
  const { service, calls } = setup(t, async () => '{"message":"点击保存","steps":[{"actionId":"control.c1.invoke"}]}');
  assert.deepEqual(service.view().controls, []);
  assert.ok(service.actions().every((action) => !action.id.startsWith('control.')));
  assert.deepEqual((await service.evidence()).controls, []);
  assert.equal((await service.run({ actionId: 'control.c1.invoke' })).ok, false);
  assert.equal((await service.run({ instruction: '点击保存按钮' })).ok, false);
  assert.deepEqual(calls, []);
});

test('new capture invalidates the old plan and cancellation prevents inference from returning a plan', async (t) => {
  let release;
  const { service, snapshot } = setup(t, () => new Promise((resolve) => { release = resolve; }));
  const pending = service.run({ instruction: '排版' });
  while (!release) await new Promise((r) => setTimeout(r, 1));
  service.set({ ...snapshot, id: 'new' });
  release('{"message":"排版","steps":[{"actionId":"file.typeset"}]}');
  assert.equal((await pending).ok, false);
});

test('model plan parser bounds steps and requires known action parameters', () => {
  assert.throws(() => parseContextPlan('{"message":"x","steps":[{"actionId":"fill"}]}', [{ id: 'fill', label: '填写', param: { required: true } }]), /参数/);
  assert.throws(() => parseContextPlan(JSON.stringify({ message: '', steps: Array(7).fill({ actionId: 'a' }) }), [{ id: 'a' }]), /格式/);
});

test('Stop or a new capture during document processing prevents clipboard side effects', async (t) => {
  for (const change of ['cancel', 'capture']) {
    const { service, calls, snapshot } = setup(t);
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    service.deps.office.run = () => new Promise((resolve) => { release = resolve; entered(); });
    const pending = service.run({ actionId: 'doc.summary' });
    await started;
    if (change === 'cancel') service.cancel();
    else service.set({ ...snapshot, id: 'another capture' });
    release({ kind: 'clipboard', text: 'Late document contents', message: 'copied' });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.deepEqual(calls, [], `${change} must prevent clipboard writes, not merely hide their result`);
  }
});

test('Stop while a document answer is pending prevents automatic clipboard writes', async (t) => {
  let release;
  const { service, calls } = setup(t, () => new Promise((resolve) => { release = resolve; }));
  service.deps.office.run = async () => ({ kind: 'ask', question: 'summarize actual document', autoCopy: true });
  const pending = service.run({ actionId: 'doc.summary' });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  service.cancel();
  release('An answer that arrived after Stop');
  assert.equal((await pending).ok, false);
  assert.deepEqual(calls, [], 'a model that ignores AbortSignal must not change the clipboard after Stop');
});

test('file changes between confirmed steps stop remaining actions', async (t) => {
  const { service, file, calls } = setup(t, async () => JSON.stringify({ message: 'Open and reveal', steps: [{ actionId: 'file.open.0' }, { actionId: 'file.reveal.0' }] }));
  service.deps.openFile = async (_file, mode) => { calls.push(mode); fs.writeFileSync(file, 'external edit while the first operation runs'); };
  const plan = await service.run({ instruction: 'Open and reveal the current file' });
  const result = await service.execute(plan.plan.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /文件已改变/);
  assert.deepEqual(calls, ['open']);
});

test('changed or cancelled evidence is never passed to the model after an asynchronous PDF read', async (t) => {
  for (const change of ['cancel', 'capture', 'file']) {
    let requests = 0, release, closed = false;
    const { service, dir, snapshot } = setup(t, async () => { requests++; return '{"message":"answer","steps":[]}'; });
    const pdf = path.join(dir, 'document.pdf');
    fs.writeFileSync(pdf, 'fixture handled by the injected PDF reader');
    service.set({ ...snapshot, files: [pdf] });
    service.deps.openPdf = async () => ({ pages: 1, text: () => new Promise((resolve) => { release = resolve; }), close: async () => { closed = true; } });
    const pending = service.run({ instruction: 'Read this PDF' });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    if (change === 'cancel') service.cancel();
    else if (change === 'capture') service.set({ ...snapshot, id: 'new capture', files: [pdf] });
    else fs.writeFileSync(pdf, 'changed PDF contents');
    release('contents from the old capture');
    assert.equal((await pending).ok, false);
    assert.equal(requests, 0, `${change} must stop the model request`);
    assert.equal(closed, true);
  }
});

test('MCP evidence without a capture or with a changed file gives a clear error', async (t) => {
  const { service, file } = setup(t);
  fs.writeFileSync(file, 'modified after capture');
  await assert.rejects(service.evidence(), /文件已改变/);
  service.set(null);
  await assert.rejects(service.evidence(), /先按 F8/);
});

