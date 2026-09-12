/* Elaina Pet：LingChat 风格三段式（深色玻璃气泡 + 静态立绘 + 输入） */
(function () {
  'use strict';
  var scroller = document.getElementById('bubbleScroller');
  var input = document.getElementById('petInput');
  var sendBtn = document.getElementById('petSend');
  var typeTimer = null;

  /* ===== 伊蕾娜表情系统（回复情绪词 → 切换立绘） ===== */
  var EMOTIONS = {
    smirk: '坏笑', shy: '害羞', calm: '平静', surprised: '惊讶', resigned: '无奈',
    speechless: '无语', angry: '生气', confused: '疑惑', happy: '高兴'
  };
  var avatar = document.getElementById('petAvatar');
  var emoTimer = null;
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
    var t = String(text || '');
    if (/微笑|开心|高兴|嘿嘿|哈哈|愉快|开心|喜悦/ .test(t)) return 'happy';
    if (/生气|哼|愤怒|恼火|气死/.test(t)) return 'angry';
    if (/疑惑|奇怪|嗯？|？$/m.test(t) || /\?\s*$/.test(t)) return 'confused';
    if (/害羞|脸红|唔|呜/.test(t)) return 'shy';
    if (/惊讶|！|吃惊|诶|哎/.test(t)) return 'surprised';
    if (/无奈|叹气|唉/.test(t)) return 'resigned';
    if (/无语|真是的|服了/.test(t)) return 'speechless';
    if (/坏笑|偷|狡黠|得意/.test(t)) return 'smirk';
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
    var div = document.createElement('div');
    div.className = 'pet-bubble ' + who;
    var speak = document.createElement('div');
    speak.className = 'pet-speak';
    speak.textContent = who === 'me' ? '你' : '伊蕾娜';
    var msg = document.createElement('div');
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
    var i = 0;
    div.textContent = '';
    typeTimer = setInterval(function () {
      i += 2;
      div.textContent = text.slice(0, i);
      scroller.scrollTop = scroller.scrollHeight;
      if (i >= text.length) { clearInterval(typeTimer); typeTimer = null; }
    }, 24);
  }

  function send() {
    var v = input.value.trim();
    if (!v) return;
    addBubble(v, 'me');
    input.value = '';
    toNative('send', v);
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') send(); });

  window.PetOnReply = function (text) {
    var b = addBubble(String(text), 'bot');
    typewrite(b.msg, String(text));
    var emo = emotionFromText(text);
    if (emo) setEmotion(emo);
  };

  function showTip(msg) {
    var tip = document.getElementById('statusTip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'statusTip'; document.body.appendChild(tip); }
    tip.textContent = msg;
    tip.classList.add('show');
    setTimeout(function () { tip.classList.remove('show'); }, 2600);
  }
  window.PetShowTip = showTip;

  /* 拖拽条 → 原生拖窗 */
  var strip = document.getElementById('dragStrip');
  var moved = false;
  strip.addEventListener('touchmove', function (ev) {
    /* 移动超过阈值交给原生拖动 */
  }, { passive: true });
  strip.addEventListener('touchstart', function () { moved = false; }, { passive: true });
  strip.addEventListener('touchend', function () { setTimeout(function(){ if (!moved) notifyDrag(); }, 50); });
  strip.addEventListener('mousedown', function () { moved = false; });
  strip.addEventListener('mouseup', function () { setTimeout(function(){ if (!moved) notifyDrag(); }, 50); });
  function notifyDrag() {
    try {
      if (window.PetBridge && window.PetBridge.startDrag) window.PetBridge.startDrag();
      else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage({ kind: 'drag' });
    } catch (e) {}
  }
  strip.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

  /* ===== 语音输入（与主界面同链路：麦克风→16k float32→网关 ASR→填入并发送） ===== */
  var recCtx = null, recStream = null, recNode = null, recChunks = [], recActive = false, recTimer = null;
  function ggCfg() {
    var cfg = { baseUrl: '', apiKey: '' };
    try {
      if (window.PetBridge && typeof window.PetBridge.getConfig === 'function') {
        var raw = window.PetBridge.getConfig();
        var o = JSON.parse(raw || '{}');
        cfg.baseUrl = o.baseUrl || ''; cfg.apiKey = o.apiKey || '';
      }
    } catch (e) {}
    if (!cfg.baseUrl) {
      try {
        var st = JSON.parse(localStorage.getItem('elaina_settings') || '{}');
        cfg.baseUrl = st.baseUrl || ''; cfg.apiKey = st.apiKey || '';
      } catch (e) {}
    }
    /* PC 桌面：file:// 直连网关会被 CORS 拦，改走内置本地代理 */
    try { if (window.chrome && window.chrome.webview) cfg.baseUrl = 'http://127.0.0.1:3500'; } catch (e) {}
    return cfg;
  }
  function downsample(input, inRate, outRate) {
    if (outRate === inRate) return input;
    var ratio = inRate / outRate;
    var len = Math.max(1, Math.floor(input.length / ratio));
    var out = new Float32Array(len);
    var off = 0;
    for (var i = 0; i < len; i++) {
      var next = Math.round((i + 1) * ratio);
      var sum = 0, n = 0;
      for (var k = off; k < next && k < input.length; k++) { sum += input[k]; n++; }
      out[i] = n > 0 ? sum / n : 0;
      off = next;
    }
    return out;
  }
  function mergeChunks(chunks) {
    var total = 0;
    chunks.forEach(function (c) { total += c.length; });
    var merged = new Float32Array(total), off = 0;
    chunks.forEach(function (c) { merged.set(c, off); off += c.length; });
    return merged;
  }
  function stopVoiceInput(sendIt) {
    recActive = false;
    var btn = document.getElementById('petMic');
    if (btn) btn.classList.remove('rec');
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
    try { if (recNode) { recNode.disconnect(); recNode.onaudioprocess = null; } } catch (e) {}
    try { if (recStream) recStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (recCtx) recCtx.close(); } catch (e) {}
    recNode = null; recStream = null; recCtx = null;
    if (!sendIt) { recChunks = []; return; }
    var pcm = mergeChunks(recChunks);
    recChunks = [];
    if (pcm.length < 16000 * 0.15) { showTip('录音太短，请再说一次'); return; }
    asrUpload(pcm);
  }
  function asrUpload(pcm) {
    var cfg = ggCfg();
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
        var text = res.p && res.p.text ? String(res.p.text).trim() : '';
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
        var src = recCtx.createMediaStreamSource(stream);
        recNode = recCtx.createScriptProcessor(4096, 1, 1);
        recNode.onaudioprocess = function (ev) {
          if (!recActive) return;
          var ch = ev.inputBuffer.getChannelData(0);
          var copy = new Float32Array(ch.length);
          copy.set(ch);
          recChunks.push(downsample(copy, recCtx.sampleRate, 16000));
        };
        src.connect(recNode);
        recNode.connect(recCtx.destination);
        recActive = true;
        var btn = document.getElementById('petMic');
        if (btn) btn.classList.add('rec');
        showTip('正在聆听… 再次点击结束并发送');
        recTimer = setTimeout(function () { if (recActive) stopVoiceInput(true); }, 60000);
      })
      .catch(function (e) { showTip('麦克风不可用：' + (e && e.message ? e.message : '权限被拒绝')); });
  }
  try {
    var micBtn = document.getElementById('petMic');
    if (micBtn) micBtn.addEventListener('click', function (ev) { ev.stopPropagation(); startVoiceInput(); });
  } catch (e) {}

  /* 返回主界面（仅 PC 桌面） */
  try {
    var backBtn = document.getElementById('petBackBtn');
    var isPc = window.chrome && window.chrome.webview;
    var isAndroid = window.PetBridge && typeof window.PetBridge.openApp === 'function';
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
      var d = ev.data || {};
      if (d.kind === 'pet-reply') window.PetOnReply(d.payload || d.text || '');
      if (d.kind === 'tip') showTip(d.payload || '');
    });
  }

  setTimeout(function () {
    var hb = document.getElementById('helloBubble');
    if (hb) hb.style.display = '';
  }, 600);
})();
