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
            response.writeHead(200, {
                'Content-Type': target.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream'
            });
            response.end(await readFile(target));
        } catch {
            response.writeHead(404).end();
        }
    });
}

test('BYOK client compresses context at 90% and tracks real provider usage', async () => {
    const source = await readFile(path.join(webRoot, 'index.html'), 'utf8');
    assert.match(source, /CONTEXT_COMPRESSION_THRESHOLD = 0\.9/);
    assert.match(source, /CONTEXT_COMPRESSION_KEEP_FIRST_TURNS = 2/);
    assert.match(source, /CONTEXT_COMPRESSION_KEEP_RECENT_TURNS = 2/);
    assert.match(source, /trackUsage: true/);
    assert.match(source, /contextUsage/);
    assert.match(source, /maxContextTokens:/);

    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const captured = [];

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://openai.test/v1/chat/completions') {
            const payload = route.request().postDataJSON();
            captured.push(payload);
            const isCompression = payload.messages?.some(message => (
                typeof message.content === 'string' && message.content.includes('请压缩下面的早前对话历史')
            ));
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    choices: [{
                        message: {
                            content: isCompression
                                ? '时间：昨天下午。地点：王城面包店。事件：约定今天一起去旅行。'
                                : '好的，我们继续。'
                        }
                    }],
                    usage: { input_tokens: isCompression ? 60 : 77, prompt_tokens: isCompression ? 60 : 77, total_tokens: isCompression ? 70 : 90 }
                })
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
            typeof maybeCompressConversationContext === 'function' &&
            typeof compressConversationHistory === 'function' &&
            typeof getRecentHistoryMessages === 'function' &&
            typeof buildLayeredRoleplayMessages === 'function' &&
            typeof callChatAPI === 'function'
        ));

        const result = await page.evaluate(async () => {
            state.settings = {
                ...state.settings,
                apiFormat: 'openai',
                providerMode: 'custom-proxy',
                baseUrl: 'https://openai.test/v1',
                model: 'test-model',
                apiKey: 'openai-key',
                maxContextTokens: 100
            };
            const messages = [
                { id: 'u1', role: 'user', text: '最早的用户问题' },
                { id: 'a1', role: 'ai', text: '最早的伊蕾娜回答' },
                { id: 'u2', role: 'user', text: '旧事件1' },
                { id: 'a2', role: 'ai', text: '旧回复1' },
                { id: 'u3', role: 'user', text: '旧事件2' },
                { id: 'a3', role: 'ai', text: '旧回复2' },
                { id: 'u4', role: 'user', text: '旧事件3' },
                { id: 'a4', role: 'ai', text: '旧回复3' },
                { id: 'u5', role: 'user', text: '旧事件4' },
                { id: 'a5', role: 'ai', text: '旧回复4' },
                { id: 'u6', role: 'user', text: '旧事件5' },
                { id: 'a6', role: 'ai', text: '旧回复5' },
                { id: 'u7', role: 'user', text: '最近的问题' },
                { id: 'a7', role: 'ai', text: '最近的回答' },
                { id: 'u8', role: 'user', text: '当前问题' }
            ];
            const conversation = {
                id: 'compress-test',
                title: 'compress',
                messages,
                contextUsage: { inputTokens: 95, totalTokens: 100, updatedAt: 0 }
            };
            state.currentConversationId = conversation.id;
            state.conversations = [conversation];

            const compressed = await maybeCompressConversationContext('当前问题', {}, conversation);
            const history = getRecentHistoryMessages('当前问题');
            const layered = buildLayeredRoleplayMessages('当前问题');
            const legacy = buildLegacyRoleplayMessages('当前问题');
            await callChatAPI([{ role: 'user', content: '继续' }], { trackUsage: true });
            return {
                compressed,
                summary: conversation.contextCompression?.summary || '',
                throughIndex: conversation.contextCompression?.throughIndex || 0,
                firstKeptCount: conversation.contextCompression?.firstKeptCount || 0,
                contextUsageInputTokens: conversation.contextUsage?.inputTokens ?? -1,
                historyRoles: history.map(message => message.role),
                historyContents: history.map(message => message.content),
                layeredHasSummary: layered.some(message => message.role === 'system' && message.content.includes('早前对话压缩摘要')),
                roleCardPreserved: layered[2].content.includes('最喜欢面包') && layered[2].content.includes('不喜欢蘑菇类食物'),
                legacyHasSummary: legacy[0].content.includes('早前对话压缩摘要')
            };
        });

        assert.equal(result.compressed, true);
        assert.match(result.summary, /昨天下午/);
        assert.match(result.summary, /王城面包店/);
        assert.equal(result.throughIndex, 10);
        assert.equal(result.firstKeptCount, 4);
        assert.equal(result.historyRoles.length, 8);
        assert.equal(result.historyContents[0], '最早的用户问题');
        assert.equal(result.historyContents[1], '最早的伊蕾娜回答');
        assert.equal(result.historyContents.at(-2), '最近的问题');
        assert.equal(result.historyContents.at(-1), '最近的回答');
        assert.equal(result.historyContents.some(content => content.includes('旧事件3')), false);
        assert.equal(result.layeredHasSummary, true);
        assert.equal(result.legacyHasSummary, true);
        assert.equal(result.roleCardPreserved, true);
        assert.equal(result.contextUsageInputTokens, 77);
        assert.equal(captured.length, 2);
        assert.equal(captured[0].max_tokens, 1400);
        assert.equal(captured[0].model, 'test-model');
        assert.equal(captured[1].max_tokens, undefined);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
