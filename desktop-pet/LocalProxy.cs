using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ElainaPet;

/// <summary>
/// PC 本地同源代理（file:// 页面跨域问题的解决方案）。
/// 安全约束：
///   1) 仅监听 127.0.0.1；
///   2) 只允许来源为本地页面（Origin 缺失或 "null"，即 file://）的请求，其它来源一律 403；
///   3) 只转发网关白名单路径（/api/、/health、/announcement.json、/qr-*.png），其它 404；
///   4) Content-Length 有上限，避免异常请求造成 OOM。
/// </summary>
public sealed class LocalProxy : IDisposable
{
    public const int Port = 3500;
    private static readonly HttpClient Http = new(new HttpClientHandler { UseProxy = false })
    {
        Timeout = TimeSpan.FromMinutes(3)
    };
    private const int MaxBodyBytes = 32 * 1024 * 1024;

    public string BaseUrl { get; set; } = "http://106.14.16.68";

    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task? _loop;

    public LocalProxy()
    {
        _listener = new TcpListener(IPAddress.Loopback, Port);
        _loop = Task.Run(ListenLoop);
    }

    private async Task ListenLoop()
    {
        try
        {
            _listener.Start();
            while (!_cts.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync();
                _ = Task.Run(() => HandleAsync(client));
            }
        }
        catch { /* 端口占用/退出：静默（主窗另有提示） */ }
    }

    private async Task HandleAsync(TcpClient client)
    {
        /* OCR 二轮 2：stream 必须在 try 之外持有 —— 否则异常路径里它已被释放，catch 中的 502 写不出去 */
        NetworkStream? netStream = null;
        try
        {
            client.ReceiveTimeout = 15000;
            netStream = client.GetStream();
            using var reader = new StreamReader(netStream!, Encoding.UTF8, false, 8192, leaveOpen: true);
            string? requestLine = await reader.ReadLineAsync();
            if (string.IsNullOrWhiteSpace(requestLine)) return;
            var parts = requestLine.Split(' ');
            if (parts.Length < 3) return;
            string method = parts[0], path = parts[1];

            string? origin = null, contentType = null, authorization = null, acrh = null;
            int contentLength = 0;
            bool chunked = false;
            client.ReceiveTimeout = 15000;   /* OCR M2：避免客户端连上不发数据长期挂起 */
            string? line;
            while ((line = await reader.ReadLineAsync()) != null && line.Length > 0)
            {
                var idx = line.IndexOf(':');
                if (idx <= 0) continue;
                string k = line[..idx].Trim().ToLowerInvariant();
                string v = line[(idx + 1)..].Trim();
                if (k == "origin") origin = v;
                else if (k == "content-type") contentType = v;
                else if (k == "authorization") authorization = v;
                else if (k == "access-control-request-headers") acrh = v;   /* OCR 二轮 4：预检需回显 */
                else if (k == "content-length") int.TryParse(v, out contentLength);
                else if (k == "transfer-encoding" && v.ToLowerInvariant().Contains("chunked")) chunked = true;   /* OCR M2 */
            }

            /* 来源校验：只服务本地 file:// 页面（Origin 缺失或为 "null"） */
            bool localOrigin = string.IsNullOrEmpty(origin) || origin == "null" || origin.StartsWith("file://", StringComparison.OrdinalIgnoreCase);
            if (!localOrigin)
            {
                await WriteResponseAsync(netStream!, 403, Encoding.UTF8.GetBytes("{\"error\":\"forbidden origin\"}"), "application/json; charset=utf-8", origin);
                return;
            }

            /* 路径白名单（剥离 query 后比较，避免 /announcement.json?t=1 被误判 404 —— OCR 二轮） */
            string barePath = path;
            int qIdx = barePath.IndexOf('?');
            if (qIdx >= 0) barePath = barePath[..qIdx];
            bool allowed = barePath.StartsWith("/api/", StringComparison.Ordinal)
                        || barePath.Equals("/health", StringComparison.OrdinalIgnoreCase)
                        || barePath.Equals("/announcement.json", StringComparison.OrdinalIgnoreCase)
                        || barePath.StartsWith("/qr-", StringComparison.OrdinalIgnoreCase);
            if (!allowed)
            {
                await WriteResponseAsync(netStream!, 404, Encoding.UTF8.GetBytes("{\"error\":\"not found\"}"), "application/json; charset=utf-8", origin);
                return;
            }

            if (method.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                await WriteResponseAsync(netStream!, 204, Array.Empty<byte>(), "text/plain; charset=utf-8", origin, acrh);
                return;
            }

            if (chunked)
            {
                await WriteResponseAsync(netStream!, 411, Encoding.UTF8.GetBytes("{\"error\":\"chunked not supported\"}"), "application/json; charset=utf-8", origin);
                return;
            }
            if (contentLength < 0 || contentLength > MaxBodyBytes)
            {
                await WriteResponseAsync(netStream!, 400, Encoding.UTF8.GetBytes("{\"error\":\"bad content-length\"}"), "application/json; charset=utf-8", origin);
                return;
            }

            byte[] body = Array.Empty<byte>();
            if (contentLength > 0)
            {
                body = new byte[contentLength];
                int read = 0;
                while (read < contentLength)
                {
                    int n = await netStream!.ReadAsync(body.AsMemory(read, contentLength - read));
                    if (n <= 0) break;
                    read += n;
                }
            }

            var target = (BaseUrl ?? "").Trim().TrimEnd('/');
            if (target.Length == 0) target = "http://106.14.16.68";
            using var req = new HttpRequestMessage(new HttpMethod(method), target + path);
            if (!string.IsNullOrWhiteSpace(authorization)) req.Headers.TryAddWithoutValidation("Authorization", authorization);
            if (body.Length > 0)
            {
                req.Content = new ByteArrayContent(body);
                if (!string.IsNullOrWhiteSpace(contentType)) req.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
            }
            using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, _cts.Token);
            byte[] respBody = res.Content == null ? Array.Empty<byte>() : await res.Content.ReadAsByteArrayAsync();
            string respType = res.Content?.Headers.ContentType?.ToString() ?? "application/json; charset=utf-8";
            await WriteResponseAsync(netStream!, (int)res.StatusCode, respBody, respType, origin, acrh);
        }
        catch
        {
            /* 明确回 502，而不是静默断连（否则前端只看到网络错误） */
            try
            {
                netStream ??= client.GetStream();
                await WriteResponseAsync(netStream!, 502, Encoding.UTF8.GetBytes("{\"error\":\"upstream unavailable\"}"), "application/json; charset=utf-8", null);
            }
            catch { }
        }
        finally
        {
            try { client.Close(); } catch { }
        }
    }

    private static async Task WriteResponseAsync(NetworkStream stream, int code, byte[] body, string contentType, string? origin, string? acrh = null)
    {
        string reason = code switch
        {
            200 => "OK", 204 => "No Content", 400 => "Bad Request", 403 => "Forbidden",
            404 => "Not Found", 502 => "Bad Gateway", _ => "OK"
        };
        string acao = (string.IsNullOrEmpty(origin) || origin == "null") ? "null" : origin;
        string head = "HTTP/1.1 " + code + " " + reason + "\r\n" +
                      "Content-Type: " + contentType + "\r\n" +
                      "Access-Control-Allow-Origin: " + acao + "\r\n" +
                      "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS" + "\r\n" +
                      "Access-Control-Allow-Headers: " + (string.IsNullOrWhiteSpace(acrh) ? "Content-Type, Authorization" : acrh) + "\r\n" +
                      "Access-Control-Max-Age: 86400" + "\r\n" +
                      "Vary: Origin" + "\r\n" +
                      "Content-Length: " + body.Length + "\r\n" +
                      "Connection: close" + "\r\n\r\n";
        await stream.WriteAsync(Encoding.UTF8.GetBytes(head));
        if (body.Length > 0) await stream.WriteAsync(body);
        await stream.FlushAsync();
    }

    public void Dispose()
    {
        try { _cts.Cancel(); } catch { }
        try { _listener.Stop(); } catch { }
    }
}
