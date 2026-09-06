/* Elaina Pet 前端：Live2D 形象 + 玻璃气泡 + 打字机；桥自适应（安卓 PetBridge / PC chrome.webview） */
(function () {
  'use strict';
  var MODEL_URL = 'vendor/live2d/hiyori/Hiyori.model3.json';
  var scroller = document.getElementById('bubbleScroller');
  var input = document.getElementById('petInput');
  var sendBtn = document.getElementById('petSend');
  var tip = null;
  var typeTimer = null;

  /* ---- 桥 ---- */
  var bridge = window.PetBridge;
  if (!bridge && window.chrome && window.chrome.webview) bridge = window.chrome.webview;
  function toNative(kind, payload) {
    try {
      if (window.PetBridge) {
        if (kind === 'send') window.PetBridge.sendMessage(payload);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ kind: kind, payload: payload });
      }
    } catch (e) {}
  }

  /* ---- 气泡 ---- */
  function addBubble(text, who) {
    var div = document.createElement('div');
    div.className = 'bubble ' + who;
    var pre = document.createElement('pre');
    pre.textContent = text;
    div.appendChild(pre);
    scroller.appendChild(div);
    scroller.scrollTop = scroller.scrollHeight;
    return div;
  }
  function typewrite(div, text) {
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    var pre = div.querySelector('pre');
    var i = 0;
    pre.textContent = '';
    typeTimer = setInterval(function () {
      i += 2;
      pre.textContent = text.slice(0, i);
      scroller.scrollTop = scroller.scrollHeight;
      if (i >= text.length) { clearInterval(typeTimer); typeTimer = null; }
    }, 24);
  }

  /* ---- 发送 ---- */
  function send() {
    var v = input.value.trim();
    if (!v) return;
    addBubble(v, 'me');
    input.value = '';
    toNative('send', v);
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') send(); });

  /* ---- 收回复（安卓原生回调 / PC C# 回调） ---- */
  window.PetOnReply = function (text) {
    var b = addBubble(String(text), 'bot');
    typewrite(b, String(text));
  };

  /* ---- 状态提示 ---- */
  function showTip(msg) {
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'statusTip';
      document.body.appendChild(tip);
    }
    tip.textContent = msg;
    tip.classList.add('show');
    setTimeout(function () { tip.classList.remove('show'); }, 2600);
  }
  window.PetShowTip = showTip;

  /* ---- 拖拽条 → 原生开始拖窗 ---- */
  var dragStrip = document.getElementById('dragStrip');
  var dragMoved = false;
  dragStrip.addEventListener('mousedown', function (ev) { dragMoved = false; });
  dragStrip.addEventListener('touchstart', function (ev) { dragMoved = false; }, { passive: true });
  dragStrip.addEventListener('click', function () {
    if (!dragMoved) {
      try {
        if (window.PetBridge && window.PetBridge.startDrag) window.PetBridge.startDrag();
        else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage({ kind: 'drag' });
      } catch (e) {}
    }
  });
  setInterval(function () { dragMoved = true; }, 60);
  dragStrip.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

  /* ---- Live2D ---- */
  function initLive2D() {
    try {
      if (!window.PIXI || !PIXI.live2d) { return; }
      var canvas = document.getElementById('petCanvas');
      var app = new PIXI.Application({ view: canvas, transparent: true, autoStart: true, backgroundAlpha: 0, resizeTo: document.getElementById('live2dWrap') });
      PIXI.live2d.Live2DModel.from(MODEL_URL, { autoInteract: false }).then(function (model) {
        var wrap = document.getElementById('live2dWrap');
        function fit() {
          var w = wrap.clientWidth, h = wrap.clientHeight;
          var scale = Math.min(w / model.width, h / model.height) * 0.96;
          model.scale.set(scale);
          model.anchor.set(0.5, 1);
          model.position.set(w / 2, h);
        }
        fit();
        window.addEventListener('resize', fit);
        app.stage.addChild(model);
        /* 闲置动画 */
        try {
          var mm = model.internalModel && model.internalModel.motionManager;
          if (mm && mm.definitions) {
            var groups = mm.definitions;
            var idleGroup = groups['Idle'] || groups['idle'] ? 'Idle' : Object.keys(groups)[0];
            if (idleGroup) mm.startRandomMotion(idleGroup, 0);
          }
        } catch (e) {}
        /* 点击互动 */
        canvas.addEventListener('pointerdown', function (ev) {
          if (ev.target === dragStrip) return;
          try { if (model.motion) model.motion('Tap'); } catch (e) {}
        });
        window.__petModel = model;
      }).catch(function () { /* 模型离线时静默，气泡照常 */ });
    } catch (e) {}
  }
  initLive2D();

  /* PC 收 C# 回调（kind: pet-reply / tip） */
  if (window.chrome && window.chrome.webview && window.chrome.webview.addEventListener) {
    window.chrome.webview.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.kind === 'pet-reply') window.PetOnReply(d.payload || d.text || '');
      if (d.kind === 'tip') showTip(d.payload || '');
    });
  }

  setTimeout(function () {
    var hello = document.getElementById('helloBubble');
    if (hello) hello.classList.remove('hidden');
  }, 900);
})();
