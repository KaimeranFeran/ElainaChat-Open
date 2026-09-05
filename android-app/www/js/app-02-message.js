// 文件② message：消息处理/记忆导入导出/日志/菜单/导入提示
// ==================== 消息渲染 ====================

        function renderThinkingMessage() {
            if (!elements.conversationHistory) return;
            if (document.getElementById('thinking-bubble')) return;

            const wrapper = document.createElement('div');
            wrapper.id = 'thinking-bubble';
            wrapper.className = 'flex gap-3 mb-4 thinking-bubble animate-fade-in-up';
            wrapper.innerHTML = `
                <div class="pixso-chat-avatar" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="12" r="2.7"/>
                        <circle cx="5.5" cy="12" r="3.2"/>
                        <circle cx="18.5" cy="12" r="3.2"/>
                        <circle cx="12" cy="5.5" r="3.2"/>
                        <circle cx="12" cy="18.5" r="3.2"/>
                    </svg>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="bubble-ai rounded-2xl px-4 py-3 inline-flex items-center gap-2.5">
                        <span class="thinking-dot"></span>
                        <span class="thinking-dot"></span>
                        <span class="thinking-dot"></span>
                        <span class="thinking-label text-sm ml-1">伊蕾娜正在想...</span>
                    </div>
                </div>
            `;
            elements.conversationHistory.appendChild(wrapper);
            elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
        }

        function removeThinkingMessage() {
            const el = document.getElementById('thinking-bubble');
            if (el) {
                el.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
                el.style.opacity = '0';
                el.style.transform = 'translateY(-4px)';
                setTimeout(() => el.remove(), 200);
            }
            state.thinkingMessageId = null;
        }

        let activeVoicePlayerId = null;
        let activeVoicePlaybackStatus = 'idle';
        let voicePlaybackGeneration = 0;
        let voicePlaybackStartGeneration = 0;
        let activeVoiceSession = null;
        const pendingAutomaticVoiceMessageIds = new Set();
        const pendingJapaneseVoiceTextTasks = new WeakMap();
        const voicePlaybackTasksByMessageId = new Map();

        function getJapaneseVoiceText(message) {
            const voiceText = String(message?.voiceJp || '').trim();
            return /[\u3040-\u30ff]/.test(voiceText) ? voiceText : '';
        }

        function ensureJapaneseVoiceText(message) {
            const existing = getJapaneseVoiceText(message);
            if (existing) return Promise.resolve(existing);
            if (!message || typeof message !== 'object') return Promise.resolve('');
            const pending = pendingJapaneseVoiceTextTasks.get(message);
            if (pending) return pending;
            const dialogueOnly = sanitizeTtsText(message.text || '', false);
            if (!dialogueOnly) return Promise.resolve('');
            const task = translateToJapanese(dialogueOnly).then(result => {
                const japanese = String(result || '').trim();
                if (!/[\u3040-\u30ff]/.test(japanese)) return '';
                message.voiceJp = japanese;
                return japanese;
            });
            pendingJapaneseVoiceTextTasks.set(message, task);
            const clearTask = () => {
                if (pendingJapaneseVoiceTextTasks.get(message) === task) pendingJapaneseVoiceTextTasks.delete(message);
            };
            task.then(clearTask, clearTask);
            return task;
        }

        function createVoiceCancellationError() {
            const error = new Error('语音播放已取消');
            error.name = 'AbortError';
            error.code = 'VOICE_CANCELLED';
            return error;
        }

        function isVoiceCancellation(error) {
            return error?.name === 'AbortError' || error?.code === 'VOICE_CANCELLED';
        }

        function createVoiceSession(messageId = null) {
            const session = {
                generation: ++voicePlaybackGeneration,
                messageId,
                cancelled: false,
                abortController: null,
                webSocket: null,
                audioSources: new Set(),
                browserUtterance: null
            };
            session.cancelPromise = new Promise(resolve => { session.resolveCancel = resolve; });
            activeVoiceSession = session;
            return session;
        }

        function isVoiceSessionActive(session) {
            return Boolean(session) && activeVoiceSession === session && !session.cancelled && session.generation === voicePlaybackGeneration;
        }

        function ensureVoiceSessionActive(session) {
            if (!isVoiceSessionActive(session)) throw createVoiceCancellationError();
        }

        function estimateVoiceDurationSeconds(text) {
            const clean = sanitizeTtsText(text || '', false);
            if (!clean) return 0;
            const cjkCount = (clean.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
            const latinWords = clean.replace(/[\u3400-\u9fff\u3040-\u30ff]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
            const punctuationPauses = (clean.match(/[，。！？；：,.!?;:]/g) || []).length * 0.16;
            const speed = Math.max(0.5, Number(state.settings.ttsSpeed) || 1);
            return Math.max(2, Math.ceil((cjkCount / 4.5 + latinWords / 2.4 + punctuationPauses) / speed));
        }

        function formatVoiceDuration(seconds) {
            const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
            return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
        }

        function voiceWaveformMarkup() {
            return Array.from({ length: 15 }, () => '<span class="voice-wave-bar"></span>').join('');
        }

        function updateVoicePlayerButton(messageId, status) {
            const button = document.getElementById(`voice-player-${messageId}`);
            if (!button) return;
            const isPlaying = status === 'playing';
            const isPaused = status === 'paused';
            const isLoading = status === 'loading';
            button.classList.toggle('is-playing', isPlaying);
            button.classList.toggle('is-paused', isPaused);
            button.classList.toggle('is-loading', isLoading);
            button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
            button.setAttribute('aria-label', isLoading ? '伊蕾娜的语音生成中' : isPlaying ? '暂停伊蕾娜的语音' : isPaused ? '继续伊蕾娜的语音' : '播放伊蕾娜的语音');
        }

        function setVoicePlaybackLoading(messageId) {
            if (activeVoicePlayerId && String(activeVoicePlayerId) !== String(messageId)) {
                updateVoicePlayerButton(activeVoicePlayerId, 'idle');
            }
            activeVoicePlayerId = messageId;
            activeVoicePlaybackStatus = 'loading';
            updateVoicePlayerButton(messageId, 'loading');
        }

        function setVoicePlaybackState(messageId, playing, durationSeconds = 0) {
            if (activeVoicePlayerId && String(activeVoicePlayerId) !== String(messageId)) {
                updateVoicePlayerButton(activeVoicePlayerId, 'idle');
            }
            if (!playing) {
                updateVoicePlayerButton(messageId, 'idle');
                if (String(activeVoicePlayerId) === String(messageId)) {
                    activeVoicePlayerId = null;
                    activeVoicePlaybackStatus = 'idle';
                }
                return;
            }
            activeVoicePlayerId = messageId;
            activeVoicePlaybackStatus = 'playing';
            updateVoicePlayerButton(messageId, 'playing');
        }

        function markVoicePlaybackStarted(messageId, durationSeconds = 0) {
            // 用户可能在音频真正产出前就点了暂停，启动回调不能把它强行切回播放。
            if (String(activeVoicePlayerId) === String(messageId) && activeVoicePlaybackStatus === 'paused') {
                updateVoicePlayerButton(messageId, 'paused');
                if (_audioContext && _audioContext.state === 'running') _audioContext.suspend().catch(() => {});
                if ('speechSynthesis' in window && window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
                    window.speechSynthesis.pause();
                }
                return;
            }
            setVoicePlaybackState(messageId, true, durationSeconds);
        }

        async function toggleVoicePlayback(messageId) {
            if (String(activeVoicePlayerId) !== String(messageId)) return false;
            if (activeVoicePlaybackStatus === 'loading') {
                console.log('[TTS] 语音仍在生成，点击复用当前任务');
                return true;
            }
            if (activeVoicePlaybackStatus === 'playing') {
                activeVoicePlaybackStatus = 'paused';
                updateVoicePlayerButton(messageId, 'paused');
                if (_audioContext && _audioContext.state === 'running') await _audioContext.suspend().catch(() => {});
                if ('speechSynthesis' in window && window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
                    window.speechSynthesis.pause();
                }
                return true;
            }
            if (activeVoicePlaybackStatus === 'paused') {
                if (_audioContext && _audioContext.state === 'suspended') await _audioContext.resume().catch(() => {});
                if ('speechSynthesis' in window && window.speechSynthesis.paused) window.speechSynthesis.resume();
                activeVoicePlaybackStatus = 'playing';
                updateVoicePlayerButton(messageId, 'playing');
                return true;
            }
            return false;
        }

        async function stopActiveVoicePlayback(invalidatePendingStart = true) {
            if (invalidatePendingStart) voicePlaybackStartGeneration += 1;
            const previousId = activeVoicePlayerId;
            const previousSession = activeVoiceSession;
            voicePlaybackGeneration += 1;
            activeVoiceSession = null;
            if (previousSession) {
                previousSession.cancelled = true;
                if (previousSession.resolveCancel) previousSession.resolveCancel({ cancelled: true });
                if (previousSession.abortController) previousSession.abortController.abort();
                if (previousSession.webSocket) {
                    try { previousSession.webSocket.close(1000, 'cancelled'); } catch (e) { /* 已关闭的连接无需处理 */ }
                }
                previousSession.audioSources.forEach(source => {
                    try { source.stop(); } catch (e) { /* 音频源可能已经结束 */ }
                    try { source.disconnect(); } catch (e) { /* 已断开的音频源无需处理 */ }
                });
                previousSession.audioSources.clear();
            }
            activeTtsTasks.clear();
            if (previousId != null) setVoicePlaybackState(previousId, false);
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            const previousContext = _audioContext;
            _audioContext = null;
            if (previousContext && previousContext.state !== 'closed') {
                try { await previousContext.close(); } catch (e) { /* 已结束的上下文无需处理 */ }
            }
        }

        async function startExclusiveVoicePlayback(messageId, text, onStart, options = {}) {
            const startGeneration = ++voicePlaybackStartGeneration;
            await stopActiveVoicePlayback(false);
            if (startGeneration !== voicePlaybackStartGeneration) return { cancelled: true };
            const session = createVoiceSession(messageId);
            if (startGeneration !== voicePlaybackStartGeneration || !isVoiceSessionActive(session)) return { cancelled: true };
            setVoicePlaybackLoading(messageId);
            return speakText(text, onStart, { ...options, messageId, session });
        }

        function startVoicePlaybackOnce(messageId, text, onStart, options = {}) {
            const messageKey = String(messageId);
            const existingTask = voicePlaybackTasksByMessageId.get(messageKey);
            if (existingTask) {
                console.log('[TTS] 复用同一消息正在进行的播放任务');
                return existingTask;
            }
            const task = startExclusiveVoicePlayback(messageId, text, onStart, options);
            voicePlaybackTasksByMessageId.set(messageKey, task);
            const clearTask = () => {
                if (voicePlaybackTasksByMessageId.get(messageKey) === task) {
                    voicePlaybackTasksByMessageId.delete(messageKey);
                }
            };
            task.then(clearTask, clearTask);
            return task;
        }

        function renderMessage(message) {
            const div = document.createElement('div');
            div.id = `msg-${message.id}`;
            div.className = `message-item ${message.role === 'user' ? 'message-item-user' : 'message-item-ai'} animate-fade-in-up`;

            if (message.role === 'user') {
                const userImageUrl = isSafeComposerImageDataUrl(message.imageDataUrl) ? message.imageDataUrl : '';
                div.innerHTML = `
                    <div class="flex gap-3 mb-4 group">
                        <div class="flex-1">
                            <div class="bubble-user rounded-2xl p-4">
                                <div class="flex items-center gap-2 mb-2">
                                    <span class="text-xs font-medium text-indigo-500">You</span>
                                    <span class="text-xs text-indigo-300">${message.timestamp}</span>
                                    <button onclick="event.stopPropagation(); handleMessageFavoriteClick('${message.id}')"
                                            class="message-action-btn ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-all flex items-center gap-1 ${isMessageFavorited(state.currentConversationId, message.id) ? 'text-amber-500' : 'text-indigo-300 hover:text-amber-500'}">
                                        <svg class="w-3.5 h-3.5" fill="${isMessageFavorited(state.currentConversationId, message.id) ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                            <path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                                        </svg>
                                        <span class="text-xs font-medium">${isMessageFavorited(state.currentConversationId, message.id) ? '已收藏' : '收藏'}</span>
                                    </button>
                                </div>
                                ${userImageUrl ? `<img class="message-image" src="${userImageUrl}" alt="${escapeHtml(message.imageName || '用户发送的图片')}">` : ''}
                                ${message.text ? `<p class="text-indigo-800 text-sm leading-relaxed whitespace-pre-wrap">${escapeHtml(message.text)}</p>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            } else if (message.role === 'system') {
                div.innerHTML = `
                    <div class="flex justify-center mb-4">
                        <div class="text-[11px] text-indigo-400 bg-white/40 border border-white/50 rounded-full px-3 py-1 max-w-[90%] text-center">${escapeHtml(message.text)}</div>
                    </div>`;
            } else {
                const faved = isMessageFavorited(state.currentConversationId, message.id);
                const name = state.characterCard.name || '伊蕾娜';
                const voiceDurationSeconds = estimateVoiceDurationSeconds(message.voiceJp || message.text);
                const voiceCard = `
                                <div class="ai-voice-card">
                                    <button id="voice-player-${message.id}" onclick="event.stopPropagation(); replayAIMessage('${message.id}')" class="ai-voice-player" type="button" aria-label="播放伊蕾娜的语音">
                                        <span class="voice-play-box" aria-hidden="true">
                                            <svg class="voice-icon-play" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8v10.4L13 8 4 2.8z"/></svg>
                                            <svg class="voice-icon-pause" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>
                                        </span>
                                        <span class="voice-duration">${formatVoiceDuration(voiceDurationSeconds)}</span>
                                        <span class="voice-waveform" aria-hidden="true">${voiceWaveformMarkup()}</span>
                                    </button>
                                </div>`;
                div.innerHTML = `
                    <div class="flex gap-3 mb-4 group">
                        <div class="flex-1">
                            <div class="bubble-ai rounded-2xl p-4">
                                <div class="flex items-center gap-2 mb-2">
                                    <span class="ai-speaker-name">${escapeHtml(name)}</span>
                                    <span class="text-xs text-indigo-300">${message.timestamp}</span>
                                    <button onclick="event.stopPropagation(); handleMessageFavoriteClick('${message.id}')"
                                            class="message-action-btn ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-all flex items-center gap-1 ${faved ? 'text-amber-500' : 'text-indigo-300 hover:text-amber-500'}">
                                        <svg class="w-3.5 h-3.5" fill="${faved ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                            <path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                                        </svg>
                                        <span class="text-xs font-medium">${faved ? '已收藏' : '收藏'}</span>
                                    </button>
                                </div>
                                <p class="text-indigo-950 text-sm leading-relaxed whitespace-pre-wrap">${escapeHtml(message.text)}</p>
                                ${voiceCard}
                            </div>
                        </div>
                    </div>
                `;
            }
            // 附加多选标记圆点
            const selectMark = document.createElement('span');
            selectMark.className = 'message-select-mark';
            selectMark.textContent = '✓';
            div.appendChild(selectMark);

            elements.conversationHistory.appendChild(div);
            elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;

            // 附加消息交互（长按菜单 / 多选 / 桌面右键）
            if (messageSelection.active) {
                div.classList.add('is-multi-selectable');
                div.classList.toggle('is-selected', messageSelection.selectedIds.has(String(message.id)));
            }
            attachMessageInteractions(div, message.id);

            return div;
        }

        async function replayAIMessage(messageId) {
            const voiceMessageKey = String(messageId);
            const existingPlaybackTask = voicePlaybackTasksByMessageId.get(voiceMessageKey);
            if (existingPlaybackTask && activeVoicePlaybackStatus === 'loading') {
                console.log('[TTS] 自动语音尚未返回，手动点击复用当前请求');
                return;
            }
            if (await toggleVoicePlayback(messageId)) return;
            if (existingPlaybackTask) {
                console.log('[TTS] 同一消息已有播放任务，忽略重复启动');
                return;
            }
            if (pendingAutomaticVoiceMessageIds.has(voiceMessageKey)) {
                console.log('[TTS] 自动语音仍在准备，忽略重复的手动播放请求');
                return;
            }
            const conv = state.conversations.find(c => c.id === state.currentConversationId);
            if (!conv) return;
            const msg = conv.messages.find(m => String(m.id) === String(messageId));
            if (!msg) return;
            const wantsJp = state.settings.ttsLang === 'japanese';
            let textToSpeak = msg.text;
            if (wantsJp) {
                try {
                    textToSpeak = await ensureJapaneseVoiceText(msg);
                    if (textToSpeak) saveConversations();
                } catch (error) {
                    console.error('[TTS] 手动播放的日语朗读稿生成失败:', error);
                    setVoicePlaybackState(messageId, false);
                    showClientApiError(error);
                    return;
                }
                if (!textToSpeak) {
                    setVoicePlaybackState(messageId, false);
                    showCustomAlert('未能生成日语朗读稿，本次不会回退播放中文。请稍后重试。', '日语语音生成失败');
                    return;
                }
            }
            const durationSeconds = estimateVoiceDurationSeconds(textToSpeak);
            startVoicePlaybackOnce(messageId, textToSpeak, () => {
                markVoicePlaybackStarted(messageId, durationSeconds);
            }, {
                cacheKey: buildMessageTtsCacheKey(msg, textToSpeak, conv.id),
                onEnd: () => setVoicePlaybackState(messageId, false)
            }).catch(error => {
                if (isVoiceCancellation(error)) return;
                console.error('[TTS] 缓存语音播放失败:', error);
                setVoicePlaybackState(messageId, false);
                showClientApiError(error);
            });
        }

        // ==================== 语音识别 ====================

        function initSpeechRecognition() {
            initBrowserSpeechRecognition();
        }

        function initBrowserSpeechRecognition() {
            if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return;
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            browserRecognition = new SpeechRecognition();
            browserRecognition.lang = 'zh-CN';
            browserRecognition.continuous = true;
            browserRecognition.interimResults = true;

            browserRecognition.onstart = () => {
                if (asrEnding || asrSubmitting) return;
                state.voiceState = 'listening';
                updateUI();
            };

            browserRecognition.onresult = (event) => {
                if (asrEnding || asrSubmitting) return;
                let allFinals = '';
                let latestInterim = '';
                for (let i = 0; i < event.results.length; i++) {
                    if (event.results[i].isFinal) {
                        allFinals += event.results[i][0].transcript + ' ';
                    } else if (i === event.results.length - 1) {
                        latestInterim = event.results[i][0].transcript;
                    }
                }
                handleTranscriptUpdate((allFinals + latestInterim).trim(), 'browser');
            };

            browserRecognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error);
                asrRecognitionActive = false;
                clearVoiceTimers();
                if (asrEnding || asrSubmitting) return;
                if (isBrowserSpeechPermissionError(event.error) && canUseCloudFinalAsr() && asrMediaStream) {
                    console.warn('[ASR] 浏览器实时识别被拒绝，继续录音并改用阿里最终识别');
                    asrMode = 'cloud-final-only';
                    state.voiceState = 'listening';
                    updateUI();
                    elements.statusText.textContent = '正在录音，点击麦克风结束后识别...';
                    return;
                }
                if (event.error !== 'aborted' && event.error !== 'no-speech') {
                    state.voiceState = 'error';
                    updateUI();
                    showCustomAlert('语音识别出错: ' + event.error, '语音识别错误');
                }
            };

            browserRecognition.onend = () => {
                asrRecognitionActive = false;
                if (asrEnding || asrSubmitting) return;
                if (silenceTimer) {
                    clearTimeout(silenceTimer);
                    silenceTimer = null;
                }
                const endedSessionId = asrSessionId;
                if ((asrMode === 'browser' || asrMode === 'browser-session' || asrMode === 'browser-cloud-final') && (state.voiceState === 'listening' || state.voiceState === 'paused')) {
                    setTimeout(() => {
                        if (endedSessionId === asrSessionId && !asrStarting && (asrMode === 'browser' || asrMode === 'browser-session' || asrMode === 'browser-cloud-final') && (state.voiceState === 'listening' || state.voiceState === 'paused')) {
                            try {
                                browserRecognition.start();
                                asrRecognitionActive = true;
                            } catch (e) {
                                console.warn('[Voice] 浏览器识别重启失败', e);
                                if (state.voiceState === 'listening') {
                                    state.voiceState = 'paused';
                                    updateUI();
                                }
                            }
                        }
                    }, 250);
                }
            };
        }

        function canUseCloudFinalAsr() {
            return (state.settings.asrProvider || 'browser') === 'aliyun' && Boolean(String(state.settings.dashscopeApiKey || '').trim());
        }

        function isLocalAudioAsrMode(mode = asrMode) {
            return mode === 'browser-session' || mode === 'browser-cloud-final' || mode === 'cloud-final-only';
        }

        function isBrowserSpeechPermissionError(error) {
            const text = String(error?.message || error?.name || error || '').toLowerCase();
            return text.includes('permission') ||
                text.includes('denied') ||
                text.includes('not-allowed') ||
                text.includes('not_allowed') ||
                text.includes('service-not-allowed');
        }

        function clearVoiceTimers() {
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
            if (pausedSubmitTimer) {
                clearTimeout(pausedSubmitTimer);
                pausedSubmitTimer = null;
            }
        }

        function scheduleVoicePause() {
            if (!currentTranscript.trim()) return;
            if (silenceTimer) clearTimeout(silenceTimer);
            if (pausedSubmitTimer) {
                clearTimeout(pausedSubmitTimer);
                pausedSubmitTimer = null;
            }

            silenceTimer = setTimeout(() => {
                if (currentTranscript.trim() && state.voiceState === 'listening') {
                    console.log('[Voice] 2s 停顿，切换到 paused 状态');
                    state.voiceState = 'paused';
                    updateUI();
                    pausedSubmitTimer = setTimeout(() => {
                        if (state.voiceState === 'paused' && currentTranscript.trim()) {
                            console.log('[Voice] paused 2.5s 仍无后续输入，自动提交transcript');
                            endListening();
                        }
                    }, ASR_AUTO_SUBMIT_DELAY_MS);
                }
            }, ASR_PAUSE_DELAY_MS);
        }

        function handleTranscriptUpdate(text, source = 'local') {
            currentTranscript = (text || '').trim();
            if (currentTranscript) {
                elements.statusText.textContent = '听到: ' + currentTranscript;
                lastSpeechTime = Date.now();
                if (state.voiceState === 'paused') {
                    state.voiceState = 'listening';
                    updateUI();
                }
                scheduleVoicePause();
            } else if (state.voiceState === 'listening') {
                elements.statusText.textContent = source === 'cloud' ? '云端识别中...' : '正在聆听...';
            }
        }

        function downsampleBuffer(input, inputSampleRate, outputSampleRate) {
            if (outputSampleRate === inputSampleRate) return input;
            const ratio = inputSampleRate / outputSampleRate;
            const outputLength = Math.max(1, Math.floor(input.length / ratio));
            const output = new Float32Array(outputLength);
            let inputOffset = 0;
            for (let i = 0; i < outputLength; i++) {
                const nextOffset = Math.round((i + 1) * ratio);
                let sum = 0;
                let count = 0;
                for (let j = inputOffset; j < nextOffset && j < input.length; j++) {
                    sum += input[j];
                    count++;
                }
                output[i] = count > 0 ? sum / count : 0;
                inputOffset = nextOffset;
            }
            return output;
        }

        function resetRecordedAudio() {
            asrRecordedChunks = [];
            asrRecordedSampleCount = 0;
            asrRecordedSquareSum = 0;
            asrRecordedPeak = 0;
            asrRecordedActiveSamples = 0;
        }

        function rememberAsrAudio(samples) {
            if (!samples?.length) return;
            const maxSamples = ASR_TARGET_SAMPLE_RATE * ASR_MAX_RECORD_SECONDS;
            if (asrRecordedSampleCount >= maxSamples) return;
            const available = maxSamples - asrRecordedSampleCount;
            const chunk = samples.length > available ? samples.slice(0, available) : new Float32Array(samples);
            asrRecordedChunks.push(chunk);
            asrRecordedSampleCount += chunk.length;
            for (let i = 0; i < chunk.length; i++) {
                const value = chunk[i];
                const abs = Math.abs(value);
                asrRecordedSquareSum += value * value;
                if (abs > asrRecordedPeak) asrRecordedPeak = abs;
                if (abs > 0.01) asrRecordedActiveSamples++;
            }
        }

        function getRecordedAsrAudio() {
            if (!asrRecordedSampleCount) return null;
            const merged = new Float32Array(asrRecordedSampleCount);
            let offset = 0;
            for (const chunk of asrRecordedChunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
            }
            return merged;
        }

        function getRecordedAsrStats() {
            const samples = asrRecordedSampleCount;
            return {
                samples,
                seconds: samples / ASR_TARGET_SAMPLE_RATE,
                rms: samples > 0 ? Math.sqrt(asrRecordedSquareSum / samples) : 0,
                peak: asrRecordedPeak,
                activeRatio: samples > 0 ? asrRecordedActiveSamples / samples : 0
            };
        }

        function float32ToWavBase64(samples, sampleRate) {
            const wav = new ArrayBuffer(44 + samples.length * 2);
            const view = new DataView(wav);
            const writeText = (offset, text) => {
                for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
            };
            writeText(0, 'RIFF');
            view.setUint32(4, 36 + samples.length * 2, true);
            writeText(8, 'WAVE');
            writeText(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            writeText(36, 'data');
            view.setUint32(40, samples.length * 2, true);
            for (let index = 0; index < samples.length; index++) {
                const sample = Math.max(-1, Math.min(1, samples[index]));
                view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            }
            const bytes = new Uint8Array(wav);
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 0x8000) {
                binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
            }
            return btoa(binary);
        }

        function normalizeAsrTextForGuard(text) {
            return String(text || '')
                .trim()
                .toLowerCase()
                .replace(/[，。！？；：、]/g, '.')
                .replace(/\s+/g, ' ')
                .replace(/\s+([,.!?;:])/g, '$1');
        }

        function isBadCloudFinalText(text, fallbackTranscript) {
            const normalized = normalizeAsrTextForGuard(text);
            if (!normalized) return true;
            if (ASR_BAD_FINAL_TEXTS.has(normalized)) return true;
            if (/^[.。]+$/.test(normalized)) return true;
            if (fallbackTranscript && normalized.length <= 2 && normalizeAsrTextForGuard(fallbackTranscript).length > normalized.length) return true;
            return false;
        }

        async function fetchWithTimeout(url, options, timeoutMs) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const externalSignal = options?.signal;
            const abortFromExternal = () => controller.abort();
            if (externalSignal) {
                if (externalSignal.aborted) controller.abort();
                else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
            }
            try {
                return await fetch(url, { ...options, signal: controller.signal });
            } finally {
                clearTimeout(timer);
                if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
            }
        }

        async function transcribeRecordedAudioWithCloud() {
            const audio = getRecordedAsrAudio();
            if (!audio || audio.length < ASR_TARGET_SAMPLE_RATE * 0.15) {
                console.warn('[ASR] 跳过阿里最终识别：录音太短或没有录到音频');
                return '';
            }

            const stats = getRecordedAsrStats();
            if (stats.rms < ASR_MIN_RMS || stats.activeRatio < ASR_MIN_ACTIVE_RATIO) {
                console.warn('[ASR] 跳过阿里最终识别：录音能量过低');
                return '';
            }

            const dashscopeApiKey = String(state.settings.dashscopeApiKey || '').trim();
            if (!dashscopeApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 DashScope API Key');
            const startedAt = performance.now();
            const result = await postJsonFromDevice(DASHSCOPE_SYNC_URL, {
                model: 'qwen3-asr-flash',
                input: {
                    messages: [{
                        role: 'user',
                        content: [{ audio: `data:audio/wav;base64,${float32ToWavBase64(audio, ASR_TARGET_SAMPLE_RATE)}` }]
                    }]
                },
                parameters: { asr_options: { language: 'zh', enable_itn: true } }
            }, {
                Authorization: `Bearer ${dashscopeApiKey}`,
                'X-DashScope-DataInspection': 'enable'
            }, ASR_CLOUD_FINAL_TIMEOUT_MS);
            if (!result.ok) await throwProviderResponseError(result, '阿里百炼语音识别失败');
            const content = result.payload?.choices?.[0]?.message?.content ?? result.payload?.output?.text;
            const text = Array.isArray(content) ? content.map(part => part?.text || '').join(' ') : String(content || '');
            console.info(`[ASR] 阿里百炼完成: ${Math.round(performance.now() - startedAt)}ms`);
            return text.trim();
        }

        async function startBrowserRecognitionSession() {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('当前浏览器不支持语音采集');
            }
            if (!browserRecognition && !canUseCloudFinalAsr()) {
                throw new Error('当前浏览器不支持实时语音预览');
            }

            currentTranscript = '';
            resetRecordedAudio();
            asrEnding = false;
            asrReady = false;
            state.voiceState = 'listening';
            updateUI();
            elements.statusText.textContent = '正在聆听...';

            asrMediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            asrAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (asrAudioContext.state === 'suspended') {
                await asrAudioContext.resume();
            }
            asrSourceNode = asrAudioContext.createMediaStreamSource(asrMediaStream);
            asrProcessorNode = asrAudioContext.createScriptProcessor(4096, 1, 1);
            asrProcessorNode.onaudioprocess = (event) => {
                if (asrEnding) return;
                const input = event.inputBuffer.getChannelData(0);
                const samples = downsampleBuffer(input, asrAudioContext.sampleRate, ASR_TARGET_SAMPLE_RATE);
                rememberAsrAudio(samples);
            };
            asrSourceNode.connect(asrProcessorNode);
            const silentGain = asrAudioContext.createGain();
            silentGain.gain.value = 0;
            asrProcessorNode.connect(silentGain);
            silentGain.connect(asrAudioContext.destination);

            asrMode = 'browser-session';
            asrReady = true;
            if (browserRecognition) {
                // 清理可能仍在运行的旧识别会话，避免 start() 抛
                // "Failed to execute 'start' ... recognition has already started"
                if (asrRecognitionActive) {
                    try { browserRecognition.abort(); } catch (e) { /* 已停止则忽略 */ }
                    try { browserRecognition.stop(); } catch (e) { /* 已停止则忽略 */ }
                    await new Promise(resolve => setTimeout(resolve, 150));
                    asrRecognitionActive = false;
                }
                try {
                    browserRecognition.start();
                    asrRecognitionActive = true;
                } catch (error) {
                    if (canUseCloudFinalAsr() && isBrowserSpeechPermissionError(error)) {
                        asrMode = 'cloud-final-only';
                        elements.statusText.textContent = '正在录音，点击麦克风结束后识别...';
                        return;
                    }
                    stopLocalAudioGraph();
                    throw error;
                }
            } else {
                asrMode = 'cloud-final-only';
                elements.statusText.textContent = '正在录音，点击麦克风结束后识别...';
            }
        }

        function stopLocalAudioGraph() {
            if (asrProcessorNode) {
                asrProcessorNode.disconnect();
                asrProcessorNode.onaudioprocess = null;
                asrProcessorNode = null;
            }
            if (asrSourceNode) {
                asrSourceNode.disconnect();
                asrSourceNode = null;
            }
            if (asrMediaStream) {
                asrMediaStream.getTracks().forEach(track => track.stop());
                asrMediaStream = null;
            }
            if (asrAudioContext) {
                asrAudioContext.close().catch(() => {});
                asrAudioContext = null;
            }
        }

        function closeLocalAsr(sendCancel = false) {
            stopLocalAudioGraph();
            asrReady = false;
            asrEnding = false;
            resetRecordedAudio();
        }

        function handleMicClick() {
            if (state.notesMode || state.diaryMode) return;
            if (state.voiceState === 'idle') {
                startListening().catch(error => {
                    console.error('[Voice] startListening failed:', error);
                    state.voiceState = 'error';
                    updateUI();
                    showCustomAlert('语音识别启动失败: ' + error.message, '语音识别错误');
                });
            } else {
                endListening().catch(error => {
                    console.error('[Voice] endListening failed:', error);
                    state.voiceState = 'error';
                    updateUI();
                });
            }
        }

        async function startListening() {
            if (asrSubmitting || asrStarting) {
                console.log('[ASR] 忽略重复 startListening 调用');
                return;
            }
            asrStarting = true;
            asrSessionId++;
            clearVoiceTimers();
            currentTranscript = '';

            if (!browserRecognition && !canUseCloudFinalAsr()) {
                asrStarting = false;
                showCustomAlert('当前浏览器不支持实时语音识别', '语音识别不可用');
                return;
            }

            try {
                await startBrowserRecognitionSession();
            } catch (error) {
                console.error('[ASR] 浏览器实时预览启动失败', error);
                state.voiceState = 'error';
                updateUI();
                showCustomAlert('语音识别启动失败: ' + error.message, '语音识别错误');
            } finally {
                asrStarting = false;
            }
        }

        async function endListening() {
            if (asrSubmitting) {
                console.log('[ASR] 忽略重复 endListening 调用');
                return;
            }
            asrSubmitting = true;
            clearVoiceTimers();
            asrEnding = true;
            const fallbackTranscript = currentTranscript.trim();
            let finalText = fallbackTranscript;
            const activeMode = asrMode;
            asrMode = 'submitting';
            state.voiceState = 'thinking';
            updateUI();

            try {
                if (isLocalAudioAsrMode(activeMode)) {
                    stopLocalAudioGraph();
                    if (browserRecognition && activeMode !== 'cloud-final-only') {
                        try {
                            browserRecognition.stop();
                        } catch (e) {
                            console.error('Failed to stop recognition:', e);
                        }
                    }
                    if (canUseCloudFinalAsr()) {
                        elements.statusText.textContent = '正在用阿里百炼识别...';
                        try {
                            const cloudText = await transcribeRecordedAudioWithCloud();
                            if (cloudText && !isBadCloudFinalText(cloudText, fallbackTranscript)) {
                                finalText = cloudText;
                                cloudFinalAsrAvailable = true;
                            } else {
                                console.warn('[ASR] 阿里百炼返回空或疑似无效文本，保留浏览器识别结果');
                            }
                        } catch (error) {
                            console.warn(`[ASR] 阿里百炼识别失败，保留浏览器识别结果：${error.message || error}`);
                            if (!fallbackTranscript) showClientApiError(error);
                        }
                    }
                    resetRecordedAudio();
                } else if (browserRecognition) {
                    try {
                        browserRecognition.stop();
                    } catch (e) {
                        console.error('Failed to stop recognition:', e);
                    }
                    finalText = currentTranscript.trim();
                }

                const text = finalText.trim();
                currentTranscript = '';

                if (text) {
                    processVoiceInput(text);
                } else {
                    state.voiceState = 'idle';
                    updateUI();
                    if (activeMode === 'cloud-final-only' || activeMode === 'browser-session' || activeMode === 'browser-cloud-final') {
                        elements.statusText.textContent = '没有识别到清晰语音，请重试';
                    }
                }
            } finally {
                asrEnding = false;
                asrSubmitting = false;
                if (state.voiceState === 'idle' || state.voiceState === 'thinking') {
                    asrMode = canUseCloudFinalAsr() ? 'cloud-final-only' : 'browser';
                }
            }
        }

        function cancelListening() {
            if (asrSubmitting) {
                console.log('[ASR] 忽略提交中的取消操作');
                return;
            }
            clearVoiceTimers();
            currentTranscript = '';
            if (isLocalAudioAsrMode()) {
                closeLocalAsr(true);
            } else if (browserRecognition) {
                try {
                    browserRecognition.stop();
                } catch (e) {
                    console.error('Failed to stop recognition:', e);
                }
            }
            state.voiceState = 'idle';
            updateUI();
        }

        function stopListening() {
            if (isLocalAudioAsrMode()) {
                closeLocalAsr(true);
                return;
            }
            if (browserRecognition) {
                try {
                    browserRecognition.stop();
                } catch (e) {
                    console.error('Failed to stop recognition:', e);
                }
            }
        }

        // ==================== 输入处理 ====================

        const recentSubmitKeys = new Map();
        const activeReplyTasks = new Set();
        const MAX_COMPOSER_IMAGE_SOURCE_BYTES = 12 * 1024 * 1024;
        const MAX_COMPOSER_IMAGE_DATA_URL_CHARS = 900000;
        let pendingComposerImage = null;
        let composerImageProcessing = false;

        function isSafeComposerImageDataUrl(value) {
            return /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(String(value || ''));
        }

        function renderPendingComposerImage() {
            const previews = [elements.initialComposerImagePreview, elements.composerImagePreview].filter(Boolean);
            previews.forEach(preview => {
                if (!pendingComposerImage || !isSafeComposerImageDataUrl(pendingComposerImage.dataUrl)) {
                    preview.classList.add('hidden');
                    preview.replaceChildren();
                    return;
                }
                const image = document.createElement('img');
                image.src = pendingComposerImage.dataUrl;
                image.alt = pendingComposerImage.name || '待发送图片';
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'composer-image-remove';
                remove.setAttribute('aria-label', '移除图片');
                remove.textContent = '×';
                remove.addEventListener('click', removePendingComposerImage);
                preview.replaceChildren(image, remove);
                preview.classList.remove('hidden');
            });
            updateComposerSendVisibility();
        }

        function removePendingComposerImage() {
            pendingComposerImage = null;
            if (elements.composerImageInput) elements.composerImageInput.value = '';
            renderPendingComposerImage();
        }

        function readImageFileAsDataUrl(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error('图片读取失败'));
                reader.readAsDataURL(file);
            });
        }

        function loadComposerImage(dataUrl) {
            return new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('无法解析这张图片'));
                image.src = dataUrl;
            });
        }

        async function compressComposerImage(file) {
            if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择图片文件');
            if (file.size > MAX_COMPOSER_IMAGE_SOURCE_BYTES) throw new Error('图片不能超过 12 MB');
            const source = await readImageFileAsDataUrl(file);
            const image = await loadComposerImage(source);
            let maxDimension = 1280;
            const qualities = [0.84, 0.76, 0.68, 0.58];
            for (const quality of qualities) {
                const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
                const width = Math.max(1, Math.round(image.naturalWidth * scale));
                const height = Math.max(1, Math.round(image.naturalHeight * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext('2d');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, width, height);
                context.drawImage(image, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (dataUrl.length <= MAX_COMPOSER_IMAGE_DATA_URL_CHARS) {
                    const previewScale = Math.min(1, 360 / Math.max(image.naturalWidth, image.naturalHeight));
                    const previewWidth = Math.max(1, Math.round(image.naturalWidth * previewScale));
                    const previewHeight = Math.max(1, Math.round(image.naturalHeight * previewScale));
                    const previewCanvas = document.createElement('canvas');
                    previewCanvas.width = previewWidth;
                    previewCanvas.height = previewHeight;
                    const previewContext = previewCanvas.getContext('2d');
                    previewContext.fillStyle = '#ffffff';
                    previewContext.fillRect(0, 0, previewWidth, previewHeight);
                    previewContext.drawImage(image, 0, 0, previewWidth, previewHeight);
                    return {
                        dataUrl,
                        previewDataUrl: previewCanvas.toDataURL('image/jpeg', 0.72),
                        name: file.name || 'image.jpg',
                        width,
                        height
                    };
                }
                maxDimension = Math.max(720, Math.round(maxDimension * 0.82));
            }
            throw new Error('图片压缩后仍然过大，请选择尺寸更小的图片');
        }

        function openComposerImagePicker() {
            closeComposerToolsMenu();
            if (!elements.composerImageInput) return;
            elements.composerImageInput.value = '';
            elements.composerImageInput.click();
        }

        function consumePendingComposerImage() {
            const image = pendingComposerImage;
            pendingComposerImage = null;
            if (elements.composerImageInput) elements.composerImageInput.value = '';
            renderPendingComposerImage();
            return image;
        }

        function attachComposerImageToMessage(message, image) {
            if (!image || !isSafeComposerImageDataUrl(image.dataUrl)) return message;
            message.imageDataUrl = isSafeComposerImageDataUrl(image.previewDataUrl) ? image.previewDataUrl : image.dataUrl;
            message.imageName = image.name || '';
            Object.defineProperty(message, 'imageRequestDataUrl', {
                value: image.dataUrl,
                configurable: true,
                enumerable: false
            });
            return message;
        }

        function claimMessageSubmission(text, channel = 'text') {
            const key = `${channel}:${String(text || '').trim()}`;
            const now = Date.now();
            const previous = recentSubmitKeys.get(key) || 0;
            if (now - previous < 900) return false;
            recentSubmitKeys.set(key, now);
            setTimeout(() => {
                if ((recentSubmitKeys.get(key) || 0) === now) recentSubmitKeys.delete(key);
            }, 1200);
            return true;
        }

        function setSendButtonVisibility(button, visible) {
            if (!button) return;
            button.classList.toggle('is-hidden', !visible);
            button.setAttribute('aria-hidden', visible ? 'false' : 'true');
            button.tabIndex = visible ? 0 : -1;
        }

        function updateComposerSendVisibility() {
            const hasContent = Boolean(pendingComposerImage);
            setSendButtonVisibility(elements.initialSendBtn, Boolean(elements.initialTextInput.value.trim()) || hasContent);
            setSendButtonVisibility(elements.conversationSendBtn, Boolean(elements.textInput.value.trim()) || hasContent);
            elements.initialSendBtn.disabled = composerImageProcessing;
            elements.conversationSendBtn.disabled = composerImageProcessing;
            elements.initialSendBtn.setAttribute('aria-busy', composerImageProcessing ? 'true' : 'false');
            elements.conversationSendBtn.setAttribute('aria-busy', composerImageProcessing ? 'true' : 'false');
        }

        function closeComposerToolsMenu() {
            [
                [elements.initialComposerMoreBtn, elements.initialComposerMoreMenu],
                [elements.composerMoreBtn, elements.composerMoreMenu]
            ].forEach(([button, menu]) => {
                if (!button || !menu) return;
                menu.classList.add('hidden');
                button.setAttribute('aria-expanded', 'false');
            });
        }

        function toggleComposerToolsMenu(button, menu, toggle) {
            const opening = menu.classList.contains('hidden');
            closeComposerToolsMenu();
            if (opening) {
                menu.classList.remove('hidden');
                button.setAttribute('aria-expanded', 'true');
                toggle.checked = Boolean(state.settings.thinkingMode);
            }
        }

        function syncComposerThinkingToggles(value) {
            elements.initialComposerThinkingToggle.checked = value;
            elements.composerThinkingToggle.checked = value;
        }

        function processVoiceInput(text) {
            if (composerImageProcessing) return;
            if (!text.trim()) return;
            if (!claimMessageSubmission(text, 'voice')) return;

            if (state.conversations.length === 0 || !state.currentConversationId) {
                elements.initialState.classList.add('hidden');
                createConversation();
            }

            const conversation = state.conversations.find(c => c.id === state.currentConversationId);
            if (!conversation) return;

            const image = consumePendingComposerImage();
            const message = attachComposerImageToMessage({
                id: generateId(),
                role: 'user',
                text: text,
                timestamp: new Date().toLocaleTimeString()
            }, image);

            conversation.messages.push(message);

            state.thinkingMessageId = message.id;

            loadConversation(conversation.id);

            if (conversation.messages.length === 1) {
                conversation.title = autoNameConversation(conversation.messages);
                renderFolderList();
                updateCurrentConversationTitle();
            }

            state.voiceState = 'thinking';
            updateUI();

            handleUserInput(message, conversation);
        }

        function handleInitialTextSubmit() {
            if (composerImageProcessing) return;
            if (state.notesMode || state.diaryMode) return;
            const text = document.getElementById('initialTextInput').value.trim();
            const image = pendingComposerImage;
            if (!text && !image) return;
            if (!claimMessageSubmission(text || image.dataUrl.slice(-96), 'text')) return;
            closeComposerToolsMenu();

            let conversation = state.conversations.find(c => c.id === state.currentConversationId);
            if (!conversation) {
                elements.initialState.classList.add('hidden');
                createConversation();
                conversation = state.conversations[0];
            }

            const message = attachComposerImageToMessage({
                id: generateId(),
                role: 'user',
                text: text,
                timestamp: new Date().toLocaleTimeString()
            }, image);

            conversation.messages.push(message);
            consumePendingComposerImage();
            document.getElementById('initialTextInput').value = '';
            updateComposerSendVisibility();
            loadConversation(conversation.id);

            if (conversation.messages.length === 1) {
                conversation.title = autoNameConversation(conversation.messages);
                renderFolderList();
                updateCurrentConversationTitle();
            }

            state.voiceState = 'thinking';
            updateUI();

            handleUserInput(message, conversation);
        }

        function handleTextSubmit() {
            if (composerImageProcessing) return;
            if (state.notesMode || state.diaryMode) return;
            const text = elements.textInput.value.trim();
            const image = pendingComposerImage;
            if (!text && !image) return;
            if (!claimMessageSubmission(text || image.dataUrl.slice(-96), 'text')) return;
            closeComposerToolsMenu();
            let conversation = state.conversations.find(c => c.id === state.currentConversationId);
            if (!conversation) {
                elements.initialState.classList.add('hidden');
                createConversation();
                conversation = state.conversations[0];
            }

            const message = attachComposerImageToMessage({
                id: generateId(),
                role: 'user',
                text: text,
                timestamp: new Date().toLocaleTimeString()
            }, image);

            conversation.messages.push(message);
            consumePendingComposerImage();

            state.thinkingMessageId = message.id;

            loadConversation(conversation.id);

            if (conversation.messages.length === 1) {
                conversation.title = autoNameConversation(conversation.messages);
                renderFolderList();
                updateCurrentConversationTitle();
            }

            state.voiceState = 'thinking';
            updateUI();

            handleUserInput(message, conversation);
            elements.textInput.value = '';
            updateComposerSendVisibility();
        }

        function isTtsConfigured(settings = state.settings) {
            const provider = String(settings.ttsProvider || 'minimax');
            if (provider === 'doubao') {
                const hasV3 = Boolean(String(settings.doubaoApiKey || '').trim());
                const hasV1 = Boolean(String(settings.doubaoAppId || '').trim() && String(settings.doubaoToken || '').trim());
                return (hasV3 || hasV1) && Boolean(String(settings.doubaoVoice || '').trim());
            }
            if (provider === 'dashscope') {
                return Boolean(String(settings.dashscopeApiKey || '').trim() && String(settings.dashscopeTtsVoice || '').trim());
            }
            return Boolean(String(settings.minimaxApiKey || '').trim() && String(settings.minimaxVoice || '').trim());
        }

        async function handleUserInput(message, conversation) {
            if (!conversation) {
                conversation = state.conversations.find(c => c.id === state.currentConversationId);
            }
            if (!conversation) return;
            const replyTaskKey = `${conversation.id}:${message.id}`;
            if (activeReplyTasks.has(replyTaskKey)) {
                console.log('[Chat] 忽略同一条用户消息的重复回复任务');
                return;
            }
            activeReplyTasks.add(replyTaskKey);
            hideContinueReplyButton();
            let automaticVoiceMessageKey = '';

            const t0 = performance.now();

            state.thinkingMessageId = message.id;
            renderThinkingMessage();

            try {
                const ttsConfigured = isTtsConfigured(state.settings);
                const wantsJp = ttsConfigured && state.settings.ttsLang === 'japanese';
                const aiRequestOptions = {
                    includeVoiceJp: wantsJp,
                    imageDataUrl: message.imageRequestDataUrl || message.imageDataUrl || ''
                };
                const rawResponse = await callAI(message.text, aiRequestOptions);
                const parsedReply = wantsJp ? splitVoiceReply(rawResponse) : { displayText: rawResponse, voiceJp: '' };
                const response = parsedReply.displayText;

                const t1 = performance.now();
                console.log(`[TIMING] 文字模型完成: ${Math.round(t1 - t0)}ms`);

                const aiMessage = {
                    id: generateId(),
                    role: 'ai',
                    text: response,
                    voiceJp: parsedReply.voiceJp,
                    timestamp: new Date().toLocaleTimeString()
                };
                automaticVoiceMessageKey = String(aiMessage.id);
                pendingAutomaticVoiceMessageIds.add(automaticVoiceMessageKey);

                let textToSpeak = wantsJp ? getJapaneseVoiceText(aiMessage) : response;
                const prepareVoiceText = async () => {
                    if (!wantsJp || textToSpeak) return;
                    try {
                        textToSpeak = await ensureJapaneseVoiceText(aiMessage);
                        if (textToSpeak) console.log('[TTS] 已生成仅含对白的日语朗读文本');
                        else console.warn('[TTS] 未能生成日语朗读稿，本轮不播放中文兜底');
                    } catch (error) {
                        textToSpeak = '';
                        console.warn('[TTS] 日语翻译失败，本轮不播放中文兜底:', error.message || error);
                    }
                };

                const presentationMode = state.settings.replyDisplayMode || DEFAULT_SETTINGS.replyDisplayMode;
                let voiceStarted = false;
                let messageCommitted = false;
                const commitAiMessageOnce = () => {
                    if (messageCommitted) return;
                    messageCommitted = true;
                    conversation.messages.push(aiMessage);
                    conversation.updatedAt = new Date().toISOString();
                    saveConversations();
                    renderFolderList();
                    updateCurrentConversationTitle();
                    removeThinkingMessage();
                    if (state.currentConversationId === conversation.id && !state.notesMode && !state.diaryMode && !document.getElementById(`msg-${aiMessage.id}`)) {
                        renderMessage(aiMessage);
                    }
                    maybeShowContinueReplyButton();
                    state.voiceState = 'idle';
                    updateUI();

                    if (state.settings.autoMemory) {
                        const userCount = conversation.messages.filter(m => m.role === 'user').length;
                        const every = Math.max(3, state.settings.memoryEvery || 6);
                        if (userCount % every === 0) {
                            console.log(`[记忆] 自动整理触发（第 ${userCount} 轮）`);
                            setTimeout(() => { requestMemorySummary(conversation.id); }, 800);
                        }
                    }
                };

                const handleVoiceStart = () => {
                    voiceStarted = true;
                    if (presentationMode === 'simultaneous') commitAiMessageOnce();
                    markVoicePlaybackStarted(aiMessage.id, estimateVoiceDurationSeconds(textToSpeak));
                };

                if (presentationMode === 'text-first') commitAiMessageOnce();

                if (!ttsConfigured) {
                    pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
                    commitAiMessageOnce();
                    return;
                }

                // Text-first mode commits above; Japanese preparation continues without
                // delaying the visible reply. Persist the late voice text for replay.
                await prepareVoiceText();
                if (messageCommitted && aiMessage.voiceJp) saveConversations();

                if (!textToSpeak) {
                    pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
                    if (presentationMode === 'simultaneous') {
                        removeThinkingMessage();
                        state.voiceState = 'error';
                        updateUI();
                        showCustomAlert('本次回复没有可播放的语音，因此未显示文本。', '语音生成失败');
                    }
                    return;
                }
                startVoicePlaybackOnce(aiMessage.id, textToSpeak, handleVoiceStart, {
                    cacheKey: buildMessageTtsCacheKey(aiMessage, textToSpeak, conversation.id),
                    onEnd: () => setVoicePlaybackState(aiMessage.id, false)
                }).then(result => {
                    if (result?.cancelled) return;
                    if (!voiceStarted) {
                        if (presentationMode === 'simultaneous') {
                            console.warn('[TTS] 没有收到可播放语音，同步模式不展示本次回复');
                            removeThinkingMessage();
                            state.voiceState = 'error';
                            updateUI();
                            showCustomAlert('本次语音未能生成，回复没有显示，请稍后重试。', '语音生成失败');
                        } else {
                            console.warn('[TTS] 语音未生成，但先文本后语音模式保留文字回复');
                            setVoicePlaybackState(aiMessage.id, false);
                            state.voiceState = 'idle';
                            updateUI();
                        }
                    }
                }).catch(error => {
                    if (isVoiceCancellation(error)) return;
                    console.error('[TTS] 自动语音播放失败:', error);
                    if (!voiceStarted && presentationMode === 'simultaneous') {
                        removeThinkingMessage();
                        state.voiceState = 'error';
                        updateUI();
                    }
                    if (presentationMode === 'text-first') {
                        setVoicePlaybackState(aiMessage.id, false);
                        state.voiceState = 'idle';
                        updateUI();
                    } else setVoicePlaybackState(aiMessage.id, false);
                    showClientApiError(error);
                }).finally(() => pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey));
            } catch (error) {
                if (automaticVoiceMessageKey) pendingAutomaticVoiceMessageIds.delete(automaticVoiceMessageKey);
                console.error('API Error:', error);
                removeThinkingMessage();
                state.voiceState = 'error';

                updateUI();
                showClientApiError(error);
            } finally {
                if (Object.prototype.hasOwnProperty.call(message, 'imageRequestDataUrl')) delete message.imageRequestDataUrl;
                activeReplyTasks.delete(replyTaskKey);
                maybeShowContinueReplyButton();
            }
        }

        // ==================== 主动回复（继续生成一条，2 分钟窗口） ====================
        const CONTINUE_REPLY_WINDOW_MS = 2 * 60 * 1000;
        let continueReplyTimer = null;
        function hasActiveReplyForConv(convId) {
            for (const k of activeReplyTasks) {
                if (k.indexOf(convId + ':') === 0) return true;
            }
            return false;
        }
        function hideContinueReplyButton() {
            const el = document.getElementById('continueReplyBtn');
            if (el) el.remove();
            if (continueReplyTimer) { window.clearTimeout(continueReplyTimer); continueReplyTimer = null; }
        }
        function maybeShowContinueReplyButton() {
            const conv = currentConv();
            const hist = elements.conversationHistory;
            if (!conv || !hist || hist.classList.contains('hidden') || state.notesMode || state.diaryMode || state.thinkingMessageId) { hideContinueReplyButton(); return; }
            if (hasActiveReplyForConv(conv.id)) { hideContinueReplyButton(); return; }
            const last = conv.messages[conv.messages.length - 1];
            if (!last || last.role !== 'ai') { hideContinueReplyButton(); return; }
            const lastAt = conv.updatedAt ? new Date(conv.updatedAt).getTime() : 0;
            const age = Date.now() - lastAt;
            if (!lastAt || age > CONTINUE_REPLY_WINDOW_MS) { hideContinueReplyButton(); return; }
            let btn = document.getElementById('continueReplyBtn');
            if (!btn) {
                btn = document.createElement('button');
                btn.id = 'continueReplyBtn';
                btn.type = 'button';
                btn.className = 'message-continue-btn';
                btn.textContent = '💬 让伊蕾娜继续回复一条';
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    hideContinueReplyButton();
                    continueReply(conv);
                });
                hist.appendChild(btn);
                hist.scrollTop = hist.scrollHeight;
            }
            if (continueReplyTimer) window.clearTimeout(continueReplyTimer);
            continueReplyTimer = window.setTimeout(() => {
                if (document.getElementById('continueReplyBtn')) hideContinueReplyButton();
            }, Math.max(0, CONTINUE_REPLY_WINDOW_MS - age));
        }
        function continueReply(conv) {
            if (!conv || !conv.id || hasActiveReplyForConv(conv.id)) { memShowToast('伊蕾娜正在回复中，请稍候…'); return; }
            memShowToast('已让伊蕾娜继续回复一条…');
            appLog('info', '主动回复-继续生成（对话 ' + conv.id + '）');
            const synthetic = {
                id: generateId(),
                role: 'user',
                text: '（请继续生成下一条回复：自然地延续当前对话，不要重复或总结已说的内容）',
                timestamp: new Date().toLocaleTimeString()
            };
            handleUserInput(synthetic, conv);
        }

        