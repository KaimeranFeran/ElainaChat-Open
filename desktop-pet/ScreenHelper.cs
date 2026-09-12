using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace ElainaPet;

/// <summary>
/// 多显示器 / 混合 DPI 下的工作区计算（OCR M7）。
/// SystemParameters.WorkArea 只返回主屏工作区且为主屏 DPI 的 DIP，
/// 副屏缩放不同时窗口会算错位置甚至跑到屏外。
/// </summary>
public static class ScreenHelper
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    private const uint MONITOR_DEFAULTTONEAREST = 2;

    /// <summary>返回窗口所在显示器的工作区（WPF 设备无关单位）</summary>
    public static Rect WorkArea(Window window)
    {
        try
        {
            IntPtr hwnd = new WindowInteropHelper(window).Handle;
            var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (GetMonitorInfo(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), ref mi))
            {
                double sx = 1, sy = 1;
                try
                {
                    var src = PresentationSource.FromVisual(window);
                    if (src?.CompositionTarget != null)
                    {
                        sx = src.CompositionTarget.TransformToDevice.M11;
                        sy = src.CompositionTarget.TransformToDevice.M22;
                    }
                }
                catch { }
                if (sx <= 0) sx = 1;
                if (sy <= 0) sy = 1;
                return new Rect(
                    mi.rcWork.Left / sx,
                    mi.rcWork.Top / sy,
                    Math.Max(0, mi.rcWork.Right - mi.rcWork.Left) / sx,
                    Math.Max(0, mi.rcWork.Bottom - mi.rcWork.Top) / sy);
            }
        }
        catch { }
        return SystemParameters.WorkArea;
    }
}
