import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDesktopBridge, WINDOWS_DESKTOP_HELPER, MAC_DESKTOP_HELPER } from '../src/main/context/desktop.js';
import { powershellPath } from '../src/main/context/watch.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-context-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const rawWindow = (extra = {}) => ({
  app: 'WINWORD', title: 'Report.docx - Word', windowId: '123456', pid: 300,
  _processStamp: '638900000000000000', _rootRuntimeId: '42,123456',
  files: ['C:\\Users\\Me\\Report.docx'], selectedText: 'Selected paragraph',
  bounds: { x: -1920, y: 10, w: 1200, h: 800 },
  controls: [
    { name: 'Save', role: 'ControlType.Button', actions: ['invoke', 'focus'], _runtimeId: '42,123456,7', _automationId: 'SaveButton' },
    { name: 'Find text', role: 'ControlType.Edit', actions: ['setvalue', 'focus'], _runtimeId: '42,123456,9', _automationId: 'FindEdit' },
    { name: 'Document', role: 'ControlType.Document', actions: ['scroll'], _runtimeId: '42,123456,10', _automationId: '' },
  ],
  ...extra,
});
function fixture(raw = rawWindow(), overrides = {}) {
  const calls = [], statCalls = [];
  const bridge = createDesktopBridge({
    platform: 'win32', now: () => 1000,
    isFile: (p) => { statCalls.push(p); return p === 'C:\\Users\\Me\\Report.docx'; },
    request: async (platform, request) => {
      calls.push({ platform, request: structuredClone(request) });
      return request.mode === 'capture' ? raw : { ok: true, message: 'done' };
    },
    ...overrides,
  });
  return { bridge, calls, statCalls };
}

test('desktop capture reports OS identity, existing files, bounded controls, and no native action descriptors', async () => {
  const { bridge } = fixture();
  const context = await bridge.captureContext();
  assert.equal(context.app, 'WINWORD');
  assert.equal(context.title, 'Report.docx - Word');
  assert.equal(context.windowId, '123456');
  assert.equal(context.bounds.x, -1920);
  assert.deepEqual(context.files, ['C:\\Users\\Me\\Report.docx']);
  assert.equal(context.selectedText, 'Selected paragraph');
  assert.deepEqual(context.controls[0], { id: 'c1', name: 'Save', role: 'ControlType.Button', actions: ['invoke', 'focus'], bounds: null });
  const exposed = JSON.stringify(context);
  assert.ok(!exposed.includes('638900000000000000'));
  assert.ok(!exposed.includes('SaveButton'));
  assert.ok(!exposed.includes('42,123456,7'));
});

test('paths cannot be invented from a title, made relative, or trigger UNC/network file probes', async () => {
  const { bridge, statCalls } = fixture(rawWindow({
    title: 'C:\\Users\\Me\\Report.docx',
    files: ['Report.docx', 'https://example.com/Report.docx', '\\\\server\\share\\Report.docx', '\\\\?\\C:\\Users\\Me\\Report.docx', 'C:\\missing.docx'],
  }));
  assert.deepEqual((await bridge.captureContext()).files, []);
  assert.deepEqual(statCalls, ['C:\\missing.docx']);
});

test('control actions use only captured descriptors even when the public snapshot is altered', async () => {
  const { bridge, calls } = fixture();
  const snapshot = await bridge.captureContext();
  snapshot.windowId = '999'; snapshot.pid = 999; snapshot.title = 'Forged';
  snapshot.controls[0].name = 'Forged'; snapshot.controls[0].actions.push('setvalue');
  assert.equal((await bridge.executeContextAction(snapshot, { controlId: 'c1', action: 'setvalue', value: 'wrong' })).ok, false);
  assert.equal((await bridge.executeContextAction(snapshot, { controlId: 'c1', action: 'invoke' })).ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].request.expected.windowId, '123456');
  assert.equal(calls[1].request.expected.pid, 300);
  assert.equal(calls[1].request.expected.title, 'Report.docx - Word');
  assert.equal(calls[1].request.control.runtimeId, '42,123456,7');
  assert.equal(calls[1].request.control.name, 'Save');
});

test('cloned, unknown, expired and unsupported action requests never reach the OS helper', async () => {
  let clock = 1000;
  const { bridge, calls } = fixture(undefined, { now: () => clock });
  const snapshot = await bridge.captureContext();
  for (const args of [
    [structuredClone(snapshot), { controlId: 'c1', action: 'invoke' }],
    [snapshot, { controlId: 'missing', action: 'invoke' }],
    [snapshot, { controlId: 'c1', action: 'shell', value: 'calc.exe' }],
    [snapshot, { controlId: 'c2', action: 'setvalue', value: { command: 'anything' } }],
    [snapshot, { controlId: 'c2', action: 'setvalue', value: 'x'.repeat(4001) }],
    [snapshot, { controlId: 'c3', action: 'scroll', value: 'run arbitrary command' }],
  ]) assert.equal((await bridge.executeContextAction(...args)).ok, false);
  clock += 10 * 60_000 + 1;
  assert.equal((await bridge.executeContextAction(snapshot, { controlId: 'c1', action: 'invoke' })).ok, false);
  assert.equal(calls.length, 1);
});

test('setvalue stays data and scroll accepts only the explicit supported directions', async () => {
  const { bridge, calls } = fixture();
  const snapshot = await bridge.captureContext();
  const text = "quotes ' \" $() ` Unicode 中文\nnew line";
  assert.equal((await bridge.executeContextAction(snapshot, { controlId: 'c2', action: 'setvalue', value: text })).ok, true);
  assert.equal(calls[1].request.value, text);
  assert.equal((await bridge.executeContextAction(snapshot, { controlId: 'c3', action: 'scroll', value: 'pagedown' })).ok, true);
});

test('unverifiable process identity and password controls are read-only or omitted', async () => {
  const raw = rawWindow({ _processStamp: '' });
  raw.controls.push({ password: true, name: 'secret value', actions: ['setvalue'] });
  const { bridge, calls } = fixture(raw);
  const snapshot = await bridge.captureContext();
  assert.equal(snapshot.controls.length, 3);
  assert.ok(snapshot.controls.every((c) => c.actions.length === 0));
  assert.equal((await bridge.executeContextAction(snapshot, { controlId: 'c1', action: 'invoke' })).ok, false);
  assert.equal(calls.length, 1);
});

test('native failures return readable context warnings or failed actions, without throwing into capture flow', async () => {
  const bridge = createDesktopBridge({ request: async () => { throw new Error('Access denied'); } });
  const empty = await bridge.captureContext();
  assert.deepEqual(empty.files, []);
  assert.deepEqual(empty.controls, []);
  assert.match(empty.warnings[0], /Access denied/);
  const { bridge: stale } = fixture(undefined, { request: async (_platform, req) => req.mode === 'capture' ? rawWindow() : Promise.reject(new Error('目标控件已变化，请重新按 F8')) });
  const snapshot = await stale.captureContext();
  assert.deepEqual(await stale.executeContextAction(snapshot, { controlId: 'c1', action: 'invoke' }), { ok: false, message: '目标控件已变化，请重新按 F8' });
});

test('oversized accessible content is bounded before it can enter a model prompt', async () => {
  const { bridge } = fixture(rawWindow({ selectedText: 'x'.repeat(30000), controls: Array.from({ length: 200 }, (_, i) => ({ name: 'n'.repeat(500), role: 'ControlType.Text', actions: ['shell'], _runtimeId: `42,123456,${i}` })) }));
  const snapshot = await bridge.captureContext();
  assert.equal(snapshot.selectedText.length, 20000);
  assert.equal(snapshot.controls.length, 120);
  assert.ok(snapshot.controls.every((c) => c.name.length === 400 && c.actions.length === 0));
});

test('Windows helper parses with the system PowerShell parser', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(root, 'desktop.ps1');
  fs.writeFileSync(file, '\uFEFF' + WINDOWS_DESKTOP_HELPER, 'utf8');
  const script = "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:ZHIDIAN_PARSE_FILE,[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }";
  execFileSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ZHIDIAN_PARSE_FILE: file }, timeout: 15000 });
});

test('macOS helper is valid JavaScript before its native API calls', () => {
  assert.doesNotThrow(() => new Function(MAC_DESKTOP_HELPER));
});
