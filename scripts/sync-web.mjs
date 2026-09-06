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
await copyDir(path.join(sourceRoot, 'vendor'), path.join(androidWebRoot, 'vendor'));
await copyDir(path.join(sourceRoot, 'assets'), path.join(androidWebRoot, 'assets'));
await copyDir(path.join(sourceRoot, 'js'), path.join(androidWebRoot, 'js'));
await copyDir(path.join(sourceRoot, 'img'), path.join(androidWebRoot, 'img'));
await copyFile(path.join(sourceRoot, 'pet.html'), path.join(androidWebRoot, 'pet.html'));
await copyFile(path.join(sourceRoot, 'pet.css'), path.join(androidWebRoot, 'pet.css'));
await copyFile(path.join(sourceRoot, 'pet.js'), path.join(androidWebRoot, 'pet.js'));
console.log('Synced web UI (html + vendor + assets + js) into Android www/.');
