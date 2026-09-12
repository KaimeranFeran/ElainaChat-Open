import { cpSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 允许用环境变量覆盖（换机/CI 可移植），默认取同级的官方仓库 web 目录 */
const src = process.env.ELAINA_WEB_DIR
  ? path.resolve(process.env.ELAINA_WEB_DIR)
  : path.resolve(root, '..', 'ElainaChat-Official', 'web');
if (!existsSync(src)) {
  console.error('[pack] 找不到 web 源目录：' + src + '（可用 ELAINA_WEB_DIR 指定）');
  process.exit(1);
}
const gateway = process.env.ELAINA_DEFAULT_GW || 'http://106.14.16.68';

/* ---------- 1) 主界面：web -> web-pack（PC 聊天界面） ---------- */
const dst = path.join(root, 'web-pack');
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true, filter: (p) => !p.includes('serve.mjs') });
const idx = path.join(dst, 'index.html');
let c = readFileSync(idx, 'utf8');
/* 只替换 HTML 属性中的绝对路径前缀（锚定属性，避免误伤内联脚本字面量） */
c = c.split('src="/').join('src="').split('href="/').join('href="');
c = c.replace('<head>', '<head>\n<script>window.__PC_DESKTOP=true;window.__PC_DEFAULT_GW=' + JSON.stringify(gateway) + ';window.__PC_PROXY_BASE="http://127.0.0.1:3500";</script>');
writeFileSync(idx, c, 'utf8');

/* ---------- 2) 桌宠窗：web -> www（pet.* + 立绘 + 背景），避免手工副本过期 ---------- */
const www = path.join(root, 'www');
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of ['pet.html', 'pet.css', 'pet.js']) {
  if (existsSync(path.join(src, f))) cpSync(path.join(src, f), path.join(www, f));
}
for (const dir of ['img']) {
  if (existsSync(path.join(src, dir))) cpSync(path.join(src, dir), path.join(www, dir), { recursive: true });
}
console.log('packed ->', dst, '| www ->', www, '| config.json:', existsSync(path.join(dst, 'config.json')), '| gateway:', gateway);
