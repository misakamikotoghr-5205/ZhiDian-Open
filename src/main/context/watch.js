// Knows what the person has selected in other applications: files in the file manager, or a
// piece of text. That is what turns "select something" into an offer of things to do with it.
//
// There is no cross-platform way to ask this, and no native module in this app, so each system
// is asked through what it ships with:
//   Windows  one long-lived PowerShell process: the selection of the folder window in front (of
//            its tab in front, on Windows 11) or of the desktop through the shell's COM objects,
//            selected text through UI Automation. It looks when the mouse button is released
//            and once a second besides (for selections made with the keyboard).
//   macOS    one long-lived osascript (JavaScript for Automation): Finder's selection, and the
//            selected text of the focused element through the accessibility API. macOS asks
//            the person for permission the first time; until it is given, nothing is reported.
//   Linux    the X11 primary selection for text (it is what "select to copy" already uses).
//            File managers offer nothing comparable; files come in through the file picker.
// Nothing is read from the clipboard and no keystrokes are sent.
//
// Neither helper can be run where this is developed. What they rely on, and where it is written:
//   - Add-Type -MemberDefinition imports System and System.Runtime.InteropServices, and treats
//     compiler warnings as errors unless told otherwise (Add-Type, PowerShell 5.1 reference).
//   - Shell.Windows() also holds Internet Explorer windows; Item(VT_UI4 8) is the desktop
//     (IShellWindows::Item, ShellWindowTypeConstants: SWC_DESKTOP).
//   - On Windows 11 every tab is a window object of its own with the frame's HWND; the tab is
//     told by IShellBrowser::GetWindow (through IServiceProvider, SID_STopLevelBrowser), the one
//     in front is first in z-order, and from an MTA thread these calls hand back null windows.
//     Not documented by Microsoft: this is what programs that work with Explorer's tabs do.
//   - So the helper runs in a single-threaded apartment, which Windows PowerShell 3 and later
//     start in anyway (about_PowerShell_exe). UI Automation's advice to call from an MTA thread
//     is about event handlers and about a client's own windows; the helper has neither.
//   - GetAsyncKeyState sees the physical buttons, answers 0 when the window in front belongs to
//     an elevated program, and its lowest bit is a hint only (GetAsyncKeyState reference). UI
//     Automation gives nothing for an elevated program either: no text is reported there.
//   - In JavaScript for Automation delay() is the only way to wait; a Finder item has no path,
//     only a url (JXA Cookbook); Automation.getDisplayString() gives an item's specifier as text.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// No backtick and no dollar-brace in the two scripts: they are template literals here.
// test/win/selection-helper.mjs runs everything above the "# -- watch --" line by itself.
export const WINDOWS_HELPER = String.raw`
# Says what is selected in the window the person is working in: one JSON object per line.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stdout = [Console]::OpenStandardOutput()
function Say([string]$line) {
  # As UTF-8 bytes: [Console]::Out would write a file name in whatever code page the console has.
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($line + [char]10)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
try {
  Add-Type -Namespace Zhidian -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, IntPtr title);
'@
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $shell = New-Object -ComObject Shell.Application
} catch {
  # Without these nothing can be read. Say why and end, rather than run on as if all were well.
  $bytes = [System.Text.Encoding]::UTF8.GetBytes("$_" + [char]10)
  $stderr = [Console]::OpenStandardError()
  $stderr.Write($bytes, 0, $bytes.Length)
  exit 1
}
# Telling the tabs of a folder window apart is a piece of its own: should it not compile on some
# machine, everything else still works, and a window with several tabs reports nothing.
$tabsMissing = ''   # or why that piece is missing
try {
  Add-Type -IgnoreWarnings -Namespace Zhidian -Name Tabs -MemberDefinition @'
[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IServices { [PreserveSig] int QueryService(ref Guid service, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IBrowser browser); }
[ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBrowser { [PreserveSig] int GetWindow(out IntPtr hwnd); }

// The window of the tab that one of the shell's window objects stands for; zero when it cannot be told.
// (IServiceProvider::QueryService(SID_STopLevelBrowser, IID_IShellBrowser), then IOleWindow::GetWindow.)
public static IntPtr Of(object window) {
  try {
    IServices services = window as IServices;
    if (services == null) return IntPtr.Zero;
    Guid topLevelBrowser = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
    Guid shellBrowser = new Guid("000214E2-0000-0000-C000-000000000046");
    IBrowser browser;
    IntPtr hwnd;
    if (services.QueryService(ref topLevelBrowser, ref shellBrowser, out browser) != 0 || browser == null) return IntPtr.Zero;
    return browser.GetWindow(out hwnd) == 0 ? hwnd : IntPtr.Zero;
  } catch (Exception) {
    return IntPtr.Zero;
  }
}
'@
} catch {
  $tabsMissing = "$_"
}
$ErrorActionPreference = 'SilentlyContinue'

function Get-WindowClass($hwnd) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][Zhidian.Native]::GetClassName($hwnd, $sb, 256)
  $sb.ToString()
}

# The files selected in a folder window, given its top-level window.
function Get-FolderFiles($hwnd) {
  $files = @()
  $mine = @()
  # The shell's list also holds Internet Explorer windows, and an entry can be null while a window
  # closes: those have another window, no window, or no selection to give, and fall out below.
  foreach ($w in $shell.Windows()) {
    try { if ([long]$w.HWND -eq $hwnd.ToInt64()) { $mine += $w } } catch {}
  }
  if ($mine.Count -gt 1) {
    # Windows 11: every tab is an entry of its own with the same top-level window. Only the tab in
    # front is what the person sees: it is the first ShellTabWindowClass child of that window.
    # If the tabs cannot be told apart, nothing is reported rather than the files of a hidden tab.
    $tab = [Zhidian.Native]::FindWindowEx($hwnd, [IntPtr]::Zero, 'ShellTabWindowClass', [IntPtr]::Zero).ToInt64()
    $mine = @($mine | Where-Object { ($tabsMissing -eq '') -and ($tab -ne 0) -and ([Zhidian.Tabs]::Of($_).ToInt64() -eq $tab) })
  }
  foreach ($w in $mine) {
    try { foreach ($item in $w.Document.SelectedItems()) { if ($item.Path) { $files += [string]$item.Path } } } catch {}
  }
  $files
}

# The icons selected on the desktop, given the desktop's window.
function Get-DesktopFiles($hwnd) {
  $files = @()
  $known = $false
  try {
    # The desktop is a shell window too, though not a listed one: it is asked for by its type
    # (SWC_DESKTOP = 8, which must arrive as an unsigned number or it is taken for an index).
    $desk = $shell.Windows().Item([uint32]8)
    $cls = Get-WindowClass ([IntPtr][long]$desk.HWND)
    if ($desk.Document -and ($cls -eq 'Progman' -or $cls -eq 'WorkerW')) {
      $known = $true
      foreach ($item in $desk.Document.SelectedItems()) { if ($item.Path) { $files += [string]$item.Path } }
    }
  } catch {}
  if (-not $known) {
    # Otherwise by the names of the selected icons. Two icons can show the same name (extensions
    # are hidden): a name counts only when as many icons are selected under it as there are.
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::List)
      $list = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
      if ($list) {
        $names = @($list.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection() | ForEach-Object { $_.Current.Name })
        if ($names.Count -gt 0) {
          $all = @($shell.NameSpace(0).Items())
          foreach ($name in @($names | Sort-Object -Unique)) {
            $same = @($all | Where-Object { $_.Name -eq $name })
            if ($same.Count -eq @($names | Where-Object { $_ -eq $name }).Count) {
              foreach ($item in $same) { if ($item.Path) { $files += [string]$item.Path } }
            }
          }
        }
      }
    } catch {}
  }
  $files
}

# The text selected in the control that has the keyboard.
function Get-SelectedText {
  $text = ''
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    $pattern = $null
    # A password box is none of our business, whatever it would hand out.
    if ($el -and (-not $el.Current.IsPassword) -and $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
      $text = (($pattern.GetSelection() | ForEach-Object { $_.GetText(20000) }) -join [Environment]::NewLine)
      if ($text.Length -gt 20000) { $text = $text.Substring(0, 20000) }
    }
  } catch {}
  $text
}

function Get-Selection {
  $fg = [Zhidian.Native]::GetForegroundWindow()
  $files = @()
  $text = ''
  $app = ''
  if ($fg.ToInt64() -ne 0) {
    $files = @(Get-FolderFiles $fg)
    if ($files.Count -eq 0) {
      $cls = Get-WindowClass $fg
      if ($cls -eq 'Progman' -or $cls -eq 'WorkerW') { $files = @(Get-DesktopFiles $fg) }
    }
    if ($files.Count -eq 0) { $text = Get-SelectedText }
    if ($files.Count -gt 0 -or $text -ne '') {
      try {
        $procId = [uint32]0
        [void][Zhidian.Native]::GetWindowThreadProcessId($fg, [ref]$procId)
        if ($procId -ne 0) { $app = [string](Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName }
      } catch {}
    }
  }
  (@{ files = @($files); text = "$text"; app = "$app" } | ConvertTo-Json -Compress)
}

# -- watch --
Say '{"ready":true}'
# The button that selects is the left one, unless the buttons are swapped: the key state is that
# of the physical buttons.
$button = 1
if ([Zhidian.Native]::GetSystemMetrics(23) -ne 0) { $button = 2 }
$last = ''
$wasDown = $false
$tick = 0
while ($true) {
  Start-Sleep -Milliseconds 60
  $tick++
  $state = [Zhidian.Native]::GetAsyncKeyState($button)
  $down = ($state -band 0x8000) -ne 0
  # The lowest bit (pressed since the last look) catches a click shorter than one round. Windows
  # may fail to set it, never sets it wrongly, and the look once a second is there in any case.
  $released = (-not $down) -and ($wasDown -or (($state -band 1) -ne 0))
  $wasDown = $down
  if ($down) { continue }
  if ($released) { Start-Sleep -Milliseconds 140 }
  if ($released -or ($tick % 16 -eq 0)) {
    $now = Get-Selection
    # -cne: "abc" and "ABC" are two selections.
    if ($now -cne $last) {
      $last = $now
      Say $now
    }
  }
}
`;

export const MAC_HELPER = String.raw`
ObjC.import('Foundation');
const se = Application('System Events');
// What macOS answers while it has not been allowed to look: Automation (-1743), Accessibility (-1719, -25211).
const REFUSED = [-1743, -1719, -25211, -10004];
let finder = null, knownKey = null, knownPaths = [], quietUntil = 0, told = false;

// file:///Users/me/My%20notes.txt -> /Users/me/My notes.txt ; the URL of a folder ends in a slash.
function pathOf(url) {
  const m = /^file:\/\/(?:localhost)?(\/.*)$/.exec(String(url));
  if (!m) return '';
  try { return decodeURIComponent(m[1]).replace(/(.)\/$/, '$1'); } catch (e) { return ''; }
}

function finderPaths() {
  finder = finder || Application('Finder');
  const items = finder.selection().slice(0, 200);
  // A path costs one Apple event per item. The items as text (...folders.byName("a").documentFiles.byName("b.txt"))
  // tell whether this is still the selection whose paths are known.
  let texts = null;
  try { texts = items.map((item) => String(Automation.getDisplayString(item)).normalize('NFC')); } catch (e) {}
  const key = texts ? texts.join('\n') : null;
  if (key === null || key !== knownKey) {
    knownPaths = items.map((item) => { try { return pathOf(item.url()); } catch (e) { return ''; } });
    // ...and that text is believed only when, for every item, it names the file the path ends in.
    const named = (p, i) => p !== '' && texts[i].indexOf(JSON.stringify(p.slice(p.lastIndexOf('/') + 1).normalize('NFC'))) >= 0;
    knownKey = texts && knownPaths.every(named) ? key : null;
  }
  return knownPaths.filter((p) => p !== '');
}

function look() {
  let files = [], text = '', app = '';
  if (Date.now() >= quietUntil) {
    try {
      const front = se.applicationProcesses.whose({ frontmost: true })[0];
      const frontName = String(front.name() || '');
      if (frontName === 'Finder') {
        files = finderPaths();
      } else {
        const focused = front.attributes.byName('AXFocusedUIElement').value();
        const picked = String(focused.attributes.byName('AXSelectedText').value() || '');
        // A password field is none of our business, whatever it would hand out.
        let secret = false;
        try { secret = picked !== '' && focused.subrole() === 'AXSecureTextField'; } catch (e) {}
        if (!secret) text = picked;
      }
      if (files.length > 0 || text !== '') app = frontName;
    } catch (e) {
      if (e && REFUSED.indexOf(e.errorNumber) >= 0) {
        // Not allowed (yet). Asking twice a second would not change the answer: look again in a while.
        quietUntil = Date.now() + 5000;
        if (!told) { told = true; console.log('macOS has not allowed this: ' + e.message); }
      }
    }
  }
  return JSON.stringify({ files: files, text: text.slice(0, 20000), app: app });
}

function emit(line) {
  // In plain ASCII: nothing on the way can then spoil a file name, and half of a character pair
  // (a text cut at 20000) cannot make the conversion to bytes fail.
  const ascii = line.replace(/[\u0080-\uffff]/g, (c) => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(ascii + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

emit('{"ready":true}');
let last = '', seen = '', round = 0;
while (true) {
  const began = Date.now();
  const now = look();
  // Two identical readings in a row: the selection has come to rest.
  if (now === seen && now !== last) { last = now; emit(now); }
  seen = now;
  // An empty line twice a minute: once the application is gone, writing is what ends this process.
  if (++round % 64 === 0) emit('');
  // Looking costs the application in front something: at most a fifth of the time is spent on it.
  delay(Math.max(0.45, (Date.now() - began) / 250));
}
`;

const APP_ALIASES = {
  vscode: ['code', 'code - insiders', 'visual studio code'],
  'vs code': ['code', 'code - insiders', 'visual studio code'],
  terminal: ['terminal', 'windowsterminal', 'iterm2', 'gnome-terminal', 'konsole', 'powershell', 'pwsh', 'cmd'],
  '终端': ['terminal', 'windowsterminal', 'iterm2', 'gnome-terminal', 'konsole', 'powershell', 'pwsh', 'cmd'],
  iterm: ['iterm2'],
};

function normApp(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\.(exe|app)$/i, '').trim();
}

/** Whether `appName` matches the user's comma/newline-separated `ignoredApps` list. */
export function isAppIgnored(appName, ignoredApps) {
  const app = normApp(appName);
  if (!app) return false;
  const rules = String(ignoredApps ?? '').split(/[,，;；\r\n]+/).map(normApp).filter(Boolean);
  for (const r of rules) {
    const targets = APP_ALIASES[r] ?? [r];
    if (targets.some((t) => app === t || (t.length >= 4 && app.includes(t)))) return true;
  }
  return false;
}

/** How the Windows helper is started; the Windows test starts its own scripts the same way. */
export const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File'];

/** Windows PowerShell by its full path: a bare name is looked for in the working directory first. */
export function powershellPath(env = process.env) {
  const exe = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(exe) ? exe : 'powershell.exe';
}

export class SelectionWatcher extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir                       where the helper script may be written
   * @param {() => Promise<string>} o.readPrimary  reads the X11 primary selection (Linux only)
   * @param {string} [o.platform]
   */
  constructor({ dir, readPrimary, platform = process.platform }) {
    super();
    this.dir = dir;
    this.readPrimary = readPrimary;
    this.platform = platform;
    this.child = null;
    this.timer = null;
    this.current = { files: [], text: '', app: '' };
    this.changedAt = 0;
    this.status = 'stopped'; // 'stopped' | 'starting' | 'running' | 'failed'
    this.error = '';
    this.wanted = false;
  }

  /** What is selected right now, as far as is known. */
  latest() {
    return this.current;
  }

  /**
   * Is `latest()` something the person selected just now? On Windows and macOS the helper
   * reports the live selection, so it always is. The X11 primary selection keeps its text
   * until something else is selected, however long ago that was.
   */
  fresh(ms) {
    return this.platform !== 'linux' || Date.now() - this.changedAt <= ms;
  }

  start() {
    if (this.wanted) return;
    this.wanted = true;
    // -Sta is what Windows PowerShell 5 does anyway; the helper depends on it (see the top).
    if (this.platform === 'win32') this.#startHelper(powershellPath(), POWERSHELL_ARGS, 'zhidian-selection.ps1', WINDOWS_HELPER);
    else if (this.platform === 'darwin') this.#startHelper('/usr/bin/osascript', ['-l', 'JavaScript'], 'zhidian-selection.js', MAC_HELPER);
    else this.#startPrimary();
  }

  stop() {
    this.wanted = false;
    clearInterval(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
    this.status = 'stopped';
    this.current = { files: [], text: '', app: '' };
  }

  #set(next) {
    const files = Array.isArray(next.files) ? next.files.filter((f) => typeof f === 'string' && f).slice(0, 200) : [];
    const text = typeof next.text === 'string' ? next.text : '';
    const app = typeof next.app === 'string' ? next.app : '';
    const before = JSON.stringify({ files: this.current.files, text: this.current.text });
    this.current = { files, text, app };
    if (JSON.stringify({ files, text }) !== before) {
      this.changedAt = Date.now();
      this.emit('selection', this.current);
    }
  }

  #startHelper(command, args, fileName, script) {
    this.status = 'starting';
    let file;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      file = path.join(this.dir, fileName);
      // PowerShell 5 reads a script without a byte-order mark as the system code page.
      fs.writeFileSync(file, (this.platform === 'win32' ? '\uFEFF' : '') + script, 'utf8');
    } catch (err) {
      this.status = 'failed';
      this.error = String(err?.message ?? err);
      return;
    }
    let child;
    try {
      child = spawn(command, [...args, file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this.status = 'failed';
      this.error = String(err?.message ?? err);
      return;
    }
    this.child = child;
    let buf = '';
    let errText = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.ready) this.status = 'running';
          else this.#set(msg);
        } catch {
          // not ours
        }
      }
    });
    child.stderr.setEncoding('utf8'); // both helpers write UTF-8; a character may arrive in two pieces
    child.stderr.on('data', (chunk) => {
      errText = (errText + chunk).slice(-400);
    });
    child.once('error', (err) => {
      if (this.child === child) {
        this.child = null;
        this.status = 'failed';
        this.error = String(err?.message ?? err);
      }
    });
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.status = this.wanted ? 'failed' : 'stopped';
      this.error = this.wanted ? `选区监听进程退出了（${code}）：${errText.trim().slice(0, 200)}` : '';
      this.current = { files: [], text: '' };
    });
  }

  #startPrimary() {
    this.status = 'running';
    let seen = null; // the reading before this one
    let reported = null; // whatever was selected before we started is not news
    let busy = false;
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const now = await this.#primary();
        if (reported === null) reported = now;
        // Report a selection once it has stopped changing (the drag is over).
        else if (now === seen && now !== reported) {
          reported = now;
          this.#set({ files: [], text: now });
        }
        seen = now;
      } finally {
        busy = false;
      }
    }, 300);
    this.timer.unref?.();
  }

  async #primary() {
    try {
      return String((await this.readPrimary?.()) ?? '');
    } catch {
      return '';
    }
  }
}
