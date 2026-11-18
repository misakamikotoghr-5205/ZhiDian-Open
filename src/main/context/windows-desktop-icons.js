// Desktop icons are not consistently exposed as UIA children on Windows 11.
// Read their identity and position through the supported Shell IFolderView API.
// References: learn.microsoft.com/windows/win32/api/shobjidl_core/nn-shobjidl_core-ifolderview
export const WINDOWS_DESKTOP_ICONS = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace Zhidian.FileView {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IServiceProvider { [PreserveSig] int QueryService(ref Guid service, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object value); }
  [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellBrowser {
    [PreserveSig] int GetWindow(out IntPtr window);
    [PreserveSig] int ContextSensitiveHelp(bool enter);
    [PreserveSig] int InsertMenusSB(IntPtr menu, IntPtr widths);
    [PreserveSig] int SetMenuSB(IntPtr menu, IntPtr hole, IntPtr window);
    [PreserveSig] int RemoveMenusSB(IntPtr menu);
    [PreserveSig] int SetStatusTextSB([MarshalAs(UnmanagedType.LPWStr)] string text);
    [PreserveSig] int EnableModelessSB(bool enable);
    [PreserveSig] int TranslateAcceleratorSB(IntPtr message, ushort id);
    [PreserveSig] int BrowseObject(IntPtr pidl, uint flags);
    [PreserveSig] int GetViewStateStream(uint mode, out IntPtr stream);
    [PreserveSig] int GetControlWindow(uint id, out IntPtr window);
    [PreserveSig] int SendControlMsg(uint id, uint message, IntPtr wp, IntPtr lp, out IntPtr result);
    [PreserveSig] int QueryActiveShellView(out IShellView view);
  }
  [ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellView { [PreserveSig] int GetWindow(out IntPtr window); }
  [ComImport, Guid("CDE725B0-CCC9-4519-917E-325D72FAB4CE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFolderView {
    [PreserveSig] int GetCurrentViewMode(out uint mode);
    [PreserveSig] int SetCurrentViewMode(uint mode);
    [PreserveSig] int GetFolder(ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object folder);
    [PreserveSig] int Item(int index, out IntPtr pidl);
    [PreserveSig] int ItemCount(uint flags, out int count);
    [PreserveSig] int Items(uint flags, ref Guid iid, out IntPtr items);
    [PreserveSig] int GetSelectionMarkedItem(out int index);
    [PreserveSig] int GetFocusedItem(out int index);
    [PreserveSig] int GetItemPosition(IntPtr pidl, out Point position);
    [PreserveSig] int GetSpacing(out Point spacing);
  }
  [ComImport, Guid("1AC3D9F0-175C-11D1-95BE-00609797EA4F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFolder2 {
    [PreserveSig] int GetClassID(out Guid id);
    [PreserveSig] int Initialize(IntPtr pidl);
    [PreserveSig] int GetCurFolder(out IntPtr pidl);
  }
  public class Icon { public string Name; public string Path; public int X; public int Y; public int Width; public int Height; }
  public static class Desktop {
    [DllImport("shell32.dll")] static extern IntPtr ILCombine(IntPtr parent, IntPtr child);
    [DllImport("shell32.dll")] static extern int SHGetNameFromIDList(IntPtr pidl, uint type, out IntPtr name);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    static string NameOf(IntPtr pidl, uint type) {
      IntPtr value;
      if (SHGetNameFromIDList(pidl, type, out value) != 0 || value == IntPtr.Zero) return "";
      try { return Marshal.PtrToStringUni(value) ?? ""; } finally { Marshal.FreeCoTaskMem(value); }
    }
    public static Icon[] Read(object shellWindow) {
      Guid service = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
      Guid browserId = new Guid("000214E2-0000-0000-C000-000000000046");
      object browserObject;
      Marshal.ThrowExceptionForHR(((IServiceProvider)shellWindow).QueryService(ref service, ref browserId, out browserObject));
      IShellView shellView;
      Marshal.ThrowExceptionForHR(((IShellBrowser)browserObject).QueryActiveShellView(out shellView));
      IFolderView view = (IFolderView)shellView;
      Guid folderId = new Guid("1AC3D9F0-175C-11D1-95BE-00609797EA4F");
      object folderObject;
      Marshal.ThrowExceptionForHR(view.GetFolder(ref folderId, out folderObject));
      IntPtr parent;
      Marshal.ThrowExceptionForHR(((IPersistFolder2)folderObject).GetCurFolder(out parent));
      var result = new List<Icon>();
      try {
        IntPtr window; Marshal.ThrowExceptionForHR(shellView.GetWindow(out window));
        int count; Marshal.ThrowExceptionForHR(view.ItemCount(2, out count));
        Point spacing; Marshal.ThrowExceptionForHR(view.GetSpacing(out spacing));
        for (int i = 0; i < Math.Min(count, 500); i++) {
          IntPtr item; if (view.Item(i, out item) != 0 || item == IntPtr.Zero) continue;
          IntPtr full = IntPtr.Zero;
          try {
            Point position; if (view.GetItemPosition(item, out position) != 0) continue;
            if (!ClientToScreen(window, ref position)) continue;
            full = ILCombine(parent, item);
            if (full == IntPtr.Zero) continue;
            result.Add(new Icon { Name = NameOf(full, 0), Path = NameOf(full, 0x80058000), X = position.X, Y = position.Y, Width = Math.Max(1, spacing.X), Height = Math.Max(1, spacing.Y) });
          } finally { if (full != IntPtr.Zero) Marshal.FreeCoTaskMem(full); Marshal.FreeCoTaskMem(item); }
        }
      } finally { Marshal.FreeCoTaskMem(parent); }
      return result.ToArray();
    }
  }
}
'@
`;
