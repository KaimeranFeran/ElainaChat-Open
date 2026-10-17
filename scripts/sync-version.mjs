#!/usr/bin/env node
/**
 * 版本号：单一来源 + 派生 + 校验（开源版 ElainaChat-Open）
 *
 * 单一来源 = 仓库根目录的 version.json：
 *   { "version": "2.2.0", "versionCode": 109 }
 *
 * 其它所有出现版本号的地方都由这里派生，不再各自维护：
 *   · package.json                                  version
 *   · android-app/android/app/build.gradle          versionCode / versionName   ← APK 的版本
 *   · web/js/version.js                             window.ELAINA_APP_VERSION   ← 侧栏版本号读它
 *   · web/index.html  侧栏                          不得再硬编码 vX.Y.Z
 *
 * 用法：
 *   node scripts/sync-version.mjs           把 version.json 写进上面这些派生位置
 *   node scripts/sync-version.mjs --check   只校验，任何一处不一致即退出 1
 *
 * 为什么要有这个脚本：开源版此前三处各说各话 —— package.json 写 1.3.4、
 * build.gradle 写 versionCode 4 / versionName "1.3.1"、侧栏干脆写死 v2.1.0，
 * 谁也不知道装到手机上的是哪一版。把校验做成一条命令，分叉当场红掉。
 *
 * 与正式版（ElainaChat-Official/scripts/sync-version.mjs）的差异 —— 有意裁掉的部分：
 *   · desktop-pet/scripts/release-pc.mjs 的产物命名规则：开源版没有这个脚本；
 *   · scripts/sign-apk.mjs 的 APK 命名规则：开源版没有签名脚本（APK 直接取自 build.gradle）；
 *   · web/js/hot-update.js 的 DEFAULT_APP_VERSION 禁令：开源版没有 hot-update.js
 *     （热更新是正式版宿主能力，网页层没有这个模块）。
 * 其它语义（只替换值的字节区间 + 写盘后重新解析自检 + --check 逐处比对）与正式版完全一致。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

function fail(message) {
  console.error('[sync-version] ' + message);
  process.exit(1);
}

function read(rel) {
  try { return readFileSync(path.join(projectRoot, rel), 'utf8'); }
  catch (error) { fail('读不到 ' + rel + '：' + error.message); return ''; }
}

/* ---------- 1) 单一来源 ---------- */

/* ★ 不要用带 BOM 的方式写 version.json：PowerShell 的 Out-File / Set-Content -Encoding UTF8
   在 Windows PowerShell 5 上会写出 EF BB BF，JSON.parse 直接抛
   "Unexpected token at position 0"。这里显式去一次 BOM 再解析，兼容手改的情况。 */
const sourceText = read('version.json').replace(/^\uFEFF/, '');
let source;
try { source = JSON.parse(sourceText); }
catch (error) { fail('version.json 不是合法 JSON（是不是被写成了带 BOM 的文件？）：' + error.message); }
const version = String(source.version || '').trim();
const versionCode = Number(source.versionCode);
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('version.json 的 version 必须是 x.y.z 形式，实际：' + JSON.stringify(source.version));
if (!Number.isInteger(versionCode) || versionCode <= 0) fail('version.json 的 versionCode 必须是正整数，实际：' + JSON.stringify(source.versionCode));

/* ---------- 2) 派生位置 ---------- */

/*
 * 每个派生位置只描述「怎么在文本里**定位那个值**」—— locate() 返回值的起止位置，
 * 改写时只替换这一段字节，行内其它字符（缩进、冒号、**两个引号**）一个都不碰。
 *
 * 为什么不是「正则分组 + 拼回去」：那样每加一个分组就要记得把没分组到的字面量拼回去，
 * 少拼一次就把文件改坏（正式版踩过两次：versionName 的两个引号都丢了）。
 * 所以这里「只替换值的字节区间」，并在写盘后**重新解析一遍自检**。
 */
const targets = [
  {
    label: 'package.json  version',
    file: 'package.json',
    /* 只认顶层 "version"：锚定到行首的两个空格缩进 */
    locate: (text) => {
      const m = /^(\s{2}"version"\s*:\s*)"([^"]*)"/m.exec(text);
      if (!m) return null;
      return { value: m[2], start: m.index + m[0].length - 1 - m[2].length };
    },
    expected: version,
  },
  {
    label: 'android build.gradle  versionCode',
    file: 'android-app/android/app/build.gradle',
    locate: (text) => {
      const m = /^(\s*versionCode\s+)(\d+)/m.exec(text);
      if (!m) return null;
      return { value: m[2], start: m.index + m[0].length - m[2].length };
    },
    expected: String(versionCode),
  },
  {
    label: 'android build.gradle  versionName',
    file: 'android-app/android/app/build.gradle',
    locate: (text) => {
      const m = /^(\s*versionName\s+)"([^"]*)"/m.exec(text);
      if (!m) return null;
      return { value: m[2], start: m.index + m[0].length - 1 - m[2].length };
    },
    expected: version,
  },
];

/* web/js/version.js 整份文件由这里生成（没有"旧值"，所以不在 targets 里） */
const versionJsPath = 'web/js/version.js';
const versionJsContent = `/* 由 scripts/sync-version.mjs 从仓库根 version.json（${version}）自动生成，请勿手改。
 *
 * 这是**运行期**的版本号单一来源：侧栏左下角的版本号（#appVersionLabel）只读这个常量。
 * 改版本请改 version.json，然后跑 node scripts/sync-version.mjs。 */
window.ELAINA_APP_VERSION = '${version}';
window.ELAINA_APP_VERSION_CODE = ${versionCode};
`;

/* 不允许再出现硬编码版本号的地方 */
const forbidden = [
  {
    label: 'web/index.html 侧栏版本号',
    file: 'web/index.html',
    /* 侧栏由 #appVersionLabel 在运行时填，不允许再写死 vX.Y.Z */
    test: (text) => /v\d+\.\d+\.\d+\s*·\s*魔女之旅/.test(text),
    hint: '侧栏版本号必须由 #appVersionLabel 在运行时从 window.ELAINA_APP_VERSION 填充',
  },
];

/* 必须继续从单一来源派生的接线（少一根线，上面的生成物就白生成了） */
const derivations = [
  {
    label: 'web/index.html 加载 /js/version.js',
    file: 'web/index.html',
    ok: (t) => /<script src="\/js\/version\.js"><\/script>/.test(t),
    need: 'index.html 必须在 app-01-core.js 之前加载 /js/version.js，否则 window.ELAINA_APP_VERSION 为 undefined、侧栏显示 v—',
  },
  {
    label: 'web/index.html 侧栏占位 #appVersionLabel',
    file: 'web/index.html',
    ok: (t) => /id="appVersionLabel"/.test(t),
    need: 'index.html 侧栏需要一个 <span id="appVersionLabel">，由 app-03-chat.js 的 renderAppVersion() 填值',
  },
];

/* ---------- 3) 执行 ---------- */

let drifted = 0;
const changes = [];

for (const target of targets) {
  const text = read(target.file);
  /* 先在原文件上定位，再在**改完的文本**上重新定位一次做自检 —— 两头都能解析出正确的值才落盘 */
  const found = target.locate(text);
  if (!found) fail('在 ' + target.file + ' 里找不到 ' + target.label + ' 的赋值位置（文件被改坏了？先手工修好再跑）');
  if (found.value === target.expected) {
    console.log('[sync-version] OK   ' + target.label + ' = ' + found.value);
    continue;
  }
  drifted += 1;
  if (CHECK) {
    console.error('[sync-version] 不一致 ' + target.label + '：' + target.file + ' 里是 ' + JSON.stringify(found.value)
      + '，version.json 里是 ' + JSON.stringify(target.expected));
    continue;
  }
  const replaced = text.slice(0, found.start) + target.expected + text.slice(found.start + found.value.length);
  const verify = target.locate(replaced);
  if (!verify || verify.value !== target.expected) {
    fail('改写 ' + target.file + ' 的 ' + target.label + ' 之后自检不过（重建把这一行改坏了），已中止、未落盘');
  }
  writeFileSync(path.join(projectRoot, target.file), replaced, 'utf8');
  changes.push(target.label + '：' + found.value + ' -> ' + target.expected);
  console.log('[sync-version] 写入 ' + target.label + ' = ' + target.expected + '（原 ' + found.value + '）');
}

/* web/js/version.js */
let currentVersionJs = '';
try { currentVersionJs = readFileSync(path.join(projectRoot, versionJsPath), 'utf8'); } catch { currentVersionJs = ''; }
if (currentVersionJs === versionJsContent) {
  console.log('[sync-version] OK   ' + versionJsPath + ' = ' + version);
} else if (CHECK) {
  drifted += 1;
  console.error('[sync-version] 不一致 ' + versionJsPath + ' 与 version.json 不符（跑 node scripts/sync-version.mjs 重新生成）');
} else {
  writeFileSync(path.join(projectRoot, versionJsPath), versionJsContent, 'utf8');
  changes.push(versionJsPath + ' 重新生成 = ' + version);
  console.log('[sync-version] 写入 ' + versionJsPath + ' = ' + version);
}

for (const d of derivations) {
  const text = read(d.file);
  if (d.ok(text)) {
    console.log('[sync-version] OK   ' + d.label);
  } else {
    drifted += 1;
    console.error('[sync-version] 违规 ' + d.label + '：' + d.need);
  }
}

for (const rule of forbidden) {
  const text = read(rule.file);
  if (rule.test(text)) {
    drifted += 1;
    console.error('[sync-version] 违规 ' + rule.label + '：' + rule.hint);
  } else {
    console.log('[sync-version] OK   ' + rule.label + ' 无硬编码');
  }
}

if (CHECK) {
  if (drifted) fail(drifted + ' 处版本号与 version.json（' + version + ' / versionCode ' + versionCode + '）不一致');
  console.log('[sync-version] 版本号一致：' + version + '（versionCode ' + versionCode + '）');
} else {
  console.log('[sync-version] 完成：' + version + '（versionCode ' + versionCode + '），改动 ' + changes.length + ' 处');
  for (const line of changes) console.log('  · ' + line);
}
