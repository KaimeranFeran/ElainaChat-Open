/* ============================================================
   ElainaChat · Galgame 界面逻辑
   - 数据与主界面共用同一 state.conversations（不复制、不冲突）
   - 发送复用主界面 handleTextSubmit（先写入 #textInput 再提交）
   - 文本渲染复用全局 renderMessageText（Markdown + LaTeX）
   - 默认关闭：localStorage elaina_galgame_enabled = '1' 才开启
   ============================================================ */
(function () {
  'use strict';
  let GK = 'elaina_galgame_';
  let V = {
    enabled: function () { try { return localStorage.getItem(GK + 'enabled') === '1'; } catch (e) { return false; } },
    get: function (k, d) { try { let v = localStorage.getItem(GK + k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(GK + k, v); } catch (e) {} }
  };
  let EMO = ['smirk', 'shy', 'calm', 'surprised', 'resigned', 'speechless', 'angry', 'confused', 'happy'];
  let layer = null, sceneEl = null, fxCanvas = null, avatar = null, nameEl = null, textEl = null, dialog = null, input = null, infoEl = null;
  let GAL_SETTING_OPEN = false;
  let shownCount = 0;          // 已展示到对话框的消息条数
  let typeTimer = null, typing = false, lastMsgKey = '';
  let pollTimer = null;

  function emotionFrom(text) {
    /* OCR M3：统一走 ElainaEmotion */
    try { if (window.ElainaEmotion) return window.ElainaEmotion.from(text); } catch (e) {}
    return null;
  }
  function avatarSrc(k) { return 'img/elaina/p_' + (EMO.indexOf(k) >= 0 ? k : 'calm') + '.png'; }
  function setEmotion(k) {
    if (!avatar) return;
    let key = (EMO.indexOf(k) >= 0) ? k : 'calm';
    let src = avatarSrc(key);
    if (avatar.getAttribute('src') === src) return;
    avatar.setAttribute('src', src);
    avatar.classList.remove('emo-swap');
    void avatar.offsetWidth;
    avatar.classList.add('emo-swap');
  }
  function conv() {
    try {
      if (typeof state === 'undefined' || !state) return null;
      let cid = state.currentConversationId;
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
        '<div class="bgA" style="position:absolute;inset:0;background-size:cover;background-position:center;transition:opacity .6s ease;opacity:1"></div>' +
        '<div class="bgB" style="position:absolute;inset:0;background-size:cover;background-position:center;transition:opacity .6s ease;opacity:0"></div>' +
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
    layer.querySelector('#ggExit').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      GAL_SETTING_OPEN = false;
      setEnabled(false);
    });
    layer.querySelector('#ggSettings').addEventListener('click', function (ev) {
      ev.stopPropagation();
      GAL_SETTING_OPEN = true;
      layer.classList.remove('on');   /* 设置面板层级低于 Galgame，先让位 */
      try { if (typeof openSettings === 'function') openSettings(); } catch (e) {}
    });
    layer.querySelector('#ggSpeech').addEventListener('click', function (ev) { ev.stopPropagation(); startVoice(); });
    layer.querySelector('#ggSend').addEventListener('click', function (ev) { ev.stopPropagation(); send(); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.stopPropagation(); send(); } });
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    layer.querySelector('#ggInputRow').classList.add('show');
  }
  /* 背景图库（web/img/bg/*.jpg，文件名 → 中文标签） */
  let BGS = [["amusement_park","游乐园"],["amusement_plaza","游乐园广场"],["arcade","街机厅"],["bedroom","卧室"],["bedroom_cosy","温馨卧室"],["bedroom_morning","清晨卧室"],["cafe","咖啡厅"],["carousel","旋转木马"],["city_park","城市公园"],["clothing_shop","服装店"],["fastfood","快餐店"],["ferris_wheel","摩天轮"],["flashback","回忆"],["furniture_shop","家具店"],["kitchen","厨房"],["lake_trail_broken","雪湖栈道·破"],["lake_trail_snow","雪湖栈道"],["mall","商场"],["market","集市"],["restaurant","餐厅"],["rollercoaster","过山车"],["room_day","房间·白天"],["room_night","房间·夜晚"],["room_snow","房间·雪天"],["shooting_booth","拍立得亭"],["snowy_street","雪之街"],["street_dusk","黄昏街道"],["street_snow_night","雪夜街道"],["swan_lake","天鹅湖"],["swan_lake_pavilion","天鹅湖亭"]];
  let BG_FILES = BGS.map(function (b) { return b[0]; });
  let FX_MODES = ['auto', 'none', 'star', 'snow', 'rain', 'petal'];
  function bgUrl(name) { return 'img/bg/' + name + '.jpg'; }
  function autoFxFor(name) {
    if (/night/.test(name)) return 'star';
    if (/snow/.test(name)) return 'snow';
    if (/rain/.test(name)) return 'rain';
    if (/flashback/.test(name)) return 'star';
    return 'none';
  }
  let fxParticles = [], fxRaf = null, fxMode = 'none';

  /* ===== 粒子特效（星空 / 雨 / 樱花 / 雪） ===== */
  let fxResizeBound = false;
  function resizeFxCanvas() {
    try {
      if (!fxCanvas) return;
      fxCanvas.width = fxCanvas.clientWidth || window.innerWidth;
      fxCanvas.height = fxCanvas.clientHeight || window.innerHeight;
    } catch (e) {}
  }
  function fxInit(mode) {
    fxMode = mode || 'none';
    if (!fxCanvas) return;
    if (fxRaf) { cancelAnimationFrame(fxRaf); fxRaf = null; }
    fxParticles = [];
    let ctx = fxCanvas.getContext('2d');
    resizeFxCanvas();
    if (!fxResizeBound) {
      fxResizeBound = true;
      window.addEventListener('resize', resizeFxCanvas);   /* 只绑一次，避免 fxInit 反复调用导致监听器泄漏（OCR S7） */
    }
    if (fxMode === 'none') { ctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height); return; }
    let W0 = fxCanvas.width, H0 = fxCanvas.height;
    let count = fxMode === 'star' ? 140 : fxMode === 'rain' ? 180 : fxMode === 'snow' ? 150 : 60;
    for (let i = 0; i < count; i++) {
      fxParticles.push({
        x: Math.random() * W0,
        y: Math.random() * H0,
        r: fxMode === 'petal' ? 4 + Math.random() * 5 : fxMode === 'rain' ? 1 : fxMode === 'snow' ? 1.4 + Math.random() * 2.4 : 0.6 + Math.random() * 1.6,
        vx: (fxMode === 'petal' || fxMode === 'snow') ? -0.5 - Math.random() * 0.6 : fxMode === 'rain' ? -0.6 : 0,
        vy: fxMode === 'petal' ? 0.5 + Math.random() * 0.7 : fxMode === 'rain' ? 8 + Math.random() * 6 : fxMode === 'snow' ? 0.7 + Math.random() * 1.1 : 0,
        a: fxMode === 'star' ? 0.35 + Math.random() * 0.65 : fxMode === 'snow' ? 0.5 + Math.random() * 0.5 : 0.5 + Math.random() * 0.4,
        tw: Math.random() * Math.PI * 2,
        hue: fxMode === 'petal' ? 340 + Math.random() * 20 : 0
      });
    }
    function frame() {
      if (!fxCanvas) return;
      let ctx2 = fxCanvas.getContext('2d');
      let w = fxCanvas.width, h = fxCanvas.height;
      ctx2.clearRect(0, 0, w, h);
      fxParticles.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.tw += 0.05;
        if (fxMode === 'rain') {
          ctx2.strokeStyle = 'rgba(190,215,255,' + (p.a * 0.55) + ')';
          ctx2.lineWidth = p.r;
          ctx2.beginPath(); ctx2.moveTo(p.x, p.y); ctx2.lineTo(p.x + p.vx * 1.6, p.y + p.vy * 0.6); ctx2.stroke();
        } else if (fxMode === 'snow') {
          ctx2.fillStyle = 'rgba(255,255,255,' + p.a + ')';
          ctx2.beginPath(); ctx2.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx2.fill();
        } else if (fxMode === 'petal') {
          ctx2.fillStyle = 'hsla(' + p.hue + ',85%,82%,' + p.a + ')';
          ctx2.beginPath(); ctx2.ellipse(p.x, p.y, p.r, p.r * 0.62, p.tw, 0, Math.PI * 2); ctx2.fill();
        } else {
          let al = p.a * (0.6 + 0.4 * Math.sin(p.tw));
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
    /* 背景图（双层交叉淡入） */
    sceneEl = layer.querySelector('#ggScene');
    if (sceneEl) {
      let sc = V.get('scene', '');
      if (BG_FILES.indexOf(sc) < 0) sc = BG_FILES[0] || '';
      let layerA = sceneEl.querySelector('.bgA'), layerB = sceneEl.querySelector('.bgB');
      if (layerA && layerB) {
        let cur = sceneEl.getAttribute('data-bg') || '';
        if (cur !== sc) {
          let top = sceneEl.getAttribute('data-top') === 'a' ? layerB : layerA;
          let bottom = sceneEl.getAttribute('data-top') === 'a' ? layerA : layerB;
          top.style.backgroundImage = 'url("' + bgUrl(sc) + '")';
          top.style.opacity = '1';
          bottom.style.opacity = '0';
          sceneEl.setAttribute('data-top', sceneEl.getAttribute('data-top') === 'a' ? 'b' : 'a');
          sceneEl.setAttribute('data-bg', sc);
        }
      }
    }
    /* 粒子特效 */
    fxCanvas = layer.querySelector('#ggFx');
    let fx = V.get('fx', 'auto');
    let curBg = (sceneEl && sceneEl.getAttribute('data-bg')) || BG_FILES[0] || '';
    if (fx === 'auto') fx = autoFxFor(curBg);
    if (FX_MODES.indexOf(fx) < 0) fx = 'none';
    fxInit(fx);
    let alpha = Number(V.get('alpha', '0.62')) || 0.62;
    layer.style.setProperty('--gg-alpha', String(alpha));
    let scale = Number(V.get('scale', '1')) || 1;
    if (scale < 0.6) scale = 0.6;
    if (scale > 1.6) scale = 1.6;
    if (layer) layer.style.setProperty('--gg-scale', String(scale));
    /* 立绘尺寸：内联 !important 直接生效（样式表里的 !important 覆盖不到内联 important） */
    if (avatar) {
      const isPhone = (window.matchMedia && window.matchMedia('(max-width: 560px)').matches);
      const baseH = isPhone ? 118 : 100;
      const baseW = isPhone ? 104 : 68;
      try {
        avatar.style.setProperty('max-height', (baseH * scale).toFixed(1) + '%', 'important');
        avatar.style.setProperty('max-width', (baseW * scale).toFixed(1) + '%', 'important');
      } catch (e) {}
    }
    let sp = Number(V.get('speed', '24')) || 24;
  }

  /* ---------- 对话推进 ---------- */
  function visibleMessages() {
    let c = conv();
    if (!c || !c.messages) return [];
    return c.messages.filter(function (m) { return m && m.text && m.role !== 'system'; });
  }
  function renderMsg(m, animate) {
    let who = m.role === 'user' ? 'me' : 'ai';
    nameEl.textContent = who === 'me' ? '你' : '伊蕾娜';
    nameEl.classList.toggle('me', who === 'me');
    let html = '';
    try { html = (typeof renderMessageText === 'function') ? renderMessageText(m.text) : String(m.text); }
    catch (e) { html = String(m.text); }
    if (animate) typewrite(html); else { textEl.innerHTML = html; typing = false; dialog.classList.add('ready'); }
    if (who === 'ai') setEmotion(emotionFrom(m.text));
    else setEmotion('calm');
  }
  function typewrite(html) {
    let speed = Number(V.get('speed', '24')) || 24;
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    typing = true;
    dialog.classList.remove('ready');
    textEl.innerHTML = '';
    /* 以字符为粒度逐字显示（保留 HTML：先放全文再用 clip 计数不可行，故按纯文本 + 最终一次性换 HTML） */
    let probe = document.createElement('div');
    probe.innerHTML = html;
    let plain = probe.textContent || '';
    let i = 0;
    typeTimer = setInterval(function () {
      i += 2;
      /* OCR 视觉：打字机阶段同样渲染 Markdown/LaTeX，避免中途露出 # 标题与公式源码 */
      const partial = plain.slice(0, i);
      try {
        const render = (typeof renderMessageText === 'function') ? renderMessageText : null;
        textEl.innerHTML = render ? render(partial) : partial.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      } catch (e) { textEl.textContent = partial; }
      if (i >= plain.length) { finishTyping(html); }
    }, Math.max(8, speed));
  }
  function finishTyping(html) {
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    let list = visibleMessages();
    let last = list[list.length - 1];
    if (last) {
      try { textEl.innerHTML = (typeof renderMessageText === 'function') ? renderMessageText(last.text) : String(last.text); } catch (e) { textEl.textContent = String(last.text); }
    } else if (html) { textEl.innerHTML = html; }
    typing = false;
    dialog.classList.add('ready');
  }
  function nextHistory() {
    let list = visibleMessages();
    if (!list.length) { textEl.textContent = '（还没有对话，输入一句话开始吧）'; nameEl.textContent = '伊蕾娜'; return; }
    if (shownCount < list.length) { renderMsg(list[shownCount], true); shownCount++; }
    else { renderMsg(list[list.length - 1], true); }
  }
  function syncFromState(force) {
    let list = visibleMessages();
    if (!list.length) return;
    let last = list[list.length - 1];
    let key = msgKey(last);
    if (!force && key === lastMsgKey) return;
    lastMsgKey = key;
    if (last.role !== 'user') applySceneFromText(last.text);
    renderMsg(last, true);
    shownCount = list.length;
    let c = conv();
    if (infoEl && c) infoEl.textContent = '伊蕾娜 · ' + (c.title || '当前对话');
  }

  /* ---------- 发送（复用主界面链路） ---------- */
  function send() {
    let v = (input && input.value || '').trim();
    if (!v) return;
    input.value = '';
    try {
      let mainInput = document.getElementById('textInput');
      if (mainInput && typeof handleTextSubmit === 'function') {
        mainInput.value = v;
        handleTextSubmit();
        return;
      }
      /* 兜底：直接构造消息走核心链路 */
      if (typeof handleUserInput === 'function' && typeof state !== 'undefined') {
        let c = conv();
        if (c) {
          let msg = { id: (typeof generateId === 'function' ? generateId() : String(Date.now())), role: 'user', text: v, timestamp: new Date().toLocaleTimeString() };
          c.messages.push(msg);
          handleUserInput(msg, c);
        }
      }
    } catch (e) { console.warn('[galgame] 发送失败', e); }
  }

  /* ---------- 语音输入（与主界面同链路：麦克风 → 网关 ASR → 填入输入框） ---------- */
  function startVoice() {
    try {
      let btn = document.getElementById('micBtn') || document.querySelector('.conversation-mic-btn') ||
                document.querySelector('.initial-conversation-mic-btn') || document.querySelector('[id*="mic" i]');
      if (btn) {
        btn.click();
        showTip('语音识别中…结果会出现在输入框，回车发送');
        return;
      }
      showTip('未找到语音入口，请在主界面使用麦克风');
    } catch (e) { showTip('语音启动失败'); }
  }
  let tipEl = null;
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
    layer.style.display = 'block';
    syncSceneHint();
    applyOptions();
    layer.classList.add('on');
    let list = visibleMessages();
    shownCount = Math.max(0, list.length - 1);
    lastMsgKey = '';
    syncFromState(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (!layer || !layer.classList.contains('on')) return;
      try {
        let list2 = visibleMessages();
        if (!list2.length) return;
        let last = list2[list2.length - 1];
        if (msgKey(last) !== lastMsgKey) syncFromState(false);
      } catch (e) {}
    }, 600);
  }
  function close() {
    try { window.__galgameSceneHint = ''; } catch (e) {}
    if (layer) {
      layer.classList.remove('on');
      layer.style.display = 'none';
    }
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; typing = false; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------- AI 自主选择背景 ---------- */
  function sceneAliases() {
    let map = {};
    BGS.forEach(function (b) {
      map[b[1]] = b[0];            /* 中文名 → 文件 */
      map[b[0]] = b[0];            /* 英文 id → 文件 */
      map[b[0].replace(/_/g, '')] = b[0];
    });
    /* 常见简称补充 */
    let extra = { '咖啡': 'cafe', '咖啡店': 'cafe', '卧室': 'bedroom', '房间': 'room_day', '卧室·白天': 'room_day',
      '夜晚房间': 'room_night', '雪夜': 'street_snow_night', '雪街': 'snowy_street', '街道': 'street_dusk',
      '游乐园': 'amusement_park', '摩天轮': 'ferris_wheel', '旋转木马': 'carousel', '过山车': 'rollercoaster',
      '商场': 'mall', '集市': 'market', '市场': 'market', '餐厅': 'restaurant', '快餐': 'fastfood',
      '厨房': 'kitchen', '湖边': 'swan_lake', '湖': 'swan_lake', '天鹅湖': 'swan_lake', '公园': 'city_park',
      '服装店': 'clothing_shop', '家具店': 'furniture_shop', '街机': 'arcade', '游戏厅': 'arcade',
      '回忆': 'flashback', '雪湖': 'lake_trail_snow', '栈道': 'lake_trail_snow' };
    for (let k in extra) map[k] = extra[k];
    return map;
  }
  let SCENE_MAP = null;
  function extractScene(text) {
    let m = String(text || '').match(/<scene>\s*([\s\S]*?)\s*<\/scene>/i);
    if (!m) return null;
    let raw = String(m[1]).trim();
    if (!raw) return null;
    if (!SCENE_MAP) SCENE_MAP = sceneAliases();
    if (SCENE_MAP[raw]) return SCENE_MAP[raw];
    /* 模糊匹配：包含关系 */
    for (let k in SCENE_MAP) { if (raw.indexOf(k) >= 0 || k.indexOf(raw) >= 0) return SCENE_MAP[k]; }
    return null;
  }
  function aiBgEnabled() { return V.get('aiBg', '1') === '1'; }
  function applySceneFromText(text) {
    if (!aiBgEnabled()) return false;
    let file = extractScene(text);
    if (!file) return false;
    if (V.get('scene', '') === file) return false;
    V.set('scene', file);
    applyOptions();
    markPicker();
    showTip('场景切换：' + (function () { let n = file; BGS.forEach(function (b) { if (b[0] === file) n = b[1]; }); return n; })());
    return true;
  }
  /* 场景指令（注入 system，让 AI 自主决定何时切换） */
  function syncSceneHint() {
    try {
      if (V.enabled() && aiBgEnabled()) {
        let names = BGS.map(function (b) { return b[1]; }).join('、');
        window.__galgameSceneHint = '# 场景切换（内部指令，不要向用户解释）\n' +
          '当前为 Galgame 界面，背景场景可由你决定。当剧情明显进入新的地点或时段时，请在回复的**最后单独一行**输出场景标记：<scene>场景名</scene>；' +
          '如果场景没有变化，不要输出该标记，也不要在正文里提到它。\n可选场景名（必须从其中选择）：' + names + '。';
      } else {
        window.__galgameSceneHint = '';
      }
    } catch (e) {}
  }

  /* ---------- 设置面板：背景场景缩略图选择器（自管理，轮询兜底） ---------- */
  function fillScenePicker() {
    try {
      let box = document.getElementById('swGgSceneList');
      if (!box || box.dataset.filled === '1' || !BGS.length) return;
      let cur = V.get('scene', BGS[0][0]);
      if (!BG_FILES.length) return;
      if (BG_FILES.indexOf(cur) < 0) cur = BG_FILES[0];
      box.innerHTML = BGS.map(function (it) {
        let f = it[0], name = it[1];
        return '<button type="button" class="sw-gg-thumb" data-scene="' + f + '" title="' + name + '" style="flex:0 0 auto;padding:0;border:0;background:transparent;cursor:pointer">' +
          '<img src="' + bgUrl(f) + '" alt="' + name + '" style="width:92px;height:52px;object-fit:cover;border-radius:10px;display:block;border:2px solid transparent;transition:border-color .15s ease, transform .15s ease">' +
          '<div style="font-size:11px;margin-top:3px;color:var(--lg-ink-soft);text-align:center;max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</div></button>';
      }).join('');
      box.dataset.filled = '1';
      box.querySelectorAll('.sw-gg-thumb').forEach(function (btn) {
        btn.addEventListener('click', function () {
          V.set('scene', btn.getAttribute('data-scene'));
          refresh();
          markPicker();
        });
      });
      markPicker();
    } catch (e) {}
  }
  function markPicker() {
    try {
      let box = document.getElementById('swGgSceneList');
      if (!box) return;
      let cur = V.get('scene', BG_FILES[0] || '');
      if (BG_FILES.indexOf(cur) < 0) cur = BG_FILES[0] || '';
      box.querySelectorAll('.sw-gg-thumb').forEach(function (btn) {
        let img = btn.querySelector('img');
        let on = btn.getAttribute('data-scene') === cur;
        if (img) { img.style.borderColor = on ? 'var(--lg-primary)' : 'transparent'; img.style.transform = on ? 'translateY(-2px)' : 'none'; }
      });
    } catch (e) {}
  }
  function refresh() { applyOptions(); syncSceneHint(); if (V.enabled()) { open(); } }

  /* ---------- 对外接口 + 启动 ---------- */
  window.ElainaGalgame = {
    bgs: function () { return BGS.slice(); },
    isEnabled: V.enabled,
    setEnabled: setEnabled,
    toggle: function () { setEnabled(!V.enabled()); },
    refresh: refresh
  };
  function boot() {
    build();
    setInterval(fillScenePicker, 900);
    /* 监听设置变化（同页 localStorage 改变不会触发 storage 事件，用轮询兜底） */
    setInterval(function () {
      let on = V.enabled();
      let showing = layer && layer.classList.contains('on');
      if (GAL_SETTING_OPEN) {
        let ov = document.getElementById('settingsOverlay');
        let closed = !ov || ov.classList.contains('hidden');
        if (closed) { GAL_SETTING_OPEN = false; if (on) open(); }
        return;
      }
      if (on && !showing) open();
      else if (!on && showing) close();
    }, 800);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
