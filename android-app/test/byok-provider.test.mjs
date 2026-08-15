import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(testDirectory, '..');
const webRoot = path.join(appRoot, 'www');
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
            response.writeHead(200, { 'Content-Type': target.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript' });
            response.end(await readFile(target));
        } catch {
            response.writeHead(404).end();
        }
    });
}

test('open build uses user-owned direct providers and does not persist API keys in localStorage', async () => {
    const source = await readFile(path.join(webRoot, 'index.html'), 'utf8');
    const capacitorConfig = JSON.parse(await readFile(path.join(appRoot, 'capacitor.config.json'), 'utf8'));
    const gradle = await readFile(path.join(appRoot, 'android/app/build.gradle'), 'utf8');

    assert.doesNotMatch(source, /sslip\.io/i);
    assert.match(source, /minimaxVoice:\s*''/);
    assert.equal(capacitorConfig.appId, 'com.elainachat.opensource');
    assert.equal(capacitorConfig.appName, 'ElainaChat Open');
    assert.match(gradle, /applicationId "com\.elainachat\.opensource"/);

    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const page = await browser.newPage();
    const requests = [];

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://api.deepseek.com/v1/chat/completions') {
            requests.push({ headers: route.request().headers(), payload: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ message: { content: 'OK' } }] })
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
        await page.waitForFunction(() => typeof callChatAPI === 'function' && typeof saveApiSecrets === 'function');
        const result = await page.evaluate(async () => {
            state.settings = {
                ...state.settings,
                providerMode: 'direct',
                baseUrl: DEEPSEEK_DIRECT_BASE_URL,
                model: 'deepseek-chat'
            };
            await saveApiSecrets({ apiKey: 'sk-user-owned-test', minimaxApiKey: '', dashscopeApiKey: '' });
            persistSettings();
            const reply = await callChatAPI([{ role: 'user', content: 'ping' }], { maxTokens: 12 });
            const persisted = JSON.parse(localStorage.getItem('elaina_open_settings') || '{}');
            const session = JSON.parse(sessionStorage.getItem('elainachat_open_api_secrets') || '{}');
            return { reply, persisted, session };
        });

        assert.equal(result.reply, 'OK');
        assert.equal(result.persisted.apiKey, undefined);
        assert.equal(result.persisted.minimaxApiKey, undefined);
        assert.equal(result.persisted.dashscopeApiKey, undefined);
        assert.equal(result.session.apiKey, 'sk-user-owned-test');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].headers.authorization, 'Bearer sk-user-owned-test');
        assert.equal(requests[0].payload.model, 'deepseek-chat');
        assert.equal(requests[0].payload.max_tokens, 12);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
