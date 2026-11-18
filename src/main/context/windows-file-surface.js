// Runs inside desktop.js's existing isolated STA helper. All paths come from Shell FolderItems.
import { WINDOWS_DESKTOP_ICONS } from './windows-desktop-icons.js';
export const WINDOWS_FILE_SURFACE_HELPER = String.raw`
${WINDOWS_DESKTOP_ICONS}
function Visible-FileRows($hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $listRole = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::List)
  $desktopClass = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'SysListView32')
  $listCondition = New-Object System.Windows.Automation.OrCondition($listRole, $desktopClass)
  $rows = @()
  $lists = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCondition)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  foreach ($list in $lists) {
    if ($watch.ElapsedMilliseconds -gt 1800) { break }
    try {
      if ($list.Current.IsOffscreen) { continue }
      $id = [string]$list.Current.AutomationId
      $class = [string]$list.Current.ClassName
      if ($id -ne 'ItemsView' -and $class -ne 'UIItemsView' -and $class -ne 'SysListView32') { continue }
      $one = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
      $two = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataItem)
      $itemCondition = New-Object System.Windows.Automation.OrCondition($one, $two)
      foreach ($item in $list.FindAll([System.Windows.Automation.TreeScope]::Descendants, $itemCondition)) {
        if ($rows.Count -ge 500 -or $watch.ElapsedMilliseconds -gt 1800) { break }
        try {
          if ($item.Current.IsOffscreen) { continue }
          $name = [string]$item.Current.Name
          $bounds = Bounds-Of $item
          if ($name -eq '' -or (-not $bounds) -or $bounds.w -le 0 -or $bounds.h -le 0) { continue }
          $hits = @()
          $nameCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'System.ItemNameDisplay')
          $label = $item.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
          if (-not $label) {
            $nameCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
            $label = $item.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
          }
          if ($label) {
            $b = Bounds-Of $label
            if ($b -and $b.w -gt 0 -and $b.h -gt 0) {
              $hits += $b
              # Details view's row spans all columns. Its file icon occupies the real gap
              # between the row's left edge and the name cell, not the entire row width.
              if ($b.x -gt $bounds.x -and $b.x -lt $bounds.x + $bounds.w) {
                $hits += @{ x = $bounds.x; y = $bounds.y; w = $b.x - $bounds.x; h = $bounds.h }
              }
            }
          }
          $imageCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Image)
          $image = $item.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $imageCondition)
          if ($image) { $b = Bounds-Of $image; if ($b -and $b.w -gt 0 -and $b.h -gt 0) { $hits += $b } }
          $rows += @{ name = $name; bounds = $bounds; hitBounds = $hits }
        } catch {}
      }
    } catch {}
  }
  @{ rows = $rows; truncated = ($rows.Count -ge 500 -or $watch.ElapsedMilliseconds -gt 1800) }
}

function Capture-FileSurface($hwnd) {
  $class = Get-WindowClass $hwnd
  $kind = 'none'
  $folder = $null
  $folderPath = ''
  if ($class -eq 'Progman' -or $class -eq 'WorkerW') {
    $kind = 'desktop'
    $folder = $shell.NameSpace(0)
  } elseif ($class -eq 'CabinetWClass' -or $class -eq 'ExploreWClass') {
    $mine = @()
    foreach ($window in $shell.Windows()) {
      try { if ([long]$window.HWND -eq $hwnd.ToInt64()) { $mine += $window } } catch {}
    }
    if ($mine.Count -gt 1) {
      $tab = [Zhidian.Native]::FindWindowEx($hwnd, [IntPtr]::Zero, 'ShellTabWindowClass', [IntPtr]::Zero).ToInt64()
      $mine = @($mine | Where-Object { ($tabsMissing -eq '') -and ($tab -ne 0) -and ([Zhidian.Tabs]::Of($_).ToInt64() -eq $tab) })
    }
    if ($mine.Count -eq 1) {
      $folder = $mine[0].Document.Folder
      $folderPath = [string]$folder.Self.Path
      $kind = 'explorer'
    }
  }
  if (-not $folder) { return @{ kind = 'none'; rows = @(); entries = @(); truncated = $false } }
  if ($kind -eq 'desktop') {
    try {
      # The Shell gives exact identities as well as positions, even when UIA omits all icons.
      $desktopWindow = $shell.Windows().Item([uint32]8)
      $icons = @([Zhidian.FileView.Desktop]::Read($desktopWindow))
      if ($icons.Count -gt 0) {
        $rows = @()
        $entries = @()
        foreach ($icon in $icons) {
          $rows += @{ name = $icon.Name; path = $icon.Path; bounds = @{ x = $icon.X; y = $icon.Y; w = $icon.Width; h = $icon.Height }; hitBounds = @() }
          if ($icon.Path -ne '') { $entries += @{ name = $icon.Name; path = $icon.Path; aliases = @() } }
        }
        return @{ kind = $kind; folder = ''; rows = $rows; entries = $entries; truncated = ($icons.Count -ge 500) }
      }
    } catch {}
  }
  $visible = Visible-FileRows $hwnd
  $entries = @()
  $count = 0
  $hideExtensions = $true
  try { $hideExtensions = (Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name HideFileExt) -ne 0 } catch {}
  $watch = [Diagnostics.Stopwatch]::StartNew()
  foreach ($item in $folder.Items()) {
    $count++
    if ($count -gt 5000 -or $watch.ElapsedMilliseconds -gt 1800) { break }
    try {
      if ($item.IsFileSystem -and (-not $item.IsFolder)) {
        $itemPath = [string]$item.Path
        $aliases = @([string]$folder.GetDetailsOf($item, 0))
        $extension = [IO.Path]::GetExtension($itemPath)
        if ($hideExtensions -or $extension -in @('.lnk', '.url')) { $aliases += [IO.Path]::GetFileNameWithoutExtension($itemPath) }
        $entries += @{ name = [string]$item.Name; path = $itemPath; aliases = $aliases }
      }
    } catch {}
  }
  @{ kind = $kind; folder = $folderPath; rows = $visible.rows; entries = $entries; truncated = ($visible.truncated -or $count -gt 5000 -or $watch.ElapsedMilliseconds -gt 1800) }
}
`;
