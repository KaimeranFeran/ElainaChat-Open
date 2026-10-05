/* ElainaChat · 聊天平台接入（把 QQ / Telegram / 通用 Webhook 接进伊蕾娜）
   ------------------------------------------------------------------
   参考 AstrBot 的平台适配层（astrbot/core/platform/sources/*）划的范围，这里各取一条最常用、且
   **纯出站**就能跑通的路（PC 的 WebView2 与安卓 WebView 都不需要监听端口，也不需要云端中转）：

     · AstrBot aiocqhttp（OneBot v11 / QQ：NapCat、Lagrange、go-cqhttp…）
         → 本文件 onebot  适配器：正向 WebSocket **客户端**，连上去收 message 事件，send_*_msg 回消息
     · AstrBot telegram
         → 本文件 telegram 适配器：Bot API 长轮询（getUpdates / sendMessage）
     · AstrBot webchat / satori 一类"自建桥"
         → 本文件 webhook  适配器：通用 HTTP 拉取新消息 + POST 回复（约定见 README 段落说明）

   硬性约束（与设备互联同一口径）：
     · 密钥/令牌只落本地 localStorage，**绝不写进日志**（日志里只出现打码后的形状）；
     · 任何失败都给明确状态与可操作提示，不静默；
     · 只处理"被允许的来源"，默认空名单 = 全部允许，但群聊默认**只在被 @ 或带前缀时**才回复，
       避免机器人对着整个群自说自话。
   对外接口（也给自动化验证用）：
     window.ElainaChatPlatforms = {
       mount(sectionEl), start(), stop(), status(), config(), saveConfig(patch),
       connect(id), disconnect(id), clearLog(), handleIncoming(msg), isRunning()
     }
*/
(function (global) {
  'use strict';

  var LS_KEY = 'elaina_platforms_v1';
  var LOG_MAX = 200;
  var AI_TIMEOUT_MS = 180000;

  function core() {
    var c = global.ElainaChatCore;
    return (c && typeof c.conversations === 'function') ? c : null;
  }
  function log2(level, text) {
    try { if (typeof global.appLog === 'function') global.appLog(level, '聊天平台：' + text); } catch (e) {}
    if (level === 'error') { try { console.warn('[chat-platforms] ' + text); } catch (e2) {} }
  }
  /* 令牌打码：只保留头尾，日志里绝不出现完整串 */
  function mask(secret) {
    var s = String(secret || '');
    if (!s) return '(空)';
    if (s.length <= 8) return '***';
    return s.slice(0, 4) + '***' + s.slice(-2);
  }

  /* ==================== 配置 ==================== */

  var DEFAULTS = {
    autoStart: true,
    conversationMode: 'per-source',   /* 'shared' = 都用当前对话；'per-source' = 每个来源单独一间 */
    replyPrefix: '',                  /* 回复前要不要加一句前缀，空 = 不加 */
    allowed: '',                      /* 允许的来源 ID，逗号/换行分隔；空 = 全部允许 */
    groupAtOnly: true,                /* 群聊里只有被 @ 或带触发前缀才回 */
    triggerPrefix: '',                /* 例如 '/'：群聊里以它开头才回（空 = 只看 @） */
    maxReplyChars: 1200,
    platforms: {
      onebot: { enabled: false, wsUrl: 'ws://127.0.0.1:3001', accessToken: '', selfId: '' },
      telegram: { enabled: false, botToken: '', apiBase: 'https://api.telegram.org' },
      webhook: { enabled: false, pollUrl: '', replyUrl: '', token: '', intervalMs: 3000 }
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function merge(base, patch) {
    var out = clone(base);
    if (!patch || typeof patch !== 'object') return out;
    Object.keys(patch).forEach(function (k) {
      if (k === 'platforms' && patch.platforms && typeof patch.platforms === 'object') {
        Object.keys(patch.platforms).forEach(function (p) {
          out.platforms[p] = Object.assign({}, out.platforms[p] || {}, patch.platforms[p] || {});
        });
        return;
      }
      out[k] = patch[k];
    });
    return out;
  }
  function loadConfig() {
    var raw = null;
    try { raw = JSON.parse(global.localStorage.getItem(LS_KEY) || 'null'); } catch (e) { raw = null; }
    return merge(DEFAULTS, raw);
  }
  var config = loadConfig();
  function saveConfig(patch) {
    config = merge(config, patch || {});
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(config)); } catch (e) { log2('warn', '配置写入失败: ' + e.message); }
    render();
    return clone(config);
  }

  /* ==================== 状态与日志 ==================== */

  var state = {
    running: false,
    platforms: {
      onebot: { state: 'off', detail: '未连接', at: 0 },
      telegram: { state: 'off', detail: '未连接', at: 0 },
      webhook: { state: 'off', detail: '未连接', at: 0 }
    }
  };
  var logs = [];
  function pushLog(level, text) {
    logs.push({ t: Date.now(), level: level, text: String(text).slice(0, 300) });
    while (logs.length > LOG_MAX) logs.shift();
    log2(level, text);
    renderLog();
  }
  function clearLog() { logs = []; renderLog(); }
  function setState(id, st, detail) {
    if (!state.platforms[id]) return;
    state.platforms[id] = { state: st, detail: String(detail || ''), at: Date.now() };
    render();
  }

  /* ==================== AI 往返 ==================== */

  var activeAsks = {};      /* sourceKey → true，避免同一来源并发刷屏 */
  function characterName() {
    var c = core();
    try { return (c && c.characterName && c.characterName()) || '伊蕾娜'; } catch (e) { return '伊蕾娜'; }
  }
  function sourceKey(msg) { return msg.platform + ':' + String(msg.sourceId || ''); }

  /** 找到（或新建）这个来源对应的会话；shared 模式直接用当前对话 */
  function pickConversation(msg) {
    var c = core();
    if (config.conversationMode !== 'per-source' || !c) {
      return { conv: (typeof global.currentConv === 'function' ? global.currentConv() : null), created: false };
    }
    var title = '[' + msg.platformLabel + '] ' + (msg.sourceName || msg.sourceId || '会话');
    var list = c.conversations();
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && String(list[i].title || '') === title) return { conv: list[i], created: false };
    }
    var conv = {
      id: (typeof global.generateId === 'function' ? global.generateId() : ('cp_' + Date.now())),
      title: title,
      categoryId: (c.activeCategoryId ? c.activeCategoryId() : ''),
      isPinned: false, isStarred: false, worldSetting: '', characterPrompt: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      messages: [], platformSource: { platform: msg.platform, sourceId: String(msg.sourceId || '') }
    };
    list.unshift(conv);
    if (typeof c.save === 'function') c.save();
    pushLog('info', '为来源「' + title + '」新建了一间会话');
    return { conv: conv, created: true };
  }

  /**
   * 把平台消息交给伊蕾娜，拿回这一轮的回复文本数组。
   * ★ 走的就是界面上点"发送"用的同一条链路（app-02-message.js 的 handleUserInput，全局函数），
   *   所以人设、记忆、简洁化、多段回复等行为与手动聊天完全一致；这里只负责把结果取出来。
   */
  function askAI(msg) {
    var key = sourceKey(msg);
    if (activeAsks[key]) return Promise.resolve({ ok: false, code: 'BUSY', text: '这一条还没答完，先等等。' });
    activeAsks[key] = true;
    var done = function () { delete activeAsks[key]; };

    var picked;
    try { picked = pickConversation(msg); } catch (e) {
      done();
      return Promise.resolve({ ok: false, code: 'NO_CONV', text: '找不到可用会话：' + e.message });
    }
    var conv = picked && picked.conv;
    if (!conv) { done(); return Promise.resolve({ ok: false, code: 'NO_CONV', text: '当前没有打开的对话，先在界面上建一间教室/对话。' }); }

    var settings = null;
    try { settings = (core() && core().settings) ? core().settings() : null; } catch (e) {}
    if (settings && !String(settings.apiKey || '').trim()) {
      done();
      return Promise.resolve({ ok: false, code: 'NO_API_KEY', text: '这台设备还没配置模型 API Key（设置 → 连接），配置好再接平台。' });
    }

    var before = (conv.messages || []).length;
    var userMsg = {
      id: (typeof global.generateId === 'function' ? global.generateId() : ('cp_' + Date.now())),
      role: 'user',
      text: String(msg.text || ''),
      timestamp: new Date().toLocaleTimeString(),
      fromPlatform: { platform: msg.platform, sourceId: String(msg.sourceId || ''), sourceName: msg.sourceName || '' }
    };
    conv.messages.push(userMsg);
    if (typeof global.saveConversations === 'function') { try { global.saveConversations(); } catch (e) {} }

    var runner = global.handleUserInput;   /* 每次调用都重新取，测试里可替换 */
    if (typeof runner !== 'function') {
      conv.messages.pop();
      done();
      return Promise.resolve({ ok: false, code: 'NO_RUNNER', text: '对话链路没就绪（app-02-message.js 未加载）。' });
    }

    var timer = null;
    var guard = new Promise(function (resolve) { timer = global.setTimeout(function () { resolve({ timeout: true }); }, AI_TIMEOUT_MS); });
    var run = Promise.resolve()
      .then(function () { return runner(userMsg, conv); })
      .then(function () { return { timeout: false }; }, function (e) { return { timeout: false, err: e }; });
    return Promise.race([run, guard]).then(function (r) {
      if (timer) global.clearTimeout(timer);
      done();
      if (r && r.timeout) {
        pushLog('error', '「' + sourceKey(msg) + '」这条消息等模型超过 ' + Math.round(AI_TIMEOUT_MS / 1000) + ' 秒，已放弃');
        return { ok: false, code: 'TIMEOUT', text: '（AI 这边超时了，稍后再试）' };
      }
      var fresh = (conv.messages || []).slice(before + 1);
      var replies = fresh.filter(function (m) { return m && m.role === 'ai' && String(m.text || '').trim(); })
        .map(function (m) { return String(m.text).trim(); });
      if (!replies.length) {
        pushLog('warn', '这一轮没有生成任何回复（' + (r && r.err ? (r.err.message || r.err) : '模型没返回内容') + '）');
        return { ok: false, code: 'EMPTY', text: '（伊蕾娜这次没说话）' };
      }
      return { ok: true, replies: replies, conversationId: conv.id };
    });
  }

  /* ==================== 入口：一条平台消息 ==================== */

  function allowedSource(id) {
    var raw = String(config.allowed || '').trim();
    if (!raw) return true;
    var list = raw.split(/[\s,，;；]+/).filter(Boolean);
    return list.indexOf(String(id)) >= 0;
  }
  function shouldAnswer(msg) {
    if (!msg || !String(msg.text || '').trim()) return { ok: false, why: '空消息' };
    if (!allowedSource(msg.sourceId)) return { ok: false, why: '来源 ' + msg.sourceId + ' 不在允许名单里' };
    if (msg.isGroup) {
      var prefix = String(config.triggerPrefix || '').trim();
      var hitPrefix = prefix && String(msg.text || '').indexOf(prefix) === 0;
      if (!msg.atMe && !hitPrefix && config.groupAtOnly) return { ok: false, why: '群里没被 @（也没带触发前缀），不插话' };
      if (hitPrefix) msg.text = String(msg.text).slice(prefix.length).trim();
    }
    return { ok: true };
  }

  /** 平台适配器拿到一条消息后统一走这里；也给探针直接调用 */
  function handleIncoming(msg) {
    var verdict = shouldAnswer(msg);
    if (!verdict.ok) { pushLog('info', '跳过一条消息：' + verdict.why); return Promise.resolve({ ok: false, code: 'SKIP', text: verdict.why }); }
    pushLog('info', '收到 ' + msg.platformLabel + ' 消息（' + msg.sourceId + (msg.isGroup ? '，群' : '，私聊') + '）：' + String(msg.text).slice(0, 40));
    return askAI(msg).then(function (r) {
      if (!r.ok) {
        pushLog('warn', '没有可用回复：' + r.code + ' ' + r.text);
        /* 只有明确是"给人看的原因"才回给平台，避免把内部错误刷到群里 */
        if (r.code === 'NO_API_KEY' || r.code === 'NO_CONV') return r;
        return r;
      }
      var text = r.replies.join('\n');
      if (config.replyPrefix) text = config.replyPrefix + text;
      var chunks = splitForPlatform(text, Number(config.maxReplyChars) || 1200);
      var sender = adapters[msg.platform];
      if (!sender || typeof sender.send !== 'function') { pushLog('error', '没有 ' + msg.platform + ' 的发送器'); return r; }
      return Promise.resolve(sender.send(msg, chunks)).then(function () {
        pushLog('ok', '已回复 ' + msg.platform + '（' + chunks.length + ' 条）：' + chunks[0].slice(0, 40));
        return r;
      }, function (e) {
        pushLog('error', '回复失败：' + ((e && e.message) || e));
        return r;
      });
    });
  }

  /** 长回复按行切块，别把平台的风控触发了（OneBot/Telegram 单条都有长度上限） */
  function splitForPlatform(text, max) {
    var s = String(text || '');
    if (s.length <= max) return [s];
    var out = [], buf = '';
    s.split('\n').forEach(function (line) {
      if ((buf + '\n' + line).length > max && buf) { out.push(buf); buf = line; } else { buf = buf ? buf + '\n' + line : line; }
    });
    if (buf) out.push(buf);
    return out;
  }

  /* ==================== 适配器 ==================== */

  var adapters = {};

  /* ---------- OneBot v11（正向 WebSocket 客户端） ---------- */
  adapters.onebot = (function () {
    var sock = null, seq = 0, pending = {}, closedByUs = false;
    function api(action, params) {
      if (!sock || sock.readyState !== 1) return Promise.reject(new Error('还没连上 OneBot'));
      var echo = 'cp' + (++seq);
      return new Promise(function (resolve, reject) {
        pending[echo] = { resolve: resolve, reject: reject, action: action };
        try { sock.send(JSON.stringify({ action: action, params: params || {}, echo: echo })); }
        catch (e) { delete pending[echo]; reject(e); }
        global.setTimeout(function () {
          if (pending[echo]) { delete pending[echo]; reject(new Error(action + ' 超时')); }
        }, 15000);
      });
    }
    function textOf(event) {
      var m = event && event.message;
      if (typeof m === 'string') return m;
      if (Array.isArray(m)) {
        return m.map(function (seg) {
          if (!seg) return '';
          if (seg.type === 'text') return String(seg.data && seg.data.text || '');
          if (seg.type === 'at') return '<@' + String(seg.data && seg.data.qq || '') + '>';
          return '';
        }).join('').trim();
      }
      return String((event && event.raw_message) || '').trim();
    }
    function atMe(event) {
      var self = String(config.platforms.onebot.selfId || '');
      var m = event && event.message;
      if (!Array.isArray(m)) return /<@/.test(textOf(event)) || String(event && event.raw_message || '').indexOf('[CQ:at,qq=') >= 0;
      for (var i = 0; i < m.length; i += 1) {
        if (m[i] && m[i].type === 'at' && String((m[i].data || {}).qq || '') === self) return true;
      }
      return false;
    }
    return {
      id: 'onebot', label: 'QQ（OneBot v11 正向 WS）',
      send: function (msg, chunks) {
        var params = msg.isGroup
          ? { group_id: Number(msg.chatId || msg.sourceId), message: '' }
          : { user_id: Number(msg.sourceId), message: '' };
        var action = msg.isGroup ? 'send_group_msg' : 'send_private_msg';
        return chunks.reduce(function (p, c) {
          return p.then(function () { params.message = c; return api(action, params); });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.onebot;
        var url = String(cfg.wsUrl || '').trim();
        if (!url) { setState('onebot', 'error', '还没填 WebSocket 地址'); return Promise.resolve(false); }
        if (cfg.accessToken) {
          try {
            var u = new URL(url);
            if (!u.searchParams.get('access_token')) u.searchParams.set('access_token', String(cfg.accessToken));
            url = u.toString();
          } catch (e) { /* 地址不合法就原样试 */ }
        }
        closedByUs = false;
        setState('onebot', 'connecting', '正在连接 ' + url.replace(/access_token=[^&]+/, 'access_token=***'));
        return new Promise(function (resolve) {
          var ws;
          try { ws = new global.WebSocket(url); } catch (e) {
            setState('onebot', 'error', '地址不合法：' + e.message); resolve(false); return;
          }
          sock = ws;
          ws.onopen = function () {
            setState('onebot', 'on', '已连接（令牌 ' + mask(cfg.accessToken) + '）');
            pushLog('ok', 'OneBot 已连接：' + url.replace(/access_token=[^&]+/, 'access_token=***'));
            resolve(true);
          };
          ws.onmessage = function (ev) {
            var data;
            try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (e) { return; }
            if (data && data.echo && pending[data.echo]) {
              var p = pending[data.echo]; delete pending[data.echo];
              if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data);
              else p.reject(new Error((data.message || data.wording) || ('retcode ' + data.retcode)));
              return;
            }
            if (!data || data.post_type !== 'message') return;
            var isGroup = data.message_type === 'group';
            handleIncoming({
              platform: 'onebot', platformLabel: 'QQ',
              sourceId: String(isGroup ? data.group_id : data.user_id),
              sourceName: String((data.sender && (data.sender.card || data.sender.nickname)) || ''),
              chatId: String(isGroup ? data.group_id : data.user_id),
              isGroup: isGroup, atMe: atMe(data),
              text: textOf(data)
            });
          };
          ws.onerror = function () { setState('onebot', 'error', '连接出错（地址/令牌/对方没开 WS 服务）'); };
          ws.onclose = function () {
            if (sock === ws) sock = null;
            if (closedByUs) { setState('onebot', 'off', '已断开'); return; }
            setState('onebot', 'error', '连接已断开（对方关闭或网络不通）');
            pushLog('warn', 'OneBot 连接断开');
          };
        });
      },
      stop: function () {
        closedByUs = true;
        try { if (sock) sock.close(); } catch (e) {}
        sock = null;
        setState('onebot', 'off', '已断开');
        return Promise.resolve(true);
      }
    };
  })();

  /* ---------- Telegram Bot（长轮询） ---------- */
  adapters.telegram = (function () {
    var running = false, offset = 0, pollTimer = null;
    function api(method, params) {
      var cfg = config.platforms.telegram;
      var token = String(cfg.botToken || '').trim();
      var base = String(cfg.apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
      if (!token) return Promise.reject(new Error('还没填 Bot Token'));
      return global.fetch(base + '/bot' + token + '/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {})
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.description) || 'Telegram 返回失败');
        return j.result;
      });
    }
    function pollOnce() {
      if (!running) return Promise.resolve();
      return api('getUpdates', { offset: offset, timeout: 25, allowed_updates: ['message'] })
        .then(function (updates) {
          setState('telegram', 'on', '长轮询中');
          (updates || []).forEach(function (u) {
            offset = Math.max(offset, Number(u.update_id || 0) + 1);
            var m = u.message || u.edited_message;
            if (!m || !m.text) return;
            handleIncoming({
              platform: 'telegram', platformLabel: 'Telegram',
              sourceId: String((m.chat && m.chat.id) || ''),
              sourceName: String((m.from && (m.from.username || m.from.first_name)) || ''),
              chatId: String((m.chat && m.chat.id) || ''),
              isGroup: !!(m.chat && (m.chat.type === 'group' || m.chat.type === 'supergroup')),
              atMe: String(m.text || '').indexOf('@') === 0 || !!(m.entities || []).some(function (e) { return e.type === 'mention'; }),
              text: String(m.text || '')
            });
          });
        })
        .catch(function (e) {
          setState('telegram', 'error', String((e && e.message) || e));
          pushLog('error', 'Telegram 拉取失败：' + ((e && e.message) || e));
          return new Promise(function (r) { global.setTimeout(r, 5000); });
        })
        .then(function () { if (running) pollTimer = global.setTimeout(pollOnce, 300); });
    }
    return {
      id: 'telegram', label: 'Telegram Bot',
      send: function (msg, chunks) {
        return chunks.reduce(function (p, c) {
          return p.then(function () { return api('sendMessage', { chat_id: msg.chatId || msg.sourceId, text: c }); });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.telegram;
        if (!String(cfg.botToken || '').trim()) { setState('telegram', 'error', '还没填 Bot Token'); return Promise.resolve(false); }
        running = true;
        setState('telegram', 'connecting', '正在握手（getMe）');
        return api('getMe').then(function (me) {
          setState('telegram', 'on', '已连接 @' + (me && me.username ? me.username : 'bot') + '（令牌 ' + mask(cfg.botToken) + '）');
          pushLog('ok', 'Telegram 已连接：@' + (me && me.username));
          pollOnce();
          return true;
        }, function (e) {
          running = false;
          setState('telegram', 'error', '连接失败：' + ((e && e.message) || e));
          return false;
        });
      },
      stop: function () {
        running = false;
        if (pollTimer) { global.clearTimeout(pollTimer); pollTimer = null; }
        setState('telegram', 'off', '已停止');
        return Promise.resolve(true);
      }
    };
  })();

  /* ---------- 通用 Webhook（拉取 + 回复，给自建桥用） ---------- */
  adapters.webhook = (function () {
    var running = false, timer = null, cursor = '';
    function pollOnce() {
      if (!running) return Promise.resolve();
      var cfg = config.platforms.webhook;
      var url = String(cfg.pollUrl || '').trim();
      if (!url) { running = false; setState('webhook', 'error', '还没填拉取地址'); return Promise.resolve(); }
      var full = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'since=' + encodeURIComponent(cursor);
      var headers = {};
      if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
      return global.fetch(full, { headers: headers })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          setState('webhook', 'on', '轮询中（每 ' + (Number(cfg.intervalMs) || 3000) + ' ms）');
          var list = (j && (j.messages || j.items)) || [];
          list.forEach(function (m) {
            if (!m) return;
            if (m.cursor) cursor = String(m.cursor);
            handleIncoming({
              platform: 'webhook', platformLabel: 'Webhook',
              sourceId: String(m.from || m.sourceId || m.user || 'webhook'),
              sourceName: String(m.name || m.from || ''),
              chatId: String(m.chatId || m.from || ''),
              isGroup: !!m.isGroup,
              atMe: m.atMe !== false,
              text: String(m.text || m.content || '')
            });
          });
        })
        .catch(function (e) {
          setState('webhook', 'error', String((e && e.message) || e));
        })
        .then(function () {
          if (running) timer = global.setTimeout(pollOnce, Math.max(1000, Number(config.platforms.webhook.intervalMs) || 3000));
        });
    }
    return {
      id: 'webhook', label: '通用 Webhook（自建桥）',
      send: function (msg, chunks) {
        var cfg = config.platforms.webhook;
        var url = String(cfg.replyUrl || cfg.pollUrl || '').trim();
        if (!url) return Promise.reject(new Error('还没填回复地址'));
        var headers = { 'Content-Type': 'application/json' };
        if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
        return chunks.reduce(function (p, c) {
          return p.then(function () {
            return global.fetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ to: msg.sourceId, text: c, platform: 'webhook' }) });
          });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.webhook;
        if (!String(cfg.pollUrl || '').trim()) { setState('webhook', 'error', '还没填拉取地址'); return Promise.resolve(false); }
        running = true;
        pushLog('info', 'Webhook 开始轮询' + (cfg.token ? '（令牌 ' + mask(cfg.token) + '）' : ''));
        pollOnce();
        return Promise.resolve(true);
      },
      stop: function () {
        running = false;
        if (timer) { global.clearTimeout(timer); timer = null; }
        setState('webhook', 'off', '已停止');
        return Promise.resolve(true);
      }
    };
  })();

  /* ==================== 启停 ==================== */

  function connect(id) {
    var a = adapters[id];
    if (!a) return Promise.resolve(false);
    saveConfig({ platforms: (function () { var o = {}; o[id] = { enabled: true }; return o; })() });
    return Promise.resolve(a.start());
  }
  function disconnect(id) {
    var a = adapters[id];
    if (!a) return Promise.resolve(false);
    saveConfig({ platforms: (function () { var o = {}; o[id] = { enabled: false }; return o; })() });
    return Promise.resolve(a.stop());
  }
  function start(onlyId) {
    state.running = true;
    var ids = onlyId ? [onlyId] : ['onebot', 'telegram', 'webhook'];
    return ids.reduce(function (p, id) {
      return p.then(function () {
        var cfg = config.platforms[id] || {};
        if (!cfg.enabled) { setState(id, 'off', '未启用'); return null; }
        return connect(id);
      });
    }, Promise.resolve()).then(function () { render(); return true; });
  }
  function stop() {
    state.running = false;
    return Promise.all(Object.keys(adapters).map(function (id) { return adapters[id].stop(); })).then(function () { return true; });
  }
  function status() {
    return {
      running: state.running,
      autoStart: config.autoStart,
      conversationMode: config.conversationMode,
      platforms: JSON.parse(JSON.stringify(state.platforms)),
      logs: logs.slice(-40),
      config: clone(config)
    };
  }
  function isRunning() { return state.running; }

  /* ==================== 设置页 UI ==================== */

  var ui = { root: null };
  function el(id) { return ui.root ? ui.root.querySelector('#' + id) : null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dot(st) {
    var color = st === 'on' ? '#22c55e' : (st === 'connecting' ? '#f59e0b' : (st === 'error' ? '#ef4444' : '#94a3b8'));
    return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';vertical-align:middle;margin-right:6px"></span>';
  }
  function platformCard(id) {
    var a = adapters[id];
    var st = state.platforms[id] || { state: 'off', detail: '' };
    var cfg = config.platforms[id] || {};
    var btn = st.state === 'on' || st.state === 'connecting'
      ? '<button type="button" class="sw-seg" data-cp-act="disconnect" data-cp-id="' + id + '" style="min-height:30px;padding:0 12px">断开</button>'
      : '<button type="button" class="sw-seg" data-cp-act="connect" data-cp-id="' + id + '" style="min-height:30px;padding:0 12px">连接</button>';
    var fields = [];
    if (id === 'onebot') {
      fields.push(['wsUrl', 'WebSocket 地址', 'ws://127.0.0.1:3001', cfg.wsUrl]);
      fields.push(['accessToken', 'Access Token（可空）', '和 NapCat/Lagrange 里配的一致', cfg.accessToken, true]);
      fields.push(['selfId', '机器人 QQ 号（判断被 @）', '10001', cfg.selfId]);
    } else if (id === 'telegram') {
      fields.push(['botToken', 'Bot Token', '123456:ABC-DEF…', cfg.botToken, true]);
      fields.push(['apiBase', 'API 地址', 'https://api.telegram.org', cfg.apiBase]);
    } else if (id === 'webhook') {
      fields.push(['pollUrl', '拉取地址（GET，返回 {messages:[…]}）', 'http://127.0.0.1:8080/pull', cfg.pollUrl]);
      fields.push(['replyUrl', '回复地址（POST {to,text}）', 'http://127.0.0.1:8080/reply', cfg.replyUrl]);
      fields.push(['token', 'Bearer 令牌（可空）', '', cfg.token, true]);
      fields.push(['intervalMs', '轮询间隔 ms', '3000', cfg.intervalMs]);
    }
    return '<div class="sw-setting-theme-row" style="flex-direction:column;align-items:stretch;gap:6px;padding:10px 0;border-top:1px solid rgba(120,120,160,.16)" data-cp-card="' + id + '">' +
      '<div style="display:flex;align-items:center;gap:8px">' + dot(st.state) +
      '<span class="sw-ttl" style="flex:1">' + esc(a.label) + '</span>' + btn + '</div>' +
      '<div style="font-size:11px;opacity:.8;line-height:1.6" id="cpState_' + id + '">' + esc(st.detail || '未连接') + '</div>' +
      fields.map(function (f) {
        return '<div class="sw-setting-theme-row" style="gap:8px;align-items:center">' +
          '<span style="font-size:11.5px;opacity:.85;flex:0 0 122px">' + esc(f[1]) + '</span>' +
          '<input type="' + (f[4] ? 'password' : 'text') + '" data-cp-field="' + f[0] + '" data-cp-id="' + id + '" value="' + esc(f[3] == null ? '' : f[3]) + '" placeholder="' + esc(f[2]) + '" ' +
          'style="flex:1;min-width:0;font-size:11.5px;padding:5px 8px;border-radius:8px;border:1px solid rgba(120,120,160,.28);background:transparent;color:inherit"></div>';
      }).join('') +
      '</div>';
  }
  function render() {
    if (!ui.root) return;
    var body = ui.root.querySelector('#cpBody');
    if (!body) return;
    body.innerHTML =
      '<div class="sw-setting-theme-row" style="gap:10px;align-items:center;flex-wrap:wrap">' +
      '<span class="sw-ttl" style="flex:0 0 auto">自动连接</span>' +
      '<div class="sw-switch ' + (config.autoStart ? 'on' : 'off') + '" id="cpAutoStart"></div>' +
      '<span style="font-size:11px;opacity:.75">开启后，每次启动 ElainaChat 就自动把已启用的平台接上</span></div>' +
      '<div class="sw-setting-theme-row" style="gap:10px;align-items:center;flex-wrap:wrap">' +
      '<span class="sw-ttl" style="flex:0 0 auto">会话归属</span>' +
      '<button type="button" class="sw-seg" data-cp-mode="per-source" style="min-height:28px;padding:0 10px">每个来源单独一间</button>' +
      '<button type="button" class="sw-seg" data-cp-mode="shared" style="min-height:28px;padding:0 10px">都用当前对话</button>' +
      '<span style="font-size:11px;opacity:.75" id="cpModeNow">当前：' + (config.conversationMode === 'shared' ? '都用当前对话' : '每个来源单独一间') + '</span></div>' +
      '<div class="sw-setting-theme-row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
      '<span class="sw-ttl" style="flex:0 0 122px">允许的来源</span>' +
      '<input type="text" data-cp-field="allowed" value="' + esc(config.allowed) + '" placeholder="留空 = 全部允许；多个用逗号分隔，例如 12345,67890" ' +
      'style="flex:1;min-width:0;font-size:11.5px;padding:5px 8px;border-radius:8px;border:1px solid rgba(120,120,160,.28);background:transparent;color:inherit"></div>' +
      '<div class="sw-setting-theme-row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
      '<span class="sw-ttl" style="flex:0 0 122px">群聊触发</span>' +
      '<div class="sw-switch ' + (config.groupAtOnly ? 'on' : 'off') + '" id="cpGroupAt"></div>' +
      '<input type="text" data-cp-field="triggerPrefix" value="' + esc(config.triggerPrefix) + '" placeholder="前缀（可空），如 /" ' +
      'style="flex:1;min-width:110px;font-size:11.5px;padding:5px 8px;border-radius:8px;border:1px solid rgba(120,120,160,.28);background:transparent;color:inherit"></div>' +
      '<div class="sw-ttl" style="margin-top:6px">平台</div>' +
      platformCard('onebot') + platformCard('telegram') + platformCard('webhook') +
      '<div class="sw-setting-theme-row" style="gap:8px;flex-wrap:wrap;padding-top:8px">' +
      '<button type="button" class="sw-seg" data-cp-act="start" style="min-height:30px;padding:0 12px">全部连接</button>' +
      '<button type="button" class="sw-seg" data-cp-act="stop" style="min-height:30px;padding:0 12px">全部断开</button>' +
      '<button type="button" class="sw-seg" data-cp-act="clearLog" style="min-height:30px;padding:0 12px">清空日志</button>' +
      '</div>' +
      '<div class="sw-ttl" style="margin-top:6px">最近事件</div>' +
      '<div id="cpLog" style="max-height:150px;overflow:auto;font-size:11px;line-height:1.75;opacity:.9"></div>';
    renderLog();
    bindBody(body);
  }
  function renderLog() {
    var box = el('cpLog');
    if (!box) return;
    if (!logs.length) { box.innerHTML = '<div style="opacity:.65">（还没有事件）</div>'; return; }
    box.innerHTML = logs.slice(-30).reverse().map(function (l) {
      var color = l.level === 'error' ? '#ef4444' : (l.level === 'warn' ? '#f59e0b' : 'inherit');
      return '<div style="color:' + color + '">' + new Date(l.t).toLocaleTimeString() + ' · ' + esc(l.text) + '</div>';
    }).join('');
  }
  function bindBody(body) {
    body.querySelectorAll('[data-cp-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-cp-act');
        var id = b.getAttribute('data-cp-id');
        if (act === 'connect') { memToast('正在连接…'); connect(id); }
        else if (act === 'disconnect') { memToast('已断开'); disconnect(id); }
        else if (act === 'start') { memToast('正在连接已启用的平台…'); start(); }
        else if (act === 'stop') { memToast('已全部断开'); stop(); }
        else if (act === 'clearLog') { clearLog(); }
      });
    });
    body.querySelectorAll('[data-cp-mode]').forEach(function (b) {
      b.addEventListener('click', function () { saveConfig({ conversationMode: b.getAttribute('data-cp-mode') }); });
    });
    var auto = el('cpAutoStart');
    if (auto) auto.addEventListener('click', function () {
      saveConfig({ autoStart: !config.autoStart });
      auto.className = 'sw-switch ' + (config.autoStart ? 'on' : 'off');
    });
    var gat = el('cpGroupAt');
    if (gat) gat.addEventListener('click', function () {
      saveConfig({ groupAtOnly: !config.groupAtOnly });
      gat.className = 'sw-switch ' + (config.groupAtOnly ? 'on' : 'off');
    });
    body.querySelectorAll('[data-cp-field]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var name = inp.getAttribute('data-cp-field');
        var pid = inp.getAttribute('data-cp-id');
        var patch = {};
        if (pid) { patch.platforms = {}; patch.platforms[pid] = {}; patch.platforms[pid][name] = inp.value; }
        else { patch[name] = name === 'intervalMs' ? Number(inp.value) : inp.value; }
        saveConfig(patch);
      });
    });
  }
  function memToast(text) {
    try { if (typeof global.memShowToast === 'function') { global.memShowToast(text); return; } } catch (e) {}
    pushLog('info', text);
  }
  function mount(sectionEl) {
    if (!sectionEl) return false;
    ui.root = sectionEl;
    if (sectionEl.getAttribute('data-cp-mounted') === '1') { render(); return true; }
    sectionEl.setAttribute('data-cp-mounted', '1');
    render();
    if (config.autoStart) start();
    return true;
  }

  /* ==================== 导出 ==================== */

  global.ElainaChatPlatforms = {
    mount: mount,
    start: start,
    stop: stop,
    status: status,
    config: function () { return clone(config); },
    saveConfig: saveConfig,
    connect: connect,
    disconnect: disconnect,
    clearLog: clearLog,
    log: pushLog,
    handleIncoming: handleIncoming,
    askAI: askAI,
    isRunning: isRunning,
    adapters: Object.keys(adapters)
  };
  pushLog('info', '聊天平台模块就绪（适配器：' + Object.keys(adapters).join(' / ') + '）');
})(window);
