// 文件③ chat：渲染/对话/TTS/设置/启动
// ==================== TTS ====================

        let _audioContext = null;
        function getAudioContext() {
            if (!_audioContext) {
                _audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (activeVoicePlaybackStatus === 'paused') {
                if (_audioContext.state === 'running') _audioContext.suspend().catch(() => {});
            } else if (_audioContext.state === 'suspended') {
                _audioContext.resume().catch(() => {});
            }
            return _audioContext;
        }

        const TTS_CACHE_DB_NAME = 'elaina_tts_cache_v1';
        const TTS_CACHE_STORE = 'pcm_audio';
        const TTS_CACHE_LIMIT = 80;
        let ttsCacheDbPromise = null;
        const activeTtsTasks = new Map();
        const ttsMemoryCache = new Map();

        function hashTtsText(text) {
            let hash = 2166136261;
            const source = String(text || '');
            for (let i = 0; i < source.length; i++) {
                hash ^= source.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(36);
        }

        function buildMessageTtsCacheKey(message, spokenText, conversationId = state.currentConversationId) {
            const clean = sanitizeTtsText(spokenText || '', false);
            return [
                'message-v1',
                conversationId || 'conversation',
                message?.id || 'unknown',
                state.settings.minimaxModel || 'speech-2.8-hd',
                FIXED_MINIMAX_VOICE_ID,
                state.settings.ttsLang || 'japanese',
                Number(state.settings.ttsSpeed || 1).toFixed(2),
                Number(state.settings.ttsVolume ?? 1).toFixed(2),
                hashTtsText(clean)
            ].join(':');
        }

        function openTtsCacheDb() {
            if (!('indexedDB' in window)) return Promise.resolve(null);
            if (ttsCacheDbPromise) return ttsCacheDbPromise;
            ttsCacheDbPromise = new Promise(resolve => {
                const request = indexedDB.open(TTS_CACHE_DB_NAME, 1);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(TTS_CACHE_STORE)) {
                        const store = db.createObjectStore(TTS_CACHE_STORE, { keyPath: 'key' });
                        store.createIndex('createdAt', 'createdAt');
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => {
                    console.warn('[TTS Cache] IndexedDB 打开失败:', request.error);
                    resolve(null);
                };
            });
            return ttsCacheDbPromise;
        }

        async function getCachedTtsAudio(key) {
            if (!key) return null;
            if (ttsMemoryCache.has(key)) return ttsMemoryCache.get(key);
            const db = await openTtsCacheDb();
            if (!db) return null;
            return new Promise(resolve => {
                const request = db.transaction(TTS_CACHE_STORE, 'readonly').objectStore(TTS_CACHE_STORE).get(key);
                request.onsuccess = () => {
                    const record = request.result || null;
                    if (record) ttsMemoryCache.set(key, record);
                    resolve(record);
                };
                request.onerror = () => resolve(null);
            });
        }

        async function pruneTtsCache() {
            const db = await openTtsCacheDb();
            if (!db) return;
            const transaction = db.transaction(TTS_CACHE_STORE, 'readwrite');
            const store = transaction.objectStore(TTS_CACHE_STORE);
            const countRequest = store.count();
            countRequest.onsuccess = () => {
                let removeCount = Math.max(0, countRequest.result - TTS_CACHE_LIMIT);
                if (!removeCount) return;
                const cursorRequest = store.index('createdAt').openCursor();
                cursorRequest.onsuccess = event => {
                    const cursor = event.target.result;
                    if (!cursor || removeCount <= 0) return;
                    store.delete(cursor.primaryKey);
                    removeCount -= 1;
                    cursor.continue();
                };
            };
        }

        async function saveCachedTtsAudio(key, pcmBuffer, sampleRate, format = 'pcm') {
            if (!key || !pcmBuffer || !pcmBuffer.byteLength) return;
            const record = { key, pcm: pcmBuffer, sampleRate, format, createdAt: Date.now() };
            ttsMemoryCache.set(key, record);
            while (ttsMemoryCache.size > TTS_CACHE_LIMIT) {
                ttsMemoryCache.delete(ttsMemoryCache.keys().next().value);
            }
            const db = await openTtsCacheDb();
            if (!db) return;
            await new Promise(resolve => {
                const transaction = db.transaction(TTS_CACHE_STORE, 'readwrite');
                transaction.objectStore(TTS_CACHE_STORE).put(record);
                transaction.oncomplete = resolve;
                transaction.onerror = () => {
                    console.warn('[TTS Cache] 写入失败:', transaction.error);
                    resolve();
                };
            });
            pruneTtsCache().catch(() => {});
        }

        function mergePcmChunks(chunks) {
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            const merged = new Uint8Array(totalLength);
            let offset = 0;
            chunks.forEach(chunk => {
                merged.set(chunk, offset);
                offset += chunk.byteLength;
            });
            return merged.buffer;
        }

        async function playCachedPcm(record, onStart, onEnd, session) {
            const raw = record.pcm instanceof ArrayBuffer ? record.pcm : record.pcm?.buffer;
            if (!raw || raw.byteLength < 2) throw new Error('缓存音频为空');
            ensureVoiceSessionActive(session);
            const context = getAudioContext();
            let buffer;
            if (record.format === 'mp3') {
                buffer = await context.decodeAudioData(raw.slice(0));
            } else {
                    const bytes = new Uint8Array(raw);
                    const sampleCount = Math.floor(bytes.byteLength / 2);
                    const pcm = new Int16Array(sampleCount);
                    for (let i = 0; i < sampleCount; i++) {
                        pcm[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
                    }
                    buffer = context.createBuffer(1, sampleCount, record.sampleRate || 24000);
                    const channel = buffer.getChannelData(0);
                    for (let i = 0; i < sampleCount; i++) channel[i] = pcm[i] / 32768;
            }
            ensureVoiceSessionActive(session);
            return new Promise((resolve, reject) => {
                try {
                    ensureVoiceSessionActive(session);
                    const source = context.createBufferSource();
                    session.audioSources.add(source);
                    source.buffer = buffer;
                    source.connect(context.destination);
                    source.onended = () => {
                        session.audioSources.delete(source);
                        if (isVoiceSessionActive(session) && onEnd) onEnd();
                        resolve();
                    };
                    if (isVoiceSessionActive(session) && onStart) onStart();
                    ensureVoiceSessionActive(session);
                    source.start();
                    if (activeVoicePlaybackStatus === 'paused' && context.state === 'running') context.suspend().catch(() => {});
                } catch (error) {
                    reject(error);
                }
            });
        }

        class PCMStreamPlayer {
            constructor(sampleRate, session) {
                this.ctx = getAudioContext();
                this.sampleRate = sampleRate;
                this.session = session;
                this.nextStartTime = 0;
                this.ended = false;
            }
            enqueue(bytes) {
                if (this.ended || this.ctx.state === 'closed' || !isVoiceSessionActive(this.session)) return;
                const buffer = new ArrayBuffer(bytes.length);
                const view = new Int16Array(buffer);
                for (let i = 0; i < bytes.length; i += 2) {
                    view[i / 2] = (bytes[i] | (bytes[i + 1] << 8));
                }
                const audioBuffer = this.ctx.createBuffer(1, view.length, this.sampleRate);
                const channel = audioBuffer.getChannelData(0);
                for (let i = 0; i < view.length; i++) {
                    channel[i] = view[i] / 32768;
                }
                const source = this.ctx.createBufferSource();
                this.session.audioSources.add(source);
                source.buffer = audioBuffer;
                source.connect(this.ctx.destination);
                source.onended = () => this.session.audioSources.delete(source);
                const now = this.ctx.currentTime;
                if (this.nextStartTime < now) this.nextStartTime = now;
                source.start(this.nextStartTime);
                this.nextStartTime += audioBuffer.duration;
            }
            finalize() {
                this.ended = true;
            }
        }

        async function speakTextMinimax(text, onStart, options = {}) {
            const { cacheKey = '', onEnd = null } = options;
            const session = options.session || createVoiceSession(options.messageId || null);
            ensureVoiceSessionActive(session);
            if (cacheKey) {
                const cached = await getCachedTtsAudio(cacheKey);
                ensureVoiceSessionActive(session);
                if (cached?.pcm) {
                    console.log('[TTS Cache] 命中缓存，直接播放，不调用 MiniMax');
                    try {
                        await playCachedPcm(cached, onStart, onEnd, session);
                        if (!isVoiceSessionActive(session)) return { cancelled: true };
                        return { cached: true };
                    } catch (error) {
                        if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
                        console.warn('[TTS Cache] 缓存播放失败，将重新生成:', error);
                    }
                } else {
                    console.log('[TTS Cache] 未命中，首次调用 MiniMax 生成');
                }
            }
            const appAccessKey = String(state.settings.apiKey || '').trim();
            if (!appAccessKey || !state.settings.baseUrl) {
                throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 ElainaChat 使用 Key');
            }
            try {
                session.abortController = new AbortController();
                const response = await fetchWithTimeout(`${getGatewayBaseUrl()}/api/tts`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${appAccessKey}`
                    },
                    signal: session.abortController.signal,
                    body: JSON.stringify({
                        text,
                        model: state.settings.minimaxModel || 'speech-2.8-hd',
                        speed: state.settings.ttsSpeed || 1.0,
                        volume: state.settings.ttsVolume ?? 1
                    })
                }, 120000);
                if (!response.ok) {
                    throw await readApiErrorResponse(response, '云端语音生成失败');
                }
                const mp3 = await response.arrayBuffer();
                if (!mp3.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '云端 TTS 返回了空音频');
                ensureVoiceSessionActive(session);
                if (cacheKey) {
                    await saveCachedTtsAudio(cacheKey, mp3, 24000, 'mp3');
                    console.log('[TTS Cache] 首次 MP3 音频已写入 IndexedDB');
                }
                await playCachedPcm({ pcm: mp3, format: 'mp3' }, onStart, onEnd, session);
                if (!isVoiceSessionActive(session)) return { cancelled: true };
                return { cached: false };
            } catch (error) {
                if (isVoiceCancellation(error) || !isVoiceSessionActive(session)) return { cancelled: true };
                console.error('[MiniMax TTS] error:', error);
                throw toClientApiError(error);
            }
        }

        function useBrowserTTS(text, onStart, onEnd, session = null) {
            const playbackPromise = new Promise(resolve => {
                if (session && !isVoiceSessionActive(session)) { resolve({ cancelled: true }); return; }
                if ('speechSynthesis' in window) {
                    window.speechSynthesis.cancel();

                    const utterance = new SpeechSynthesisUtterance(text);
                    const voices = window.speechSynthesis.getVoices();
                    const isJapanese = /[\u3040-\u30ff]/.test(text);
                    utterance.lang = isJapanese ? 'ja-JP' : 'zh-CN';
                    utterance.rate = 0.95;
                    utterance.pitch = 1;
                    utterance.volume = Math.max(0, Math.min(1, Number(state.settings.ttsVolume ?? 1)));

                    const voice = voices.find(v => v.lang.startsWith(isJapanese ? 'ja' : 'zh'));
                    if (voice) utterance.voice = voice;

                    utterance.onstart = () => {
                        if ((!session || isVoiceSessionActive(session)) && onStart) {
                            try { onStart(); } catch (e) { console.error('Browser TTS onStart error:', e); }
                        }
                    };
                    const finish = () => {
                        if (!session || isVoiceSessionActive(session)) {
                            if (onEnd) onEnd();
                        }
                        resolve();
                    };
                    utterance.onend = finish;
                    utterance.onerror = finish;
                    window.speechSynthesis.speak(utterance);
                } else {
                    if (onEnd) onEnd();
                    resolve();
                }
            });
            return session ? Promise.race([playbackPromise, session.cancelPromise]) : playbackPromise;
        }

        if ('speechSynthesis' in window) {
            window.speechSynthesis.getVoices();
            window.speechSynthesis.onvoiceschanged = () => {
                window.speechSynthesis.getVoices();
            };
        }

        function sanitizeTtsText(text, stripKana = false) {
            let t = String(text || '').trim();

            // Parenthesized/bracketed passages are stage directions for display only.
            // Repeat a few times so simple nested brackets are removed as one block.
            for (let i = 0; i < 4; i++) {
                const next = t.replace(/（[^（）]*）|\([^()]*\)|【[^【】]*】|\[[^\[\]]*\]/g, ' ');
                if (next === t) break;
                t = next;
            }

            if (stripKana) t = t.replace(/[\u3040-\u30ff]+/g, '');
            t = t.replace(/\s{2,}/g, ' ');
            t = t.replace(/[，、]+(?=[。！？；：,.!?;:])/g, '');
            t = t.replace(/([。！？；：,.!?;:])\1+/g, '$1');
            t = t.replace(/^[\u2014\u2015\u301c\uff5e~，、。！？；：,.!?;:\s]+|[\u2014\u2015\u301c\uff5e~，、。！？；：,.!?;:\s]+$/g, '');
            return t.trim();
        }

        /* ---- 语音 Seek（QQ 式：长按放大，按住声纹拖动跳转）---- */
        window.__voiceSeekInfo = () => {
            try {
                if (!window.__voiceInfo) return { ok: false, duration: 0 };
                return { ok: true, duration: window.__voiceInfo.duration || 0 };
            } catch (e) { return { ok: false, duration: 0 }; }
        };
        window.__voiceSeek = async (ratio, messageId) => {
            try {
                const info = window.__voiceInfo;
                if (!info || !info.buffer) return { ok: false, reason: 'buffering' };
                const duration = info.duration || info.buffer.duration || 0;
                if (!duration) return { ok: false, reason: 'noduration' };
                const offset = Math.max(0, Math.min(0.999, Number(ratio) || 0)) * duration;
                /* 干净清场：停止旧源/终结旧 onEnd 链/关闭旧 context（避免 seek 后旧回调杀掉新播放） */
                await stopActiveVoicePlayback();
                const ctx = getAudioContext();
                try { if (ctx.state === 'suspended') await ctx.resume(); } catch (e) {}
                const source = ctx.createBufferSource();
                source.buffer = info.buffer;
                source.connect(ctx.destination);
                source.onended = () => {
                    try { updateVoicePlayerButton(String(messageId || ''), 'idle'); } catch (e) {}
                    try { activeVoicePlaybackStatus = 'idle'; activeVoicePlayerId = null; } catch (e) {}
                };
                source.start(0, offset);
                if (messageId) {
                    activeVoicePlayerId = messageId;
                    activeVoicePlaybackStatus = 'playing';
                    try { updateVoicePlayerButton(messageId, 'playing'); } catch (e) {}
                }
                try { window.__voicePlaybackStart = { at: Date.now(), offset, duration, msgId: messageId }; window.__voicePlaybackRatio = ratio; } catch (e) {}
                return { ok: true, offset, duration, at: Date.now() };
            } catch (e) {
                return { ok: false, reason: String(e && e.message || e) };
            }
        };

        function speakText(text, onStart, options = {}) {
            const ttsLang = state.settings.ttsLang || 'japanese';
            const clean = sanitizeTtsText(text, ttsLang === 'chinese');
            if (clean !== text) {
                console.log('[TTS] 已移除动作描写并净化朗读文本');
            }
            if (!clean) {
                if (options.onEnd) options.onEnd();
                return Promise.resolve({ empty: true });
            }
            const cacheKey = String(options.cacheKey || '');
            if (cacheKey && activeTtsTasks.has(cacheKey)) {
                console.log('[TTS] 同一消息的语音任务仍在进行，复用现有任务');
                return activeTtsTasks.get(cacheKey);
            }
            const task = speakTextMinimax(clean, onStart, options);
            if (!cacheKey) return task;
            activeTtsTasks.set(cacheKey, task);
            const clearTask = () => {
                if (activeTtsTasks.get(cacheKey) === task) activeTtsTasks.delete(cacheKey);
            };
            task.then(clearTask, clearTask);
            return task;
        }

        // ==================== 状态机 UI ====================

        function alignFloatingMicToComposer() {
            if (!elements.floatingMic || elements.floatingMic.classList.contains('hidden')) return;
            const conversationComposer = elements.inputBar && !elements.inputBar.classList.contains('hidden')
                ? elements.inputBar.querySelector('.conversation-composer')
                : null;
            const initialComposer = elements.initialState && !elements.initialState.classList.contains('hidden')
                ? elements.initialState.querySelector('.initial-composer-shell')
                : null;
            const target = conversationComposer || initialComposer;
            if (!target) return;
            const rect = target.getBoundingClientRect();
            elements.floatingMic.style.left = `${Math.round(rect.left)}px`;
            elements.floatingMic.style.top = `${Math.round(rect.top)}px`;
            elements.floatingMic.style.width = `${Math.round(rect.width)}px`;
            elements.floatingMic.style.transform = 'none';
        }

        function updateUI() {
            const { voiceState } = state;

            const statusMap = {
                'idle': '点击麦克风开始说话',
                'listening': '正在聆听...',
                'paused': '⏸ 已暂停（可继续说话，或点麦克风结束）',
                'thinking': '伊蕾娜思考中...',
                'error': '发生错误'
            };
            elements.statusText.textContent = statusMap[voiceState] || '';

            const micClass = {
                'listening': 'mic-btn mic-listening relative w-32 h-32 rounded-full flex items-center justify-center',
                'paused': 'mic-btn mic-paused relative w-32 h-32 rounded-full flex items-center justify-center',
                'thinking': 'mic-btn mic-thinking relative w-32 h-32 rounded-full flex items-center justify-center',
                'error': 'mic-btn mic-error relative w-32 h-32 rounded-full flex items-center justify-center',
                'idle': 'mic-btn mic-idle relative w-32 h-32 rounded-full flex items-center justify-center'
            };
            elements.micBtn.className = micClass[voiceState] || micClass['idle'];

            const listening = voiceState === 'listening' || voiceState === 'paused';
            elements.pulseRing1.classList.toggle('hidden', !listening);
            elements.pulseRing2.classList.toggle('hidden', !listening);
            elements.floatingPulse1.classList.toggle('hidden', !listening);
            elements.floatingPulse2.classList.toggle('hidden', !listening);

            if (elements.floatingVoiceTitle) {
                elements.floatingVoiceTitle.textContent = voiceState === 'paused' ? '等待继续说话' : '正在聆听';
                elements.floatingVoiceHint.textContent = voiceState === 'paused'
                    ? '继续说话，或点击绿色按钮发送'
                    : '说完后点击麦克风发送';
            }

            const dockVisible = listening && !state.notesMode && !state.diaryMode;
            elements.floatingMic.classList.toggle('hidden', !dockVisible);
            if (dockVisible) requestAnimationFrame(alignFloatingMicToComposer);
        }

        // ==================== 设置 ====================

        function openSettings() {
            elements.settingBaseUrl.value = state.settings.baseUrl || DEFAULT_SETTINGS.baseUrl;
            elements.settingApiKey.value = state.settings.apiKey;
            document.getElementById('settingMinimaxApiKey').value = state.settings.minimaxApiKey || '';
            document.getElementById('settingMinimaxVoice').value = FIXED_MINIMAX_VOICE_ID;
            document.getElementById('settingMinimaxModel').value = state.settings.minimaxModel || 'speech-2.8-hd';
            elements.settingTtsSpeed.value = state.settings.ttsSpeed;
            elements.ttsSpeedLabel.textContent = state.settings.ttsSpeed.toFixed(1) + 'x';
            elements.settingTtsVolume.value = Number(state.settings.ttsVolume ?? 1);
            elements.ttsVolumeLabel.textContent = Math.round(Number(state.settings.ttsVolume ?? 1) * 100) + '%';
            updateSliderFill(elements.settingTtsSpeed);
            updateSliderFill(elements.settingTtsVolume);

            document.querySelectorAll('input[name="ttsLang"]').forEach(r => {
                r.checked = (r.value === (state.settings.ttsLang || 'japanese'));
            });
            document.querySelectorAll('input[name="replyDisplayMode"]').forEach(r => {
                r.checked = (r.value === (state.settings.replyDisplayMode || DEFAULT_SETTINGS.replyDisplayMode));
            });

            document.querySelectorAll('input[name="asrProvider"]').forEach(r => {
                r.checked = (r.value === (state.settings.asrProvider || 'aliyun'));
            });
            updateAsrProviderUI();

            document.getElementById('settingDashscopeApiKey').value = state.settings.dashscopeApiKey || '';
            elements.settingAutoMemory.checked = Boolean(state.settings.autoMemory);
            elements.settingMemoryEvery.value = state.settings.memoryEvery || 6;

            document.getElementById('ccName').value = state.characterCard.name;
            document.getElementById('ccTitle').value = state.characterCard.title;
            document.getElementById('ccWorldSetting').value = state.characterCard.worldSetting;
            document.getElementById('ccCharacterPrompt').value = state.characterCard.characterPrompt;
            document.getElementById('ccGreeting').value = state.characterCard.greeting;
            document.getElementById('uiName').value = state.userIdentity.name;
            document.getElementById('uiTitle').value = state.userIdentity.title;
            document.getElementById('uiPersonality').value = state.userIdentity.personality;
            document.getElementById('uiBackground').value = state.userIdentity.background;
            document.getElementById('uiExtra').value = state.userIdentity.extra;
            settingsContent.scrollTop = 0;

            elements.settingsOverlay.classList.remove('hidden');
            elements.settingsOverlay.classList.add('flex');
            setRailActive('settings');
        }

        function closeSettingsPanel() {
            elements.settingsOverlay.classList.add('hidden');
            elements.settingsOverlay.classList.remove('flex');
            syncRailActive();
        }

        function updateAsrProviderUI() {
            const provider = document.querySelector('input[name="asrProvider"]:checked')?.value || 'aliyun';
            elements.dashscopeAsrFields.classList.toggle('hidden', provider !== 'aliyun');
        }

        function updateSliderFill(slider) {
            if (!slider) return;
            const min = Number(slider.min || 0);
            const max = Number(slider.max || 100);
            const value = Number(slider.value || min);
            const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
            slider.style.setProperty('--slider-progress', `${Math.max(0, Math.min(100, percent))}%`);
        }

        function saveSettings() {
            const asrProvider = 'aliyun';
            const ttsLang = document.querySelector('input[name="ttsLang"]:checked')?.value || 'chinese';
            const replyDisplayMode = document.querySelector('input[name="replyDisplayMode"]:checked')?.value || DEFAULT_SETTINGS.replyDisplayMode;

            state.settings = {
                ...state.settings,
                apiProvider: DEFAULT_SETTINGS.apiProvider,
                baseUrl: elements.settingBaseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl,
                apiKey: elements.settingApiKey.value.trim(),
                model: DEFAULT_SETTINGS.model,
                minimaxApiKey: document.getElementById('settingMinimaxApiKey')?.value.trim() || '',
                minimaxVoice: FIXED_MINIMAX_VOICE_ID,
                minimaxModel: document.getElementById('settingMinimaxModel')?.value || 'speech-2.8-hd',
                ttsSpeed: parseFloat(elements.settingTtsSpeed.value) || 1.0,
                ttsVolume: Math.max(0, Math.min(2, parseFloat(elements.settingTtsVolume.value) || 0)),
                ttsLang,
                replyDisplayMode,
                asrProvider,
                dashscopeApiKey: document.getElementById('settingDashscopeApiKey')?.value.trim() || '',
                autoMemory: elements.settingAutoMemory.checked,
                memoryEvery: Math.max(3, Math.min(50, parseInt(elements.settingMemoryEvery.value, 10) || 6))
            };
            persistSettings();

            state.characterCard = {
                name: document.getElementById('ccName').value.trim() || '伊蕾娜',
                title: document.getElementById('ccTitle').value.trim() || '灰之魔女',
                worldSetting: document.getElementById('ccWorldSetting').value.trim(),
                characterPrompt: document.getElementById('ccCharacterPrompt').value.trim(),
                greeting: document.getElementById('ccGreeting').value.trim()
            };
            saveCharacterCard();
            state.userIdentity = {
                name: document.getElementById('uiName').value.trim(),
                title: document.getElementById('uiTitle').value.trim(),
                personality: document.getElementById('uiPersonality').value.trim(),
                background: document.getElementById('uiBackground').value.trim(),
                extra: document.getElementById('uiExtra').value.trim()
            };
            saveUserIdentity();

            closeSettingsPanel();
            showCustomAlert('设置已保存！', '保存成功');
        }

        function previewPrompt() {
            const card = {
                name: document.getElementById('ccName').value.trim() || '伊蕾娜',
                title: document.getElementById('ccTitle').value.trim() || '灰之魔女',
                worldSetting: document.getElementById('ccWorldSetting').value.trim(),
                characterPrompt: document.getElementById('ccCharacterPrompt').value.trim(),
                greeting: document.getElementById('ccGreeting').value.trim()
            };
            const uiText = buildUserIdentitySystemMessages({
                name: document.getElementById('uiName').value.trim(),
                title: document.getElementById('uiTitle').value.trim(),
                personality: document.getElementById('uiPersonality').value.trim(),
                background: document.getElementById('uiBackground').value.trim(),
                extra: document.getElementById('uiExtra').value.trim()
            }).map(m => m.content).join('\n\n');
            const prompt = uiText ? (buildCharacterSystemPrompt(card) + '\n\n' + uiText) : buildCharacterSystemPrompt(card);
            showCustomAlert(prompt, '角色卡生成的 System Prompt');
        }

        function resetCharacterCard() {
            document.getElementById('ccName').value = DEFAULT_CHARACTER_CARD.name;
            document.getElementById('ccTitle').value = DEFAULT_CHARACTER_CARD.title;
            document.getElementById('ccWorldSetting').value = DEFAULT_CHARACTER_CARD.worldSetting;
            document.getElementById('ccCharacterPrompt').value = DEFAULT_CHARACTER_CARD.characterPrompt;
            document.getElementById('ccGreeting').value = DEFAULT_CHARACTER_CARD.greeting;
        }

        // ==================== 角色设定快捷槽位 ====================

        function getCharacterCardSlots() {
            try {
                const raw = localStorage.getItem('elaina_character_slots');
                const arr = raw ? JSON.parse(raw) : [];
                return Array.isArray(arr) ? arr : [];
            } catch (e) { return []; }
        }

        function saveCharacterCardSlots(slots) {
            localStorage.setItem('elaina_character_slots', JSON.stringify(slots));
        }

        // 忽略标签符号，用于重复检测
        function normalizeSlotSignature(card) {
            const text = [
                String(card.name || ''),
                String(card.title || ''),
                String(card.worldSetting || ''),
                String(card.characterPrompt || ''),
                String(card.greeting || '')
            ].join('\u0001').toLowerCase().replace(/[\s\u3000\n\r\t]+/g, ' ').replace(/[#*_~\[\]（）()【】"'\u201c\u201d\u2018\u2019]/g, '').trim();
            return text;
        }

        function readCurrentCardFromSettings() {
            return {
                name: String(document.getElementById('ccName').value || '').trim(),
                title: String(document.getElementById('ccTitle').value || '').trim(),
                worldSetting: String(document.getElementById('ccWorldSetting').value || '').trim(),
                characterPrompt: String(document.getElementById('ccCharacterPrompt').value || '').trim(),
                greeting: String(document.getElementById('ccGreeting').value || '').trim()
            };
        }

        function applyCardToSettings(card) {
            document.getElementById('ccName').value = String(card.name || '');
            document.getElementById('ccTitle').value = String(card.title || '');
            document.getElementById('ccWorldSetting').value = String(card.worldSetting || '');
            document.getElementById('ccCharacterPrompt').value = String(card.characterPrompt || '');
            document.getElementById('ccGreeting').value = String(card.greeting || '');
            closeCharaSlotPicker();
        }

        function cardSlotLabel(card, index) {
            const name = String(card.name || '').trim() || '未命名角色';
            const world = String(card.worldSetting || '').trim();
            return '#' + (index + 1) + ' ' + name + (world ? ' · ' + world.slice(0, 18) : '');
        }

        function openCharaSlotPicker() {
            const picker = document.getElementById('charaSlotPicker');
            if (!picker) return;
            const slots = getCharacterCardSlots();
            if (!slots.length) {
                picker.innerHTML = '<div class="text-[11px] text-indigo-400 px-2 py-1">还没有保存过设定槽位。</div>';
            } else {
                picker.innerHTML = slots.map((card, i) =>
                    '<button type="button" class="chara-slot-option w-full text-left text-xs text-indigo-700 hover:bg-white/60 rounded-lg px-2 py-1.5" data-slot-index="' + i + '">' + escapeHtml(cardSlotLabel(card, i)) + '</button>'
                ).join('');
                picker.querySelectorAll('[data-slot-index]').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        applyCardToSettings(slots[Number(btn.dataset.slotIndex)]);
                    });
                });
            }
            picker.classList.remove('hidden');
        }

        function closeCharaSlotPicker() {
            const picker = document.getElementById('charaSlotPicker');
            if (picker) picker.classList.add('hidden');
        }

        function saveCharacterCardToSlot() {
            const card = readCurrentCardFromSettings();
            const signature = normalizeSlotSignature(card);
            if (!signature) {
                showCustomAlert('请先填写角色设定内容，再保存到槽位。', '保存槽位');
                return;
            }
            let slots = getCharacterCardSlots();
            const existingIndex = slots.findIndex(s => normalizeSlotSignature(s) === signature);
            if (existingIndex >= 0) {
                // 完全相同：把旧槽位移到最前
                const [existing] = slots.splice(existingIndex, 1);
                slots.unshift(existing);
            } else {
                slots.unshift(card);
            }
            slots = slots.slice(0, 20);
            saveCharacterCardSlots(slots);
            showCustomAlert('已保存到角色设定槽位。', '保存槽位');
        }

        function toggleCharaSlotPicker() {
            const picker = document.getElementById('charaSlotPicker');
            if (!picker) return;
            if (picker.classList.contains('hidden')) openCharaSlotPicker();
            else closeCharaSlotPicker();
        }

        // ==================== 问候打字机 ====================

        let greetingTyping = false;
        function startGreetingTyping() {
            if (greetingTyping) return;
            greetingTyping = true;
            const el = document.getElementById('greetingText');
            const text = String(getEffectiveCharacterCard().greeting || '').trim() || DEFAULT_CHARACTER_CARD.greeting;
            el.classList.add('typing-cursor');
            let i = 0;
            const timer = setInterval(() => {
                i++;
                el.textContent = text.substring(0, i);
                if (i >= text.length) {
                    clearInterval(timer);
                    el.classList.remove('typing-cursor');
                    greetingTyping = false;
                }
            }, 45);
        }

        // ==================== 初始化====================

        function init() {
            syncViewportHeight({ preferWindowHeight: true });
            loadSettings();
            loadCharacterCard();
            loadUserIdentity();
            loadConversations();
            loadFavorites();
            loadLikedQuotes();
            loadMemoryCore();
            elements.textInput.value = '';
            document.getElementById('initialTextInput').value = '';
            elements.sidebarSearchInput.value = '';
            elements.notesSearch.value = '';
            syncComposerThinkingToggles(Boolean(state.settings.thinkingMode));
            updateComposerSendVisibility();

            initSpeechRecognition();

            loadDailyQuote();

            startGreetingTyping();

            elements.micBtn.addEventListener('click', handleMicClick);
            elements.floatingMicBtn.addEventListener('click', handleMicClick);
            elements.floatingEndBtn.addEventListener('click', endListening);
            elements.floatingCancelBtn.addEventListener('click', cancelListening);

            elements.railSettingsBtn.addEventListener('click', openSettings);
            elements.closeSettings.addEventListener('click', closeSettingsPanel);
            elements.cancelSettings.addEventListener('click', closeSettingsPanel);
            elements.settingsOverlay.addEventListener('click', (e) => {
                if (e.target === elements.settingsOverlay) closeSettingsPanel();
            });
            elements.saveSettings.addEventListener('click', saveSettings);
            elements.announcementConfirmBtn.addEventListener('click', closeAnnouncement);
            elements.announcementSkipBtn?.addEventListener('click', dismissAnnouncement);
            elements.announcementOverlay.addEventListener('click', (event) => {
                if (event.target === elements.announcementOverlay && !isFirstInstall()) closeAnnouncement();
            });

            document.querySelectorAll('input[name="asrProvider"]').forEach(r => {
                r.addEventListener('change', updateAsrProviderUI);
            });
            elements.settingTtsSpeed.addEventListener('input', () => {
                elements.ttsSpeedLabel.textContent = parseFloat(elements.settingTtsSpeed.value).toFixed(1) + 'x';
                updateSliderFill(elements.settingTtsSpeed);
            });
            elements.settingTtsVolume.addEventListener('input', () => {
                elements.ttsVolumeLabel.textContent = Math.round(parseFloat(elements.settingTtsVolume.value) * 100) + '%';
                updateSliderFill(elements.settingTtsVolume);
            });
            document.getElementById('previewPromptBtn').addEventListener('click', previewPrompt);
            document.getElementById('resetCharacterBtn').addEventListener('click', resetCharacterCard);
            document.getElementById('charaSlotSaveBtn').addEventListener('click', saveCharacterCardToSlot);
            document.getElementById('charaSlotUseBtn').addEventListener('click', toggleCharaSlotPicker);

            elements.newConversationBtn.addEventListener('click', () => {
                createConversation(state.activeCategoryId);
                closeSidebarDrawer();
            });
            elements.newCategoryBtn.addEventListener('click', () => {
                promptCreateCategory();
            });

            elements.initialTextInput.addEventListener('input', updateComposerSendVisibility);
            elements.textInput.addEventListener('input', updateComposerSendVisibility);
            elements.initialTextInput.addEventListener('focus', () => {
                captureInitialComposerViewportBaseline();
            });
            elements.initialTextInput.addEventListener('blur', () => {
                scheduleViewportRecovery();
            });
            elements.textInput.addEventListener('focus', () => keepFocusedComposerVisible(elements.textInput));
            elements.initialComposerMoreBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                toggleComposerToolsMenu(elements.initialComposerMoreBtn, elements.initialComposerMoreMenu, elements.initialComposerThinkingToggle);
            });
            elements.composerMoreBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                toggleComposerToolsMenu(elements.composerMoreBtn, elements.composerMoreMenu, elements.composerThinkingToggle);
            });
            elements.initialComposerImageBtn.addEventListener('click', openComposerImagePicker);
            elements.composerImageBtn.addEventListener('click', openComposerImagePicker);
            elements.composerImageInput.addEventListener('change', async () => {
                const file = elements.composerImageInput.files?.[0];
                if (!file) return;
                composerImageProcessing = true;
                elements.initialComposerImageBtn.disabled = true;
                elements.composerImageBtn.disabled = true;
                updateComposerSendVisibility();
                try {
                    pendingComposerImage = await compressComposerImage(file);
                    renderPendingComposerImage();
                } catch (error) {
                    removePendingComposerImage();
                    showCustomAlert(error?.message || '图片处理失败，请更换一张图片。', '无法添加图片');
                } finally {
                    composerImageProcessing = false;
                    elements.initialComposerImageBtn.disabled = false;
                    elements.composerImageBtn.disabled = false;
                    updateComposerSendVisibility();
                }
            });
            const updateThinkingMode = (checked) => {
                state.settings.thinkingMode = checked;
                syncComposerThinkingToggles(checked);
                persistSettings();
            };
            elements.initialComposerThinkingToggle.addEventListener('change', () => updateThinkingMode(elements.initialComposerThinkingToggle.checked));
            elements.composerThinkingToggle.addEventListener('change', () => updateThinkingMode(elements.composerThinkingToggle.checked));
            elements.initialComposerMemoryBtn.addEventListener('click', runManualMemorySummary);
            elements.composerMemoryBtn.addEventListener('click', runManualMemorySummary);
            document.getElementById('initialComposerExportMemoryBtn')?.addEventListener('click', () => guardedMemoryOpen('导出记忆', () => showMemoryExportDialog('all')));
            document.getElementById('initialComposerImportMemoryBtn')?.addEventListener('click', () => guardedMemoryOpen('导入记忆', () => showMemoryImportDialog()));
            document.getElementById('composerExportMemoryBtn')?.addEventListener('click', () => guardedMemoryOpen('导出记忆', () => showMemoryExportDialog('all')));
            document.getElementById('composerImportMemoryBtn')?.addEventListener('click', () => guardedMemoryOpen('导入记忆', () => showMemoryImportDialog()));
            document.getElementById('sidebarMemoryImportBtn')?.addEventListener('click', (e) => { e.stopPropagation(); guardedMemoryOpen('导入记忆（侧栏）', () => showMemoryImportDialog()); });
            document.getElementById('settingExportMemoryBtn')?.addEventListener('click', () => guardedMemoryOpen('导出记忆（设置页）', () => showMemoryExportDialog('all')));
            document.getElementById('settingImportMemoryBtn')?.addEventListener('click', () => guardedMemoryOpen('导入记忆（设置页）', () => showMemoryImportDialog()));
            document.getElementById('settingLogsBtn')?.addEventListener('click', () => guardedMemoryOpen('日志与错误报告', () => showAppLogsModal()));
            document.getElementById('settingExportLogsBtn')?.addEventListener('click', () => guardedMemoryOpen('导出日志', () => exportAppLogsFile()));
            document.getElementById('settingClearLogsBtn')?.addEventListener('click', () => { clearAppLogs(); memShowToast('日志已清空'); });
            elements.composerPromptBtn.addEventListener('click', openConversationPromptEditor);
            elements.initialComposerPromptBtn.addEventListener('click', openConversationPromptEditor);
            elements.conversationPromptCancelBtn.addEventListener('click', closeConversationPromptEditor);
            elements.conversationPromptSaveBtn.addEventListener('click', saveConversationPrompt);
            if (elements.convCcResetBtn) elements.convCcResetBtn.addEventListener('click', resetConversationPromptCard);
            elements.conversationPromptOverlay.addEventListener('click', (event) => {
                if (event.target === elements.conversationPromptOverlay) closeConversationPromptEditor();
            });
            document.addEventListener('click', (event) => {
                const anyMenuOpen = !elements.initialComposerMoreMenu.classList.contains('hidden') || !elements.composerMoreMenu.classList.contains('hidden');
                if (anyMenuOpen && !event.target.closest('.composer-tools')) {
                    closeComposerToolsMenu();
                }
            });

            elements.sidebarSearchInput.addEventListener('input', renderFolderList);
            elements.sidebarSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && elements.sidebarSearchInput.value) {
                    elements.sidebarSearchInput.value = '';
                    renderFolderList();
                }
            });
            elements.sidebarSearchClear.addEventListener('click', () => {
                elements.sidebarSearchInput.value = '';
                elements.sidebarSearchClear.classList.add('hidden');
                renderFolderList();
                elements.sidebarSearchInput.focus();
            });
            elements.sidebarSearchInput.addEventListener('input', () => {
                elements.sidebarSearchClear.classList.toggle('hidden', !elements.sidebarSearchInput.value);
            });

            elements.railChatBtn.addEventListener('click', () => {
                if (state.notesMode) exitNotesMode();
                else if (state.diaryMode) exitDiaryMode();
                else syncRailActive();
            });
            elements.notesBtn.addEventListener('click', () => {
                if (state.notesMode) {
                    exitNotesMode();
                } else {
                    enterNotesMode();
                }
            });
            elements.railDiaryBtn.addEventListener('click', () => {
                if (state.diaryMode) exitDiaryMode();
                else enterDiaryMode();
            });
            elements.exitDiaryBtn.addEventListener('click', exitDiaryMode);
            elements.exitNotesBtn.addEventListener('click', () => {
                if (state.notesMode) exitNotesMode();
            });
            elements.notesSearch.addEventListener('input', (e) => renderNotesPage(e.target.value));

            document.querySelectorAll('.notes-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    state.notesTab = btn.dataset.tab;
                    document.querySelectorAll('.notes-tab').forEach(b => {
                        const active = b === btn;
                        b.classList.toggle('tab-active', active);
                        b.classList.toggle('text-indigo-500', !active);
                        b.classList.toggle('bg-white/40', !active);
                        b.classList.toggle('border', !active);
                        b.classList.toggle('border-white/55', !active);
                    });
                    renderNotesPage(elements.notesSearch.value);
                });
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    closeComposerToolsMenu();
                    closeMessageContextMenu();
                    if (messageSelection.active) exitMessageSelection();
                }
                if (e.key === 'Escape' && state.selectedFavoriteId) {
                    collapseFavorite();
                }
            });

            elements.detailClose.addEventListener('click', collapseFavorite);
            elements.notesOverlay.addEventListener('click', (e) => {
                if (e.target === elements.notesOverlay) collapseFavorite();
            });
            elements.detailRemoveBtn.addEventListener('click', () => {
                if (state.selectedFavoriteId) {
                    removeFavoriteWithConfirm(state.selectedFavoriteId);
                }
            });
            elements.detailJumpBtn.addEventListener('click', () => {
                const fav = state.favorites.find(f => f.id === state.selectedFavoriteId);
                if (fav) jumpToOriginal(fav);
            });

            elements.manageCategoriesBtn.addEventListener('click', () => {
                openCategoriesModal();
            });
            elements.memoryBtn.addEventListener('click', runManualMemorySummary);
            elements.categoriesModalClose.addEventListener('click', closeCategoriesModal);
            elements.categoriesModalOverlay.addEventListener('click', (e) => {
                if (e.target === elements.categoriesModalOverlay) closeCategoriesModal();
            });
            elements.categoriesModalNew.addEventListener('click', async () => {
                await promptCreateCategory();
                renderCategoriesModalList();
            });
            elements.catSelectAllBtn.addEventListener('click', () => {
                const visible = [...elements.categoriesModalList.querySelectorAll('.cat-checkbox')];
                const allChecked = visible.every(cb => cb.checked);
                visible.forEach(cb => cb.checked = !allChecked);
                if (allChecked) {
                    visible.forEach(cb => catSelected.delete(cb.dataset.convId));
                } else {
                    visible.forEach(cb => catSelected.add(cb.dataset.convId));
                }
                renderCategoriesModalList();
                renderCatBatchBar();
            });
            elements.catInvertBtn.addEventListener('click', () => {
                const visible = [...elements.categoriesModalList.querySelectorAll('.cat-checkbox')];
                visible.forEach(cb => {
                    if (cb.checked) catSelected.delete(cb.dataset.convId);
                    else catSelected.add(cb.dataset.convId);
                });
                renderCategoriesModalList();
                renderCatBatchBar();
            });
            elements.catMoveSelect.addEventListener('change', catMoveSelected);
            elements.catDeleteSelectedBtn.addEventListener('click', catDeleteSelected);
            elements.conversationMoveClose.addEventListener('click', closeConversationMoveDialog);
            elements.conversationMoveCancel.addEventListener('click', closeConversationMoveDialog);
            elements.conversationMoveOverlay.addEventListener('click', (e) => {
                if (e.target === elements.conversationMoveOverlay) closeConversationMoveDialog();
            });

            document.getElementById('quoteLikeBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                toggleQuoteLike();
            });
            document.getElementById('quoteFavBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                toggleQuoteFavorite();
            });

            elements.showSidebar.addEventListener('click', showSidebarFunc);
            elements.mobileSidebarClose.addEventListener('click', closeSidebarDrawer);
            elements.sidebarOverlay.addEventListener('click', closeSidebarDrawer);
            elements.folderList.addEventListener('scroll', closeConversationContextMenu, { passive: true });
            elements.diaryGrid.parentElement.addEventListener('scroll', closeConversationContextMenu, { passive: true });
            if (elements.conversationHistory) {
                elements.conversationHistory.addEventListener('scroll', () => {
                    closeMessageContextMenu();
                }, { passive: true });
            }
            window.addEventListener('resize', () => {
                syncViewportHeight();
                closeConversationContextMenu();
                closeMessageContextMenu();
                requestAnimationFrame(alignFloatingMicToComposer);
            });
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', syncViewportHeight);
                window.visualViewport.addEventListener('scroll', syncViewportHeight);
            }
            document.addEventListener('pointerdown', (e) => {
                if (conversationContextMenu && !conversationContextMenu.contains(e.target)) {
                    closeConversationContextMenu();
                }
                if (messageContextMenu && !messageContextMenu.contains(e.target)) {
                    closeMessageContextMenu();
                }
            });
            document.addEventListener('click', (e) => {
                if (window.innerWidth > 860 || !document.body.classList.contains('sidebar-open')) return;
                if (elements.sidebar.contains(e.target) || elements.showSidebar.contains(e.target)) return;
                closeSidebarDrawer();
            });
            elements.sidebar.addEventListener('click', (e) => {
                if (window.innerWidth > 860) return;
                if (e.target.closest('[data-conv-id], [data-rail-action]')) {
                    closeSidebarDrawer();
                }
            });

            updateNotesBadge();
            const mobileFirstScreen = window.matchMedia('(max-width: 860px)').matches;
            if (mobileFirstScreen) {
                // 移动端每次进入先落在新对话欢迎页，不直接恢复上次聊天内容。
                state.currentConversationId = null;
            }
            renderFolderList();

            if (mobileFirstScreen) {
                showInitialState();
                loadAnnouncement().then(openAnnouncement);
                return;
            }
            const hasConversation = Boolean(state.currentConversationId);
            if (hasConversation) {
                const conv = state.conversations.find(c => c.id === state.currentConversationId);
                if (conv && conv.messages.length > 0) {
                    loadConversation(conv.id);
                }
            }
            loadAnnouncement().then(openAnnouncement);
        }

        function showSidebarFunc() {
            if (window.innerWidth <= 860) {
                elements.initialState.classList.add('sidebar-underlay-hidden');
                elements.floatingMic.classList.add('sidebar-underlay-hidden');
            }
            document.body.classList.add('sidebar-open');
            elements.sidebarOverlay.classList.remove('hidden');
        }

        let viewportRecoveryGeneration = 0;
        let initialComposerViewportBaseline = 0;
        let initialComposerViewportWidth = 0;

        function isViewportTextEntryFocused() {
            const active = document.activeElement;
            if (!active) return false;
            return active.matches?.('input, textarea, [contenteditable="true"]') || false;
        }

        function resetInitialComposerKeyboardState() {
            initialComposerViewportBaseline = 0;
            initialComposerViewportWidth = 0;
            document.body.classList.remove('initial-keyboard-tracking');
            document.body.classList.remove('initial-keyboard-visible');
            document.documentElement.style.setProperty('--initial-keyboard-inset', '0px');
        }

        function captureInitialComposerViewportBaseline() {
            if (window.innerWidth > 860) {
                resetInitialComposerKeyboardState();
                return;
            }
            const viewport = window.visualViewport;
            initialComposerViewportBaseline = Math.max(
                Number(window.innerHeight) || 0,
                Number(viewport?.height) || 0
            );
            initialComposerViewportWidth = Number(viewport?.width) || Number(window.innerWidth) || 0;
            document.body.classList.add('initial-keyboard-tracking');
            document.documentElement.style.setProperty('--initial-stable-height', `${Math.round(initialComposerViewportBaseline)}px`);
            document.documentElement.style.setProperty('--initial-keyboard-inset', '0px');
            syncViewportHeight();
        }

        function syncInitialComposerKeyboardState(viewportHeight) {
            const initialInputFocused = document.activeElement === elements.initialTextInput && window.innerWidth <= 860;
            const trackingInitialKeyboard = window.innerWidth <= 860 && initialComposerViewportBaseline > 0;
            if (!initialInputFocused && !trackingInitialKeyboard) {
                document.body.classList.remove('initial-keyboard-visible');
                document.documentElement.style.setProperty('--initial-keyboard-inset', '0px');
                return;
            }
            const viewportWidth = Number(window.visualViewport?.width) || Number(window.innerWidth) || 0;
            if (!initialComposerViewportBaseline || Math.abs(viewportWidth - initialComposerViewportWidth) > 48) {
                initialComposerViewportBaseline = Math.max(viewportHeight, Number(window.innerHeight) || 0);
                initialComposerViewportWidth = viewportWidth;
            } else if (viewportHeight > initialComposerViewportBaseline) {
                initialComposerViewportBaseline = viewportHeight;
            }
            const keyboardInset = Math.max(0, initialComposerViewportBaseline - viewportHeight);
            const keyboardThreshold = Math.max(96, Math.round(initialComposerViewportBaseline * 0.15));
            const keyboardWasVisible = document.body.classList.contains('initial-keyboard-visible');
            const keyboardVisible = keyboardWasVisible
                ? keyboardInset > 8
                : initialInputFocused && keyboardInset > keyboardThreshold;
            document.documentElement.style.setProperty('--initial-stable-height', `${Math.round(initialComposerViewportBaseline)}px`);
            document.documentElement.style.setProperty('--initial-keyboard-inset', `${Math.round(keyboardInset)}px`);
            if (!initialInputFocused && !keyboardVisible) {
                resetInitialComposerKeyboardState();
                return;
            }
            document.body.classList.toggle('initial-keyboard-visible', keyboardVisible);
        }

        function syncViewportHeight(options = {}) {
            const viewport = window.visualViewport;
            const textEntryFocused = isViewportTextEntryFocused();
            const preferWindowHeight = Boolean(options.preferWindowHeight) && !textEntryFocused;
            const visualHeight = Number(viewport?.height) || 0;
            const windowHeight = Number(window.innerHeight) || 0;
            const wideAndroidViewport = ANDROID_GATEWAY_CLIENT && window.innerWidth > 860;
            const viewportHeight = wideAndroidViewport
                ? (visualHeight || windowHeight)
                : (!textEntryFocused || preferWindowHeight
                    ? Math.max(windowHeight, visualHeight)
                    : (visualHeight || windowHeight));
            const observedViewportHeight = visualHeight || windowHeight;
            const viewportTop = window.innerWidth <= 860 && textEntryFocused && !preferWindowHeight
                ? Math.max(0, viewport?.offsetTop || 0)
                : 0;
            if (viewportHeight) document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
            document.documentElement.style.setProperty('--viewport-offset-top', `${Math.round(viewportTop)}px`);
            if (!initialComposerViewportBaseline && !textEntryFocused && viewportHeight) {
                document.documentElement.style.setProperty('--initial-stable-height', `${Math.round(viewportHeight)}px`);
            }
            syncInitialComposerKeyboardState(observedViewportHeight);
        }

        function scheduleViewportRecovery() {
            const generation = ++viewportRecoveryGeneration;
            requestAnimationFrame(() => {
                if (generation !== viewportRecoveryGeneration) return;
                syncViewportHeight();
            });
            [120, 320].forEach(delay => {
                setTimeout(() => {
                    if (generation !== viewportRecoveryGeneration) return;
                    syncViewportHeight({ preferWindowHeight: true });
                }, delay);
            });
        }

        function keepFocusedComposerVisible(input) {
            if (!input || window.innerWidth > 860) return;
            const align = () => {
                if (document.activeElement !== input) return;
                syncViewportHeight();
                input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                if (input === elements.textInput && elements.conversationHistory) {
                    elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
                }
            };
            requestAnimationFrame(align);
            setTimeout(align, 180);
            setTimeout(align, 360);
        }

        function closeSidebarDrawer() {
            if (window.innerWidth > 860) return;
            closeConversationContextMenu();
            document.body.classList.remove('sidebar-open');
            elements.sidebarOverlay.classList.add('hidden');
            elements.initialState.classList.remove('sidebar-underlay-hidden');
            elements.floatingMic.classList.remove('sidebar-underlay-hidden');
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    