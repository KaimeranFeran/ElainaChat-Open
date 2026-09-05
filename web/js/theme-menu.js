/* ElainaChat · Theme Menu（Swift 风格二级菜单注入层）
   视觉层：捕获现有小按钮 → 由主按钮 + 弹出菜单取代；
   全部调用现有全局函数（promptCreateCategory/showMemoryImportDialog/
   showMemoryExportDialog/runManualMemorySummary），不改变任何业务逻辑。 */
(() => {
  'use strict';
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
  const explode = new Set(['submit']);
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

  /* ---- 5) Finder 顶栏：设置分段导航 + 分块切换 + 滑动动画 ---- */
  safe(() => {
    const content = document.getElementById('settingsContent');
    if (!content || content.querySelector('.sw-setting-nav')) return;
    const secs = Array.from(content.querySelectorAll(':scope > section'));
    if (secs.length < 3) return;
    // 分组（按注入后的静态顺序）
    const groups = [
      { label: '外观', idx: [0] },
      { label: '连接', idx: [1, 3] },
      { label: '语音', idx: [2] },
      { label: '记忆与日志', idx: [4, 5] },
      { label: '角色设定', idx: [6] }
    ];
    const nav = document.createElement('div');
    nav.className = 'sw-setting-nav';
    content.insertBefore(nav, content.firstChild);
    const segs = [];
    let prev = 0;
    const apply = (gi, animate) => {
      const visible = new Set(groups[gi].idx);
      secs.forEach((s, si) => {
        const show = visible.has(si);
        const old = s.classList.contains('hidden');
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
      try { localStorage.setItem('elaina_settings_tab', String(gi)); } catch (e) {}
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
    try { const t = parseInt(localStorage.getItem('elaina_settings_tab') || '0', 10); if (!isNaN(t) && t >= 0 && t < groups.length) initial = t; } catch (e) {}
    apply(initial, false);
  }, 'settings nav');

  /* ---- 6) 语音 seek：长按放大 → 声纹分段（已播/未播）→ 按住拖动跳转 ---- */
  safe(() => {
    let pressTimer = null;
    let seeking = false;
    let suppressed = false;
    let startX = 0, startY = 0;
    let card = null, wf = null, msgId = null;
    let ratio = 0;
    let progressTimer = null;

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
    const applyRatio = (r) => {
      if (!wf) return;
      const n = Math.round(r * SPIKES);
      const spikes = wf.querySelectorAll('.wf-spike');
      spikes.forEach((s, i) => s.classList.toggle('on', i < n));
    };
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
      const btn = card.querySelector('[id^="voice-player-"]');
      msgId = btn ? btn.id.replace('voice-player-', '') : null;
      if (!btn) return;
      startX = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      startY = (ev.touches ? ev.touches[0].clientY : ev.clientY);
      pressTimer = setTimeout(() => {
        pressTimer = null;
        seeking = true;
        suppressed = true;
        if (!wf.querySelector('.wf-spikes')) buildSpikes(wf);
        card.classList.add('voice-zoomed');
        ratio = 0; applyRatio(0);
      }, 480);
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
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!seeking || !card) { if (pressTimer === null) suppressed = false; return; }
      const c = card;
      card = null; seeking = false;
      const r = ratio;
      const info = window.__voiceSeekInfo ? window.__voiceSeekInfo() : { ok: false };
      if (info.ok) {
        try { window.__voiceSeek(r, msgId); } catch (e) {}
        const d = info.duration || 0;
        const at = Date.now();
        progressTimer = setInterval(() => {
          const el = (Date.now() - at) / 1000;
          const r2 = Math.min(1, ((r * d) + el) / Math.max(0.001, d));
          applyRatio(r2);
          if (r2 >= 1) { clearInterval(progressTimer); progressTimer = null; }
        }, 300);
      }
      setTimeout(() => { c.classList.remove('voice-zoomed'); }, 1300);
      setTimeout(() => { suppressed = false; }, 200);
    };
    const pressCancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    let lastTouchTs = 0;
    const onTouchStart = (ev) => { lastTouchTs = Date.now(); pressStart(ev, ev.target); };
    const onMouseDown = (ev) => { if (Date.now() - lastTouchTs < 500) return; pressStart(ev, ev.target); };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', pressMove, { passive: false });
    document.addEventListener('touchend', pressEnd, { passive: true });
    document.addEventListener('touchcancel', pressCancel, { passive: true });
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', pressMove);
    document.addEventListener('mouseup', pressEnd);
    document.addEventListener('click', (ev) => {
      if (suppressed) { ev.stopPropagation(); ev.preventDefault(); }
    }, true);
  }, 'voice seek');

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

})();
