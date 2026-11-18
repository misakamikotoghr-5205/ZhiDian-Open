// Windows only: checks the selection helper against a real Explorer window. Opens a folder,
// selects two files in it the way a person would have (through Explorer's own object model),
// and waits for the helper to report exactly those files.
//
//   node test/win/selection-helper.mjs
//
// On your own machine, leave the mouse and keyboard alone while it runs (about a minute): to get
// its Explorer window to the front it may press Alt and click that window's status bar, and with
// that window in front it presses Ctrl+T, Ctrl+Shift+Tab, Ctrl+Tab and Ctrl+W to try a second tab.
//
// A build machine's desktop is not a person's, so every step says what it found, and the last
// line says which of three things happened:
//   system:    Windows and PowerShell versions, the apartment, the session and whether it is
//              interactive, how PowerShell writes a single file, whether the helper script parses
//   helper:    whether the helper started
//   explorer:  per try: is there a window on the folder, how many of the two files got selected,
//              is the window in front (and what it took), what is in front instead
//   direct:    what the helper's own functions answer when asked at that moment
//   watcher:   whether the running helper reported the two files
//   tabs:      where Explorer has tabs: the same with a second tab in front, then behind
//   RESULT: VERIFIED      exit 0   the running helper reported the two files
//   RESULT: WRONG         exit 1   the scene was there and the helper answered something else
//   RESULT: INCONCLUSIVE  exit 2   the scene could not be set up here (no window, nothing
//                                  selected, window not in front): nothing is known about the helper
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POWERSHELL_ARGS, SelectionWatcher, WINDOWS_HELPER, powershellPath } from '../../src/main/context/watch.js';

if (process.platform !== 'win32') {
  console.log('skipped: this check is for Windows');
  process.exit(0);
}

// No backtick and no dollar-brace in the PowerShell below: it sits in template literals.

// Facts about the machine, and whether the helper script is PowerShell at all. Stands alone: it
// must still answer when the helper does not.
const FACTS = String.raw`
$ErrorActionPreference = 'Continue'
$tokens = $null
$problems = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($env:ZHIDIAN_TEST_HELPER, [ref]$tokens, [ref]$problems)
$facts = @{
  powershell = $PSVersionTable.PSVersion.ToString()
  apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString()
  language = $ExecutionContext.SessionState.LanguageMode.ToString()
  os = [System.Environment]::OSVersion.Version.ToString()
  session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  interactive = [System.Environment]::UserInteractive
  shells = @(Get-Process -Name explorer -ErrorAction SilentlyContinue).Count
  oneFile = (@{ files = @('a'); text = '' } | ConvertTo-Json -Compress)
  parse = @($problems | ForEach-Object { 'line ' + $_.Extent.StartLineNumber + ': ' + $_.Message })
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes(($facts | ConvertTo-Json -Compress) + [char]10)
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
`;

// Runs after everything the helper defines (its part above "# -- watch --"), so that what is
// asked here is the helper's own Get-Selection, Get-FolderFiles and tab lookup, not a copy of them.
//   scene  find the folder's window, select the two files, bring the window to the front
//   look   only look
//   tabs   open a second tab, look, switch back, look, close the second tab
//   close  close the window
const PROBE = String.raw`
$ErrorActionPreference = 'Continue'
Add-Type -IgnoreWarnings -Namespace Zhidian -Name Test -MemberDefinition @'
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int how);
[DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
[DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint which);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

public static bool Front(IntPtr h) { return GetForegroundWindow() == h; }
public static string Title(IntPtr h) { System.Text.StringBuilder text = new System.Text.StringBuilder(256); GetWindowText(h, text, 256); return text.ToString(); }
public static int ProcessOf(IntPtr h) { uint id; GetWindowThreadProcessId(h, out id); return (int)id; }
// Presses the keys in this order and lets them go in the other.
public static void Keys(byte[] keys) {
  foreach (byte key in keys) keybd_event(key, 0, 0, UIntPtr.Zero);
  System.Threading.Thread.Sleep(60);
  for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2, UIntPtr.Zero);
}
// Brings a window to the front, the mildest way first; says which way worked, or "".
public static string BringToFront(IntPtr h) {
  if (IsIconic(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(300); }
  if (Front(h)) return "it already was";
  SetForegroundWindow(h);
  System.Threading.Thread.Sleep(300);
  if (Front(h)) return "SetForegroundWindow";
  // Windows lets the process that received the last input do it: a key press is such an input.
  keybd_event(0x12, 0, 0, UIntPtr.Zero);
  SetForegroundWindow(h);
  keybd_event(0x12, 0, 2, UIntPtr.Zero);
  System.Threading.Thread.Sleep(300);
  if (Front(h)) return "Alt key, then SetForegroundWindow";
  // What a person would do: click on it. On its status bar, where a click selects nothing,
  // and only if that spot really shows this window.
  RECT r;
  if (!GetWindowRect(h, out r)) return "";
  POINT p;
  p.X = (r.Left + r.Right) / 2;
  p.Y = r.Bottom - 12;
  if (GetAncestor(WindowFromPoint(p), 2) != h) return "";
  SetCursorPos(p.X, p.Y);
  mouse_event(2, 0, 0, 0, UIntPtr.Zero);
  System.Threading.Thread.Sleep(80);
  mouse_event(4, 0, 0, 0, UIntPtr.Zero);
  System.Threading.Thread.Sleep(500);
  return Front(h) ? "a click on its status bar" : "";
}
'@

$dir = $env:ZHIDIAN_TEST_DIR
$stage = $env:ZHIDIAN_TEST_STAGE
$notes = @()
$r = @{ stage = $stage; found = $false; front = $false }

function Describe($h) {
  if ($h.ToInt64() -eq 0) { return 'no window at all' }
  $id = [Zhidian.Test]::ProcessOf($h)
  $exe = ''
  try { $exe = [System.Diagnostics.Process]::GetProcessById($id).ProcessName } catch {}
  (Get-WindowClass $h) + ' "' + [Zhidian.Test]::Title($h) + '" of ' + $exe + ' (' + $id + ')'
}

# The window that shows the folder, and what else the shell lists.
$w = $null
$open = @()
foreach ($x in $shell.Windows()) {
  try {
    $where = [string]$x.Document.Folder.Self.Path
    $open += $where
    if ($where -eq $dir) { $w = $x }
  } catch { $open += '?' }
}
$r.open = $open

if ($w) {
  $h = [IntPtr][long]$w.HWND
  $r.found = $true
  $r.hwndType = $w.HWND.GetType().Name
  if ($stage -eq 'scene') {
    $first = $true
    foreach ($n in $env:ZHIDIAN_TEST_NAMES.Split('|')) {
      try {
        $item = $w.Document.Folder.ParseName($n)
        if ($item) {
          # ShellFolderView.SelectItem: 1 select, 4 deselect all others, 8 scroll into view
          if ($first) { [void]$w.Document.SelectItem($item, 13) } else { [void]$w.Document.SelectItem($item, 1) }
          $first = $false
        } else { $notes += 'the folder has no item called ' + $n }
      } catch { $notes += 'SelectItem: ' + $_.Exception.Message }
    }
    Start-Sleep -Milliseconds 400
    $r.how = [Zhidian.Test]::BringToFront($h)
  }
  $mineTab = 0
  if ($tabsMissing -eq '') { $mineTab = [Zhidian.Tabs]::Of($w).ToInt64() } else { $notes += 'the piece that tells tabs apart did not compile: ' + $tabsMissing }
  $entries = { @($shell.Windows() | Where-Object { [long]$_.HWND -eq $h.ToInt64() }).Count }
  $frontTab = { [Zhidian.Native]::FindWindowEx($h, [IntPtr]::Zero, 'ShellTabWindowClass', [IntPtr]::Zero).ToInt64() }
  $r.selected = [int]$w.Document.SelectedItems().Count
  $r.front = [Zhidian.Test]::Front($h)
  $r.entries = & $entries
  $r.tab = & $frontTab
  $r.tabOf = $mineTab
  # What the helper's own functions say, asked right now.
  $r.folderFiles = @(Get-FolderFiles $h)
  $r.selection = Get-Selection

  if ($stage -eq 'tabs' -and $r.front) {
    [Zhidian.Test]::Keys([byte[]](0x11, 0x54))
    Start-Sleep -Milliseconds 2500
    $r.entriesWithNewTab = & $entries
    $r.newTabInFront = (& $frontTab) -ne $mineTab
    $r.selectionBehind = Get-Selection
    if ($r.entriesWithNewTab -gt $r.entries) {
      [Zhidian.Test]::Keys([byte[]](0x11, 0x10, 0x09))
      Start-Sleep -Milliseconds 1500
      $r.oursInFront = (& $frontTab) -eq $mineTab
      $r.selectionInFront = Get-Selection
      # Close the second tab again, but only when it is certain that it is the one in front.
      [Zhidian.Test]::Keys([byte[]](0x11, 0x09))
      Start-Sleep -Milliseconds 1000
      if (($mineTab -ne 0) -and ((& $frontTab) -ne $mineTab) -and [Zhidian.Test]::Front($h)) {
        [Zhidian.Test]::Keys([byte[]](0x11, 0x57))
        Start-Sleep -Milliseconds 1000
      }
      $r.entriesAfter = & $entries
    }
  }
  if ($stage -eq 'close') { try { $w.Quit() } catch { $notes += 'Quit: ' + $_.Exception.Message } }
}
$r.inFront = Describe ([Zhidian.Native]::GetForegroundWindow())

if ($stage -eq 'scene') {
  # Is the desktop found the way the helper looks for it?
  try {
    $desk = $shell.Windows().Item([uint32]8)
    if ($desk) { $r.desktop = (Get-WindowClass ([IntPtr][long]$desk.HWND)) + ' showing ' + [string]$desk.Document.Folder.Self.Path } else { $r.desktop = 'Item(8) gave nothing' }
  } catch { $r.desktop = 'Item(8) failed: ' + $_.Exception.Message }
}
$r.notes = $notes
Say ($r | ConvertTo-Json -Compress -Depth 4)
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The long form of the path: os.tmpdir() can be the 8.3 short form (RUNNER~1), which is not
// what Explorer reports.
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-sel-')));
const dir = path.join(work, 'folder');
const helperDir = path.join(work, 'helper');
fs.mkdirSync(dir);
const names = ['报告.docx', 'photo.png', 'notes.txt'];
for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
const want = [path.join(dir, names[0]), path.join(dir, names[1])];
const same = (files) => Array.isArray(files) && files.length === want.length && want.every((f) => files.some((g) => String(g).toLowerCase() === f.toLowerCase()));
const ours = (files) => Array.isArray(files) && files.some((g) => want.some((f) => String(g).toLowerCase() === f.toLowerCase()));
const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Runs a script the way the helper is run. Its answer is its last line of JSON; {} if none. */
function ps(name, script, env = {}) {
  const file = path.join(work, name);
  fs.writeFileSync(file, '\uFEFF' + script, 'utf8');
  const r = spawnSync(powershellPath(), [...POWERSHELL_ARGS, file], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, ZHIDIAN_TEST_DIR: dir, ZHIDIAN_TEST_NAMES: names.slice(0, 2).join('|'), ...env },
  });
  const answer = parsed(String(r.stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('{')).pop() ?? '');
  const stderr = String(r.stderr ?? '').trim().slice(0, 800);
  if (!answer) console.log(`  ${name}: no answer (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})${stderr ? `: ${stderr}` : ''}`);
  else if (stderr) console.log(`  ${name} wrote to stderr: ${stderr}`);
  return answer ?? {};
}

const parts = WINDOWS_HELPER.split('# -- watch --');
if (parts.length !== 2) {
  console.log('RESULT: WRONG: the helper script has no "# -- watch --" line any more; this check runs what is above it');
  process.exit(1);
}
const probe = (stage) => ps(`probe-${stage}.ps1`, parts[0] + PROBE, { ZHIDIAN_TEST_STAGE: stage });

const watcher = new SelectionWatcher({ dir: helperDir });
const seen = [];
watcher.on('selection', (s) => {
  seen.push(s);
  console.log('  the running helper reported:', JSON.stringify(s));
});
const reported = () => seen.some((s) => same(s.files));
let windowOpened = false;

function finish(code, verdict, why) {
  if (windowOpened) probe('close');
  watcher.stop();
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // Explorer may still hold the folder
  }
  console.log(`RESULT: ${verdict}: ${why}`);
  process.exit(code);
}

// ---- system
watcher.start(); // writes the helper script, which the next step reads
const facts = ps('facts.ps1', FACTS, { ZHIDIAN_TEST_HELPER: path.join(helperDir, 'zhidian-selection.ps1') });
if (!facts.powershell) console.log('system: PowerShell gave no facts');
else {
  console.log(`system: Windows ${facts.os}, PowerShell ${facts.powershell} (${facts.apartment}, ${facts.language}), session ${facts.session}, interactive: ${facts.interactive}, explorer.exe processes: ${facts.shells}`);
  console.log(`system: PowerShell writes one file as ${facts.oneFile} ${Array.isArray(parsed(facts.oneFile)?.files) ? '(an array, as the app expects)' : '(NOT an array: the app would drop it)'}`);
  console.log(facts.parse?.length ? `system: the helper script does NOT parse:\n  ${facts.parse.join('\n  ')}` : 'system: the helper script parses');
}

// ---- helper
for (let i = 0; i < 300 && watcher.status === 'starting'; i++) await sleep(200);
console.log(`helper: ${watcher.status}${watcher.error ? ` (${watcher.error})` : ''}`);
if (watcher.status !== 'running') finish(1, 'WRONG', `the helper did not start: ${watcher.status} ${watcher.error}`);

// ---- explorer
spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir], { detached: true, stdio: 'ignore' }).unref();
let scene = {};
let before = '';
for (let i = 1; i <= 12; i++) {
  await sleep(i === 1 ? 3000 : 1500);
  scene = probe('scene');
  windowOpened ||= Boolean(scene.found);
  const state = [
    !scene.found
      ? `no window on the folder; the shell lists ${JSON.stringify(scene.open ?? [])}; in front: ${scene.inFront}`
      : `window found, ${scene.selected} of 2 files selected, ${scene.front ? `in front (${scene.how})` : `NOT in front; in front: ${scene.inFront}`}`,
    ...(scene.notes ?? []).map((n) => `  note: ${n}`),
  ].join('\n');
  // Twelve tries that all find the same are one piece of news.
  console.log(state === before ? `explorer (try ${i}): the same` : `explorer (try ${i}): ${state}`);
  before = state;
  if (scene.found && scene.selected === 2 && scene.front) break;
}
const direct = parsed(scene.selection)?.files;
if (scene.found) {
  console.log(`explorer: HWND arrives as ${scene.hwndType}; entries with this window: ${scene.entries}; tab in front: ${scene.tab}, tab of this entry: ${scene.tabOf}; desktop: ${scene.desktop}`);
  console.log(`direct: Get-FolderFiles for this window: ${JSON.stringify(scene.folderFiles)}${same(scene.folderFiles) ? '' : '  <- not the two files'}`);
  console.log(`direct: Get-Selection: ${scene.selection}${scene.front ? (same(direct) ? '' : '  <- not the two files') : ours(direct) ? '  <- files of a window that is not in front' : '  (the window is not in front: no files is the right answer)'}`);
}

// ---- watcher
for (let i = 0; i < 40 && !reported(); i++) await sleep(500);
console.log(`watcher: ${reported() ? 'reported the two files' : `did not report the two files within 20 s; its last report: ${JSON.stringify(watcher.latest())}`} (status ${watcher.status}${watcher.error ? `, ${watcher.error}` : ''})`);

let code;
let verdict;
let why;
const say = (c, v, w) => {
  code = c;
  verdict = v;
  why = w;
};
if (reported()) say(0, 'VERIFIED', 'the running helper reported the two files selected in Explorer');
else if (!scene.found) say(2, 'INCONCLUSIVE', `Explorer showed no window on the folder (session ${facts.session}, interactive: ${facts.interactive}, the shell lists ${JSON.stringify(scene.open ?? [])})`);
else if (scene.selected !== 2) say(2, 'INCONCLUSIVE', `the two files could not be selected through Explorer (${scene.selected} selected)`);
else if (!same(scene.folderFiles)) say(1, 'WRONG', `two files are selected in the window, but Get-FolderFiles for that window answered ${JSON.stringify(scene.folderFiles)}`);
else if (!scene.front && ours(direct)) say(1, 'WRONG', `the window was not in front (in front: ${scene.inFront}), and Get-Selection reported its files all the same: ${scene.selection}`);
else if (!scene.front) say(2, 'INCONCLUSIVE', `the window could not be brought to the front (in front: ${scene.inFront}), and the helper reads only the window in front. Asked for this window by its handle, it did give the two files`);
else if (!same(direct)) say(1, 'WRONG', `the window was in front with the two files selected, but Get-Selection answered ${scene.selection}`);
else {
  const look = probe('look');
  if (look.front) say(1, 'WRONG', 'Get-Selection gives the two files when asked and the window is still in front, but the running helper did not report them');
  else say(2, 'INCONCLUSIVE', `Get-Selection gave the two files when asked, but the window did not stay in front for the running helper to see (in front now: ${look.inFront})`);
}

// ---- tabs (Windows 11 and Server 2025: every tab is a shell window with the same HWND)
if (scene.found && scene.front) {
  const t = probe('tabs');
  const behind = parsed(t.selectionBehind);
  const inFront = parsed(t.selectionInFront);
  let line;
  let wrong = false;
  if (!t.found || !t.front) line = 'not checked: the window was no longer in front';
  else if (!(t.entriesWithNewTab > t.entries)) line = `not checked: Ctrl+T opened no second tab (entries with this window: ${t.entries}, then ${t.entriesWithNewTab}); this Explorer has no tabs, or the keys did not arrive`;
  else if (t.tabOf === 0) [wrong, line] = [true, `the tab of a window object could not be told (the lookup gave 0; the tab in front is ${t.tab}), so with two tabs open nothing can be reported`];
  else if (t.newTabInFront && ours(behind?.files)) [wrong, line] = [true, `with another tab in front, the files of the hidden tab were reported: ${t.selectionBehind}`];
  else if (!t.oursInFront) line = `checked in part: with the new tab in front the hidden tab's files were not reported (${t.selectionBehind}); switching back did not work`;
  else if (!same(inFront?.files)) [wrong, line] = [true, `with two tabs open and the tab with the files in front, Get-Selection answered ${t.selectionInFront}`];
  else line = `right: with a second tab in front the hidden tab's files were not reported (${t.selectionBehind}); back in front they were. Entries afterwards: ${t.entriesAfter}`;
  console.log(`tabs: ${wrong ? 'WRONG: ' : ''}${line}`);
  for (const n of t.notes ?? []) console.log(`  note: ${n}`);
  if (wrong) say(1, 'WRONG', code === 0 ? `one tab works, but ${line}` : `${why}; and ${line}`);
}

finish(code, verdict, why);
