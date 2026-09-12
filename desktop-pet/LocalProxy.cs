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
/// 本地同源代理（127.0.0.1:3500）：把 file:// 页面发起的 /api/* 请求转发到真实网关，
/// 并补上 CORS 头（绕过 WebView2 跨域限制）。WebSocket（/ws-tts）由前端直连网关，不经此代理。
/// </summary>
public class LocalProxy : IDisposable
{
    public const int Port = 3500;
    public string BaseUrl { get; set; } = "https://elainachat.j3.ink";

    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

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
        catch { }
    }

    private async Task HandleAsync(TcpClient client)
    {
        try
        {
            using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.UTF8, false, 8192, leaveOpen: true);
            string? requestLine = await reader.ReadLineAsync();
            if (string.IsNullOrWhiteSpace(requestLine)) return;
            var parts = requestLine.Split(' ');
            if (parts.Length < 3) return;
            string method = parts[0], path = parts[1];

            // 请求头
            string? host = null, contentType = null, authorization = null;
            int contentLength = 0;
            string? line;
            while ((line = await reader.ReadLineAsync()) != null && line.Length > 0)
            {
                var idx = line.IndexOf(':');
                if (idx <= 0) continue;
                string k = line[..idx].Trim().ToLowerInvariant();
                string v = line[(idx + 1)..].Trim();
                if (k == "host") host = v;
                else if (k == "content-type") contentType = v;
                else if (k == "authorization") authorization = v;
                else if (k == "content-length") int.TryParse(v, out contentLength);
            }

            // OPTIONS 预检直接放行
            if (method.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                await WriteResponseAsync(stream, 200, new byte[0], "text/plain; charset=utf-8");
                return;
            }

            // Body
            byte[] body = new byte[0];
            if (contentLength > 0)
            {
                body = new byte[contentLength];
                int read = 0;
                while (read < contentLength)
                {
                    int n = await stream.ReadAsync(body, read, contentLength - read);
                    if (n <= 0) break;
                    read += n;
                }
            }

            // 转发
            var target = (BaseUrl ?? "https://elainachat.j3.ink").Trim().TrimEnd('/');
            var full = target + path;
            using var req = new HttpRequestMessage(new HttpMethod(method), full);
            if (!string.IsNullOrWhiteSpace(authorization)) req.Headers.TryAddWithoutValidation("Authorization", authorization);
            if (!string.IsNullOrWhiteSpace(contentType) && body.Length > 0)
                req.Content = new ByteArrayContent(body);
            if (req.Content != null && !string.IsNullOrWhiteSpace(contentType))
                req.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
            using var handler = new HttpClientHandler { UseProxy = false };
            using var http = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(3) };
            using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, _cts.Token);
            byte[] respBody = res.Content == null ? new byte[0] : await res.Content.ReadAsByteArrayAsync();
            string respType = res.Content?.Headers.ContentType?.ToString() ?? "application/json; charset=utf-8";
            await WriteResponseAsync(stream, (int)res.StatusCode, respBody, respType);
        }
        catch { }
        finally
        {
            try { client.Close(); } catch { }
        }
    }

    private static async Task WriteResponseAsync(NetworkStream stream, int code, byte[] body, string contentType)
    {
        string head = "HTTP/1.1 " + code + " OK" + "\r\n" +
                      "Content-Type: " + contentType + "\r\n" +
                      "Access-Control-Allow-Origin: *" + "\r\n" +
                      "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS" + "\r\n" +
                      "Access-Control-Allow-Headers: Content-Type, Authorization" + "\r\n" +
                      "Access-Control-Max-Age: 86400" + "\r\n" +
                      "Content-Length: " + body.Length + "\r\n" +
                      "Connection: keep-alive" + "\r\n" + "\r\n";
        var headBytes = Encoding.UTF8.GetBytes(head);
        await stream.WriteAsync(headBytes);
        if (body.Length > 0) await stream.WriteAsync(body);
        await stream.FlushAsync();
    }

    public void Dispose()
    {
        try { _cts.Cancel(); } catch { }
        try { _listener.Stop(); } catch { }
    }
}
