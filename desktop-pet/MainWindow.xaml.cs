using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;

namespace ElainaPet;

/// <summary>
/// ElainaChat PC 主窗体：
///  - 聊天模式：WebView2 加载 web-pack/index.html（与安卓同源完整聊天界面）
///  - 桌宠模式：小窗切换 pet.html（立绘+气泡）
///  - 权限：麦克风/媒体授权；下载放行到用户下载目录
/// </summary>
public partial class MainWindow : Window
{
    private CoreWebView2Environment? _env;
    private PetBrain? _brain;
    private LocalProxy? _proxy;
    private bool _petMode;
    private string _appDir = AppContext.BaseDirectory;
    private double _chatW = 1180, _chatH = 800;

    public MainWindow()
    {
        InitializeComponent();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        PositionAtBottomRight();
        await InitializeWebViewAsync();
        _brain = new PetBrain(WebView);
        StartLocalProxy();
        ReloadSettingsAndTimer();
    }

    private void PositionAtBottomRight()
    {
        var wa = SystemParameters.WorkArea;
        Left = wa.Right - Width - 8;
        Top = wa.Bottom - Height - 8;
    }

    private async Task InitializeWebViewAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ElainaPet", "WebView2");
        _env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
        await WebView.EnsureCoreWebView2Async(_env);
        WebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(238, 241, 245);
        WebView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        WebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.__pcPetStatus = { enabled: null };");
        WebView.CoreWebView2.NavigationCompleted += (_, _e) => SyncPetFromSettings();
        WebView.CoreWebView2.PermissionRequested += OnPermissionRequested;
        WebView.CoreWebView2.DownloadStarting += OnDownloadStarting;
        LoadChatPage();
    }

    private void LoadChatPage()
    {
        var html = Path.Combine(_appDir, "web-pack", "index.html");
        if (!File.Exists(html)) html = Path.Combine(Environment.CurrentDirectory, "web-pack", "index.html");
        WebView.Source = new Uri(Path.GetFullPath(html));
    }

    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        try
        {
            var kind = e.PermissionKind;
            if (kind == CoreWebView2PermissionKind.Microphone ||
                kind == CoreWebView2PermissionKind.Camera ||
                kind == CoreWebView2PermissionKind.Notifications)
            {
                e.State = CoreWebView2PermissionState.Allow;
            }
            else
            {
                e.State = CoreWebView2PermissionState.Deny;
            }
        }
        catch { }
    }

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        try
        {
            var downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
            try { Directory.CreateDirectory(downloads); } catch { }
            string name = string.IsNullOrWhiteSpace(e.ResultFilePath) ? "download" : Path.GetFileName(e.ResultFilePath);
            e.ResultFilePath = Path.Combine(downloads, name);
        }
        catch { }
    }

    private void ReloadSettingsAndTimer()
    {
        var s = PetBrain.LoadSettings();
        _brain?.Configure(s.ServerBase, s.ApiKey);
        _brain?.RestartProactive(s.AutoReply, s.IntervalMinutes);
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
                switch (p.ValueKind)
                {
                    case System.Text.Json.JsonValueKind.String: payload = p.GetString() ?? ""; break;
                    case System.Text.Json.JsonValueKind.True: payload = "true"; break;
                    case System.Text.Json.JsonValueKind.False: payload = "false"; break;
                    default: payload = p.ToString(); break;
                }
            }
            if (kind == "send" && !string.IsNullOrWhiteSpace(payload)) _brain?.ChatAsync(payload);
            else if (kind == "drag") DragWindowViaWin32();
            else if (kind == "pet-enabled") SyncPet(payload == "true" || payload == "1" || payload == true.ToString());
            else if (kind == "gateway" && !string.IsNullOrWhiteSpace(payload) && _proxy != null) _proxy.BaseUrl = payload;
            else if (kind == "pet-back") { SyncPet(false); }
        }
        catch (Exception ex) { System.Diagnostics.Debug.WriteLine("[JS→C#] " + ex.Message); }
    }

    /* ---------- 桌宠模式（由设置「桌宠」段控制，默认关闭） ---------- */
    private async void SyncPet(bool? force = null)
    {
        bool want;
        if (force.HasValue) { want = force.Value; }
        else
        {
            want = false;
            try
            {
                var v = await WebView.CoreWebView2.ExecuteScriptAsync("try { localStorage.getItem('elaina_pet_enabled') === '1' } catch(e){ false }");
                want = v.IndexOf("true", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch { }
        }
        if (want == _petMode) return;
        _petMode = want;
        await ApplyPetSizeAsync();
        if (_petMode)
        {
            _chatW = Width; _chatH = Height;
            Width = 360; Height = 520;
            var wa = SystemParameters.WorkArea;
            Left = wa.Right - Width - 8;
            Top = wa.Bottom - Height - 8;
            Topmost = true;
            TitleBar.Visibility = Visibility.Collapsed;
            var html = Path.Combine(_appDir, "www", "pet.html");
            if (!File.Exists(html)) html = Path.Combine(Environment.CurrentDirectory, "www", "pet.html");
            WebView.CoreWebView2.Navigate(new Uri(Path.GetFullPath(html)).AbsoluteUri);
        }
        else
        {
            Width = _chatW; Height = _chatH;
            Left = (SystemParameters.WorkArea.Width - Width) / 2;
            Top = Math.Max(0, (SystemParameters.WorkArea.Height - Height) / 2);
            Topmost = false;
            WindowState = WindowState.Normal;
            LoadChatPage();
        }
    }
    private void StartLocalProxy()
    {
        try
        {
            _proxy = new LocalProxy();
            var st = PetBrain.LoadSettings();
            if (!string.IsNullOrWhiteSpace(st.ServerBase)) _proxy.BaseUrl = st.ServerBase;
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(1200);
                    if (WebView.CoreWebView2 != null)
                        await WebView.CoreWebView2.ExecuteScriptAsync(
                            "(function(){try{var o=JSON.parse(localStorage.getItem('elaina_settings')||'{}');window.chrome&&window.chrome.webview&&window.chrome.webview.postMessage({kind:'gateway',payload:o.baseUrl||''})}catch(e){}})()");
                }
                catch { }
            });
        }
        catch { }
    }

    protected override void OnClosed(EventArgs e)
    {
        _proxy?.Dispose();
        base.OnClosed(e);
    }

    private void SyncPetFromSettings()
    {
        try { SyncPet(); } catch { }
    }

    /* 桌宠尺度（滑块 0.6~1.6）+ 点击穿透（设置 localStorage） */
    private async Task ApplyPetSizeAsync()
    {
        try
        {
            double scale = 1.0; bool ct = false;
            var v = await WebView.CoreWebView2.ExecuteScriptAsync("(function(){try{return localStorage.getItem('elaina_pet_scale')}catch(e){return '1'}})()");
            var v2 = await WebView.CoreWebView2.ExecuteScriptAsync("(function(){try{return localStorage.getItem('elaina_pet_clickthrough')}catch(e){return '0'}})()");
            var m = System.Text.RegularExpressions.Regex.Match(v ?? "", "[0-9.]+");
            if (m.Success && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var sc))
                scale = Math.Clamp(sc, 0.6, 1.6);
            ct = v2.IndexOf("1", StringComparison.Ordinal) >= 0;
            if (_petMode)
            {
                Width = 360 * scale;
                Height = 520 * scale;
            }
            SetClickthrough(ct);
        }
        catch { }
    }
    private void SetClickthrough(bool enabled)
    {
        try
        {
            IntPtr h = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            int style = GetWindowLong(h, GWL_EXSTYLE);
            if (enabled) style |= WS_EX_TRANSPARENT;
            else style &= ~WS_EX_TRANSPARENT;
            SetWindowLong(h, GWL_EXSTYLE, style);
        }
        catch { }
    }
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    private static int GetWindowLong(IntPtr h, int i) => (int)(IntPtr.Size == 8 ? (long)GetWindowLongPtr(h, i) : (long)(uint)GetWindowLong32(h, i));
    private static int SetWindowLong(IntPtr h, int i, int v) => IntPtr.Size == 8 ? (int)(long)SetWindowLongPtr(h, i, (IntPtr)v) : (int)SetWindowLong32(h, i, v);
    [DllImport("user32.dll", EntryPoint = "GetWindowLong")] private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint = "SetWindowLong")] private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

    private void Min_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void Max_Click(object sender, RoutedEventArgs e)
    {
        if (WindowState == WindowState.Maximized) { WindowState = WindowState.Normal; Shell.CornerRadius = new CornerRadius(18); }
        else { WindowState = WindowState.Maximized; Shell.CornerRadius = new CornerRadius(0); }
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Application.Current.Shutdown();

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

    private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is System.Windows.Controls.Button) return;
        if (e.ClickCount == 2 && !_petMode) Max_Click(sender, e);
        else DragMove();
    }

    private void Exit_Click(object sender, RoutedEventArgs e) => Application.Current.Shutdown();
}
