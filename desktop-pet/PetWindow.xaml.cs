using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
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
    private readonly TaskCompletionSource _pageReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _configReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private HwndSource? _hwndSource;
    private bool _clickthrough;
    private double _scale = 1.0;

    private const int WmNcHitTest = 0x0084;
    private const int HtClient = 1;
    private const int HtTransparent = -1;

    public PetWindow()
    {
        InitializeComponent();
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        _hwndSource = PresentationSource.FromVisual(this) as HwndSource;
        _hwndSource?.AddHook(WindowMessageHook);
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        PositionDefault();
        RestoreWindowState();
        LocationChanged += (_, _) => SaveWindowState();
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ElainaPet", "WebView2", "Pet");
        var options = new CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required"
        };
        _env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
        await PetView.EnsureCoreWebView2Async(_env);
        PetView.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        PetView.CoreWebView2.IsMuted = false;
        PetView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        PetView.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess)
            {
                _pageReady.TrySetResult();
                ApplySizeAndClickthrough();
            }
            else _pageReady.TrySetException(new InvalidOperationException("桌宠页面加载失败：" + args.WebErrorStatus));
        };
        PetView.CoreWebView2.PermissionRequested += (s, args) =>
        {
            if (args.PermissionKind == CoreWebView2PermissionKind.Microphone ||
                args.PermissionKind == CoreWebView2PermissionKind.Autoplay) args.State = CoreWebView2PermissionState.Allow;
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

    private void RestoreWindowStateEarly() { try { RestoreWindowState(); LocationChanged += (_, _) => SaveWindowState(); } catch { } }
    private void PositionDefault()
    {
        RestoreWindowStateEarly();

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
            _scale = scale;
            Width = 360 * scale;
            Height = 520 * scale;
            var wa = ScreenHelper.WorkArea(this);   /* OCR M7：按窗口所在显示器工作区计算 */
            Left = Math.Min(Left, wa.Right - Width - 4);
            Top = Math.Min(Top, wa.Bottom - Height - 4);
            /* PC 桌宠包含输入框，整窗穿透会让后台应用吃掉点击；命中板负责固定窗口域。 */
            SetClickthrough(false);
        }
        catch { }
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
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
            if (kind == "send" && !string.IsNullOrWhiteSpace(payload)) await HandleSendAsync(payload);
            else if (kind == "drag") { if (_draggable) DragWindowViaWin32(); }
            else if (kind == "input-focus")
            {
                if (payload == "true") SetClickthrough(false);
                else ApplySizeAndClickthrough();
            }
            else if (kind == "pet-back") ActivateMain();
            else if (kind == "gateway") { /* 目标由主窗代理处理 */ }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine("[Pet JS→C#] " + ex);
            ShowTip("桌宠发送失败，请重试");
        }
    }

    private async Task HandleSendAsync(string payload)
    {
        try
        {
            await _ready.Task;
            await _pageReady.Task;
            var configTask = _configReady.Task;
            var completed = await Task.WhenAny(configTask, Task.Delay(TimeSpan.FromSeconds(8)));
            if (completed != configTask)
                ShowTip("桌宠配置同步超时，正在使用当前设置");
            if (_brain == null) { ShowTip("桌宠尚未就绪，请稍后再试"); return; }
            ShowTip("正在回复…");
            await _brain.ChatAsync(payload);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine("[Pet send] " + ex);
            ShowTip("桌宠回复失败，请检查设置或网络");
        }
    }

    private void ShowTip(string text)
    {
        var q = JsonSerializer.Serialize(text);
        try
        {
            Dispatcher.BeginInvoke(new Action(() =>
            {
                PetView.CoreWebView2?.ExecuteScriptAsync("window.PetShowTip && window.PetShowTip(" + q + ")");
            }));
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
            _clickthrough = enabled;
            IntPtr h = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            int style = IntPtr.Size == 8 ? (int)(long)GetWindowLongPtr(h, GWL_EXSTYLE) : GetWindowLong32(h, GWL_EXSTYLE);
            if (enabled) style |= WS_EX_TRANSPARENT; else style &= ~WS_EX_TRANSPARENT;
            if (IntPtr.Size == 8) SetWindowLongPtr(h, GWL_EXSTYLE, (IntPtr)style); else SetWindowLong32(h, GWL_EXSTYLE, style);
        }
        catch { }
    }

    private IntPtr WindowMessageHook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WmNcHitTest && _clickthrough)
        {
            long packed = lParam.ToInt64();
            int screenX = unchecked((short)(packed & 0xffff));
            int screenY = unchecked((short)((packed >> 16) & 0xffff));
            try
            {
                var local = PointFromScreen(new Point(screenX, screenY));
                double inputHeight = Math.Max(64, 76 * _scale);
                if (local.Y >= ActualHeight - inputHeight && local.Y <= ActualHeight + 2)
                {
                    handled = true;
                    return new IntPtr(HtClient);
                }
            }
            catch { }
            handled = true;
            return new IntPtr(HtTransparent);
        }
        return IntPtr.Zero;
    }

    /* 就绪门：WebView/大脑初始化是异步的，主窗可能在 _brain 赋值前就注入配置（OCR 二轮 1） */
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private (string b, string k, string m, bool p, int i)? _pending;

    /// <summary>等待桌宠大脑就绪</summary>
    private bool _draggable = true;
    private static readonly string WinStateFile = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ElainaPet", "pet-window.json");

    /** 主窗把「尺度 / 允许拖动 / 点击穿透」应用到桌宠窗（热生效） */
    public void ApplyOptions(double scale, bool draggable, bool clickthrough)
    {
        try
        {
            if (scale < 0.6) scale = 0.6;
            if (scale > 1.6) scale = 1.6;
            _draggable = draggable;
            Width = 360 * scale;
            Height = 520 * scale;
            SetClickthrough(clickthrough);
            ClampToWorkArea();
        }
        catch { }
    }

    private void ClampToWorkArea()
    {
        try
        {
            var wa = ScreenHelper.WorkArea(this);
            if (Left + Width > wa.Right) Left = wa.Right - Width;
            if (Top + Height > wa.Bottom) Top = wa.Bottom - Height;
            if (Left < wa.Left) Left = wa.Left;
            if (Top < wa.Top) Top = wa.Top;
        }
        catch { }
    }

    private void SaveWindowState()
    {
        try
        {
            var dir = System.IO.Path.GetDirectoryName(WinStateFile);
            if (!string.IsNullOrEmpty(dir)) System.IO.Directory.CreateDirectory(dir);
            System.IO.File.WriteAllText(WinStateFile, System.Text.Json.JsonSerializer.Serialize(new
            {
                Left = double.IsNaN(Left) ? 0 : Left,
                Top = double.IsNaN(Top) ? 0 : Top
            }));
        }
        catch { }
    }

    private void RestoreWindowState()
    {
        try
        {
            if (!System.IO.File.Exists(WinStateFile)) return;
            using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(WinStateFile));
            if (doc.RootElement.TryGetProperty("Left", out var l) && doc.RootElement.TryGetProperty("Top", out var t))
            {
                Left = l.GetDouble();
                Top = t.GetDouble();
            }
        }
        catch { }
    }

    public Task EnsureReadyAsync() => _ready.Task;

    /** 主窗把前端设置（网关/Key/模型/主动回复）注入桌宠大脑；未就绪则缓存待用 */
    public void ConfigureBrain(string baseUrl, string apiKey, string model, bool proactive, int intervalMinutes)
    {
        _pending = (baseUrl, apiKey, model, proactive, intervalMinutes);
        _configReady.TrySetResult();
        if (!_ready.Task.IsCompleted) return;   /* 就绪后在 Loaded 收尾里补应用 */
        ApplyPending();
    }

    private void ApplyPending()
    {
        try
        {
            if (_pending is not { } q || _brain == null) return;
            _brain.Configure(q.b, q.k, q.m);
            _brain.ConfigureRequestBase("http://127.0.0.1:" + LocalProxy.Port);
            _brain.RestartProactive(q.p, q.i);
        }
        catch { }
    }

    protected override void OnClosed(EventArgs e)
    {
        try { _hwndSource?.RemoveHook(WindowMessageHook); } catch { }
        try { _brain?.Dispose(); _brain = null; } catch { }
        try { PetView.Dispose(); } catch { }
        _env = null;
        base.OnClosed(e);
    }

    /* 尺度/穿透变化时由主窗调用刷新 */
    public void RefreshFromSettings() => ApplySizeAndClickthrough();
}
