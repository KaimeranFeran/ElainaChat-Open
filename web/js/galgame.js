/* ============================================================
   ElainaChat · Galgame 界面逻辑
   - 数据与主界面共用同一 state.conversations（不复制、不冲突）
   - 发送复用主界面 handleTextSubmit（先写入 #textInput 再提交）
   - 文本渲染复用全局 renderMessageText（Markdown + LaTeX）
   - 默认关闭：localStorage elaina_galgame_enabled = '1' 才开启
   ============================================================ */
(function () {
  'use strict';
  var GK = 'elaina_galgame_';
  var V = {
    enabled: function () { try { return localStorage.getItem(GK + 'enabled') === '1'; } catch (e) { return false; } },
    get: function (k, d) { try { var v = localStorage.getItem(GK + k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(GK + k, v); } catch (e) {} }
  };
  var EMO = ['smirk', 'shy', 'calm', 'surprised', 'resigned', 'speechless', 'angry', 'confused', 'happy'];
  var layer = null, sceneEl = null, fxCanvas = null, avatar = null, nameEl = null, textEl = null, dialog = null, input = null, infoEl = null;
  var shownCount = 0;          // 已展示到对话框的消息条数
  var typeTimer = null, typing = false, lastMsgKey = '';
  var pollTimer = null;

  function emotionFrom(text) {
    var t = String(text || '');
    if (/微笑|开心|高兴|嘿嘿|哈哈|愉快|喜悦/.test(t)) return 'happy';
    if (/生气|哼|愤怒|恼火/.test(t)) return 'angry';
    if (/疑惑|奇怪|嗯？/.test(t) || /\?\s*$/.test(t)) return 'confused';
    if (/害羞|脸红|唔|呜/.test(t)) return 'shy';
    if (/惊讶|吃惊|诶|哎|！/.test(t)) return 'surprised';
    if (/无奈|叹气|唉/.test(t)) return 'resigned';
    if (/无语|真是的|服了/.test(t)) return 'speechless';
    if (/坏笑|狡黠|得意/.test(t)) return 'smirk';
    return null;
  }
  function avatarSrc(k) { return 'img/elaina/p_' + (EMO.indexOf(k) >= 0 ? k : 'calm') + '.png'; }
  function setEmotion(k) {
    if (!avatar) return;
    var key = (EMO.indexOf(k) >= 0) ? k : 'calm';
    var src = avatarSrc(key);
    if (avatar.getAttribute('src') === src) return;
    avatar.setAttribute('src', src);
    avatar.classList.remove('emo-swap');
    void avatar.offsetWidth;
    avatar.classList.add('emo-swap');
  }
  function conv() {
    try {
      if (typeof state === 'undefined' || !state) return null;
      var cid = state.currentConversationId;
      return (state.conversations || []).find(function (c) { return c.id === cid; }) || (state.conversations || [])[0] || null;
    } catch (e) { return null; }
  }
  function msgKey(m) { return m ? (m.id + ':' + (m.text || '').length) : ''; }

  /* ---------- 构建 DOM ---------- */
  function build() {
    if (layer) return;
    layer = document.createElement('div');
    layer.id = 'galgameLayer';
    layer.innerHTML =
      '<div id="ggScene" class="scene-dusk">' +
        '<div class="sky"></div><div class="glow"></div><div class="clouds"></div>' +
        '<div class="hill-far"></div><div class="hill-near"></div><div class="ground"></div>' +
        '<canvas id="ggFx"></canvas><div class="vignette"></div>' +
      '</div>' +
      '<div id="ggStage"><img id="ggAvatar" src="' + avatarSrc('calm') + '" alt="伊蕾娜"></div>' +
      '<div id="ggInfo">伊蕾娜 · 魔女之旅</div>' +
      '<div id="ggMenu">' +
      '<button class="gg-btn" id="ggSettings" type="button">⚙ 设置</button>' +
      '<button class="gg-btn" id="ggSpeech" type="button">🎤 语音</button>' +
      '<button class="gg-btn" id="ggExit" type="button">✕ 退出 Galgame</button>' +
      '</div>' +
      '<div id="ggDialogWrap"><div id="ggDialog">' +
      '<div id="ggName">伊蕾娜</div>' +
      '<div id="ggText"></div>' +
      '<div id="ggInputRow"><input id="ggInput" type="text" placeholder="和伊蕾娜说点什么…（回车发送）" autocomplete="off">' +
      '<button id="ggSend" type="button">➤</button></div>' +
      '</div></div>';
    document.body.appendChild(layer);
    avatar = layer.querySelector('#ggAvatar');
    nameEl = layer.querySelector('#ggName');
    textEl = layer.querySelector('#ggText');
    dialog = layer.querySelector('#ggDialog');
    input = layer.querySelector('#ggInput');
    infoEl = layer.querySelector('#ggInfo');
    applyOptions();

    /* 交互 */
    dialog.addEventListener('click', function (ev) {
      if (ev.target.closest('#ggInputRow')) return;
      if (typing) { finishTyping(); return; }
      nextHistory();
    });
    layer.querySelector('#ggExit').addEventListener('click', function (ev) { ev.stopPropagation(); setEnabled(false); });
    layer.querySelector('#ggSettings').addEventListener('click', function (ev) {
      ev.stopPropagation();
      try { if (typeof openSettings === 'function') openSettings(); } catch (e) {}
    });
    layer.querySelector('#ggSpeech').addEventListener('click', function (ev) { ev.stopPropagation(); startVoice(); });
    layer.querySelector('#ggSend').addEventListener('click', function (ev) { ev.stopPropagation(); send(); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.stopPropagation(); send(); } });
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    layer.querySelector('#ggInputRow').classList.add('show');
  }
  var SCENES = ['dusk', 'night', 'rain', 'sakura'];
  var FX_MODES = ['none', 'star', 'rain', 'petal'];
  var fxParticles = [], fxRaf = null, fxMode = 'none';

  /* ===== 粒子特效（星空 / 雨 / 樱花） ===== */
  function fxInit(mode) {
    fxMode = mode || 'none';
    if (!fxCanvas) return;
    if (fxRaf) { cancelAnimationFrame(fxRaf); fxRaf = null; }
    fxParticles = [];
    var ctx = fxCanvas.getContext('2d');
    function resize() {
      if (!fxCanvas) return;
      fxCanvas.width = fxCanvas.clientWidth || window.innerWidth;
      fxCanvas.height = fxCanvas.clientHeight || window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);
    if (fxMode === 'none') { ctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height); return; }
    var W0 = fxCanvas.width, H0 = fxCanvas.height;
    var count = fxMode === 'star' ? 140 : fxMode === 'rain' ? 180 : 60;
    for (var i = 0; i < count; i++) {
      fxParticles.push({
        x: Math.random() * W0,
        y: Math.random() * H0,
        r: fxMode === 'petal' ? 4 + Math.random() * 5 : fxMode === 'rain' ? 1 : 0.6 + Math.random() * 1.6,
        vx: fxMode === 'petal' ? -0.5 - Math.random() * 0.6 : fxMode === 'rain' ? -0.6 : 0,
        vy: fxMode === 'petal' ? 0.5 + Math.random() * 0.7 : fxMode === 'rain' ? 8 + Math.random() * 6 : 0,
        a: fxMode === 'star' ? 0.35 + Math.random() * 0.65 : 0.5 + Math.random() * 0.4,
        tw: Math.random() * Math.PI * 2,
        hue: fxMode === 'petal' ? 340 + Math.random() * 20 : 0
      });
    }
    function frame() {
      if (!fxCanvas) return;
      var ctx2 = fxCanvas.getContext('2d');
      var w = fxCanvas.width, h = fxCanvas.height;
      ctx2.clearRect(0, 0, w, h);
      fxParticles.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.tw += 0.05;
        if (fxMode === 'rain') {
          ctx2.strokeStyle = 'rgba(190,215,255,' + (p.a * 0.55) + ')';
          ctx2.lineWidth = p.r;
          ctx2.beginPath(); ctx2.moveTo(p.x, p.y); ctx2.lineTo(p.x + p.vx * 1.6, p.y + p.vy * 0.6); ctx2.stroke();
        } else if (fxMode === 'petal') {
          ctx2.fillStyle = 'hsla(' + p.hue + ',85%,82%,' + p.a + ')';
          ctx2.beginPath(); ctx2.ellipse(p.x, p.y, p.r, p.r * 0.62, p.tw, 0, Math.PI * 2); ctx2.fill();
        } else {
          var al = p.a * (0.6 + 0.4 * Math.sin(p.tw));
          ctx2.fillStyle = 'rgba(255,255,255,' + al + ')';
          ctx2.beginPath(); ctx2.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx2.fill();
        }
        if (p.y > h + 20) p.y = -20, p.x = Math.random() * w;
        if (p.y < -20 && fxMode === 'rain') p.y = h + 20;
        if (p.x < -20) p.x = w + 20;
      });
      fxRaf = requestAnimationFrame(frame);
    }
    frame();
  }

  function applyOptions() {
    if (!layer) return;
    /* 场景背景 */
    sceneEl = layer.querySelector('#ggScene');
    if (sceneEl) {
      var sc = V.get('scene', 'dusk');
      if (SCENES.indexOf(sc) < 0) sc = 'dusk';
      SCENES.forEach(function (s) { sceneEl.classList.toggle('scene-' + s, s === sc); });
    }
    /* 粒子特效 */
    fxCanvas = layer.querySelector('#ggFx');
    var fx = V.get('fx', 'auto');
    if (fx === 'auto') fx = { dusk: 'none', night: 'star', rain: 'rain', sakura: 'petal' }[V.get('scene', 'dusk')] || 'none';
    if (FX_MODES.indexOf(fx) < 0) fx = 'none';
    fxInit(fx);
    var alpha = Number(V.get('alpha', '0.62')) || 0.62;
    layer.style.setProperty('--gg-alpha', String(alpha));
    var scale = Number(V.get('scale', '1')) || 1;
    if (avatar) avatar.style.maxWidth = (68 * scale) + '%';
    var sp = Number(V.get('speed', '24')) || 24;
    layer.dataset.speed = String(sp);
  }

  /* ---------- 对话推进 ---------- */
  function visibleMessages() {
    var c = conv();
    if (!c || !c.messages) return [];
    return c.messages.filter(function (m) { return m && m.text && m.role !== 'system'; });
  }
  function renderMsg(m, animate) {
    var who = m.role === 'user' ? 'me' : 'ai';
    nameEl.textContent = who === 'me' ? '你' : '伊蕾娜';
    nameEl.classList.toggle('me', who === 'me');
    var html = '';
    try { html = (typeof renderMessageText === 'function') ? renderMessageText(m.text) : String(m.text); }
    catch (e) { html = String(m.text); }
    if (animate) typewrite(html); else { textEl.innerHTML = html; typing = false; dialog.classList.add('ready'); }
    if (who === 'ai') setEmotion(emotionFrom(m.text));
    else setEmotion('calm');
  }
  function typewrite(html) {
    var speed = Number(V.get('speed', '24')) || 24;
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    typing = true;
    dialog.classList.remove('ready');
    textEl.innerHTML = '';
    /* 以字符为粒度逐字显示（保留 HTML：先放全文再用 clip 计数不可行，故按纯文本 + 最终一次性换 HTML） */
    var probe = document.createElement('div');
    probe.innerHTML = html;
    var plain = probe.textContent || '';
    var i = 0;
    typeTimer = setInterval(function () {
      i += 2;
      textEl.textContent = plain.slice(0, i);
      if (i >= plain.length) { finishTyping(html); }
    }, Math.max(8, speed));
  }
  function finishTyping(html) {
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    var list = visibleMessages();
    var last = list[list.length - 1];
    if (last) {
      try { textEl.innerHTML = (typeof renderMessageText === 'function') ? renderMessageText(last.text) : String(last.text); } catch (e) { textEl.textContent = String(last.text); }
    } else if (html) { textEl.innerHTML = html; }
    typing = false;
    dialog.classList.add('ready');
  }
  function nextHistory() {
    var list = visibleMessages();
    if (!list.length) { textEl.textContent = '（还没有对话，输入一句话开始吧）'; nameEl.textContent = '伊蕾娜'; return; }
    if (shownCount < list.length) { renderMsg(list[shownCount], true); shownCount++; }
    else { renderMsg(list[list.length - 1], true); }
  }
  function syncFromState(force) {
    var list = visibleMessages();
    if (!list.length) return;
    var last = list[list.length - 1];
    var key = msgKey(last);
    if (!force && key === lastMsgKey) return;
    lastMsgKey = key;
    renderMsg(last, true);
    shownCount = list.length;
    var c = conv();
    if (infoEl && c) infoEl.textContent = '伊蕾娜 · ' + (c.title || '当前对话');
  }

  /* ---------- 发送（复用主界面链路） ---------- */
  function send() {
    var v = (input && input.value || '').trim();
    if (!v) return;
    input.value = '';
    try {
      var mainInput = document.getElementById('textInput');
      if (mainInput && typeof handleTextSubmit === 'function') {
        mainInput.value = v;
        handleTextSubmit();
        return;
      }
      /* 兜底：直接构造消息走核心链路 */
      if (typeof handleUserInput === 'function' && typeof state !== 'undefined') {
        var c = conv();
        if (c) {
          var msg = { id: (typeof generateId === 'function' ? generateId() : String(Date.now())), role: 'user', text: v, timestamp: new Date().toLocaleTimeString() };
          c.messages.push(msg);
          handleUserInput(msg, c);
        }
      }
    } catch (e) { console.warn('[galgame] 发送失败', e); }
  }

  /* ---------- 语音输入（与主界面同链路：麦克风 → 网关 ASR → 填入输入框） ---------- */
  function startVoice() {
    try {
      var btn = document.getElementById('micBtn') || document.querySelector('.conversation-mic-btn') ||
                document.querySelector('.initial-conversation-mic-btn') || document.querySelector('[id*="mic" i]');
      if (btn) {
        btn.click();
        showTip('语音识别中…结果会出现在输入框，回车发送');
        return;
      }
      showTip('未找到语音入口，请在主界面使用麦克风');
    } catch (e) { showTip('语音启动失败'); }
  }
  var tipEl = null;
  function showTip(msg) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.style.cssText = 'position:fixed;left:50%;bottom:200px;transform:translateX(-50%);z-index:2100;padding:6px 14px;border-radius:999px;background:rgba(10,14,22,.85);color:#fff;font-size:12px;opacity:0;transition:opacity .2s ease;pointer-events:none';
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = msg;
    tipEl.style.opacity = '1';
    setTimeout(function () { tipEl.style.opacity = '0'; }, 2600);
  }

  /* ---------- 开关 ---------- */
  function setEnabled(on, silent) {
    V.set('enabled', on ? '1' : '0');
    if (on) open(); else close();
    try { document.dispatchEvent(new CustomEvent('elaina-galgame-changed', { detail: { enabled: !!on } })); } catch (e) {}
    if (!silent) showTip(on ? 'Galgame 界面已开启（右上角可退出）' : '已退出 Galgame，回到主界面');
  }
  function open() {
    build();
    applyOptions();
    layer.classList.add('on');
    var list = visibleMessages();
    shownCount = Math.max(0, list.length - 1);
    lastMsgKey = '';
    syncFromState(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (!layer || !layer.classList.contains('on')) return;
      try {
        var list2 = visibleMessages();
        if (!list2.length) return;
        var last = list2[list2.length - 1];
        if (msgKey(last) !== lastMsgKey) syncFromState(false);
      } catch (e) {}
    }, 600);
  }
  function close() {
    if (layer) layer.classList.remove('on');
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; typing = false; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------- 对外接口 + 启动 ---------- */
  window.ElainaGalgame = {
    isEnabled: V.enabled,
    setEnabled: setEnabled,
    toggle: function () { setEnabled(!V.enabled()); },
    refresh: function () { applyOptions(); if (V.enabled()) open(); }
  };
  function boot() {
    build();
    /* 监听设置变化（同页 localStorage 改变不会触发 storage 事件，用轮询兜底） */
    setInterval(function () {
      var on = V.enabled();
      var showing = layer && layer.classList.contains('on');
      if (on && !showing) open();
      else if (!on && showing) close();
    }, 800);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
