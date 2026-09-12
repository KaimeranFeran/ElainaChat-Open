/* ElainaChat · Theme Menu（Swift 风格二级菜单注入层）
   视觉层：捕获现有小按钮 → 由主按钮 + 弹出菜单取代；
   全部调用现有全局函数（promptCreateCategory/showMemoryImportDialog/
   showMemoryExportDialog/runManualMemorySummary），不改变任何业务逻辑。 */
(() => {
  'use strict';

  /* 顶层共享（多处 safe() 块共用，避免跨域作用域 ReferenceError —— OCR S1/S2） */
  const GV = (k, d) => { try { const v = localStorage.getItem('elaina_galgame_' + k); return v === null ? d : v; } catch (e) { return d; } };
  const GS = (k, v) => { try { localStorage.setItem('elaina_galgame_' + k, v); } catch (e) {} };
  const safeTip = (msg) => {
    try {
      if (typeof window.PetShowTip === 'function') { window.PetShowTip(msg); return; }
      console.log('[elaina]', msg);
    } catch (e) {}
  };

  /* 未配置网关时自动 seed 默认地址（正式版：PC/安卓通用；开源版注入为空则不填） */
  (function seedGateway() {
    try {
      let st = JSON.parse(localStorage.getItem('elaina_settings') || '{}');
      let gw = window.__PC_DEFAULT_GW || '';
      /* OCR GW-MIGRATE：旧域名 → 新 IP 一次性迁移（https 域名在部分 WebView 不可用） */
      try {
        const OLD_HOSTS = ['https://elainachat.j3.ink', 'http://elainachat.j3.ink'];
        if (st.baseUrl && OLD_HOSTS.indexOf(String(st.baseUrl).replace(/\/+$/, '')) >= 0) {
          st.baseUrl = 'http://106.14.16.68';
          localStorage.setItem('elaina_settings', JSON.stringify(st));
          if (typeof state !== 'undefined' && state.settings) state.settings.baseUrl = st.baseUrl;
        }
      } catch (e) {}
      function write(v) {
        if (!v || st.baseUrl) return;
        st.baseUrl = v;
        try { localStorage.setItem('elaina_settings', JSON.stringify(st)); } catch (e) {}
        try { if (typeof state !== 'undefined' && state.settings) state.settings.baseUrl = v; } catch (e) {}
      }
      if (gw) { write(gw); return; }
      /* 原生/网页：从同目录 config.json 读取默认网关（不存在则跳过） */
      try {
        fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (cfg) { if (cfg && cfg.gatewayUrl) write(cfg.gatewayUrl); })
          .catch(function () {});
      } catch (e) {}
    } catch (e) {}
  })();

  try {
    if (window.__PC_DESKTOP && window.chrome && window.chrome.webview) {
      setTimeout(function () {
        try {
          let o = JSON.parse(localStorage.getItem('elaina_settings') || '{}');
          window.chrome.webview.postMessage({ kind: 'gateway', payload: o.baseUrl || '' });
        } catch (e) {}
      }, 1500);
    }
  } catch (e) {}
  try {
    if (window.__PC_DESKTOP && window.__PC_DEFAULT_GW) {
      const st = localStorage.getItem('elaina_settings');
      if (st) {
        const o = JSON.parse(st);
        if (!o.baseUrl) { o.baseUrl = window.__PC_DEFAULT_GW; localStorage.setItem('elaina_settings', JSON.stringify(o)); }
      }
    }
  } catch (e) {}
  const ICON = {
    folder: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>',
    import: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>',
    export: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 4v12m0 0l-4-4m4 4l4-4"/></svg>',
    sparkle: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/></svg>',
    plus: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/></svg>',
    chev: '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>'
  };

  let activeMenu = null;
  function closeMenu() { if (activeMenu) { activeMenu.remove(); activeMenu = null; } }
  function openMenu(anchor, items) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'sw-menu';
    menu.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it === '-') { const s = document.createElement('div'); s.className = 'sw-menu-sep'; menu.appendChild(s); return; }
      if (it.caption) { const c = document.createElement('div'); c.className = 'sw-menu-caption'; c.textContent = it.caption; menu.appendChild(c); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw-menu-item';
      b.setAttribute('role', 'menuitem');
      b.innerHTML = (ICON[it.icon] || '') + '<span>' + it.label + '</span>';
      b.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); try { it.run && it.run(); } catch (e) { try { console.warn('[theme-menu]', e); } catch (_) {} } });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 8;
    let left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 10);
    if (menu.offsetHeight > 0 && top + menu.offsetHeight > window.innerHeight - 10) {
      top = Math.max(10, r.top - menu.offsetHeight - 8);
    }
    menu.style.top = top + 'px';
    menu.style.left = Math.max(10, left) + 'px';
    activeMenu = menu;
  }
  document.addEventListener('click', (e) => { if (activeMenu && !activeMenu.contains(e.target) && !(e.target.closest && e.target.closest('.sw-menu-btn, .sw-chev'))) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);

  function safe(fn, label) { try { fn(); } catch (e) { try { console.warn('[theme-menu] ' + label, e); } catch (_) {} } }

  /* ---- 1) 侧栏动作行：主按钮 + “…” 菜单 ---- */
  safe(() => {
    const main = document.getElementById('newConversationBtn');
    const grid = main ? main.parentElement : null;
    if (!main || !grid) return;
    const row = document.createElement('div');
    row.className = 'sw-action-row';
    grid.insertBefore(row, main);
    row.appendChild(main);
    // 内联隐藏原小按钮（防外部样式覆盖）
    try {
      const hide = (id) => { const el = document.getElementById(id); if (el) { el.style.setProperty('display', 'none', 'important'); } };
      hide('sidebarMemoryImportBtn');
      hide('newCategoryBtn');
    } catch (e) {}
    main.classList.add('sw-main-btn');
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'sw-menu-btn';
    menuBtn.title = '更多操作';
    menuBtn.innerHTML = ICON.plus;
    row.appendChild(menuBtn);
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openMenu(menuBtn, [
        { caption: '会话' },
        { icon: 'folder', label: '新建文件夹', run: () => safe(() => window.promptCreateCategory(), 'promptCreateCategory') },
        { icon: 'import', label: '导入记忆', run: () => safe(() => window.showMemoryImportDialog(), 'showMemoryImportDialog') },
        { icon: 'export', label: '导出记忆', run: () => safe(() => window.showMemoryExportDialog('all'), 'showMemoryExportDialog') }
      ]);
    });
  }, 'sidebar menu');

  /* ---- 2) 头部“整理记忆” → 下拉箭头菜单 ---- */
  safe(() => {
    const btn = document.getElementById('headerMemoryBtn');
    if (!btn || btn.querySelector('.sw-chev')) return;
    const chev = document.createElement('span');
    chev.className = 'sw-chev';
    chev.innerHTML = ICON.chev;
    btn.appendChild(chev);
    chev.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openMenu(chev, [
        { icon: 'sparkle', label: '立即整理记忆', run: () => safe(() => window.runManualMemorySummary(), 'runManualMemorySummary') },
        { icon: 'export', label: '导出记忆', run: () => safe(() => window.showMemoryExportDialog('all'), 'showMemoryExportDialog') },
        { icon: 'import', label: '导入记忆', run: () => safe(() => window.showMemoryImportDialog(), 'showMemoryImportDialog') }
      ]);
    });
  }, 'header menu');


  /* ---- 4) 主题切换：头部按钮 + 设置外观行 + 持久化 ---- */
  const THEME_KEY = 'elaina_theme';
  const setTheme = (v) => {
    try {
      document.documentElement.setAttribute('data-theme', v);
      localStorage.setItem(THEME_KEY, v);
    } catch (e) {}
    syncThemeUI();
  };
  const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const ICON_MOON = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';
  const ICON_SUN = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4l1.4-1.4"/></svg>';
  let themeBtn = null;
  let themeSwitch = null;
  const syncThemeUI = () => {
    const dark = currentTheme() === 'dark';
    if (themeBtn) themeBtn.innerHTML = dark ? ICON_SUN : ICON_MOON;
    if (themeSwitch) themeSwitch.classList.toggle('on', dark);
  };
  // 头部按钮（插在“整理记忆”前面）
  safe(() => {
    const anchor = document.getElementById('headerMemoryBtn');
    const header = anchor ? anchor.parentElement : null;
    if (!header || header.querySelector('.sw-theme-btn')) return;
    themeBtn = document.createElement('button');
    themeBtn.type = 'button';
    themeBtn.className = 'sw-theme-btn';
    themeBtn.title = '切换深色/浅色模式';
    themeBtn.setAttribute('aria-label', '切换深色/浅色模式');
    header.insertBefore(themeBtn, anchor);
    themeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
    syncThemeUI();
  }, 'theme button');
  // 设置页外观行（注入到 settingsContent 顶部）
  safe(() => {
    const content = document.getElementById('settingsContent');
    if (!content || document.getElementById('themeSettingSection')) return;
    const sec = document.createElement('section');
    sec.id = 'themeSettingSection';
    sec.innerHTML =
      '<div class="modal-label flex items-center gap-2"><span class="text-violet-500">✦</span> 外观</div>' +
      '<div class="sw-setting-theme-row" id="themeSettingRow">' +
      '<div class="sw-ttl">深色模式</div>' +
      '<div class="sw-switch" id="themeSettingSwitch"></div>' +
      '</div>';
    content.insertBefore(sec, content.firstChild);
    themeSwitch = document.getElementById('themeSettingSwitch');
    document.getElementById('themeSettingRow').addEventListener('click', () => {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
    syncThemeUI();
  }, 'theme settings row');

    /* ---- 8) 桌宠设置（Finder「桌宠」分段；全部默认关闭） ---- */
  safe(() => {
    const themeSec = document.getElementById('themeSettingSection');
    if (!themeSec || document.getElementById('petSettingSection')) return;
    /* 手机端已整体移除桌宠（用户要求）：安卓 App 里不渲染这一段，
       也不再有"启用 / 权限引导 / 主动回复"等入口。PC 端桌宠不受影响。 */
    try {
      const capIsNative = !!(window.Capacitor && ((window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
        || window.Capacitor.platform === 'android'));
      if (capIsNative) return;
    } catch (e) {}
    const PK = (k, d) => { try { const v = localStorage.getItem('elaina_pet_' + k); return v === null ? d : v; } catch (e) { return d; } };
    const SK = (k, v) => { try { localStorage.setItem('elaina_pet_' + k, v); } catch (e) {} };
    const sec = document.createElement('section');
    sec.id = 'petSettingSection';
    sec.innerHTML =
      '<div class="modal-label flex items-center gap-2"><span class="text-violet-500">✦</span> 桌宠</div>' +
      '<div class="sw-setting-theme-row sw-pet-enable-row"><div class="sw-ttl">启用桌宠</div><div class="sw-switch off" id="swPetMain"></div></div>' +
      '<div class="sw-setting-theme-row sw-pet-pro-row" style="display:none"><div class="sw-ttl">桌宠主动回复</div><div class="sw-switch off" id="swPetPro"></div></div>' +
      '<div class="sw-setting-theme-row sw-pet-interval-row" style="display:none"><div class="sw-ttl" style="flex:0 0 auto;width:96px">间隔（分钟）</div>' +
      '<input type="range" min="5" max="60" step="5" value="15" class="custom-slider sw-pet-interval-slider" id="swPetInterval" style="flex:1 1 auto;margin-left:10px">' +
      '<span class="sw-ttl" id="swPetIntervalLabel" style="font-weight:600;min-width:72px;text-align:right">15 分钟</span></div>' +
      '<div class="sw-setting-theme-row sw-pet-scale-row" style="display:none"><div class="sw-ttl" style="flex:0 0 auto;width:96px">桌宠尺度</div>' +
      '<div class="sw-setting-theme-row"><div class="sw-ttl">允许拖动桌宠</div><div class="sw-switch" id="swPetDraggable"></div></div>' +

      '<input type="range" min="0.6" max="1.6" step="0.1" value="1" class="custom-slider" id="swPetScale" style="flex:1 1 auto;margin-left:10px">' +
      '<span class="sw-ttl" id="swPetScaleLabel" style="min-width:56px;text-align:right;font-weight:600">100%</span></div>' +
      '<div class="sw-setting-theme-row sw-pet-ct-row" style="display:none"><div class="sw-ttl">内容点击穿透</div><div class="sw-switch off" id="swPetCt"></div></div>' +
      '<div class="sw-setting-theme-row sw-pet-perm-row" style="display:none"><div class="sw-ttl" style="flex:1 1 auto">权限引导（安卓）</div>' +
      '<div style="display:flex;gap:8px;flex:0 0 auto"><button type="button" class="sw-seg sw-perm-btn" data-perm="acc" style="min-height:30px;font-size:11px">无障碍</button>' +
      '<button type="button" class="sw-seg sw-perm-btn" data-perm="overlay" style="min-height:30px;font-size:11px">悬浮窗</button>' +
      '<button type="button" class="sw-seg sw-perm-btn" data-perm="battery" style="min-height:30px;font-size:11px">电池</button>' +
      '<button type="button" class="sw-seg sw-perm-btn" id="sw-perm-shizuku" data-perm="shizuku" style="min-height:30px;font-size:11px">Shizuku保活</button></div></div>' +
      '<p class="text-[11px] text-indigo-300 leading-relaxed" style="padding:8px 4px 0">开启后出现伊蕾娜桌宠（PC 悬浮窗 / 安卓悬浮窗+无障碍读界面）。主动回复开启后每隔设定时长读取当前页面并主动找你说话。安卓首次开启请到权限引导完成授权；可在系统设置里关闭（默认关闭）。</p>';
    themeSec.insertAdjacentElement('afterend', sec);
    const rows = { main: document.getElementById('swPetMain'), pro: document.getElementById('swPetPro'), ct: document.getElementById('swPetCt') };
    const setSwitch = (el, on) => el.classList.toggle('on', !!on);
    const currentScale = () => {
      const v = Number(PK('scale', '1')) || 1;
      return Math.max(0.6, Math.min(1.6, v));
    };
    const syncScale = () => {
      const inp = document.getElementById('swPetScale');
      const lb = document.getElementById('swPetScaleLabel');
      if (inp) inp.value = String(currentScale());
      if (lb) lb.textContent = Math.round(currentScale() * 100) + '%';
    };
    const syncRows = () => {
      const on = PK('enabled', '0') === '1';
      setSwitch(rows.main, on);
      ['pro', 'interval', 'scale', 'ct', 'perm'].forEach(k => {
        const r = sec.querySelector('.sw-pet-' + k + '-row');
        if (r) r.style.display = on ? '' : 'none';
      });
      setSwitch(rows.pro, PK('proactive', '0') === '1');
      setSwitch(rows.ct, PK('clickthrough', '0') === '1');
      const iv = Math.max(5, Math.min(60, Number(PK('interval', '15')) || 15));
      const inp = document.getElementById('swPetInterval');
      if (inp) inp.value = iv;
      const lb = document.getElementById('swPetIntervalLabel');
      if (lb) lb.textContent = iv + ' 分钟';
      syncScale();
      /* 缩略图由 galgame.js 自管理 */
      const sg = document.getElementById('swGgAiBg');
      if (sg) sg.classList.toggle('on', GV('aiBg', '1') === '1');
      const fx0 = GV('fx', 'auto');
      sec.querySelectorAll('.sw-gg-fx').forEach(b => b.classList.toggle('active', b.getAttribute('data-fx') === fx0));
    };
    document.querySelector('.sw-pet-enable-row .sw-switch').addEventListener('click', (ev) => {
      ev.stopPropagation();
      SK('enabled', PK('enabled', '0') === '1' ? '0' : '1');
      /* OCR A2：与服务真实状态同步（服务停止时 Java 侧已置 enabled=false，避免开关仍显示"开"） */
    try {
      const cap = (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.ElainaPet) ? Capacitor.Plugins.ElainaPet : null;
      if (cap && typeof cap.getStatus === 'function') {
        cap.getStatus().then(function (st) {
          try {
            if (st && st.enabled === false && PK('enabled', '0') === '1') { SK('enabled', '0'); syncRows(); }
          } catch (e) {}
        }).catch(function () {});
      }
    } catch (e) {}
    syncRows();
      notifyPet();
    });
    document.querySelector('.sw-pet-pro-row .sw-switch').addEventListener('click', (ev) => {
      ev.stopPropagation();
      SK('proactive', PK('proactive', '0') === '1' ? '0' : '1');
      syncRows(); notifyPet();
    });
    document.querySelector('.sw-pet-ct-row .sw-switch').addEventListener('click', (ev) => {
      ev.stopPropagation();
      SK('clickthrough', PK('clickthrough', '0') === '1' ? '0' : '1');
      syncRows(); notifyPet();
    });
    const inp = document.getElementById('swPetInterval');
    inp.addEventListener('input', () => {
      const lb = document.getElementById('swPetIntervalLabel');
      if (lb) lb.textContent = inp.value + ' 分钟';
    });
    inp.addEventListener('change', () => { SK('interval', String(inp.value)); notifyPet(); });
    /* 拖动开关（安卓悬浮窗位置可调） */

    const dragSw = document.getElementById('swPetDraggable');

    if (dragSw) {

      const paint = () => dragSw.classList.toggle('on', PK('draggable', '1') === '1');

      paint();

      dragSw.addEventListener('click', () => {

        const next = PK('draggable', '1') !== '1';

        SK('draggable', next ? '1' : '0');

        paint();

        notifyPet();

      });

    }

    const scaleInp = document.getElementById('swPetScale');
    scaleInp.addEventListener('input', () => {
      const lb = document.getElementById('swPetScaleLabel');
      if (lb) lb.textContent = Math.round(Number(scaleInp.value) * 100) + '%';
    });
    scaleInp.addEventListener('change', () => { SK('scale', String(scaleInp.value)); notifyPet(); });
    sec.querySelectorAll('.sw-perm-btn').forEach(b => b.addEventListener('click', () => {
      try {
        const cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ElainaPet;
        if (!cap) { safeTip('仅安卓端生效（当前为网页/PC 环境）'); return; }
        const perm = b.getAttribute('data-perm');
        if (perm === 'acc') cap.openAccessibilitySettings();
        else if (perm === 'overlay') cap.openOverlaySettings();
        else if (perm === 'shizuku') {
          cap.requestShizuku().then(function (r) {
            safeTip(r && r.granted ? 'Shizuku 已授权，已自动开启无障碍并加入保活白名单' : '已请求 Shizuku 授权，请在弹窗中允许');
          }).catch(function (e) {
            safeTip('Shizuku：' + ((e && e.message) || '未安装或未启动 Shizuku'));
          });
        }
        else cap.openBatteryWhitelist();
      } catch (e) {}
    }));
    /* 供 C# 侧广播：在桌宠窗里点 ✕ 关掉桌宠后，把"已关闭"同步回设置界面。
       只写 localStorage 是不够的 —— 设置面板如果正开着，开关和依赖行不会自己刷新，
       用户会看到"桌宠已经关了，但设置里还显示已开启"。 */
    window.ElainaPetSetEnabled = function (on) {
      try {
        SK('enabled', on ? '1' : '0');
        syncRows();
        notifyPet();
        window.dispatchEvent(new CustomEvent('elaina-pet-changed', { detail: { enabled: !!on } }));
      } catch (e) {}
    };

    function notifyPet() {
      const on = PK('enabled', '0') === '1';
      try {
        const cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ElainaPet;
        if (cap) {
          let st = {};
          try { st = (typeof state !== 'undefined' && state.settings) ? state.settings : {}; } catch (e) {}
          cap.setEnabled({
            enabled: on,
            baseUrl: String(st.baseUrl || ''),
            apiKey: String(st.apiKey || ''),
            systemPrompt: String(st.characterPrompt || ''),
            interval: Number(PK('interval', '15')) || 15,
            proactive: PK('proactive', '0') === '1',
            scale: Number(PK('scale', '1')) || 1,
            model: (function(){ try { return (state.settings && state.settings.model) || ''; } catch(e){ return ''; } })(),
          clickthrough: PK('clickthrough', '0') === '1',

          draggable: PK('draggable', '1') === '1'
          });
        }
      } catch (e) {}
      try {
        if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage({ kind: 'pet-enabled', payload: on });
      } catch (e) {}
    }
    syncRows();
  }, 'pet settings');


  /* ---- 9) Galgame 界面设置（Finder「Galgame」段；默认关闭） ---- */
  safe(() => {
    /* 注意：Galgame 段以前是插在桌宠段后面的，于是"桌宠段不存在"时整段被 return 掉。
       手机端移除桌宠后正是这种情况 —— Galgame 设置整个消失。现在回退到插在外观段之后。 */
    const petSec = document.getElementById('petSettingSection');
    if (document.getElementById('galgameSettingSection')) return;
    const sec = document.createElement('section');
    sec.id = 'galgameSettingSection';
    sec.innerHTML =
      '<div class="modal-label flex items-center gap-2"><span class="text-violet-500">✦</span> Galgame 界面</div>' +
      '<div class="sw-setting-theme-row" id="ggEnableRow"><div class="sw-ttl">启用 Galgame 界面</div><div class="sw-switch off" id="swGgMain"></div></div>' +
      '<div class="sw-setting-theme-row gg-row" style="display:none;flex-direction:column;align-items:stretch"><div class="sw-ttl" style="width:auto;margin-bottom:6px">背景场景</div>' +
      '<div id="swGgSceneList" style="display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;scrollbar-width:none"></div></div>' +
      '<div class="sw-setting-theme-row gg-row" id="ggAiBgRow" style="display:none"><div class="sw-ttl" style="flex:1 1 auto">背景跟随 AI（由剧情自动切换）</div><div class="sw-switch on" id="swGgAiBg"></div></div>' +
      '<div class="sw-setting-theme-row gg-row" style="display:none"><div class="sw-ttl" style="flex:0 0 auto;width:96px">背景特效</div>' +
      '<div style="display:flex;gap:6px;flex:1 1 auto;margin-left:10px">' +
      '<button type="button" class="sw-seg sw-gg-fx" data-fx="auto" style="min-height:30px;flex:1;font-size:11px">随场景</button>' +
      '<button type="button" class="sw-seg sw-gg-fx" data-fx="none" style="min-height:30px;flex:1;font-size:11px">无</button>' +
      '<button type="button" class="sw-seg sw-gg-fx" data-fx="star" style="min-height:30px;flex:1;font-size:11px">星空</button>' +
      '<button type="button" class="sw-seg sw-gg-fx" data-fx="rain" style="min-height:30px;flex:1;font-size:11px">雨</button>' +
      '<button type="button" class="sw-seg sw-gg-fx" data-fx="petal" style="min-height:30px;flex:1;font-size:11px">樱花瓣</button>' +
      '<button type="button" class="sw-seg sw-gg-fx" data-fx="snow" style="min-height:30px;flex:1;font-size:11px">雪</button></div></div>' +
      '<div class="sw-setting-theme-row gg-row" style="display:none"><div class="sw-ttl" style="flex:0 0 auto;width:96px">打字速度</div>' +
      '<input type="range" min="8" max="60" step="4" value="24" class="custom-slider" id="swGgSpeed" style="flex:1 1 auto;margin-left:10px">' +
      '<span class="sw-ttl" id="swGgSpeedLabel" style="min-width:70px;text-align:right;font-weight:600">正常</span></div>' +
      '<div class="sw-setting-theme-row gg-row" style="display:none"><div class="sw-ttl" style="flex:0 0 auto;width:96px">对话框浓度</div>' +
      '<input type="range" min="0.35" max="0.9" step="0.05" value="0.62" class="custom-slider" id="swGgAlpha" style="flex:1 1 auto;margin-left:10px">' +
      '<span class="sw-ttl" id="swGgAlphaLabel" style="min-width:58px;text-align:right;font-weight:600">62%</span></div>' +
      '<div class="sw-setting-theme-row gg-row" style="display:none"><div class="sw-ttl" style="flex:0 0 auto;width:96px">立绘大小</div>' +
      '<input type="range" min="0.6" max="1.3" step="0.1" value="1" class="custom-slider" id="swGgScale" style="flex:1 1 auto;margin-left:10px">' +
      '<span class="sw-ttl" id="swGgScaleLabel" style="min-width:58px;text-align:right;font-weight:600">100%</span></div>' +
      '<div class="sw-setting-theme-row gg-row" style="display:none"><div class="sw-ttl" style="flex:1 1 auto">进入 Galgame 界面</div>' +
      '<button type="button" class="sw-seg" id="ggEnterBtn" style="min-height:32px;padding:0 16px">立即进入 ▶</button></div>' +
      '<p class="text-[11px] text-indigo-300 leading-relaxed" style="padding:8px 4px 0">Galgame 界面与主界面共用同一份对话数据；可在界面右上角「退出 Galgame」或在此关闭开关（默认关闭）。</p>';
    const anchor = petSec || document.getElementById('themeSettingSection');
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', sec);
    else if (sec.parentNode == null) return;
    const sw = document.getElementById('swGgMain');
    const rows = () => sec.querySelectorAll('.gg-row');
    const speedLabel = (v) => { const n = Number(v) || 24; return n <= 12 ? '快' : n >= 44 ? '慢' : '正常'; };
    const sync = () => {
      const on = GV('enabled', '0') === '1';
      sw.classList.toggle('on', on);
      rows().forEach(r => { r.style.display = on ? '' : 'none'; });
      const sp = document.getElementById('swGgSpeed'); if (sp) sp.value = GV('speed', '24');
      const spL = document.getElementById('swGgSpeedLabel'); if (spL) spL.textContent = speedLabel(GV('speed', '24'));
      const al = document.getElementById('swGgAlpha'); if (al) al.value = GV('alpha', '0.62');
      const alL = document.getElementById('swGgAlphaLabel'); if (alL) alL.textContent = Math.round((Number(GV('alpha', '0.62')) || 0.62) * 100) + '%';
      const sc = document.getElementById('swGgScale'); if (sc) sc.value = GV('scale', '1');
      const scL = document.getElementById('swGgScaleLabel'); if (scL) scL.textContent = Math.round((Number(GV('scale', '1')) || 1) * 100) + '%';
    };
    sw.addEventListener('click', (ev) => {
      ev.stopPropagation();
      GS('enabled', GV('enabled', '0') === '1' ? '0' : '1');
      sync();
      try { window.ElainaGalgame && window.ElainaGalgame.refresh(); } catch (e) {}
    });
    ['Speed', 'Alpha', 'Scale'].forEach((k) => {
      const inp = document.getElementById('swGg' + k);
      if (!inp) return;
      inp.addEventListener('input', () => {
        const val = k === 'Alpha' ? Math.round(inp.value * 100) + '%' : (k === 'Scale' ? Math.round(inp.value * 100) + '%' : speedLabel(inp.value));
        const lb = document.getElementById('swGg' + k + 'Label');
        if (lb) lb.textContent = val;
      });
      inp.addEventListener('change', () => {
        GS(k.toLowerCase(), String(inp.value));
        try { window.ElainaGalgame && window.ElainaGalgame.refresh(); } catch (e) {}
      });
    });
    sec.querySelectorAll('.sw-gg-fx').forEach(b => b.addEventListener('click', () => {
      GS('fx', b.getAttribute('data-fx'));
      sync();
      try { window.ElainaGalgame && window.ElainaGalgame.refresh(); } catch (e) {}
    }));
    document.getElementById('ggEnterBtn').addEventListener('click', () => {
      GS('enabled', '1');
      sync();
      try { window.ElainaGalgame && window.ElainaGalgame.refresh(); } catch (e) {}
    });
    /* 界面内退出后同步开关显示 */
    document.addEventListener('elaina-galgame-changed', sync);
    sync();
  }, 'galgame settings');

  /* ---- 5) Finder 顶栏：设置分段导航（元素定位分组）+ 分块切换 + 滑动动画 ---- */
  safe(() => {
    const content = document.getElementById('settingsContent');
    if (!content || content.querySelector('.sw-setting-nav')) return;
    const secs = Array.from(content.querySelectorAll(':scope > section'));
    if (secs.length < 3) return;
    const labelOf = (s) => { const l = s.querySelector('.modal-label'); return l ? l.textContent || '' : ''; };
    const findIdx = (pred) => secs.findIndex(pred);
    const idx = {
      theme: findIdx(s => s.id === 'themeSettingSection'),
      pet: findIdx(s => s.id === 'petSettingSection'),
      galgame: findIdx(s => s.id === 'galgameSettingSection'),
      char: findIdx(s => s.id === 'characterSettingsSection'),
      cloud: findIdx(s => labelOf(s).indexOf('云端连接') >= 0),
      voice: findIdx(s => labelOf(s).indexOf('语音输出') >= 0),
      asr: findIdx(s => labelOf(s).indexOf('语音输入') >= 0),
      mem: findIdx(s => labelOf(s).indexOf('记忆') >= 0 && labelOf(s).indexOf('日志') < 0),
      log: findIdx(s => labelOf(s).indexOf('日志') >= 0)
    };
    const groups = [
      { label: '外观', idx: [idx.theme] },
      { label: '连接', idx: [idx.cloud, idx.asr] },
      { label: '语音', idx: [idx.voice] },
      { label: '记忆与日志', idx: [idx.mem, idx.log] },
      { label: '角色设定', idx: [idx.char] },
      { label: '桌宠', idx: [idx.pet] },
      { label: 'Galgame', idx: [idx.galgame] }
    ].filter(g => g.idx.every(i => i >= 0));
    const nav = document.createElement('div');
    nav.className = 'sw-setting-nav';
    content.insertBefore(nav, content.firstChild);
    const segs = [];
    let prev = 0;
    const apply = (gi, animate) => {
      const visible = new Set(groups[gi].idx);
      secs.forEach((s, si) => {
        const show = visible.has(si);
        if (show) s.classList.remove('hidden');
        else s.classList.add('hidden');
        if (show && animate) {
          s.classList.remove('sw-tab-anim-r', 'sw-tab-anim-l', 'sw-tab-anim');
          if (gi > prev) { s.classList.add('sw-tab-anim-l'); void s.offsetWidth; }
          else if (gi < prev) { s.classList.add('sw-tab-anim-r'); void s.offsetWidth; }
          else { s.classList.add('sw-tab-anim'); void s.offsetWidth; }
        }
      });
      segs.forEach((seg, si) => seg.classList.toggle('active', si === gi));
      prev = gi;
      try { localStorage.setItem('elaina_settings_tab', groups[gi].label); } catch (e) {}
    };
    groups.forEach((g, gi) => {
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'sw-seg';
      seg.textContent = g.label;
      seg.addEventListener('click', () => { if (!seg.classList.contains('active')) apply(gi, true); });
      nav.appendChild(seg);
      segs.push(seg);
    });
    let initial = 0;
    try {
      const t = localStorage.getItem('elaina_settings_tab');
      const ti = groups.findIndex(g => g.label === t);
      if (ti >= 0) initial = ti;
    } catch (e) {}
    apply(initial, false);
  }, 'settings nav');


  /* ---- 6) 语音 seek：长按放大 → 声纹分段（已播/未播）→ 按住拖动跳转 ---- */
  safe(() => {
    let pressTimer = null;
    let seeking = false;
    let suppressed = false;
    let startX = 0, startY = 0;
    let card = null, wf = null, msgId = null;
    /* OCR M9：lastTouchTs 以前从未声明，onTouchStart/onMouseDown 一执行就抛
       ReferenceError: lastTouchTs is not defined（已用 pageerror 实测复现），
       pressStart 永远不会被执行 —— 这就是「PC 上语音条拖不动」的直接原因。 */
    let lastTouchTs = 0;
    let ratio = 0;

    const SPIKES = 15;
    const buildSpikes = (waveEl) => {
      const svg = waveEl.querySelector('svg');
      if (!svg) return;
      const d = svg.querySelector('path') ? svg.querySelector('path').getAttribute('d') : '';
      const heights = [];
      const re = /M (\d+(?:\.\d+)?) ([\d.]+) v ([\d.]+)/g;
      let m;
      while ((m = re.exec(d)) && heights.length < SPIKES) heights.push(parseFloat(m[3]));
      const wrap = document.createElement('span');
      wrap.className = 'wf-spikes';
      for (let i = 0; i < SPIKES; i++) {
        const h = heights[i] || 8;
        const sp = document.createElement('i');
        sp.className = 'wf-spike';
        sp.style.height = (h / 22 * 100) + '%';
        wrap.appendChild(sp);
      }
      svg.replaceWith(wrap);
    };
    const applyRatioTo = (wfEl, r) => {
      if (!wfEl) return;
      const n = Math.round(r * SPIKES);
      const spikes = wfEl.querySelectorAll('.wf-spike');
      spikes.forEach((s, i) => s.classList.toggle('on', i < n));
    };
    const applyRatio = (r) => { applyRatioTo(wf, r); };
    const wfRect = () => wf ? wf.getBoundingClientRect() : null;
    const ratioFromEvent = (ev) => {
      const rect = wfRect();
      if (!rect) return 0;
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      return Math.max(0, Math.min(1, x / Math.max(1, rect.width)));
    };
    const pressStart = (ev, target) => {
      if (!(window.TouchEvent && ev.type === 'touchstart') && ev.type !== 'mousedown') return;
      const c = target.closest('.ai-voice-card');
      if (!c || seeking) return;
      card = c;
      wf = card.querySelector('.voice-waveform');
      if (!wf) return;
      /* 语音条与消息区职责分离（用户要求）：
         只有按在"波形条"上才进入拖动 seek；按在播放圆钮/时长/气泡文字上仍是普通点击，
         避免想选字或点播放时被误判成跳转。 */
      const onWave = !!(target && target.closest && target.closest('.voice-waveform') === wf);
      if (!onWave) return;
      const btn = card.querySelector('[id^="voice-player-"]');
      msgId = btn ? btn.id.replace('voice-player-', '') : null;
      if (!btn) return;
      startX = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      startY = (ev.touches ? ev.touches[0].clientY : ev.clientY);
      /* 波形条本身就是进度条：按下即进入 seek（不必再等 480ms 长按），
         并且和播放推进共用同一个 ratio → 波形点亮动画始终同步。 */
      pressTimer = null;
      seeking = true;
      window.__voiceSeeking = true;
      suppressed = true;
      if (!wf.querySelector('.wf-spikes')) buildSpikes(wf);
      card.classList.add('voice-zoomed');
      ratio = ratioFromEvent(ev); applyRatio(ratio);
    };
    const pressMove = (ev) => {
      if (!seeking || !card || !wf) return;
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      const y = (ev.touches ? ev.touches[0].clientY : ev.clientY);
      if (Math.abs(x - startX) > 6 || Math.abs(y - startY) > 6) {
        if (ev.cancelable) ev.preventDefault();
        ratio = ratioFromEvent(ev);
        applyRatio(ratio);
      }
    };
    const pressEnd = () => {
      /* 关键修复（「拖动语音条后不在拖动位置播放」的根因）：
         resetSeek(false) 会把 seeking 置回 false，而紧接着的判断又在读 seeking ——
         条件恒为真，函数直接 return：跳转永远不执行，还把 suppressed 清掉，
         于是"拖动"退化成一次普通的播放/暂停点击。
         正确做法是先把"到底有没有在拖动"和 ratio/msgId 抓出来，再复位。 */
      const wasSeeking = seeking;
      const c = card;
      const r = ratio;
      const id = msgId;
      resetSeek(false);
      card = c; msgId = id; ratio = r;

      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!wasSeeking || !c) { suppressed = false; return; }

      card = null; seeking = false;
      window.__voiceSeeking = false;
      const info2 = window.__voiceSeekInfo ? window.__voiceSeekInfo() : { ok: false };
      if (info2.ok) {
        /* 已有音源：交给全局引擎跳转（成功后会写入 __voicePlaybackStart，进度条随之同步） */
        try { window.__voiceSeek(r, id); } catch (e) {}
      } else {
        /* 首次播放前：记下目标位置并自动开始播放；音频就位后直接从目标处起播 */
        try { window.__voicePendingSeek = { ratio: r, msgId: id, at: Date.now() }; } catch (e) {}
        try { if (typeof replayAIMessage === 'function') replayAIMessage(id); } catch (e) {}
      }
      setTimeout(() => { try { c.classList.remove('voice-zoomed'); } catch (e) {} }, 1300);
      setTimeout(() => { suppressed = false; }, 200);
    };
    /* OCR 二轮 N2：取消路径必须彻底复位（seeking/card/wf/ratio/zoom），否则 seeking 永久为 true */
    const resetSeek = (dropRefs) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (dropRefs && typeof card !== 'undefined' && card) { try { card.classList.remove('voice-zoomed'); } catch (e) {} }
      if (dropRefs) { try { card = null; wf = null; msgId = null; ratio = 0; } catch (e) {} }
      try { seeking = false; window.__voiceSeeking = false; } catch (e) {}
    };
    const pressCancel = () => { resetSeek(true); };

    const onTouchStart = (ev) => { lastTouchTs = Date.now(); pressStart(ev, ev.target); };
    const onMouseDown = (ev) => { if (Date.now() - lastTouchTs < 500) return; pressStart(ev, ev.target); };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', pressMove, { passive: false });
    document.addEventListener('touchend', pressEnd, { passive: true });
    document.addEventListener('touchcancel', pressCancel, { passive: true });
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', pressMove);
    document.addEventListener('mouseup', pressEnd);
    /* OCR S8：鼠标在窗口外松开 / 失焦 / 切后台时兜底复位，避免 seeking 永久卡死 */
    window.addEventListener('blur', pressCancel);
    document.addEventListener('visibilitychange', () => { if (document.hidden) pressCancel(); });
    document.addEventListener('pointercancel', pressCancel);
    document.addEventListener('mouseleave', () => { try { pressCancel(); } catch (e) {} });
    document.addEventListener('click', (ev) => {
      if (suppressed) { ev.stopPropagation(); ev.preventDefault(); }
    }, true);
  }, 'voice seek');

  window.__voiceEnsureSpikes = (waveEl) => {
    try {
      if (!waveEl || waveEl.querySelector('.wf-spikes')) return true;
      const svg = waveEl.querySelector('svg');
      if (!svg) return false;
      const d = svg.querySelector('path') ? svg.querySelector('path').getAttribute('d') : '';
      const re = /M (\d+(?:\.\d+)?) ([\d.]+) v ([\d.]+)/g;
      const heights = [];
      let m;
      while ((m = re.exec(d)) && heights.length < 15) heights.push(parseFloat(m[3]));
      const wrap = document.createElement('span');
      wrap.className = 'wf-spikes';
      for (let i = 0; i < 15; i++) {
        const h = heights[i] || 8;
        const sp = document.createElement('i');
        sp.className = 'wf-spike';
        sp.style.height = (h / 22 * 100) + '%';
        wrap.appendChild(sp);
      }
      svg.replaceWith(wrap);
      return true;
    } catch (e) { return false; }
  };

  /* ---- 6b) 全局声纹进度引擎：播放/拖动/恢复统一推进 ---- */
  safe(() => {
    setInterval(() => {
      try {
        const p = window.__voicePlaybackStart;
        if (!p || !p.msgId || !p.duration) return;
        if (window.__voiceSeeking === true) return;
        if (typeof activeVoicePlaybackStatus !== 'undefined' && activeVoicePlaybackStatus !== 'playing') return;
        const btn = document.getElementById('voice-player-' + p.msgId);
        if (!btn) return;
        const card = btn.closest('.ai-voice-card');
        const wfEl = card ? card.querySelector('.voice-waveform') : null;
        if (!wfEl) return;
        if (!wfEl.querySelector('.wf-spikes')) { if (!window.__voiceEnsureSpikes(wfEl)) return; }
        const el = (Date.now() - p.at) / 1000;
        const r = Math.min(1, (p.offset + el) / Math.max(0.001, p.duration));
        window.__voicePlaybackRatio = r;
        const n = Math.round(r * 15);
        wfEl.querySelectorAll('.wf-spike').forEach((s2, i) => s2.classList.toggle('on', i < n));
        if (r >= 1) window.__voicePlaybackStart = null;
      } catch (e) {}
    }, 250);
  }, 'voice engine');

  /* ---- 7) 外观模板选择器（设置·外观 Finder 色板栏） ---- */
  safe(() => {
    const sec = document.getElementById('themeSettingSection');
    const row = document.getElementById('themeSettingRow');
    if (!sec || !row || document.getElementById('themeThemePicker')) return;
    const TEMPLATES = [
      { id: 'ios', name: 'iOS 蓝', dots: ['#007aff', '#8ab4ff', '#eef1f5'] },
      { id: 'claude', name: '陶土橙', dots: ['#d97757', '#eab38f', '#f6f2ed'] },
      { id: 'sage', name: '鼠尾草', dots: ['#4f9d7d', '#9cc9b4', '#eef3ee'] },
      { id: 'sakura', name: '樱花桃', dots: ['#d97b93', '#f0b6c4', '#f8f1f3'] }
    ];
    const TPL_KEY = 'elaina_theme_template';
    const currentTpl = () => {
      try { const v = document.documentElement.getAttribute('data-theme-template') || localStorage.getItem(TPL_KEY) || 'ios'; return v; } catch (e) { return 'ios'; }
    };
    const setTpl = (id) => {
      try {
        if (id === 'ios') document.documentElement.removeAttribute('data-theme-template');
        else document.documentElement.setAttribute('data-theme-template', id);
        localStorage.setItem(TPL_KEY, id);
      } catch (e) {}
      document.querySelectorAll('.sw-template-card').forEach(c => c.classList.toggle('active', c.getAttribute('data-tpl') === id));
    };
    const label = document.createElement('div');
    label.className = 'sw-template-label';
    label.textContent = '外观模板';
    const picker = document.createElement('div');
    picker.id = 'themeThemePicker';
    picker.className = 'sw-template-picker';
    TEMPLATES.forEach(t => {
      const card = document.createElement('div');
      card.className = 'sw-template-card';
      card.setAttribute('data-tpl', t.id);
      card.setAttribute('role', 'button');
      card.innerHTML = '<div class="sw-tpl-dots">' + t.dots.map(c => '<span class="sw-tpl-dot" style="background:' + c + '"></span>').join('') + '</div><div class="sw-tpl-name">' + t.name + '</div>';
      card.addEventListener('click', () => setTpl(t.id));
      picker.appendChild(card);
    });
    row.insertAdjacentElement('afterend', label);
    label.insertAdjacentElement('afterend', picker);
    setTpl(currentTpl());
  }, 'template picker');


  /* ---- 10) 滑块填充跟随（所有 .custom-slider：拖动时更新 --slider-progress） ---- */
  safe(() => {
    const sync = (el) => {
      try {
        const min = Number(el.min || 0);
        const max = Number(el.max || 100);
        const v = Number(el.value);
        const pct = ((v - min) / Math.max(1e-6, max - min)) * 100;
        el.style.setProperty('--slider-progress', pct.toFixed(2) + '%');
      } catch (e) {}
    };
    const bindAll = () => {
      document.querySelectorAll('input[type="range"]').forEach((el) => {
        if (el.dataset.sliderBound === '1') { sync(el); return; }
        el.dataset.sliderBound = '1';
        sync(el);
        el.addEventListener('input', () => sync(el));
        el.addEventListener('change', () => sync(el));
        el.addEventListener('pointerdown', () => sync(el));
      });
    };
    bindAll();
    setTimeout(bindAll, 600);
    setInterval(bindAll, 900);
  }, 'slider progress');
})();
