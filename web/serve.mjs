import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3080);

// ==================== 网关配置（web/config.json） ====================
// Web 页面跑在 http://localhost:PORT，直连网关会被浏览器跨域(CORS)拦截，
// 这里把 /api/*、/announcement.json、/health 同源代理到网关。
// gatewayUrl 为主地址，gatewayFallback 为域名不可用时的备用 IP。
let gatewayUrl = 'https://elainachat.j3.ink';
let gatewayFallback = 'http://106.14.16.68';
try {
  const cfg = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));
  if (cfg && typeof cfg.gatewayUrl === 'string' && cfg.gatewayUrl.trim()) gatewayUrl = cfg.gatewayUrl.trim().replace(/\/+$/, '');
  if (cfg && typeof cfg.gatewayFallback === 'string' && cfg.gatewayFallback.trim()) gatewayFallback = cfg.gatewayFallback.trim().replace(/\/+$/, '');
} catch (e) { console.warn('[serve] 未找到 config.json，使用默认网关 ' + gatewayUrl); }
console.log('[serve] 网关代理 -> ' + gatewayUrl + '（回退 ' + gatewayFallback + '）');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff'
};

const PROXY_PATHS = ['/api/', '/announcement.json', '/health'];

function forward(req, res, base, body) {
  return new Promise(async (resolve) => {
    try {
      const url = new URL(req.url, 'http://x');
      const target = new URL(base + url.pathname + url.search);
      const mod = target.protocol === 'https:' ? await import('node:https') : await import('node:http');
      const headers = { ...req.headers, host: target.host };
      const preq = mod.request(target, { method: req.method, headers }, (pres) => {
        const code = pres.statusCode || 502;
        if (code >= 400) { pres.resume(); resolve({ ok: false, code }); return; }
        res.writeHead(code, {
          ...pres.headers,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': '*'
        });
        pres.pipe(res);
        resolve({ ok: true, code });
      });
      preq.on('error', (err) => resolve({ ok: false, code: 0, err: String(err && err.message || err) }));
      if (body && body.length) preq.write(body);
      preq.end();
    } catch (e) {
      resolve({ ok: false, code: 0, err: String(e && e.message || e) });
    }
  });
}

async function proxy(req, res, chunks) {
  const body = Buffer.concat(chunks);
  let r = await forward(req, res, gatewayUrl, body);
  if (!r.ok && gatewayFallback && gatewayFallback !== gatewayUrl) {
    console.log('[serve] 主网关失败(' + (r.code || r.err) + ')，回退 ' + gatewayFallback);
    r = await forward(req, res, gatewayFallback, body);
  }
  if (!r.ok && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('网关不可达: ' + gatewayUrl + ' / ' + gatewayFallback);
  }
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + p);
  }
}

const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    return;
  }
  if (PROXY_PATHS.some(prefix => p === prefix || p.startsWith(prefix))) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => proxy(req, res, chunks));
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => console.log('[serve] ElainaChat Web 运行在 http://127.0.0.1:' + PORT));
