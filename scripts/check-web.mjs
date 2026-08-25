import { readFile } from 'node:fs/promises';
// 用法：node scripts/check-web.mjs web/index.html
const file = process.argv[2] || 'web/index.html';
const html = await readFile(file, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m; let found = 0; let errors = 0;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/i.test(attrs)) continue;
  const code = m[2];
  if (!code.trim()) continue;
  found++;
  try { new Function(code); } catch (e) { errors++; console.error('SYNTAX ERROR in ' + file + ': ' + e.message); }
}
console.log(found + ' inline script block(s) checked in ' + file + (errors ? ' — ' + errors + ' error(s)' : ' — OK'));
process.exit(errors ? 1 : 0);
