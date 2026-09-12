using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Wpf;

namespace ElainaPet;

/// <summary>
/// 桌宠大脑：网关 LLM 调用 + 主动回复定时器（读前台窗口文本） + 设置持久化。
/// </summary>
public class PetBrain
{
    private static readonly string SettingsDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ElainaPet");
    private static readonly string SettingsFile = Path.Combine(SettingsDir, "settings.json");

    private const string SystemPrompt =
        "你是伊蕾娜（Elaina），一位微傲娇的天才魔女，喜欢旅行与读书。说话温柔但带一点小傲娇，用中文回复，简洁自然，偶尔有（动作/神态）描述。";

    /** 默认网关（与前端 config.json / pack.mjs 注入保持一致） */
    public const string DefaultGateway = "http://106.14.16.68";

    /** 旧域名统一归一化到当前默认网关（https 域名在 WebView/HttpClient 侧握手不通，PC 端会 130s 超时） */
    public static string NormalizeGateway(string? url)
    {
        var v = (url ?? "").Trim().TrimEnd('/');
        if (v.Length == 0) return DefaultGateway;
        if (v.Contains("elainachat.j3.ink", StringComparison.OrdinalIgnoreCase)) return DefaultGateway;
        return v;
    }

    private readonly WebView2 _web;
    /* 静态复用：避免每次新建都不释放导致端口耗尽 */
    private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(130) };
    private string _base = "";
    private string _requestBase = "";
    private string _key = "";
    private string _model = "MiniMax-M3";   /* 与前端 state.settings.model 默认值一致（OCR 二轮） */
    private bool _auto;
    private int _interval = 15;
    private Timer? _timer;
    private long _lastProactiveAt;

    public PetBrain(WebView2 web) { _web = web; }

    public static ElainaSettings LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsFile))
                return JsonSerializer.Deserialize<ElainaSettings>(File.ReadAllText(SettingsFile)) ?? new ElainaSettings();
        }
        catch { }
        return new ElainaSettings();
    }

    public static void SaveSettings(ElainaSettings s)
    {
        try
        {
            Directory.CreateDirectory(SettingsDir);
            File.WriteAllText(SettingsFile, JsonSerializer.Serialize(s, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    public void ConfigureFromSettings()
    {
        var s = LoadSettings();
        var baseUrl = File.Exists(SettingsFile) ? s.ServerBase : DefaultGateway;
        Configure(baseUrl, s.ApiKey);
    }

    public void Configure(string baseUrl, string apiKey, string? model = null)
    {
        baseUrl = NormalizeGateway(baseUrl);
        var candidate = (baseUrl ?? "").Trim().TrimEnd('/');
        _base = string.IsNullOrWhiteSpace(candidate) ? DefaultGateway : candidate;
        _key = (apiKey ?? "").Trim();
        if (!string.IsNullOrWhiteSpace(model)) _model = model.Trim();
    }

    public void ConfigureRequestBase(string requestBaseUrl)
    {
        _requestBase = (requestBaseUrl ?? "").Trim().TrimEnd('/');
    }

    /// <summary>主动回复：重启定时器（默认关闭；开启后每 5~60 分钟读前台窗口并主动聊天）。</summary>
    public void RestartProactive(bool auto, int intervalMinutes)
    {
        _auto = auto;
        _interval = Math.Clamp(intervalMinutes, 5, 60);
        _timer?.Dispose();
        _timer = null;
        if (!_auto) return;
        _timer = new Timer(_ => ProactiveTick(), null, _interval * 60000, _interval * 60000);
    }

    private void ProactiveTick()
    {
        try
        {
            string text = UiTextReader.ReadForeground();
            if (string.IsNullOrWhiteSpace(text) || text.Length < 20) return;
            if (Environment.TickCount64 - _lastProactiveAt < _interval * 60000L * 0.8) return;
            _lastProactiveAt = Environment.TickCount64;
            string ctx = text.Length > 900 ? text.Substring(0, 900) : text;
            _ = ChatAsync("（主动搭话）用户现在正处在这个场景：" + ctx
                + "。自然地跟用户闲聊一句，不要复述界面内容，控制在80字以内，语气照常（可带动作描述）。");
        }
        catch { }
    }

    public async Task ChatAsync(string userText)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(_key)) { PostToWeb("请先在主界面设置中填写 ElainaChat 使用 Key"); return; }
            var payload = new
            {
                model = _model,
                messages = new object[]
                {
                    new { role = "system", content = SystemPrompt },
                    new { role = "user", content = userText }
                }
            };
            var requestBase = string.IsNullOrWhiteSpace(_requestBase) ? _base : _requestBase;
            var req = new HttpRequestMessage(HttpMethod.Post, requestBase + "/api/chat/completions");
            if (!string.IsNullOrWhiteSpace(_key)) req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + _key);
            req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            using var res = await _http.SendAsync(req);
            string raw = await res.Content.ReadAsStringAsync();
            if (!res.IsSuccessStatusCode)
            {
                PostToWeb("网关返回 [" + (int)res.StatusCode + "]，请检查 Key/地址");
                WriteLog("chat http " + (int)res.StatusCode + " " + requestBase + " target=" + _base);
                return;
            }
            using var doc = JsonDocument.Parse(raw);
            string? reply = ExtractReply(doc.RootElement);
            PostToWeb(string.IsNullOrWhiteSpace(reply) ? "（伊蕾娜没有说话）" : reply.Trim());
        }
        catch (Exception ex)
        {
            WriteLog("chat failed " + ex.GetType().Name + ": " + ex.Message);
            PostToWeb("连接失败：" + (ex.Message ?? "网络错误"));
        }
    }

    private static string? ExtractReply(JsonElement root)
    {
        if (!root.TryGetProperty("choices", out var choices) ||
            choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0) return null;
        var first = choices[0];
        if (!first.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object) return null;
        if (!message.TryGetProperty("content", out var content)) return null;
        if (content.ValueKind == JsonValueKind.String) return content.GetString();
        if (content.ValueKind == JsonValueKind.Array)
        {
            var sb = new StringBuilder();
            foreach (var part in content.EnumerateArray())
            {
                if (part.ValueKind == JsonValueKind.String) sb.Append(part.GetString());
                else if (part.ValueKind == JsonValueKind.Object && part.TryGetProperty("text", out var text)) sb.Append(text.GetString());
            }
            return sb.ToString();
        }
        return null;
    }

    private void PostToWeb(string text)
    {
        string q = JsonSerializer.Serialize(text);
        try
        {
            _web.Dispatcher.BeginInvoke(new Action(() =>
            {
                _web.CoreWebView2?.ExecuteScriptAsync("window.PetOnReply && window.PetOnReply(" + q + ")");
            }));
        }
        catch { }
    }
    /** 释放定时器（窗口关闭时调用） */
    public void Dispose()
    {
        try { _timer?.Dispose(); _timer = null; } catch { }
    }

    private static void WriteLog(string message)
    {
        try
        {
            var path = App.LogPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(path, DateTime.Now + " [PetBrain] " + message + Environment.NewLine);
        }
        catch { }
    }
}
