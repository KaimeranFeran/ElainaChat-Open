import fs from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(projectRoot, 'web');
const androidWebRoot = path.join(projectRoot, 'android-app', 'www');

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

await mkdir(path.join(androidWebRoot, 'vendor'), { recursive: true });
await copyFile(path.join(sourceRoot, 'index.html'), path.join(androidWebRoot, 'index.html'));
await copyFile(path.join(sourceRoot, 'vendor', 'tailwind.js'), path.join(androidWebRoot, 'vendor', 'tailwind.js'));
(path.join(sourceRoot, 'vendor'), path.join(androidWebRoot, 'vendor'));
await copyDir(path.join(sourceRoot, 'assets'), path.join(androidWebRoot, 'assets'));
await copyDir(path.join(sourceRoot, 'js'), path.join(androidWebRoot, 'js'));
await copyFile(path.join(sourceRoot, 'galgame.css'), path.join(androidWebRoot, 'galgame.css'));
await copyDir(path.join(sourceRoot, 'img'), path.join(androidWebRoot, 'img'));
await copyFile(path.join(sourceRoot, 'pet.html'), path.join(androidWebRoot, 'pet.html'));
await copyFile(path.join(sourceRoot, 'pet.css'), path.join(androidWebRoot, 'pet.css'));
await copyFile(path.join(sourceRoot, 'pet.js'), path.join(androidWebRoot, 'pet.js'));

/* STRIP_KEY：开源版绝不分发任何内置 Key（正式版才有） */
const petJsPath = path.join(androidWebRoot, 'pet.js');
try {
  if (fs.existsSync(petJsPath)) {
    const src = fs.readFileSync(petJsPath, 'utf8');
    const cleaned = src.replace(/apiKey: '[^']*'/, "apiKey: ''");
    if (cleaned !== src) { fs.writeFileSync(petJsPath, cleaned, 'utf8'); console.log('[sync-web] 已剥离内置 Key（开源版）'); }
  }
} catch (e) { console.warn('[sync-web] 剥离 Key 失败：' + e.message); }

console.log('Synced web UI (html + vendor + assets + js) into Android www/.');
