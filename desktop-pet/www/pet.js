/* Elaina Pet：LingChat 风格三段式（深色玻璃气泡 + 静态立绘 + 输入） */
(function () {
  'use strict';
  let scroller = document.getElementById('bubbleScroller');
  let input = document.getElementById('petInput');
  let sendBtn = document.getElementById('petSend');
  let typeTimer = null;

  /* ===== 伊蕾娜表情系统（回复情绪词 → 切换立绘） ===== */
  let EMOTIONS = (window.ElainaEmotion && window.ElainaEmotion.labels)
    ? window.ElainaEmotion.labels()
    : { calm: '平静' };
  let avatar = document.getElementById('petAvatar');
  let emoTimer = null;
  function setEmotion(key) {
    if (!avatar || !EMOTIONS[key]) return;
    avatar.src = 'img/elaina/p_' + key + '.png';
    avatar.classList.remove('emo-swap');
    void avatar.offsetWidth;
    avatar.classList.add('emo-swap');
    if (emoTimer) clearTimeout(emoTimer);
    emoTimer = setTimeout(function () { setEmotion('calm'); }, 4200);
  }
  function emotionFromText(text) {
    /* OCR M3：统一走 ElainaEmotion（与 Galgame 表情一致） */
    try { if (window.ElainaEmotion) return window.ElainaEmotion.from(text); } catch (e) {}
    return null;
  }

  /* 桥：安卓 PetBridge / PC chrome.webview */
  function toNative(kind, payload) {
    try {
      if (window.PetBridge) { window.PetBridge.sendMessage(payload); }
      else if (window.chrome && window.chrome.webview) { window.chrome.webview.postMessage({ kind: kind, payload: payload }); }
    } catch (e) {}
  }

  function addBubble(text, who) {
    let div = document.createElement('div');
    div.className = 'pet-bubble ' + who;
    let speak = document.createElement('div');
    speak.className = 'pet-speak';
    speak.textContent = who === 'me' ? '你' : '伊蕾娜';
    let msg = document.createElement('div');
    msg.className = 'pet-msg';
    msg.textContent = text;
    div.appendChild(speak);
    div.appendChild(msg);
    scroller.appendChild(div);
    scroller.scrollTop = scroller.scrollHeight;
    return { div: div, msg: msg };
  }
  function typewrite(div, text) {
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    let i = 0;
    div.textContent = '';
    typeTimer = setInterval(function () {
      i += 2;
      div.textContent = text.slice(0, i);
      scroller.scrollTop = scroller.scrollHeight;
      if (i >= text.length) { clearInterval(typeTimer); typeTimer = null; }
    }, 24);
  }

  function send() {
    let v = input.value.trim();
    if (!v) return;
    addBubble(v, 'me');
    input.value = '';
    toNative('send', v);
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') send(); });

  window.PetOnReply = function (text) {
    let b = addBubble(String(text), 'bot');
    typewrite(b.msg, String(text));
    let emo = emotionFromText(text);
    if (emo) setEmotion(emo);
  };

  function showTip(msg) {
    let tip = document.getElementById('statusTip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'statusTip'; document.body.appendChild(tip); }
    tip.textContent = msg;
    tip.classList.add('show');
    setTimeout(function () { tip.classList.remove('show'); }, 2600);
  }
  window.PetShowTip = showTip;

  /* PC 拖拽（仅无 PetBridge 时生效，避免与安卓桥双绑定 —— OCR 二轮 N1） */
  (function bindPcDrag() {
    if (window.PetBridge && typeof window.PetBridge.startDrag === 'function') return;
    const strip = document.getElementById('dragStrip');
    if (!strip) return;
    const notify = function () {
      try { if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage({ kind: 'drag' }); } catch (e) {}
    };
    strip.addEventListener('mouseup', notify);
    strip.addEventListener('touchend', function (ev) { ev.preventDefault(); notify(); }, { passive: false });
    strip.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  })();

  /* ===== 安卓悬浮窗：输入焦点 + 拖拽桥接 ===== */
  try {
    const inputEl = document.getElementById('petInput');
    const notifyPcInputFocus = function (focused) {
      try {
        if (window.chrome && window.chrome.webview) {
          window.chrome.webview.postMessage({ kind: 'input-focus', payload: !!focused });
        }
      } catch (e) {}
    };
    if (inputEl) {
      inputEl.addEventListener('focus', function () { notifyPcInputFocus(true); });
      inputEl.addEventListener('blur', function () { notifyPcInputFocus(false); });
    }
    if (inputEl && window.PetBridge) {
      if (typeof window.PetBridge.setInputFocus === 'function') {
        inputEl.addEventListener('focus', function () { try { window.PetBridge.setInputFocus(true); } catch (e) {} });
        inputEl.addEventListener('blur', function () { try { window.PetBridge.setInputFocus(false); } catch (e) {} });
      }
    }
    const dragEl = document.getElementById('dragStrip') || document.getElementById('petDrag') || document.querySelector('.pet-drag');
    if (dragEl && window.PetBridge && typeof window.PetBridge.startDrag === 'function') {
      dragEl.addEventListener('touchstart', function () { try { window.PetBridge.startDrag(); } catch (e) {} }, { passive: true });
      dragEl.addEventListener('touchend', function () { try { window.PetBridge.endDrag && window.PetBridge.endDrag(); } catch (e) {} }, { passive: true });
      dragEl.addEventListener('touchcancel', function () { try { window.PetBridge.endDrag && window.PetBridge.endDrag(); } catch (e) {} }, { passive: true });
      dragEl.addEventListener('mousedown', function () { try { window.PetBridge.startDrag(); } catch (e) {} });
      dragEl.addEventListener('mouseup', function () { try { window.PetBridge.endDrag && window.PetBridge.endDrag(); } catch (e) {} });
    }
  } catch (e) {}

  /* ===== 语音输入（与主界面同链路：麦克风→16k float32→网关 ASR→填入并发送） ===== */
  let recCtx = null, recStream = null, recNode = null, recChunks = [], recActive = false, recTimer = null;
  function ggCfg() {
    let cfg = { baseUrl: '', apiKey: '' };
    try {
      if (window.PetBridge && typeof window.PetBridge.getConfig === 'function') {
        let raw = window.PetBridge.getConfig();
        let o = JSON.parse(raw || '{}');
        cfg.baseUrl = o.baseUrl || ''; cfg.apiKey = o.apiKey || '';
      }
    } catch (e) {}
    if (!cfg.baseUrl) {
      try {
        let st = JSON.parse(localStorage.getItem('elaina_settings') || '{}');
        cfg.baseUrl = st.baseUrl || ''; cfg.apiKey = st.apiKey || '';
      } catch (e) {}
    }
    /* PC 桌面：file:// 直连网关会被 CORS 拦，改走内置本地代理 */
    try { if (window.chrome && window.chrome.webview) cfg.baseUrl = 'http://127.0.0.1:3500'; } catch (e) {}
    return cfg;
  }
  function downsample(input, inRate, outRate) {
    if (outRate === inRate) return input;
    let ratio = inRate / outRate;
    let len = Math.max(1, Math.floor(input.length / ratio));
    let out = new Float32Array(len);
    let off = 0;
    for (let i = 0; i < len; i++) {
      let next = Math.round((i + 1) * ratio);
      let sum = 0, n = 0;
      for (let k = off; k < next && k < input.length; k++) { sum += input[k]; n++; }
      out[i] = n > 0 ? sum / n : 0;
      off = next;
    }
    return out;
  }
  function mergeChunks(chunks) {
    let total = 0;
    chunks.forEach(function (c) { total += c.length; });
    let merged = new Float32Array(total), off = 0;
    chunks.forEach(function (c) { merged.set(c, off); off += c.length; });
    return merged;
  }
  function stopVoiceInput(sendIt) {
    recActive = false;
    let btn = document.getElementById('petMic');
    if (btn) btn.classList.remove('rec');
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
    try { if (recNode) { recNode.disconnect(); recNode.onaudioprocess = null; } } catch (e) {}
    try { if (recStream) recStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (recCtx) recCtx.close(); } catch (e) {}
    recNode = null; recStream = null; recCtx = null;
    if (!sendIt) { recChunks = []; return; }
    let pcm = mergeChunks(recChunks);
    recChunks = [];
    if (pcm.length < 16000 * 0.15) { showTip('录音太短，请再说一次'); return; }
    asrUpload(pcm);
  }
  function asrUpload(pcm) {
    let cfg = ggCfg();
    if (!cfg.baseUrl) { showTip('请先在设置里填写服务地址'); return; }
    if (!cfg.apiKey) { showTip('请先在设置里填写使用 Key'); return; }
    showTip('正在识别…');
    fetch(cfg.baseUrl + '/api/asr-cloud-final', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': 'Bearer ' + cfg.apiKey,
        'X-ASR-Sample-Rate': '16000',
        'X-ASR-Format': 'float32le'
      },
      body: pcm.buffer
    }).then(function (r) { return r.json().catch(function () { return null; }).then(function (p) { return { ok: r.ok, p: p }; }); })
      .then(function (res) {
        let text = res.p && res.p.text ? String(res.p.text).trim() : '';
        if (!res.ok || !text) { showTip('识别失败：' + ((res.p && (res.p.message || res.p.error)) || '请重试')); return; }
        if (input) input.value = text;
        showTip('识别完成，正在发送…');
        send();
      })
      .catch(function (e) { showTip('识别请求失败：' + (e && e.message ? e.message : '网络错误')); });
  }
  function startVoiceInput() {
    if (recActive) { stopVoiceInput(true); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showTip('当前环境不支持麦克风'); return; }
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        recStream = stream;
        recChunks = [];
        recCtx = new (window.AudioContext || window.webkitAudioContext)();
        let src = recCtx.createMediaStreamSource(stream);
        recNode = recCtx.createScriptProcessor(4096, 1, 1);
        recNode.onaudioprocess = function (ev) {
          if (!recActive) return;
          let ch = ev.inputBuffer.getChannelData(0);
          let copy = new Float32Array(ch.length);
          copy.set(ch);
          recChunks.push(downsample(copy, recCtx.sampleRate, 16000));
        };
        src.connect(recNode);
        recNode.connect(recCtx.destination);
        recActive = true;
        let btn = document.getElementById('petMic');
        if (btn) btn.classList.add('rec');
        showTip('正在聆听… 再次点击结束并发送');
        recTimer = setTimeout(function () { if (recActive) stopVoiceInput(true); }, 60000);
      })
      .catch(function (e) { showTip('麦克风不可用：' + (e && e.message ? e.message : '权限被拒绝')); });
  }
  try {
    let micBtn = document.getElementById('petMic');
    if (micBtn) micBtn.addEventListener('click', function (ev) { ev.stopPropagation(); startVoiceInput(); });
  } catch (e) {}

  /* 返回主界面（仅 PC 桌面） */
  try {
    let backBtn = document.getElementById('petBackBtn');
    let isPc = window.chrome && window.chrome.webview;
    let isAndroid = window.PetBridge && typeof window.PetBridge.openApp === 'function';
    if (backBtn) {
      backBtn.style.display = '';
      backBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        try { if (isPc) window.chrome.webview.postMessage({ kind: 'pet-back' }); } catch (e) {}
        try { if (isAndroid) window.PetBridge.openApp(); } catch (e) {}
      });
    }
  } catch (e) {}

  /* PC C# 回调 */
  if (window.chrome && window.chrome.webview && window.chrome.webview.addEventListener) {
    window.chrome.webview.addEventListener('message', function (ev) {
      let d = ev.data || {};
      if (d.kind === 'pet-reply') window.PetOnReply(d.payload || d.text || '');
      if (d.kind === 'tip') showTip(d.payload || '');
    });
  }

  setTimeout(function () {
    let hb = document.getElementById('helloBubble');
    if (hb) hb.style.display = '';
  }, 600);
})();
