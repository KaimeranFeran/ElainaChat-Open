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

test('chat API adapters support multiple provider formats and hide thinking content', async () => {
    const source = await readFile(path.join(webRoot, 'index.html'), 'utf8');
    assert.doesNotMatch(source, /id: Date\.now\(\)/);
    assert.match(source, /ROLEPLAY_HALLUCINATION_GUARD/);
    assert.match(source, /不要逐字复用/);

    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const captured = { openai: [], anthropic: [], gemini: [], ollama: [] };

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://openai.test/v1/chat/completions') {
            captured.openai.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    choices: [{ message: { content: '<think>不应显示</think>真正的回答', reasoning_content: '思考过程' } }]
                })
            });
            return;
        }
        if (url === 'https://anthropic.test/v1/messages') {
            captured.anthropic.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    content: [{ type: 'text', text: 'Claude 回答' }, { type: 'thinking', thinking: '不应显示' }]
                })
            });
            return;
        }
        if (url === 'https://gemini.test/v1beta/models/gemini-test:generateContent') {
            captured.gemini.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    candidates: [{ content: { parts: [{ text: '思考过程', thought: true }, { text: 'Gemini 回答' }] } }]
                })
            });
            return;
        }
        if (url === 'http://127.0.0.1:11434/api/chat') {
            captured.ollama.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ message: { content: 'Ollama 回答' } })
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
            typeof callChatAPI === 'function' &&
            typeof stripThinkTags === 'function' &&
            typeof ROLEPLAY_TURN_ANCHOR === 'string'
        ));

        const result = await page.evaluate(async () => {
            const messages = [
                { role: 'system', content: '你是伊蕾娜。' },
                { role: 'user', content: '你好' },
                { role: 'assistant', content: '上一次的回答' },
                { role: 'user', content: '再说一句' }
            ];
            const openaiReply = await callChatAPI(messages, { maxTokens: 300 }, {
                ...state.settings,
                apiFormat: 'openai',
                providerMode: 'custom-proxy',
                baseUrl: 'https://openai.test/v1',
                model: 'test-model',
                apiKey: 'openai-key'
            });
            const anthropicReply = await callChatAPI(messages, { maxTokens: 300 }, {
                ...state.settings,
                apiFormat: 'anthropic',
                providerMode: 'custom-proxy',
                baseUrl: 'https://anthropic.test',
                model: 'claude-test',
                apiKey: 'anthropic-key'
            });
            const geminiReply = await callChatAPI(messages, { maxTokens: 300 }, {
                ...state.settings,
                apiFormat: 'gemini',
                providerMode: 'custom-proxy',
                baseUrl: 'https://gemini.test/v1beta',
                model: 'gemini-test',
                apiKey: 'gemini-key'
            });
            const ollamaReply = await callChatAPI(messages, { maxTokens: 300 }, {
                ...state.settings,
                apiFormat: 'ollama',
                providerMode: 'custom-proxy',
                baseUrl: 'http://127.0.0.1:11434',
                model: 'qwen3:8b',
                apiKey: ''
            });
            return {
                openaiReply,
                anthropicReply,
                geminiReply,
                ollamaReply,
                stripped: stripThinkTags('<think>hidden</think>visible [think]also hidden[/think]'),
                guardInjected: ROLEPLAY_TURN_ANCHOR.includes('不要逐字复用')
            };
        });

        assert.equal(result.openaiReply, '真正的回答');
        assert.equal(result.anthropicReply, 'Claude 回答');
        assert.equal(result.geminiReply, 'Gemini 回答');
        assert.equal(result.ollamaReply, 'Ollama 回答');
        assert.equal(result.stripped, 'visible');
        assert.equal(result.guardInjected, true);

        assert.equal(captured.openai.length, 1);
        assert.equal(captured.openai[0].body.model, 'test-model');
        assert.equal(captured.openai[0].body.max_tokens, 300);
        assert.equal(captured.openai[0].headers.authorization, 'Bearer openai-key');

        assert.equal(captured.anthropic.length, 1);
        assert.equal(captured.anthropic[0].headers['x-api-key'], 'anthropic-key');
        assert.equal(captured.anthropic[0].headers['anthropic-version'], '2023-06-01');
        assert.match(captured.anthropic[0].body.system, /你是伊蕾娜/);
        assert.equal(captured.anthropic[0].body.messages.some(message => message.role === 'system'), false);
        assert.equal(captured.anthropic[0].body.max_tokens, 300);

        assert.equal(captured.gemini.length, 1);
        assert.equal(captured.gemini[0].headers['x-goog-api-key'], 'gemini-key');
        assert.match(captured.gemini[0].body.system_instruction.parts[0].text, /你是伊蕾娜/);
        assert.equal(captured.gemini[0].body.contents.length, 3);
        assert.equal(captured.gemini[0].body.generationConfig.maxOutputTokens, 300);

        assert.equal(captured.ollama.length, 1);
        assert.equal(captured.ollama[0].body.stream, false);
        assert.equal(captured.ollama[0].body.options.num_predict, 300);
        assert.equal(captured.ollama[0].headers.authorization, undefined);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
