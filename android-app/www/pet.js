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
