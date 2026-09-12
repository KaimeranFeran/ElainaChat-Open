using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace ElainaPet;

/// <summary>
/// 独立桌宠窗口（与主界面共存）：透明置顶悬浮窗，加载 www/pet.html。
/// ⟲ 回到主界面 = 激活主窗口；支持聊天 / 语音输入 / 尺度 / 点击穿透。
/// </summary>
public partial class PetWindow : Window
{
    private CoreWebView2Environment? _env;
    private PetBrain? _brain;

    public PetWindow()
    {
        InitializeComponent();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        PositionDefault();
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ElainaPet", "WebView2");
        _env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
        await PetView.EnsureCoreWebView2Async(_env);
        PetView.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        PetView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        PetView.CoreWebView2.PermissionRequested += (s, args) =>
        {
            if (args.PermissionKind == CoreWebView2PermissionKind.Microphone) args.State = CoreWebView2PermissionState.Allow;
            else args.State = CoreWebView2PermissionState.Deny;
        };
        _brain = new PetBrain(PetView);
        _brain.ConfigureFromSettings();
        ApplySizeAndClickthrough();
        var html = Path.Combine(AppContext.BaseDirectory, "www", "pet.html");
        if (!File.Exists(html)) html = Path.Combine(Environment.CurrentDirectory, "www", "pet.html");
        PetView.Source = new Uri(Path.GetFullPath(html));
        try
        {
            await PetView.CoreWebView2.ExecuteScriptAsync(
                "(function(){try{var o=JSON.parse(localStorage.getItem('elaina_settings')||'{}');window.chrome&&window.chrome.webview&&window.chrome.webview.postMessage({kind:'gateway',payload:o.baseUrl||''})}catch(e){}})()");
        }
        catch { }
        ApplyPending();          /* 主窗若已先行注入，这里补应用（OCR 二轮 1） */
        _ready.TrySetResult();
    }

    private void PositionDefault()
    {
        var wa = ScreenHelper.WorkArea(this);   /* OCR M7：按窗口所在显示器工作区计算 */
        Left = wa.Right - Width - 10;
        Top = wa.Bottom - Height - 10;
    }

    private async void ApplySizeAndClickthrough()
    {
        try
        {
            double scale = 1.0; bool ct = false;
            var v = await PetView.CoreWebView2.ExecuteScriptAsync("(function(){try{return localStorage.getItem('elaina_pet_scale')}catch(e){return '1'}})()");
            var v2 = await PetView.CoreWebView2.ExecuteScriptAsync("(function(){try{return localStorage.getItem('elaina_pet_clickthrough')}catch(e){return '0'}})()");
            var m = System.Text.RegularExpressions.Regex.Match(v ?? "", "[0-9.]+");
            if (m.Success) scale = Math.Clamp(double.Parse(m.Value, System.Globalization.CultureInfo.InvariantCulture), 0.6, 1.6);
            ct = (v2 ?? "").IndexOf("1", StringComparison.Ordinal) >= 0;
            Width = 360 * scale;
            Height = 520 * scale;
            var wa = ScreenHelper.WorkArea(this);   /* OCR M7：按窗口所在显示器工作区计算 */
            Left = Math.Min(Left, wa.Right - Width - 4);
            Top = Math.Min(Top, wa.Bottom - Height - 4);
            SetClickthrough(ct);
        }
        catch { }
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            string kind = root.TryGetProperty("kind", out var k) ? k.GetString() ?? "" : "";
            string payload = "";
            if (root.TryGetProperty("payload", out var p))
            {
                payload = p.ValueKind switch
                {
                    JsonValueKind.String => p.GetString() ?? "",
                    JsonValueKind.True => "true",
                    JsonValueKind.False => "false",
                    _ => p.ToString()
                };
            }
            if (kind == "send" && !string.IsNullOrWhiteSpace(payload)) _brain?.ChatAsync(payload);
            else if (kind == "drag") DragWindowViaWin32();
            else if (kind == "pet-back") ActivateMain();
            else if (kind == "gateway") { /* 目标由主窗代理处理 */ }
        }
        catch { }
    }

    private void ActivateMain()
    {
        try
        {
            var main = Application.Current.MainWindow;
            if (main != null)
            {
                if (main.WindowState == WindowState.Minimized) main.WindowState = WindowState.Normal;
                main.Activate();
                main.Topmost = true; main.Topmost = false;
            }
        }
        catch { }
    }

    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wp, IntPtr lp);
    private void DragWindowViaWin32()
    {
        try
        {
            IntPtr h = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            ReleaseCapture();
            SendMessage(h, 0xA1, (IntPtr)0x2, IntPtr.Zero);
        }
        catch { }
    }

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")] private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")] private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll", EntryPoint = "GetWindowLong")] private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint = "SetWindowLong")] private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);
    private void SetClickthrough(bool enabled)
    {
        try
        {
            IntPtr h = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            int style = IntPtr.Size == 8 ? (int)(long)GetWindowLongPtr(h, GWL_EXSTYLE) : GetWindowLong32(h, GWL_EXSTYLE);
            if (enabled) style |= WS_EX_TRANSPARENT; else style &= ~WS_EX_TRANSPARENT;
            if (IntPtr.Size == 8) SetWindowLongPtr(h, GWL_EXSTYLE, (IntPtr)style); else SetWindowLong32(h, GWL_EXSTYLE, style);
        }
        catch { }
    }

    /* 就绪门：WebView/大脑初始化是异步的，主窗可能在 _brain 赋值前就注入配置（OCR 二轮 1） */
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private (string b, string k, string m, bool p, int i)? _pending;

    /// <summary>等待桌宠大脑就绪</summary>
    public Task EnsureReadyAsync() => _ready.Task;

    /** 主窗把前端设置（网关/Key/模型/主动回复）注入桌宠大脑；未就绪则缓存待用 */
    public void ConfigureBrain(string baseUrl, string apiKey, string model, bool proactive, int intervalMinutes)
    {
        _pending = (baseUrl, apiKey, model, proactive, intervalMinutes);
        if (!_ready.Task.IsCompleted) return;   /* 就绪后在 Loaded 收尾里补应用 */
        ApplyPending();
    }

    private void ApplyPending()
    {
        try
        {
            if (_pending is not { } q || _brain == null) return;
            _brain.Configure(q.b, q.k, q.m);
            _brain.RestartProactive(q.p, q.i);
        }
        catch { }
    }

    protected override void OnClosed(EventArgs e)
    {
        try { _brain?.Dispose(); _brain = null; } catch { }
        try { PetView.Dispose(); } catch { }
        _env = null;
        base.OnClosed(e);
    }

    /* 尺度/穿透变化时由主窗调用刷新 */
    public void RefreshFromSettings() => ApplySizeAndClickthrough();
}
