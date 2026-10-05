import { cpSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 允许用环境变量覆盖（换机/CI 可移植），默认取同级的官方仓库 web 目录。
   ★ 之前这里少了一层 '..'：root 是 <仓库>/desktop-pet，只回一级得到的是 <仓库>/ElainaChat-Official/web，
   而两个仓库实际是**平级**的（F:\elnchat\ElainaChat-Official 与 F:\elnchat\ElainaChat-Open），
   于是 PC 打包这一步在这台机器上直接报「找不到 web 源目录」——打不出 PC 外壳。
   现在按候选顺序找：环境变量 → 平级官方仓 → 嵌套在仓库里的官方仓（旧布局）。 */
const candidates = [];
if (process.env.ELAINA_WEB_DIR) candidates.push(path.resolve(process.env.ELAINA_WEB_DIR));
candidates.push(path.resolve(root, '..', '..', 'ElainaChat-Official', 'web'));
candidates.push(path.resolve(root, '..', 'ElainaChat-Official', 'web'));
const src = candidates.find((p) => existsSync(p));
if (!src) {
  console.error('[pack] 找不到 web 源目录，试过：\n  ' + candidates.join('\n  ') + '\n（可用 ELAINA_WEB_DIR 指定）');
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
