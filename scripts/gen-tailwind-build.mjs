/**
 * 预编译 Tailwind（仓库内版本，探针里那份是同一逻辑的草稿）
 *
 * 预编译 Tailwind：把 web/ 源码里出现过的所有 class token 交给 CDN JIT 生成一份静态 CSS，
 * 再从 index.html 摘掉 407KB 运行时 JIT（它让启动长任务 535ms、FCP 604ms）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(root, 'android-app', 'package.json'));
const { chromium } = req('playwright-core');   /* 用工程里已有的 playwright-core，不额外装依赖 */
const WEB = path.join(root, 'web');
const OUT = path.join(WEB, 'assets', 'tailwind.build.css');
const SKIP = new Set(['node_modules', '.git', 'vendor']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name)); continue; }
    if (/\.(html|js)$/.test(e.name)) files.push(path.join(dir, e.name));
  }
})(WEB);
const tokens = new Set();
const RE = /class\s*=\s*[\"']([^\"']*)[\"']/g;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = RE.exec(text))) {
    String(m[1]).split(/\s+/).forEach((t) => { if (t && t.length < 90 && !t.includes('{') && !t.includes('}')) tokens.add(t); });
  }
  RE.lastIndex = 0;
}
const list = Array.from(tokens).filter((t) => /^[a-zA-Z0-9!\-\[]/.test(t));
console.log('扫描文件 ' + files.length + ' 个，class token ' + list.length + ' 个');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const srv = http.createServer((rq, rs) => {
  let p = decodeURIComponent(String(rq.url).split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.resolve(path.join(WEB, p));
  if (!f.toLowerCase().startsWith(path.resolve(WEB).toLowerCase()) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end('404'); return; }
  rs.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(rs);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage();
const doc = '<!doctype html><html><head><scr' + 'ipt src="' + BASE + '/vendor/tailwind.js"></scr' + 'ipt></head><body></body></html>';
await page.setContent(doc, { waitUntil: 'load' });
await page.waitForTimeout(1500);
const css = await page.evaluate((toks) => {
  const frag = document.createDocumentFragment();
  toks.forEach((t) => { const d = document.createElement('div'); try { d.className = t; } catch (e) {} frag.appendChild(d); });
  document.body.appendChild(frag);
  return new Promise((resolve) => setTimeout(() => resolve(Array.from(document.querySelectorAll('style')).map((s) => s.textContent || '').join('\n')), 1500));
}, list);
console.log('JIT 生成 CSS: ' + css.length + ' 字节');
if (css.length < 5000) { console.error('生成的 CSS 太小，判定失败，未写入'); process.exit(1); }
const header = '/* 由 _probe/elainachat/gen-tailwind.mjs 预编译生成，请勿手改。\n   来源：web/ 下 html+js 扫出的 ' + list.length + ' 个 class token，交给 vendor/tailwind.js 一次性生成。\n   目的：正式运行不再加载 407KB 运行时 JIT（实测启动长任务 535ms、FCP 604ms）。 */\n';
fs.writeFileSync(OUT, header + css, 'utf8');
console.log('已写入 ' + OUT);
await browser.close(); srv.close();
