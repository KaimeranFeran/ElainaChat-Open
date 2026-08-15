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
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(await readFile(target));
        } catch {
            response.writeHead(404).end();
        }
    });
}

test('TTS adapters support Doubao V1/V3 and DashScope Qwen voices with isolated cache keys', async () => {
    const source = await readFile(path.join(webRoot, 'index.html'), 'utf8');
    assert.match(source, /ttsProvider:\s*'minimax'/);
    assert.match(source, /DOUBAO_TTS_V3_URL/);
    assert.match(source, /qwen3-tts-flash/);
    assert.match(source, /伊蕾娜最喜欢面包/);
    assert.match(source, /不喜欢蘑菇类食物/);
    assert.match(source, /API_SECRET_NAMES = Object\.freeze\(\[[^\]]*'doubaoApiKey'[^\]]*'doubaoToken'\]\)/);

    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const captured = { v3: [], v1: [], dashscope: [], audio: 0 };

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse') {
            captured.v3.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: 'data: {"code":0,"data":"aGVsbG8="}\n\ndata: {"code":0,"data":"d29ybGQ="}\n\n'
            });
            return;
        }
        if (url === 'https://openspeech.bytedance.com/api/v1/tts') {
            captured.v1.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ code: 3000, message: 'Success', data: 'aGVsbG8=' })
            });
            return;
        }
        if (url === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation') {
            captured.dashscope.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    output: { audio: { url: 'https://audio.example.test/qwen.wav' } }
                })
            });
            return;
        }
        if (url === 'https://audio.example.test/qwen.wav') {
            captured.audio += 1;
            await route.fulfill({
                status: 200,
                contentType: 'audio/wav',
                body: Buffer.from([82, 73, 70, 70, 1, 2, 3, 4])
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
            typeof generateDoubaoTtsAudio === 'function' &&
            typeof generateDashscopeTtsAudio === 'function' &&
            typeof parseDoubaoSseAudio === 'function' &&
            typeof buildMessageTtsCacheKey === 'function'
        ));

        const result = await page.evaluate(async () => {
            const doubaoV3 = await generateDoubaoTtsAudio('测试语音', {
                ...state.settings,
                ttsProvider: 'doubao',
                doubaoApiKey: 'doubao-v3-key',
                doubaoResourceId: 'seed-tts-2.0',
                doubaoVoice: 'zh_female_vv_uranus_bigtts',
                ttsLang: 'japanese',
                ttsSpeed: 1.2,
                ttsVolume: 1.5
            });
            const doubaoV1 = await generateDoubaoTtsAudio('测试语音', {
                ...state.settings,
                ttsProvider: 'doubao',
                doubaoApiKey: '',
                doubaoAppId: 'app-123',
                doubaoToken: 'token-123',
                doubaoCluster: 'volcano_tts',
                doubaoVoice: 'BV001_streaming'
            });
            const dashscope = await generateDashscopeTtsAudio('测试语音', {
                ...state.settings,
                ttsProvider: 'dashscope',
                dashscopeApiKey: 'ds-key',
                dashscopeTtsModel: 'qwen3-tts-flash',
                dashscopeTtsVoice: 'Cherry',
                ttsLang: 'japanese'
            });
            state.settings = {
                ...state.settings,
                ttsProvider: 'dashscope',
                dashscopeTtsModel: 'qwen3-tts-flash',
                dashscopeTtsVoice: 'Cherry'
            };
            const dashCacheKey = buildMessageTtsCacheKey({ id: 'msg-1' }, '测试语音', 'conv-1');
            state.settings = {
                ...state.settings,
                ttsProvider: 'doubao',
                doubaoApiKey: 'doubao-v3-key',
                doubaoResourceId: 'seed-tts-2.0',
                doubaoVoice: 'zh_female_vv_uranus_bigtts'
            };
            const doubaoCacheKey = buildMessageTtsCacheKey({ id: 'msg-1' }, '测试语音', 'conv-1');
            state.settings = {
                ...state.settings,
                ttsProvider: 'doubao',
                doubaoVoice: DEFAULT_SETTINGS.doubaoVoice
            };
            openSettings();
            elements.settingTtsProvider.value = 'doubao';
            updateTtsProviderUI();
            const providerUi = {
                provider: elements.settingTtsProvider.value,
                minimaxHidden: elements.minimaxTtsFields.classList.contains('hidden'),
                doubaoHidden: elements.doubaoTtsFields.classList.contains('hidden'),
                dashscopeHidden: elements.dashscopeTtsFields.classList.contains('hidden'),
                voiceValue: document.getElementById('settingDoubaoVoice').value
            };
            closeSettingsPanel();
            return {
                v3Length: new Uint8Array(doubaoV3.bytes).byteLength,
                v1Length: new Uint8Array(doubaoV1.bytes).byteLength,
                dashLength: new Uint8Array(dashscope.bytes).byteLength,
                dashCacheKey,
                doubaoCacheKey,
                cacheKeysDiffer: dashCacheKey !== doubaoCacheKey,
                sseChunkCount: parseDoubaoSseAudio('data: {"code":0,"data":"YQ=="}\n\ndata: {"code":0,"data":"Yg=="}\n\n').length,
                providerUi
            };
        });

        assert.equal(result.v3Length, 10);
        assert.equal(result.v1Length, 5);
        assert.equal(result.dashLength, 8);
        assert.equal(result.cacheKeysDiffer, true);
        assert.equal(result.sseChunkCount, 2);
        assert.equal(result.providerUi.provider, 'doubao');
        assert.equal(result.providerUi.minimaxHidden, true);
        assert.equal(result.providerUi.doubaoHidden, false);
        assert.equal(result.providerUi.dashscopeHidden, true);
        assert.equal(result.providerUi.voiceValue, 'zh_female_shuangkuaisisi_uranus_bigtts');

        assert.equal(captured.v3.length, 1);
        assert.equal(captured.v3[0].headers['x-api-key'], 'doubao-v3-key');
        assert.equal(captured.v3[0].headers['x-api-resource-id'], 'seed-tts-2.0');
        assert.equal(captured.v3[0].body.req_params.speaker, 'zh_female_vv_uranus_bigtts');
        assert.equal(captured.v3[0].body.req_params.audio_params.speech_rate, 20);
        assert.equal(captured.v3[0].body.req_params.audio_params.loudness_rate, 50);
        assert.match(captured.v3[0].body.req_params.additions, /explicit_language.*ja/);

        assert.equal(captured.v1.length, 1);
        assert.equal(captured.v1[0].headers.authorization, 'Bearer; token-123');
        assert.equal(captured.v1[0].body.app.appid, 'app-123');
        assert.equal(captured.v1[0].body.audio.voice_type, 'BV001_streaming');

        assert.equal(captured.dashscope.length, 1);
        assert.equal(captured.dashscope[0].headers.authorization, 'Bearer ds-key');
        assert.equal(captured.dashscope[0].body.model, 'qwen3-tts-flash');
        assert.equal(captured.dashscope[0].body.input.voice, 'Cherry');
        assert.equal(captured.dashscope[0].body.input.language_type, 'Japanese');
        assert.equal(captured.audio, 1);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
