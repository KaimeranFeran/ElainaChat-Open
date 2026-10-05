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
    /* 必须在 mousedown 就通知：C# 侧是"按住期间跟随光标搬窗口"，
       原来绑在 mouseup 上，等于松手之后才喊开始 —— 窗口纹丝不动，这就是「PC 桌宠无法拖动」的根因。 */
    strip.addEventListener('mousedown', function (ev) { ev.preventDefault(); notify(); });
    strip.addEventListener('touchstart', function (ev) { ev.preventDefault(); notify(); }, { passive: false });
    strip.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  })();

  /* ===== 安卓悬浮窗：输入焦点 + 拖拽桥接 ===== */
  try {
    const notifyPcInputFocus = function (focused) {
      try {
        if (window.chrome && window.chrome.webview) {
          window.chrome.webview.postMessage({ kind: 'input-focus', payload: !!focused });
        }
      } catch (e) {}
    };
    /* OCR M9：这里原来先用了尚未初始化的 const inputEl（第 123 行才声明），
       TDZ 直接抛 ReferenceError，被下面的 catch{} 吞掉 —— 结果整段安卓拖拽/输入焦点绑定全部失效。
       统一改用文件顶部的 input。 */
    if (input) {
      input.addEventListener('focus', function () { notifyPcInputFocus(true); });
      input.addEventListener('blur', function () { notifyPcInputFocus(false); });
      if (window.PetBridge && typeof window.PetBridge.setInputFocus === 'function') {
        input.addEventListener('focus', function () { try { window.PetBridge.setInputFocus(true); } catch (e) {} });
        input.addEventListener('blur', function () { try { window.PetBridge.setInputFocus(false); } catch (e) {} });
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
  let recStarting = false, recGeneration = 0;
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
    recGeneration += 1;
    recStarting = false;
    recActive = false;
    let btn = document.getElementById('petMic');
    if (btn) btn.classList.remove('rec');
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
    try { if (recNode) { recNode.disconnect(); recNode.onaudioprocess = null; } } catch (e) {}
    try { if (recStream) recStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (recCtx) recCtx.close().catch(function () {}); } catch (e) {}
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
    if (recStarting) { stopVoiceInput(false); return; }
    if (recActive) { stopVoiceInput(true); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showTip('当前环境不支持麦克风'); return; }
    const generation = ++recGeneration;
    recStarting = true;
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(async function (stream) {
        if (generation !== recGeneration) {
          stream.getTracks().forEach(function (track) { track.stop(); });
          return;
        }
        recStream = stream;
        recChunks = [];
        recCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (recCtx.state === 'suspended') await recCtx.resume();
        if (generation !== recGeneration) return;
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
        recStarting = false;
        let btn = document.getElementById('petMic');
        if (btn) btn.classList.add('rec');
        showTip('正在聆听… 再次点击结束并发送');
        recTimer = setTimeout(function () { if (recActive) stopVoiceInput(true); }, 60000);
      })
      .catch(function (e) {
        if (generation !== recGeneration) return;
        stopVoiceInput(false);
        showTip('麦克风不可用：' + (e && e.message ? e.message : '权限被拒绝'));
      });
  }
  try {
    let micBtn = document.getElementById('petMic');
    if (micBtn) micBtn.addEventListener('click', function (ev) { ev.stopPropagation(); startVoiceInput(); });
    window.addEventListener('pagehide', function () { stopVoiceInput(false); });
  } catch (e) {}

  /* 关闭桌宠（仅 PC 桌面）：必须走网页按钮，见 pet.html 里的说明 */
  try {
    let closeBtn = document.getElementById('petCloseBtn');
    if (closeBtn) {
      closeBtn.style.display = '';
      closeBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        try { if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage({ kind: 'pet-close' }); } catch (e) {}
      });
    }
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

/* ==================== 套壳原生 UI 守卫（右键菜单 / 文字选中） ====================
   这个 App 是 WebView 套壳：默认右键会弹出 Chromium 的原生菜单（"后退 / 重新加载 / 另存为…"），
   长按、拖选还能选中文字并弹出手柄 —— 它们都属于"网页"，不属于 App 的界面语言。
   规则：
     · contextmenu：默认全部吞掉。App 自己的自定义菜单（消息 / 会话 / 日记）在各自的处理器里
       preventDefault 后照常弹出，不受影响；确实需要原生菜单的元素标 data-native-menu="1" 放行。
     · selectstart / dragstart：禁止选中与图片拖拽；输入框、文本域、.selectable 例外，
       所以输入框里选字、复制粘贴都不受影响。
   WebView2 那侧还有一层 WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false 兜底。 */
(function installElainaNativeUiGuard() {
    if (window.__elainaNativeUiGuard) return;
    window.__elainaNativeUiGuard = true;

    var TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .selectable, [data-native-menu]';
    function isTextEntry(node) {
        if (!node || node.nodeType !== 1) return false;
        var tag = String(node.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (node.isContentEditable) return true;
        return !!(node.closest && node.closest(TEXT_ENTRY));
    }

    document.addEventListener('contextmenu', function (event) {
        var target = event.target;
        if (target && target.closest && target.closest('[data-native-menu]')) return;
        event.preventDefault();
    }, true);

    document.addEventListener('selectstart', function (event) {
        if (isTextEntry(event.target)) return;
        event.preventDefault();
    }, true);

    document.addEventListener('dragstart', function (event) {
        if (isTextEntry(event.target)) return;
        event.preventDefault();
    }, true);
})();
