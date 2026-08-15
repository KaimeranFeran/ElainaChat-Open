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

test('roleplay requests keep the full character card in a stable prefix and inject bounded memories', async () => {
    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const capturedPayloads = [];

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://provider.test/v1/chat/completions') {
            capturedPayloads.push(route.request().postDataJSON());
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ message: { content: '当然，刚出炉的面包总不会让人失望。' } }] })
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
            typeof buildCharacterSystemMessages === 'function' &&
            typeof formatRoleplayMemoryForPrompt === 'function'
        ));

        const result = await page.evaluate(async () => {
            const history = [];
            for (let index = 1; index <= 6; index += 1) {
                history.push({ id: `u${index}`, role: 'user', text: `用户历史${index}` });
                history.push({ id: `a${index}`, role: 'ai', text: `伊蕾娜历史${index}` });
            }
            state.currentConversationId = 'context-test';
            state.conversations = [{ id: 'context-test', title: 'context test', messages: history }];
            state.settings = {
                ...state.settings,
                apiKey: 'app-test-key',
                providerMode: 'custom-proxy',
                baseUrl: 'https://provider.test/v1',
                model: 'test-chat-model',
                thinkingMode: false
            };

            const preferences = Array.from({ length: 19 }, (_, index) => `无关偏好${index + 1}：${'普通内容'.repeat(80)}`);
            preferences.push(`用户非常喜欢刚出炉的面包，也习惯在早餐时吃面包。${'重要'.repeat(80)}`);
            state.memoryCore = {
                diary: Array.from({ length: 8 }, (_, index) => ({
                    date: `2026年8月${index + 1}日`,
                    content: `日记${index + 1}：${'一次普通旅行经历。'.repeat(100)}`,
                    essences: [`旅行${index + 1}`]
                })),
                promise: Array.from({ length: 12 }, (_, index) => `约定${index + 1}：${'以后还要继续旅行。'.repeat(50)}`),
                preference: preferences,
                plan: Array.from({ length: 12 }, (_, index) => ({ date: `计划时间${index + 1}`, content: `计划${index + 1}：${'准备出发。'.repeat(60)}` })),
                motivation: Array.from({ length: 10 }, (_, index) => `长期目标${index + 1}：${'认真生活。'.repeat(60)}`),
                pivotal_memory: Array.from({ length: 12 }, (_, index) => `关键记忆${index + 1}：${'共同经历。'.repeat(60)}`)
            };

            const countsBefore = Object.fromEntries(Object.entries(state.memoryCore).map(([key, value]) => [key, value.length]));
            const boundedMemory = formatRoleplayMemoryForPrompt('刚出炉的面包闻起来怎么样？');
            const reply = await callAI('刚出炉的面包闻起来怎么样？', {
                includeVoiceJp: true,
                imageDataUrl: 'data:image/png;base64,iVBORw0KGgo='
            });
            const textOnlyReply = await callAI('只进行一次普通文本回复。');
            const legacyMessages = buildLegacyRoleplayMessages('回退结构检查。');
            const countsAfter = Object.fromEntries(Object.entries(state.memoryCore).map(([key, value]) => [key, value.length]));
            return {
                reply,
                textOnlyReply,
                boundedMemory,
                memoryLimit: ROLEPLAY_MEMORY_PROMPT_LIMITS.totalChars,
                countsBefore,
                countsAfter,
                rollback: {
                    activeMode: ROLEPLAY_PROMPT_STRUCTURE_MODE,
                    systemMessageCount: legacyMessages.filter(message => message.role === 'system').length,
                    hasWorldAndCard: legacyMessages[0].content.includes('# 世界观设定') && legacyMessages[0].content.includes('# 角色卡'),
                    hasLegacyGeneralMemory: legacyMessages[0].content.includes('# 一般长期记忆'),
                    textLimit: ROLEPLAY_OUTPUT_TOKEN_LIMITS.text,
                    voiceLimit: ROLEPLAY_OUTPUT_TOKEN_LIMITS.withVoice
                }
            };
        });

        assert.equal(result.reply, '当然，刚出炉的面包总不会让人失望。');
        assert.equal(result.textOnlyReply, '当然，刚出炉的面包总不会让人失望。');
        assert.deepEqual(result.countsAfter, result.countsBefore, 'prompt selection must not delete stored memory');
        assert.ok(result.boundedMemory.length <= result.memoryLimit);
        assert.match(result.boundedMemory, /刚出炉的面包/);
        assert.equal(result.rollback.activeMode, 'layered-v2');
        assert.equal(result.rollback.systemMessageCount, 1);
        assert.equal(result.rollback.hasWorldAndCard, true);
        assert.equal(result.rollback.hasLegacyGeneralMemory, true);
        assert.equal(result.rollback.textLimit, 900);
        assert.equal(result.rollback.voiceLimit, 1400);
        assert.equal(capturedPayloads.length, 2, 'both roleplay requests should be captured');
        assert.equal(capturedPayloads[0].max_tokens, 1400);
        assert.equal(capturedPayloads[1].max_tokens, 900);

        const messages = capturedPayloads[0].messages;
        assert.equal(messages[0].role, 'system');
        assert.match(messages[0].content, /# 角色扮演核心协议/);
        assert.match(messages[0].content, /事实与推理纪律/);
        assert.match(messages[1].content, /# 世界观设定/);
        assert.match(messages[2].content, /# 角色卡/);

        const fullCharacterCard = messages[2].content;
        for (const preservedDetail of [
            '最喜欢面包',
            '不喜欢蘑菇类食物',
            '不喜欢下雨',
            '对猫过敏',
            '喜欢别人称赞她漂亮、聪明或强大',
            '遇到麻烦时，她会先吐槽和权衡'
        ]) {
            assert.match(fullCharacterCard, new RegExp(preservedDetail));
        }

        const memoryIndex = messages.findIndex(message => message.content.includes('<reference_memory>'));
        const imageIndex = messages.findIndex(message => message.content.includes('# 图片对话中的角色一致性'));
        const voiceIndex = messages.findIndex(message => message.content.includes('# 内部配音输出格式'));
        const anchorIndex = messages.findIndex(message => message.content.includes('# 本轮角色锚点'));
        assert.ok(memoryIndex > 2);
        assert.ok(imageIndex > memoryIndex);
        assert.ok(voiceIndex > imageIndex);
        assert.ok(anchorIndex > voiceIndex);
        assert.match(messages[memoryIndex].content, /刚出炉的面包/);

        const firstDialogueIndex = messages.findIndex(message => message.role !== 'system');
        assert.ok(firstDialogueIndex > anchorIndex, 'all stable and dynamic system layers should precede dialogue');
        assert.equal(messages.at(-1).role, 'user');
        assert.ok(Array.isArray(messages.at(-1).content));
        assert.equal(messages.at(-1).content[1].type, 'image_url');
        assert.equal(messages.filter(message => message.role === 'user').length, 7);
        assert.equal(messages.filter(message => message.role === 'assistant').length, 6);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
