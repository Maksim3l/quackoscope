# Photographs the quackoscope window of one running process, and optionally
# clicks a point inside it or types into it first. This is how the installed
# app's own window - not a browser pointed at the same URL - is shown connecting
# to daqref://device0 and plotting.
#
#   powershell -File tools/windows-installer/photograph-and-click-the-installed-quackoscope-window.ps1 `
#              -ProcessId 62480 -SaveTo C:\path\window.png
#   ... -ProcessId 62480 -ClickAtClientX 400 -ClickAtClientY 300 -SaveTo ...
#   ... -ProcessId 62480 -TypeKeys "{ENTER}" -SaveTo ...
#
# It prints the window handle, the window rectangle in screen pixels and the
# file it wrote, so the picture can be tied back to the process that drew it.

param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$SaveTo,
  [int]$ClickAtClientX = -1,
  [int]$ClickAtClientY = -1,
  [int]$ScrollAtClientX = -1,
  [int]$ScrollAtClientY = -1,
  [int]$ScrollWheelNotches = 0,
  [int]$ResizeToWidth = 0,
  [int]$ResizeToHeight = 0,
  [string]$TypeKeys = "",
  [int]$SettleMilliseconds = 1500
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct WindowRectangle { public int Left, Top, Right, Bottom; }
public class DesktopWindow {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out WindowRectangle r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw "process $ProcessId ($($process.ProcessName)) has no main window" }

[void][DesktopWindow]::ShowWindow($handle, 9)   # SW_RESTORE
[void][DesktopWindow]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 500

if ($ResizeToWidth -gt 0 -and $ResizeToHeight -gt 0) {
  "resizing the window to $ResizeToWidth x $ResizeToHeight px"
  [void][DesktopWindow]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $ResizeToWidth, $ResizeToHeight, 0x0004 -bor 0x0002)
  Start-Sleep -Milliseconds 800
}

$rectangle = New-Object WindowRectangle
[void][DesktopWindow]::GetWindowRect($handle, [ref]$rectangle)
$width = $rectangle.Right - $rectangle.Left
$height = $rectangle.Bottom - $rectangle.Top
"window handle $handle of pid $ProcessId ($($process.ProcessName), title `"$($process.MainWindowTitle)`")"
"window rectangle on screen: left $($rectangle.Left) top $($rectangle.Top) right $($rectangle.Right) bottom $($rectangle.Bottom)  ($width x $height px)"

if ($ClickAtClientX -ge 0 -and $ClickAtClientY -ge 0) {
  $screenX = $rectangle.Left + $ClickAtClientX
  $screenY = $rectangle.Top + $ClickAtClientY
  "clicking at window-relative ($ClickAtClientX, $ClickAtClientY) = screen ($screenX, $screenY)"
  [void][DesktopWindow]::SetCursorPos($screenX, $screenY)
  Start-Sleep -Milliseconds 200
  [DesktopWindow]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
  Start-Sleep -Milliseconds 60
  [DesktopWindow]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
  Start-Sleep -Milliseconds $SettleMilliseconds
}

if ($ScrollAtClientX -ge 0 -and $ScrollAtClientY -ge 0 -and $ScrollWheelNotches -ne 0) {
  $screenX = $rectangle.Left + $ScrollAtClientX
  $screenY = $rectangle.Top + $ScrollAtClientY
  "scrolling $ScrollWheelNotches wheel notch(es) at window-relative ($ScrollAtClientX, $ScrollAtClientY) = screen ($screenX, $screenY)"
  [void][DesktopWindow]::SetCursorPos($screenX, $screenY)
  Start-Sleep -Milliseconds 200
  # mouse_event takes the wheel delta as an unsigned word; a scroll towards the
  # user is -120, which reaches the API as 0xFFFFFF88 in two's complement.
  $step = if ($ScrollWheelNotches -gt 0) { [uint32]120 } else { [uint32]4294967176 }
  for ($i = 0; $i -lt [math]::Abs($ScrollWheelNotches); $i++) {
    [DesktopWindow]::mouse_event(0x0800, 0, 0, $step, [IntPtr]::Zero)   # MOUSEEVENTF_WHEEL
    Start-Sleep -Milliseconds 80
  }
  Start-Sleep -Milliseconds $SettleMilliseconds
}

if ($TypeKeys -ne "") {
  "sending keys: $TypeKeys"
  [System.Windows.Forms.SendKeys]::SendWait($TypeKeys)
  Start-Sleep -Milliseconds $SettleMilliseconds
}

[void][DesktopWindow]::GetWindowRect($handle, [ref]$rectangle)
$width = $rectangle.Right - $rectangle.Left
$height = $rectangle.Bottom - $rectangle.Top
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rectangle.Left, $rectangle.Top, 0, 0, $bitmap.Size)
$graphics.Dispose()
$bitmap.Save($SaveTo, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
"wrote $SaveTo ($((Get-Item $SaveTo).Length) bytes, $width x $height px)"
