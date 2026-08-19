import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(testDirectory, '../www');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function createStaticServer() {
    return createServer(async (request, response) => {
        try {
            const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
            const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
            const target = path.resolve(webRoot, relativePath);
            if (!target.startsWith(`${webRoot}${path.sep}`) && target !== path.join(webRoot, 'index.html')) {
                response.writeHead(403).end();
                return;
            }
            const targetStat = await stat(target);
            if (!targetStat.isFile()) throw new Error('not a file');
            const content = await readFile(target);
            response.writeHead(200, {
                'Content-Type': target.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream'
            });
            response.end(content);
        } catch {
            response.writeHead(404).end();
        }
    });
}

const SAMPLE_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

test('视觉转译: 未配置视觉模型时图片直通主模型并提示一次', async () => {
    const source = await readFile(path.join(webRoot, 'index.html'), 'utf8');
    assert.match(source, /settingVisionBaseUrl/);
    assert.match(source, /describeImageWithVision/);
    assert.match(source, /VISION_FAILED/);

    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const mainRequests = [];
    const hints = [];

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://main.test/v1/chat/completions') {
            mainRequests.push({ body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ message: { content: '我看到图里的内容啦。' } }] })
            });
            return;
        }
        if (url.startsWith(`http://127.0.0.1:${server.address().port}/`)) {
            await route.continue();
            return;
        }
        await route.abort();
    });

    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (
            typeof callAI === 'function' &&
            typeof describeImageWithVision === 'function' &&
            typeof state !== 'undefined'
        ));

        const result = await page.evaluate(async (image) => {
            state._visionHintShown = false;
            // 主模型配置（直通测试用）
            state.settings.apiKey = 'main-key';
            state.settings.baseUrl = 'https://main.test/v1';
            state.settings.model = 'deepseek-chat';
            state.settings.providerMode = 'custom-proxy';
            // 默认设置: 未配置视觉模型
            state.settings.visionBaseUrl = '';
            state.settings.visionModel = '';
            const reply = await callAI('这是什么', {
                imageDataUrl: image,
                includeVoiceJp: false
            });
            return { reply, hintShown: Boolean(state._visionHintShown) };
        }, SAMPLE_IMAGE);

        assert.equal(result.reply, '我看到图里的内容啦。');
        assert.equal(result.hintShown, true, '未配置视觉模型时应提示一次');
        assert.equal(mainRequests.length, 1);
        const userContent = mainRequests[0].body.messages[mainRequests[0].body.messages.length - 1].content;
        assert.ok(Array.isArray(userContent), '图片直通时 user content 应为数组（含 image_url）');
        assert.ok(userContent.some(part => part.type === 'image_url'), '图片应原样发给主模型');
        // 弹出提示框存在（showCustomAlert 已触发）
        const alertVisible = await page.evaluate(() => {
            const modal = document.getElementById('customModal');
            return Boolean(modal && !modal.classList.contains('hidden') && modal.classList.contains('flex'));
        });
        assert.ok(alertVisible, '应弹出图片模式提示');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});

test('视觉转译: 配置视觉模型后图片先转译再交主模型', async () => {
    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const visionRequests = [];
    const mainRequests = [];

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://vision.test/v1/chat/completions') {
            visionRequests.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ message: { content: '我看到画面里有一只灰色的猫，正在窗台上晒太阳。' } }] })
            });
            return;
        }
        if (url === 'https://main.test/v1/chat/completions') {
            mainRequests.push({ body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ message: { content: '（伊蕾娜看了看图）哎呀，是只晒太阳的猫呢，真惬意。' } }] })
            });
            return;
        }
        if (url.startsWith(`http://127.0.0.1:${server.address().port}/`)) {
            await route.continue();
            return;
        }
        await route.abort();
    });

    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof callAI === 'function');

        const result = await page.evaluate(async (image) => {
            state._visionHintShown = false;
            state.settings.apiKey = 'main-key';
            state.settings.baseUrl = 'https://main.test/v1';
            state.settings.model = 'deepseek-chat';
            state.settings.providerMode = 'custom-proxy';
            state.settings.visionBaseUrl = 'https://vision.test/v1';
            state.settings.visionApiKey = 'vision-key';
            state.settings.visionModel = 'Qwen/Qwen2.5-VL-72B-Instruct';
            const reply = await callAI('图里有什么', {
                imageDataUrl: image,
                includeVoiceJp: false
            });
            return { reply, hintShown: Boolean(state._visionHintShown) };
        }, SAMPLE_IMAGE);

        assert.equal(result.reply, '（伊蕾娜看了看图）哎呀，是只晒太阳的猫呢，真惬意。');

        // 视觉模型请求: 应包含 image_url 且使用视觉模型配置
        assert.equal(visionRequests.length, 1, '应先调用视觉模型');
        const vBody = visionRequests[0].body;
        assert.equal(vBody.model, 'Qwen/Qwen2.5-VL-72B-Instruct');
        assert.equal(visionRequests[0].headers.authorization, 'Bearer vision-key');
        const vUserContent = vBody.messages[vBody.messages.length - 1].content;
        assert.ok(Array.isArray(vUserContent));
        assert.ok(vUserContent.some(part => part.type === 'image_url' && part.image_url.url === SAMPLE_IMAGE), '视觉模型应收到原图');

        // 主模型请求: 图片已被清除, 文本包含转译参考
        assert.equal(mainRequests.length, 1, '应调用主模型');
        const mBody = mainRequests[0].body;
        const mUserContent = mBody.messages[mBody.messages.length - 1].content;
        assert.equal(typeof mUserContent, 'string', '主模型收到的是纯文本（图片已转译）');
        assert.ok(mUserContent.includes('图片已由多模态模型看过'), '主模型文本应包含转译参考');
        assert.ok(mUserContent.includes('我看到画面里有一只灰色的猫'), '转译内容应注入主模型提示');
        assert.equal(mUserContent.includes(SAMPLE_IMAGE), false, '主模型不应收到 base64 图片');
        assert.equal(result.hintShown, false, '配置了视觉模型时不提示图片直通');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});

test('视觉转译: 视觉模型失败时抛 VISION_FAILED 且不把图片发给主模型', async () => {
    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const mainRequests = [];

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://vision.test/v1/chat/completions') {
            await route.fulfill({
                status: 400,
                contentType: 'application/json',
                body: JSON.stringify({ error: { message: 'model does not support image input' } })
            });
            return;
        }
        if (url === 'https://main.test/v1/chat/completions') {
            mainRequests.push(route.request().url());
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ message: { content: '不应到达' } }] })
            });
            return;
        }
        if (url.startsWith(`http://127.0.0.1:${server.address().port}/`)) {
            await route.continue();
            return;
        }
        await route.abort();
    });

    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof callAI === 'function');

        const result = await page.evaluate(async (image) => {
            state.settings.apiKey = 'main-key';
            state.settings.baseUrl = 'https://main.test/v1';
            state.settings.model = 'deepseek-chat';
            state.settings.providerMode = 'custom-proxy';
            state.settings.visionBaseUrl = 'https://vision.test/v1';
            state.settings.visionApiKey = 'vision-key';
            state.settings.visionModel = 'not-a-vision-model';
            let errorCode = null;
            try {
                await callAI('图里有什么', { imageDataUrl: image, includeVoiceJp: false });
            } catch (err) {
                errorCode = err && err.code ? err.code : (err && err.name === 'ClientApiError' ? err.code : 'OTHER');
            }
            return { errorCode };
        }, SAMPLE_IMAGE);

        assert.equal(result.errorCode, 'VISION_FAILED', '应抛出 VISION_FAILED');
        assert.equal(mainRequests.length, 0, '视觉失败后不应把图片转发给主模型');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
