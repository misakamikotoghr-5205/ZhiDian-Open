// Native Windows integration: only a temporary window owned by this test is read or changed.
// It exercises the real UI Automation provider (capture, SetValue, Invoke, stale-window guard).
// Hosted CI desktops do not always permit foreground activation: exit 2 means INCONCLUSIVE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureContext, executeContextAction } from '../../src/main/context/desktop.js';
import { powershellPath, POWERSHELL_ARGS } from '../../src/main/context/watch.js';

if (process.platform !== 'win32') {
  console.log('SKIPPED: native desktop-context check needs Windows.');
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-desktop-e2e-'));
const statePath = path.join(dir, 'state.json');
const commandPath = path.join(dir, 'command.json');
const formScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace ZhidianTest -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
'@
$work = $env:ZHIDIAN_DESKTOP_TEST_DIR
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Zhidian desktop context test'
$form.Width = 550
$form.Height = 240
$form.StartPosition = 'CenterScreen'
$inputBox = New-Object System.Windows.Forms.TextBox
$inputBox.Name = 'ContextInput'
$inputBox.AccessibleName = 'Context input'
$inputBox.Text = 'selected words'
$inputBox.Left = 20
$inputBox.Top = 20
$inputBox.Width = 470
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Apply test action'
$button.Name = 'ApplyButton'
$button.AccessibleName = 'Apply test action'
$button.Left = 20
$button.Top = 70
$button.Width = 180
$form.Controls.Add($inputBox)
$form.Controls.Add($button)
$script:applied = 0
$button.Add_Click({ $script:applied++ })
$form.Add_Shown({
  $form.Activate()
  [void][ZhidianTest.Native]::SetForegroundWindow($form.Handle)
  $inputBox.Focus()
  $inputBox.SelectAll()
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  try {
    $commandFile = Join-Path $work 'command.json'
    if (Test-Path -LiteralPath $commandFile) {
      $command = Get-Content -LiteralPath $commandFile -Raw | ConvertFrom-Json
      if ($command.title) { $form.Text = [string]$command.title }
    }
    $state = @{ hwnd = $form.Handle.ToInt64().ToString(); pid = [Diagnostics.Process]::GetCurrentProcess().Id; foreground = [ZhidianTest.Native]::GetForegroundWindow().ToInt64().ToString(); text = $inputBox.Text; applied = $script:applied; title = $form.Text }
    [IO.File]::WriteAllText((Join-Path $work 'state.json'), ($state | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
  } catch {}
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
$timer.Stop()
$timer.Dispose()
$form.Dispose()
`;
const file = path.join(dir, 'fixture.ps1');
fs.writeFileSync(file, '\uFEFF' + formScript, 'utf8');
let stderr = '';
const child = spawn(powershellPath(), [...POWERSHELL_ARGS, file], { env: { ...process.env, ZHIDIAN_DESKTOP_TEST_DIR: dir }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (text) => { stderr = (stderr + text).slice(-4000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function state() { try { return JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
async function until(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    if (child.exitCode !== null) throw new Error(`test window exited ${child.exitCode}: ${stderr}`);
    await sleep(100);
  }
  return null;
}
try {
  const ready = await until(() => state());
  if (!ready) throw new Error(`test window did not start: ${stderr}`);
  const foreground = await until(() => { const s = state(); return s?.foreground === s?.hwnd ? s : null; }, 5000);
  if (!foreground) {
    console.log('RESULT: INCONCLUSIVE — this Windows desktop did not let the test window take foreground.');
    process.exitCode = 2;
  } else {
    const snapshot = await captureContext({ timeoutMs: 10000 });
    assert.equal(snapshot.windowId, foreground.hwnd, JSON.stringify(snapshot.warnings));
    assert.equal(snapshot.pid, foreground.pid);
    assert.equal(snapshot.title, 'Zhidian desktop context test');
    assert.deepEqual(snapshot.files, [], 'a window title never invents a file path');
    const input = snapshot.controls.find((c) => c.name === 'Context input' && c.actions.includes('setvalue'));
    const button = snapshot.controls.find((c) => c.name === 'Apply test action' && c.actions.includes('invoke'));
    assert.ok(input, 'native TextBox offers UIA ValuePattern');
    assert.ok(button, 'native Button offers UIA InvokePattern');
    const text = "Native UIA text: 中文 ' $() `";
    assert.equal((await executeContextAction(snapshot, { controlId: input.id, action: 'setvalue', value: text })).ok, true);
    assert.ok(await until(() => state()?.text === text), 'SetValue reaches the actual textbox');
    assert.equal((await executeContextAction(snapshot, { controlId: button.id, action: 'invoke' })).ok, true);
    assert.ok(await until(() => state()?.applied === 1), 'Invoke fires the actual button once');
    fs.writeFileSync(commandPath, JSON.stringify({ title: 'Zhidian desktop context changed document' }));
    assert.ok(await until(() => state()?.title === 'Zhidian desktop context changed document'));
    const stale = await executeContextAction(snapshot, { controlId: button.id, action: 'invoke' });
    assert.equal(stale.ok, false);
    assert.match(stale.message, /变化|重新按 F8/);
    assert.equal(state().applied, 1, 'a changed document must not receive an old action');
    console.log(`RESULT: VERIFIED — ${snapshot.controls.length} native UIA controls; SetValue, Invoke and stale-window refusal passed.`);
  }
} catch (error) {
  console.error('RESULT: WRONG —', error.stack || String(error));
  process.exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
