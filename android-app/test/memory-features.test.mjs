import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(testDirectory, '../www');
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function createStaticServer() {
    return createServer(async (request, response) => {
        try {
            const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
            const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
            const target = path.resolve(webRoot, relativePath);
            if (!target.startsWith(webRoot + path.sep) && target !== path.join(webRoot, 'index.html')) { response.writeHead(403).end(); return; }
            const targetStat = await stat(target);
            if (!targetStat.isFile()) throw new Error('not a file');
            const content = await readFile(target);
            response.writeHead(200, { 'Content-Type': target.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
            response.end(content);
        } catch { response.writeHead(404).end(); }
    });
}

test('memory features: recall cascade, per-conversation card, character slots', async testContext => {
    const server = createStaticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: edgePath, headless: true });
    const consoleErrors = [];
    try {
        const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
        const page = await context.newPage();
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + (err.message || String(err))));
        await page.route('**/*', async route => {
            const url = route.request().url();
            if (new URL(url).pathname === '/favicon.ico') { await route.fulfill({ status: 204, body: '' }); return; }
            if (url.startsWith('http://127.0.0.1:' + server.address().port + '/')) { await route.continue(); return; }
            if (url.startsWith('https://cdn.jsdelivr.net/npm/@fontsource')) { await route.fulfill({ status: 200, contentType: 'text/css', body: '' }); return; }
            await route.abort();
        });
        await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof loadConversation === 'function', { timeout: 10000 });

        const result = await page.evaluate(async () => {
            const out = { _error: null };
            try {
                if (typeof getEffectiveCharacterCard !== 'function') throw new Error('getEffectiveCharacterCard missing');
                if (typeof saveCharacterCardToSlot !== 'function') throw new Error('saveCharacterCardToSlot missing');
                if (typeof buildCharacterSystemMessages !== 'function') throw new Error('buildCharacterSystemMessages missing');
                const convId = 'feat-conv';
                state.currentConversationId = convId;
                state.conversations = [{ id: convId, title: '功能测试', messages: [] }];
                state.characterCard = { name: '全局伊', title: '全局职称', worldSetting: '全局世界观', characterPrompt: '全局卡内容', greeting: '全局问候' };
                out.effectiveDefaultIsGlobal = getEffectiveCharacterCard().name === '全局伊';
                const conv = state.conversations[0];
                conv.characterCard = { name: '本地伊', title: '本地职称', worldSetting: '本地世界观', characterPrompt: '本地卡内容', greeting: '本地问候' };
                out.effectiveUsesConv = getEffectiveCharacterCard().name === '本地伊';
                const msgSys = buildCharacterSystemMessages(getEffectiveCharacterCard()).map(m => m.content).join('\n');
                out.convCardInPrompt = msgSys.includes('本地世界观') && msgSys.includes('本地卡内容') && !msgSys.includes('全局卡内容');
                out.convCardDetected = getConversationCharacterCard() !== null;
                document.getElementById('ccName').value = '槽位角色';
                document.getElementById('ccTitle').value = '槽位职称';
                document.getElementById('ccWorldSetting').value = '槽位世界观';
                document.getElementById('ccCharacterPrompt').value = '槽位卡';
                document.getElementById('ccGreeting').value = '槽位问候';
                saveCharacterCardToSlot();
                let slots = getCharacterCardSlots();
                out.slotCountAfterSave = slots.length;
                out.slotContainsName = slots.length > 0 && slots[0].name === '槽位角色';
                document.getElementById('ccName').value = '槽位角色';
                document.getElementById('ccWorldSetting').value = '【槽位世界观】';
                saveCharacterCardToSlot();
                slots = getCharacterCardSlots();
                out.slotCountAfterDup = slots.length;
                document.getElementById('ccName').value = '第二个角色';
                document.getElementById('ccWorldSetting').value = '第二个世界观';
                saveCharacterCardToSlot();
                slots = getCharacterCardSlots();
                out.slotCountAfterSecond = slots.length;
                out.secondIsFront = slots[0].name === '第二个角色';
                document.getElementById('ccName').value = '槽位角色';
                document.getElementById('ccWorldSetting').value = '槽位世界观';
                saveCharacterCardToSlot();
                slots = getCharacterCardSlots();
                out.firstMovedToFront = slots[0].name === '槽位角色';
                out.closePickerExists = typeof closeCharaSlotPicker === 'function';
                out.editorFieldsExist = !!document.getElementById('convCcName') && !!document.getElementById('convCcWorldSetting');
            } catch (e) { out._error = String(e && e.stack || e); }
            return out;
        });

        const cascadeResult = await page.evaluate(async () => {
            const out = { _error: null };
            try {
                state.currentConversationId = 'feat-conv';
                const conv = state.conversations.find(c => c.id === 'feat-conv');
                conv.messages = [
                    { id: 'u1', role: 'user', text: '第一条用户', timestamp: '10:00' },
                    { id: 'a1', role: 'ai', text: '第一条回复', timestamp: '10:01' },
                    { id: 'u2', role: 'user', text: '第二条用户', timestamp: '10:02' },
                    { id: 'a2', role: 'ai', text: '第二条回复', timestamp: '10:03' }
                ];
                loadConversation('feat-conv');
                out.preCount = conv.messages.length;
                out.hasModal = typeof showCustomModal === 'function';
            } catch (e) { out._error = String(e && e.stack || e); }
            return out;
        });

        await page.evaluate(() => { state.currentConversationId = 'feat-conv'; const c = state.conversations.find(c => c.id === 'feat-conv'); c.messages = [{ id:'u1', role:'user', text:'第一条用户', timestamp:'10:00' }, { id:'a1', role:'ai', text:'第一条回复', timestamp:'10:01' }, { id:'u2', role:'user', text:'第二条用户', timestamp:'10:02' }, { id:'a2', role:'ai', text:'第二条回复', timestamp:'10:03' }]; loadConversation('feat-conv'); });

        // 用 DOM 事件直接触发撤回并选择「同时删除之后」，避免 modal 遮挡
        await page.evaluate(() => {
            const ov = document.getElementById('announcementOverlay');
            if (ov) { ov.classList.add('hidden'); ov.classList.remove('flex'); }
            recallMessage('u1');
        });
        await page.waitForSelector('#customModal:not(.hidden)', { timeout: 5000 });
        await page.waitForFunction(() => {
            const b = document.getElementById('customModalExtraBtn');
            return b && !b.classList.contains('hidden') && b.textContent.indexOf('同时删除') >= 0;
        });
        const extraText = await page.evaluate(() => document.getElementById('customModalExtraBtn').textContent);
        await page.evaluate(() => { document.getElementById('customModalExtraBtn').click(); });
        await page.waitForTimeout(300);
        const afterCascade = await page.evaluate(() => state.conversations.find(c => c.id === 'feat-conv').messages.length);

        console.log('DIAG', JSON.stringify({ ...result, extraText, afterCascade, consoleErrors }));
        assert.equal(result._error, null, 'evaluate should not throw: ' + result._error);
        assert.equal(result.effectiveDefaultIsGlobal, true);
        assert.equal(result.effectiveUsesConv, true);
        assert.equal(result.convCardInPrompt, true);
        assert.equal(result.convCardDetected, true);
        assert.ok(result.slotCountAfterSave >= 1);
        assert.equal(result.slotContainsName, true);
        assert.equal(result.slotCountAfterDup, 1);
        assert.equal(result.slotCountAfterSecond, 2);
        assert.equal(result.secondIsFront, true);
        assert.equal(result.firstMovedToFront, true);
        assert.equal(result.closePickerExists, true);
        assert.equal(result.editorFieldsExist, true);
        assert.equal(cascadeResult._error, null, 'cascade evaluate should not throw: ' + cascadeResult._error);
        assert.ok(extraText.includes('同时删除'), 'recall modal should offer cascade, got: ' + extraText);
        assert.equal(afterCascade, 0, 'cascade recall should remove target and all after');
        const realErrors = consoleErrors.filter(e => !/ERR_FAILED|net::|Failed to load resource/.test(e));
        assert.deepEqual(realErrors, [], 'browser should have no JS errors, got: ' + JSON.stringify(realErrors));
    } finally {
        await browser.close();
        server.close();
    }
});