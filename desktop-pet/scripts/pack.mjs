import { cpSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* ★ 只吃**本仓库自己的** web/ —— 绝不再回退到 Official 的网页。
   原因：官方网页里有 client-auth.js（客户端证明）与官方网关默认值，
   一旦被拷进开源包的 web-pack，开源 PC 版就会被网关当成官方客户端放行，
   破坏「开源版不回复」这条底线。
   ELAINA_WEB_DIR 仍可覆盖（给 CI 用），但默认值只认自己。 */
const candidates = [];
if (process.env.ELAINA_WEB_DIR) candidates.push(path.resolve(process.env.ELAINA_WEB_DIR));
candidates.push(path.resolve(root, '..', 'web'));
const src = candidates.find((p) => existsSync(p));
if (!src) {
  console.error('[pack] 找不到 web 源目录，试过：\n  ' + candidates.join('\n  ') + '\n（可用 ELAINA_WEB_DIR 指定）');
  process.exit(1);
}
const gateway = process.env.ELAINA_DEFAULT_GW || '';

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
/* ★ 只清掉本脚本**自己管**的那几样（pet.* 与 img/），不再整目录 rmSync：
   www/vendor/live2d/** 是仓库里入库的资源，整目录删掉会让它们每次打包都消失
   （实测踩过两次：打完包 git status 里一串 D，得再 git checkout 回来）。 */
for (const f of ['pet.html', 'pet.css', 'pet.js']) rmSync(path.join(www, f), { force: true });
rmSync(path.join(www, 'img'), { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of ['pet.html', 'pet.css', 'pet.js']) {
  if (existsSync(path.join(src, f))) cpSync(path.join(src, f), path.join(www, f));
}
for (const dir of ['img']) {
  if (existsSync(path.join(src, dir))) cpSync(path.join(src, dir), path.join(www, dir), { recursive: true });
}
console.log('packed ->', dst, '| www ->', www, '| config.json:', existsSync(path.join(dst, 'config.json')), '| gateway:', gateway);
