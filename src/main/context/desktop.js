// A snapshot of the real foreground application, captured before our overlay takes focus.
// Paths come only from the OS / the owning application's document model. A screenshot, title,
// or model response is never turned into a guessed file path. Legacy native control validation
// remains private to the bridge; v0.5 capture exposes files and selected text only.
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_HELPER, POWERSHELL_ARGS, powershellPath } from './watch.js';
import { WINDOWS_FILE_SURFACE_HELPER } from './windows-file-surface.js';
import { candidatesForItem, filesInRegion, validRect } from './file-regions.js';

const MAX_AGE = 10 * 60_000;
const MAX_CONTROLS = 120;
const ACTIONS = new Set(['invoke', 'focus', 'setvalue', 'scroll']);
const DIRECTIONS = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown']);
const clip = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';

// Reuse Explorer's Windows 11 tab handling and selected-text reader, without the polling loop.
export const WINDOWS_DESKTOP_HELPER = WINDOWS_HELPER.split('# -- watch --')[0] + String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Zhidian -Name ContextNative -MemberDefinition @'
public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
'@

function Runtime-Key($element) { (@($element.GetRuntimeId()) -join ',') }
function Window-Title($hwnd) {
  $titleBuffer = New-Object System.Text.StringBuilder 2048
  [void][Zhidian.ContextNative]::GetWindowText($hwnd, $titleBuffer, 2048)
  $titleBuffer.ToString()
}
function Window-Owner($hwnd) {
  $ownerPid = [uint32]0
  [void][Zhidian.Native]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
  $ownerPid
}
function Process-Stamp($ownerPid) {
  try { (Get-Process -Id $ownerPid).StartTime.ToUniversalTime().Ticks.ToString() } catch { '' }
}
function Bounds-Of($element) {
  $r = $element.Current.BoundingRectangle
  if ([Double]::IsInfinity($r.X) -or [Double]::IsNaN($r.X)) { return $null }
  @{ x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }
}
function Control-Actions($element) {
  $available = @()
  if ($element.Current.IsPassword -or (-not $element.Current.IsEnabled) -or $element.Current.IsOffscreen) { return $available }
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $available += 'invoke' }
  if ($element.Current.IsKeyboardFocusable) { $available += 'focus' }
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and (-not $pattern.Current.IsReadOnly)) { $available += 'setvalue' }
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) {
    if ($pattern.Current.VerticallyScrollable -or $pattern.Current.HorizontallyScrollable) { $available += 'scroll' }
  }
  $available
}
function Walk-Controls($root, [string]$wanted = '') {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ element = $root; depth = 0 })
  $rows = @()
  $visited = 0
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($queue.Count -gt 0 -and $visited -lt 400 -and $watch.ElapsedMilliseconds -lt 1800) {
    $item = $queue.Dequeue()
    $element = $item.element
    $visited++
    try {
      if ($element.Current.IsPassword) { continue }
      $key = Runtime-Key $element
      if ($wanted -ne '' -and $key -ceq $wanted) { return $element }
      if ($wanted -eq '' -and (-not $element.Current.IsOffscreen)) {
        $label = [string]$element.Current.Name
        if ($label.Length -gt 400) { $label = $label.Substring(0, 400) }
        $available = @(Control-Actions $element)
        if ($label -ne '' -or $available.Count -gt 0) {
          $rows += @{ name = $label; role = $element.Current.ControlType.ProgrammaticName; actions = $available; bounds = (Bounds-Of $element); _runtimeId = $key; _automationId = [string]$element.Current.AutomationId }
          if ($rows.Count -ge 120) { break }
        }
      }
      if ($item.depth -lt 7) {
        $child = $walker.GetFirstChild($element)
        $children = 0
        while ($child -and $children -lt 100 -and ($queue.Count + $visited) -lt 400) {
          $queue.Enqueue(@{ element = $child; depth = $item.depth + 1 })
          $child = $walker.GetNextSibling($child)
          $children++
        }
      }
    } catch {}
  }
  if ($wanted -ne '') { return $null }
  @{ controls = $rows; truncated = ($queue.Count -gt 0 -or $visited -ge 400 -or $watch.ElapsedMilliseconds -ge 1800 -or $rows.Count -ge 120) }
}

function Office-Document($appName, $hwnd) {
  $com = $null
  $document = $null
  $active = $null
  try {
    $progid = switch ($appName.ToLowerInvariant()) { 'winword' { 'Word.Application' }; 'excel' { 'Excel.Application' }; 'powerpnt' { 'PowerPoint.Application' }; default { '' } }
    if ($progid -eq '') { return @() }
    # Attach only. Never launch Office or open a document while discovering context.
    $com = [Runtime.InteropServices.Marshal]::GetActiveObject($progid)
    $active = $com.ActiveWindow
    $officeHwnd = [IntPtr][long]$active.Hwnd
    if ([Zhidian.ContextNative]::GetAncestor($officeHwnd, 2) -ne $hwnd) { return @() }
    $document = switch ($appName.ToLowerInvariant()) { 'winword' { $com.ActiveDocument }; 'excel' { $com.ActiveWorkbook }; 'powerpnt' { $com.ActivePresentation } }
    if ($document -and [string]$document.Path -ne '') { return @([string]$document.FullName) }
  } catch {} finally {
    foreach ($obj in @($document, $active, $com)) {
      if ($obj -and [Runtime.InteropServices.Marshal]::IsComObject($obj)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($obj) }
    }
  }
  @()
}

${WINDOWS_FILE_SURFACE_HELPER}

function Capture-Desktop($request) {
  # UI Automation reports physical pixels. Use that same coordinate space for native bounds.
  try { [void][Zhidian.ContextNative]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}
  $hwnd = [Zhidian.Native]::GetForegroundWindow()
  if ($request.windowId) { $hwnd = [IntPtr][long]$request.windowId }
  if ($hwnd -eq [IntPtr]::Zero) { throw '没有可读取的前台窗口' }
  $ownerPid = Window-Owner $hwnd
  $stamp = Process-Stamp $ownerPid
  $appName = [string](Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
  $title = Window-Title $hwnd
  $rect = New-Object Zhidian.ContextNative+Rect
  [void][Zhidian.ContextNative]::GetWindowRect($hwnd, [ref]$rect)
  $warnings = @()
  $fileSurface = @{ kind = 'none'; rows = @(); entries = @() }
  try { $fileSurface = Capture-FileSurface $hwnd } catch { $warnings += '文件图标的真实路径暂时不可读取，请重新打开文件夹后按 F8' }
  if ($fileSurface.truncated) { $warnings += '文件夹内容较多，图标读取已达到上限；请缩小文件夹范围后重试' }
  $files = @()
  try { $files = @(Get-FolderFiles $hwnd) } catch { $warnings += '资源管理器没有提供当前文件选区' }
  if ($files.Count -eq 0) {
    $cls = Get-WindowClass $hwnd
    if ($cls -eq 'Progman' -or $cls -eq 'WorkerW') { try { $files = @(Get-DesktopFiles $hwnd) } catch {} }
    else { $files = @(Office-Document $appName $hwnd) }
  }
  if ($appName -match '^(WINWORD|EXCEL|POWERPNT)$' -and $files.Count -eq 0) { $warnings += '当前 Office 文档没有可确认的本地路径（可能未保存、来自网络或应用未提供访问权限）' }
  $selected = ''
  $controls = @()
  $rootKey = ''
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $rootKey = Runtime-Key $root
    # v0.5 uses file actions. Avoid walking unrelated application controls on every F8.
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused -and $focused.Current.ProcessId -eq $ownerPid) { $selected = Get-SelectedText }
  } catch { $warnings += '无法读取此窗口的辅助功能内容；可能需要权限或应用不支持 UI Automation' }
  if ($stamp -eq '') { $warnings += '无法确认应用进程身份，此快照仅供阅读'; foreach ($control in $controls) { $control.actions = @() } }
  if ((-not $request.windowId -and [Zhidian.Native]::GetForegroundWindow() -ne $hwnd) -or (Window-Owner $hwnd) -ne $ownerPid -or (Window-Title $hwnd) -cne $title) { throw '读取期间前台窗口发生变化，请重新按 F8' }
  @{ app = $appName; title = $title; windowId = $hwnd.ToInt64().ToString(); pid = $ownerPid; bounds = @{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }; files = @($files | Select-Object -First 200); selectedText = $selected; controls = $controls; warnings = $warnings; fileSurface = $fileSurface; _processStamp = $stamp; _rootRuntimeId = $rootKey }
}

function Execute-Desktop($request) {
  $expected = $request.expected
  $hwnd = [IntPtr][long]$expected.windowId
  if (-not [Zhidian.ContextNative]::IsWindow($hwnd)) { throw '原窗口已关闭，请重新按 F8' }
  if ((Window-Owner $hwnd) -ne [uint32]$expected.pid -or (Process-Stamp $expected.pid) -cne [string]$expected.processStamp -or (Window-Title $hwnd) -cne [string]$expected.title) { throw '原窗口或文档已变化，请重新按 F8' }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ((Runtime-Key $root) -cne [string]$expected.rootRuntimeId) { throw '原窗口的控件已更新，请重新按 F8' }
  # Refetch the exact runtime ID, never reuse an old object or match by a similar label.
  $element = Walk-Controls $root ([string]$request.control.runtimeId)
  if (-not $element) { throw '目标控件已消失或不在当前可访问窗口中，请重新按 F8' }
  $currentName = [string]$element.Current.Name
  if ($currentName.Length -gt 400) { $currentName = $currentName.Substring(0, 400) }
  if ([string]$element.Current.AutomationId -cne [string]$request.control.automationId -or [string]$element.Current.ControlType.ProgrammaticName -cne [string]$request.control.role -or $currentName -cne [string]$request.control.name) { throw '目标控件已变化，请重新按 F8' }
  $available = @(Control-Actions $element)
  $action = [string]$request.action
  if ($available -cnotcontains $action) { throw '这个控件目前不支持此操作' }
  # Check identity again immediately before the operation; a provider lookup can take time.
  if ((Window-Owner $hwnd) -ne [uint32]$expected.pid -or (Window-Title $hwnd) -cne [string]$expected.title) { throw '窗口已变化，请重新按 F8' }
  switch -CaseSensitive ($action) {
    'invoke' { $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    'focus' { $element.SetFocus() }
    'setvalue' {
      $value = [string]$request.value
      if ($value.Length -gt 4000) { throw '要填写的文字太长' }
      $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($value)
    }
    'scroll' {
      $vertical = [System.Windows.Automation.ScrollAmount]::NoAmount
      $horizontal = [System.Windows.Automation.ScrollAmount]::NoAmount
      switch -CaseSensitive ([string]$request.value) {
        'up' { $vertical = [System.Windows.Automation.ScrollAmount]::SmallDecrement }
        'down' { $vertical = [System.Windows.Automation.ScrollAmount]::SmallIncrement }
        'left' { $horizontal = [System.Windows.Automation.ScrollAmount]::SmallDecrement }
        'right' { $horizontal = [System.Windows.Automation.ScrollAmount]::SmallIncrement }
        'pageup' { $vertical = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
        'pagedown' { $vertical = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
        default { throw '不支持的滚动方向' }
      }
      $element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Scroll($horizontal, $vertical)
    }
    default { throw '不支持的窗口操作' }
  }
  @{ ok = $true; message = '已执行窗口控件操作' }
}
try {
  $inputText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
  $request = $inputText | ConvertFrom-Json
  if ($request.mode -ceq 'capture') { $result = Capture-Desktop $request }
  elseif ($request.mode -ceq 'execute') { $result = Execute-Desktop $request }
  else { throw '不支持的请求' }
  Say ($result | ConvertTo-Json -Depth 12 -Compress)
} catch { Say (@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress) }
`;

export const MAC_DESKTOP_HELPER = String.raw`
ObjC.import('Foundation');
function attr(element, name) { try { return element.attributes.byName(name).value(); } catch (_) { return null; } }
function nativePath(value) {
  const text = String(value || '');
  if (text.charAt(0) === '/') return text;
  const m = /^file:\/\/(?:localhost)?(\/.*)$/.exec(text);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (_) { return ''; }
}
const result = { app: '', title: '', windowId: '', pid: 0, files: [], selectedText: '', controls: [], warnings: [] };
try {
  const se = Application('System Events');
  const front = se.applicationProcesses.whose({frontmost: true})[0];
  result.app = String(front.name() || '');
  result.pid = Number(front.unixId());
  const win = attr(front, 'AXFocusedWindow');
  if (win) {
    result.title = String(attr(win, 'AXTitle') || '');
    result.windowId = String(result.pid) + ':' + result.title;
    const pos = attr(win, 'AXPosition'), size = attr(win, 'AXSize');
    if (pos && size) result.bounds = { x: Number(pos[0]), y: Number(pos[1]), w: Number(size[0]), h: Number(size[1]) };
    const file = nativePath(attr(win, 'AXDocument'));
    if (file) result.files.push(file);
  }
  const focused = attr(front, 'AXFocusedUIElement');
  if (focused && String(attr(focused, 'AXSubrole')) !== 'AXSecureTextField') result.selectedText = String(attr(focused, 'AXSelectedText') || '').slice(0, 20000);
  if (result.app === 'Finder') result.files = Application('Finder').selection().slice(0, 200).map(item => { try { return nativePath(item.url()); } catch (_) { return ''; } }).filter(Boolean);
  result.warnings.push('macOS 当前只读取前台上下文，暂不提供窗口控件操作');
} catch (error) { result.warnings.push('无法读取完整前台窗口信息，请检查自动化和辅助功能权限：' + String(error.message || error).slice(0, 180)); }
const ascii = JSON.stringify(result).replace(/[\u0080-\uffff]/g, c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
$.NSFileHandle.fileHandleWithStandardOutput.writeData($(ascii + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
`;

function scriptRequest(command, args, script, request, timeoutMs, extension) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-context-'));
  const file = path.join(dir, `helper.${extension}`);
  fs.writeFileSync(file, (extension === 'ps1' ? '\uFEFF' : '') + script, { encoding: 'utf8', mode: 0o600 });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn(command, [...args, file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('读取或操作窗口超时，请重新按 F8 后重试')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.length > 4_000_000) { child.kill(); finish(new Error('窗口辅助功能返回的内容过多')); }
    });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-1000); });
    child.once('error', finish);
    child.once('close', (code) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (settled) return;
      try {
        const line = stdout.trim().split(/\r?\n/).reverse().find((s) => s.startsWith('{'));
        if (!line) throw new Error(code ? `窗口辅助程序退出（${code}）：${stderr.slice(0, 180)}` : '窗口辅助程序未返回信息');
        const result = JSON.parse(line);
        if (result.error) throw new Error(String(result.error));
        finish(null, result);
      } catch (error) { finish(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(JSON.stringify(request), 'utf8').toString('base64'));
  });
}

const exec = (command, args, timeout) => new Promise((resolve, reject) => execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 128_000 }, (err, out) => err ? reject(err) : resolve(out)));
function xText(output, name) {
  const line = output.split('\n').find((s) => s.startsWith(name + ' = '));
  if (!line) return '';
  const value = line.slice(line.indexOf(' = ') + 3);
  try { return JSON.parse(value); } catch { return value.replace(/^"|"$/g, ''); }
}
async function linuxContext(timeoutMs) {
  if (!process.env.DISPLAY) throw new Error('当前没有 X11 显示连接；Wayland 下暂不能读取前台窗口');
  const active = await exec('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW'], timeoutMs);
  const windowId = /0x[0-9a-f]+/i.exec(active)?.[0];
  if (!windowId || windowId === '0x0') throw new Error('X11 没有提供活动窗口信息');
  const details = await exec('xprop', ['-id', windowId, '-notype', '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_PID'], timeoutMs);
  const processId = Number(/_NET_WM_PID = (\d+)/.exec(details)?.[1]) || 0;
  const app = /WM_CLASS = "[^"]*", "([^"]*)"/.exec(details)?.[1] || '';
  return { app, title: xText(details, '_NET_WM_NAME') || xText(details, 'WM_NAME'), windowId, pid: processId, files: [], selectedText: '', controls: [], warnings: ['Linux 当前仅提供 X11 前台窗口信息，文件请通过选择文件添加，暂不提供窗口控件操作'] };
}

async function nativeRequest(platform, request, timeoutMs) {
  if (platform === 'win32') return scriptRequest(powershellPath(), POWERSHELL_ARGS, WINDOWS_DESKTOP_HELPER, request, timeoutMs, 'ps1');
  if (request.mode !== 'capture') throw new Error('当前系统暂不支持窗口控件操作');
  if (platform === 'darwin') return scriptRequest('/usr/bin/osascript', ['-l', 'JavaScript'], MAC_DESKTOP_HELPER, request, timeoutMs, 'js');
  if (platform === 'linux') return linuxContext(timeoutMs);
  throw new Error('当前系统暂不支持前台窗口上下文');
}

function boundsOf(value) {
  if (!value || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(value[k])) || value.w < 0 || value.h < 0) return null;
  return { x: value.x, y: value.y, w: value.w, h: value.h };
}
function existingPath(raw, platform, isFile) {
  if (typeof raw !== 'string' || raw.length > 32768 || raw.includes('\0')) return null;
  let candidate = raw;
  if (/^file:/i.test(candidate)) {
    try { candidate = fileURLToPath(candidate); } catch { return null; }
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(candidate)) return null;
  // Avoid making an unsolicited network file access while merely inspecting a document.
  if (platform === 'win32' && (/^[\\/]{2}/.test(candidate) || /^\\\\[?.]\\/.test(candidate))) return null;
  try { return isFile(candidate) ? paths.normalize(candidate) : null; } catch { return null; }
}

function fileStamp(file) {
  try { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`; }
  catch { return null; }
}

/** Factory for native-adapter tests; app code normally uses the two exports below. */
export function createDesktopBridge({ platform = process.platform, request = nativeRequest, now = Date.now, isFile = (p) => fs.statSync(p).isFile() } = {}) {
  const known = new WeakMap();
  return {
    async captureContext({ timeoutMs = 8000, windowId } = {}) {
      let raw;
      try { raw = await request(platform, { mode: 'capture', ...(typeof windowId === 'string' && /^\d+$/.test(windowId) ? { windowId } : {}) }, Math.max(1000, Math.min(15000, timeoutMs))); }
      catch (error) { raw = { warnings: [clip(String(error?.message || error), 400)] }; }
      const snapshot = {
        id: crypto.randomUUID(), capturedAt: now(), platform,
        app: clip(raw.app, 200), title: clip(raw.title, 2000), windowId: clip(raw.windowId, 200),
        pid: Number.isSafeInteger(raw.pid) && raw.pid > 0 ? raw.pid : 0,
        bounds: boundsOf(raw.bounds), files: [], selectedText: clip(raw.selectedText, 20000), controls: [], visibleFiles: [],
        fileSurface: { kind: 'none', folder: '', coordinateSpace: 'screen-physical', truncated: false, itemCount: 0 },
        warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).slice(0, 10).map((w) => clip(w, 400)).filter(Boolean),
      };
      snapshot.files = [...new Set((Array.isArray(raw.files) ? raw.files : []).slice(0, 200).map((p) => existingPath(p, platform, isFile)).filter(Boolean))];
      if (platform === 'win32' && ['desktop', 'explorer'].includes(raw.fileSurface?.kind)) {
        const surface = raw.fileSurface;
        const entries = (Array.isArray(surface.entries) ? surface.entries : []).slice(0, 5000).filter(e => e && typeof e.path === 'string' && typeof e.name === 'string');
        snapshot.fileSurface = { kind: surface.kind, folder: clip(surface.folder, 32768), coordinateSpace: 'screen-physical', truncated: Boolean(surface.truncated), itemCount: 0 };
        for (const row of (Array.isArray(surface.rows) ? surface.rows : []).slice(0, 500)) {
          if (!row || !validRect(row.bounds)) continue;
          const direct = typeof row.path === 'string' ? entries.filter(entry => entry.path === row.path) : [];
          const candidates = direct.length ? direct : candidatesForItem(row.name, entries);
          const file = candidates.length === 1 && existingPath(candidates[0].path, platform, isFile);
          const bounds = boundsOf(row.bounds);
          snapshot.visibleFiles.push({ id: `f${snapshot.visibleFiles.length + 1}`, name: clip(row.name, 400), path: file || null, bounds,
            hitBounds: (Array.isArray(row.hitBounds) ? row.hitBounds : []).slice(0, 4).filter(validRect).map(boundsOf),
            status: file ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'unresolved', candidateCount: candidates.length });
        }
        snapshot.fileSurface.itemCount = snapshot.visibleFiles.length;
      }
      const descriptors = new Map();
      const identityKnown = platform === 'win32' && /^\d+$/.test(snapshot.windowId) && snapshot.pid > 0 && typeof raw._processStamp === 'string' && /^\d+$/.test(raw._processStamp) && typeof raw._rootRuntimeId === 'string' && /^-?\d+(,-?\d+)*$/.test(raw._rootRuntimeId);
      for (const row of (Array.isArray(raw.controls) ? raw.controls : []).slice(0, MAX_CONTROLS)) {
        if (!row || row.password) continue;
        const id = `c${snapshot.controls.length + 1}`;
        const runtimeId = clip(row._runtimeId, 300);
        const actions = identityKnown && /^-?\d+(,-?\d+)*$/.test(runtimeId) ? [...new Set((Array.isArray(row.actions) ? row.actions : []).filter((a) => ACTIONS.has(a)))] : [];
        const name = clip(row.name, 400), role = clip(row.role, 100);
        snapshot.controls.push({ id, name, role, actions, bounds: boundsOf(row.bounds) });
        descriptors.set(id, { runtimeId, automationId: clip(row._automationId, 1000), name, role, actions: [...actions] });
      }
      known.set(snapshot, { capturedAt: snapshot.capturedAt, visibleFiles: structuredClone(snapshot.visibleFiles), fileSurface: { ...snapshot.fileSurface }, fileStamps: new Map(snapshot.visibleFiles.filter(item => item.path).map(item => [item.path, fileStamp(item.path)])), expected: { windowId: snapshot.windowId, pid: snapshot.pid, title: snapshot.title, processStamp: raw._processStamp, rootRuntimeId: raw._rootRuntimeId }, descriptors });
      return snapshot;
    },
    resolveSnapshotFiles(snapshot, region) {
      const captured = snapshot && known.get(snapshot);
      const failure = (message) => ({ ok: false, files: [], items: [], unresolved: [], warnings: [message] });
      if (!captured || now() - captured.capturedAt > MAX_AGE) return failure('文件图标快照已失效，请重新按 F8 后框选。');
      if (captured.fileSurface.kind === 'none') return failure('请先打开资源管理器文件夹或桌面，再按 F8 框选文件图标。');
      const result = filesInRegion(captured.visibleFiles, region);
      const stale = result.items.filter(item => item.path && (!existingPath(item.path, platform, isFile) || (captured.fileStamps.get(item.path) && fileStamp(item.path) !== captured.fileStamps.get(item.path))));
      if (stale.length) return { ...result, ok: false, files: [], warnings: [...result.warnings, '框选的文件已改变、移动或删除，请重新按 F8。'] };
      if (captured.fileSurface.truncated) result.warnings.push('此视图的文件列表未完整读取，建议缩小文件夹范围后重新框选。');
      return result;
    },
    async executeContextAction(snapshot, { controlId, action, value } = {}) {
      const captured = snapshot && known.get(snapshot);
      if (!captured) return { ok: false, message: '窗口上下文无效，请重新按 F8' };
      if (now() - captured.capturedAt > MAX_AGE) return { ok: false, message: '窗口上下文已过期，请重新按 F8' };
      const control = captured.descriptors.get(controlId);
      if (!control || !ACTIONS.has(action) || !control.actions.includes(action)) return { ok: false, message: '此快照中没有支持该操作的控件' };
      if (action === 'setvalue' && (typeof value !== 'string' || value.length > 4000 || value.includes('\0'))) return { ok: false, message: '填写内容无效或超过 4000 字符' };
      if (action === 'scroll' && !DIRECTIONS.has(value)) return { ok: false, message: '不支持的滚动方向' };
      try {
        const result = await request(platform, { mode: 'execute', expected: captured.expected, control, action, ...(['setvalue', 'scroll'].includes(action) ? { value } : {}) }, 8000);
        return { ok: result.ok === true, message: clip(result.message, 400) || (result.ok ? '已执行窗口控件操作' : '窗口操作未完成') };
      } catch (error) { return { ok: false, message: clip(String(error?.message || error), 400) }; }
    },
  };
}

const desktop = createDesktopBridge();
export const captureContext = (options) => desktop.captureContext(options);
export const executeContextAction = (snapshot, action) => desktop.executeContextAction(snapshot, action);
export const resolveSnapshotFiles = (snapshot, region) => desktop.resolveSnapshotFiles(snapshot, region);
