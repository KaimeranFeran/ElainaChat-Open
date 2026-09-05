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
})();
