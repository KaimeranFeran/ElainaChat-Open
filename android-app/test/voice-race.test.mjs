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

function createShortWav() {
    const sampleRate = 24_000;
    const sampleCount = Math.floor(sampleRate * 0.25);
    const wav = Buffer.alloc(44 + sampleCount * 2);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + sampleCount * 2, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(sampleCount * 2, 40);
    for (let index = 0; index < sampleCount; index += 1) {
        const value = Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 440) * 2_500);
        wav.writeInt16LE(value, 44 + index * 2);
    }
    return wav;
}

async function waitFor(predicate, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for condition');
}

test('clicking the voice bubble before automatic audio returns reuses one TTS request', async () => {
    const server = createServer(async (request, response) => {
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
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const browser = await chromium.launch({
        executablePath: edgePath,
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required']
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    let ttsRequestCount = 0;
    let releaseTtsResponse;
    const ttsResponseGate = new Promise(resolve => { releaseTtsResponse = resolve; });
    const audio = createShortWav();

    await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'https://api.minimaxi.com/v1/t2a_v2') {
            ttsRequestCount += 1;
            await ttsResponseGate;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } })
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
        await page.waitForFunction(() => typeof startVoicePlaybackOnce === 'function' && typeof replayAIMessage === 'function');
        await page.evaluate(() => {
            const conversation = {
                id: 'voice-race-conversation',
                title: 'race test',
                messages: []
            };
            const message = {
                id: 'voice-race-message',
                role: 'ai',
                text: '旅を続けましょう。',
                voiceJp: '旅を続けましょう。',
                timestamp: '00:00:00'
            };
            conversation.messages.push(message);
            state.currentConversationId = conversation.id;
            state.conversations = [conversation];
            state.settings = {
                ...state.settings,
                minimaxApiKey: 'minimax-test-key',
                minimaxVoice: 'test-voice-id',
                ttsLang: 'japanese',
                ttsSpeed: 1,
                ttsVolume: 1
            };
            elements.conversationHistory.innerHTML = '';
            renderMessage(message);
            window.__voiceRaceAutomaticTask = startVoicePlaybackOnce(message.id, message.voiceJp, () => {}, {
                cacheKey: buildMessageTtsCacheKey(message, message.voiceJp, conversation.id),
                onEnd: () => setVoicePlaybackState(message.id, false)
            }).catch(error => { window.__voiceRaceError = String(error?.message || error); });
            // This is the earliest race: click in the same turn, before the async
            // automatic task has reached fetch(). It must still see the shared task.
            void replayAIMessage(message.id);
        });

        await waitFor(() => ttsRequestCount === 1);
        const loadingState = await page.evaluate(() => ({
            status: activeVoicePlaybackStatus,
            activeId: String(activeVoicePlayerId),
            hasSharedTask: voicePlaybackTasksByMessageId.has('voice-race-message')
        }));
        assert.deepEqual(loadingState, {
            status: 'loading',
            activeId: 'voice-race-message',
            hasSharedTask: true
        });

        // Repeat the user action while the HTTP response is deliberately held.
        await page.evaluate(() => replayAIMessage('voice-race-message'));
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(ttsRequestCount, 1);

        releaseTtsResponse();
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(ttsRequestCount, 1);
        assert.equal(await page.evaluate(() => window.__voiceRaceError || ''), '');
        await page.evaluate(() => stopActiveVoicePlayback());
    } finally {
        releaseTtsResponse();
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
