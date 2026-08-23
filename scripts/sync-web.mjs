import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(projectRoot, 'web');
const androidWebRoot = path.join(projectRoot, 'android-app', 'www');

await mkdir(path.join(androidWebRoot, 'vendor'), { recursive: true });
await copyFile(path.join(sourceRoot, 'index.html'), path.join(androidWebRoot, 'index.html'));
await copyFile(path.join(sourceRoot, 'vendor', 'tailwind.js'), path.join(androidWebRoot, 'vendor', 'tailwind.js'));
await copyFile(path.join(sourceRoot, 'vendor', 'qrcode.js'), path.join(androidWebRoot, 'vendor', 'qrcode.js'));
await copyFile(path.join(sourceRoot, 'vendor', 'jsQR.js'), path.join(androidWebRoot, 'vendor', 'jsQR.js'));
console.log('Synced open-source Web UI into the Android project.');
