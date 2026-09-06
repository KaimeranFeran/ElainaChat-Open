using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

namespace ElainaPet;

/// <summary>
/// 用 UIAutomation 读取前台窗口的标题 + 主要文本内容（骨架）。
/// 限制 8000 字符；递归收集时做了去重（HashSet）与深度/同级数量保护，避免卡顿。
/// </summary>
public static class UiTextReader
{
    private const int MaxChars = 8000;
    private const int MaxDepth = 12;    // 递归最大深度
    private const int MaxSiblings = 800; // 每个节点的同级遍历上限

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    /// <summary>读取当前前台窗口的标题与文本。</summary>
    public static string ReadForeground()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return string.Empty;

        try
        {
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            if (root is null) return string.Empty;

            var sb = new StringBuilder();
            var seen = new HashSet<string>(StringComparer.Ordinal); // 去重，避免重复文本

            Collect(root, sb, seen, 0);

            if (sb.Length > MaxChars) sb.Length = MaxChars;
            return sb.ToString();
        }
        catch (Exception)
        {
            // UIA 在某些窗口上可能抛异常（跨进程、权限等），骨架里直接吞掉。
            return string.Empty;
        }
    }

    private static void Collect(AutomationElement el, StringBuilder sb, HashSet<string> seen, int depth)
    {
        if (el is null || depth > MaxDepth || sb.Length >= MaxChars) return;

        // 读取控件可读文本（标题 / Name）。
        string? name = null;
        try { name = el.Current.Name; } catch { }
        if (!string.IsNullOrWhiteSpace(name) && sb.Length < MaxChars && seen.Add(name))
        {
            sb.AppendLine(name);
        }

        // 递归子元素。ControlView 只包含可见可交互控件，文本更“干净”。
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement child = walker.GetFirstChild(el);
        int guard = 0;
        while (child != null && guard++ < MaxSiblings && sb.Length < MaxChars)
        {
            Collect(child, sb, seen, depth + 1);
            child = walker.GetNextSibling(child);
        }
    }
}
