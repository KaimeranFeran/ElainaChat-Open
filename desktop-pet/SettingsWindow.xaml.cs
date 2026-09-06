using System;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Windows;

namespace ElainaPet;

/// <summary>
/// 应用设置数据模型，序列化到 %AppData%/ElainaPet/settings.json。
/// </summary>
public class ElainaSettings
{
    public string ServerBase { get; set; } = "http://127.0.0.1:8080";
    public string ApiKey { get; set; } = "";
    public bool AutoReply { get; set; } = false;    // 主动回复开关
    public int IntervalMinutes { get; set; } = 15;  // 主动回复间隔（分钟）
}

/// <summary>
/// 设置窗口：编辑并持久化设置，含“测试连接”按钮（GET {base}/health）。
/// </summary>
public partial class SettingsWindow : Window
{
    private static readonly string SettingsDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ElainaPet");
    private static readonly string SettingsFile = Path.Combine(SettingsDir, "settings.json");

    // 当前设置，供外部读取（如主窗口后续使用）。
    public ElainaSettings Current { get; private set; } = new();

    public SettingsWindow()
    {
        InitializeComponent();
        LoadSettings();
    }

    private void IntervalSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (IntervalLabel != null)
            IntervalLabel.Text = $"{(int)e.NewValue} 分钟";
    }

    private void LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsFile))
            {
                var json = File.ReadAllText(SettingsFile);
                Current = JsonSerializer.Deserialize<ElainaSettings>(json) ?? new ElainaSettings();
            }
        }
        catch (Exception ex)
        {
            StatusText.Text = "读取设置失败：" + ex.Message;
        }

        ServerBaseBox.Text = Current.ServerBase;
        ApiKeyBox.Text = Current.ApiKey;
        AutoReplyBox.IsChecked = Current.AutoReply;
        IntervalSlider.Value = Math.Clamp(Current.IntervalMinutes, 5, 60);
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        Current.ServerBase = ServerBaseBox.Text.Trim();
        Current.ApiKey = ApiKeyBox.Text.Trim();
        Current.AutoReply = AutoReplyBox.IsChecked == true;
        Current.IntervalMinutes = (int)IntervalSlider.Value;

        try
        {
            Directory.CreateDirectory(SettingsDir);
            var json = JsonSerializer.Serialize(Current, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(SettingsFile, json);
            StatusText.Text = "已保存到 " + SettingsFile;
        }
        catch (Exception ex)
        {
            StatusText.Text = "保存失败：" + ex.Message;
        }
    }

    // 测试连接：GET {base}/health。
    private async void TestConnection_Click(object sender, RoutedEventArgs e)
    {
        var baseUrl = ServerBaseBox.Text.Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            StatusText.Text = "请先填写服务地址";
            return;
        }

        StatusText.Text = "测试中...";
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var res = await client.GetAsync($"{baseUrl}/health");
            var body = await res.Content.ReadAsStringAsync();
            StatusText.Text = res.IsSuccessStatusCode
                ? $"连接成功（HTTP {(int)res.StatusCode}）：{body}"
                : $"HTTP {(int)res.StatusCode}：{body}";
        }
        catch (Exception ex)
        {
            StatusText.Text = "连接失败：" + ex.Message;
        }
    }
}
