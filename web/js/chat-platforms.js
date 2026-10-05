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
      /* 三个"出站即可"的老平台 */
      onebot: { enabled: false, wsUrl: 'ws://127.0.0.1:3001', accessToken: '', selfId: '' },
      telegram: { enabled: false, botToken: '', apiBase: 'https://api.telegram.org' },
      webhook: { enabled: false, pollUrl: '', replyUrl: '', token: '', intervalMs: 3000 },
      /* 下面这批按各自官方协议实现（WS 握手 + 收事件 + 回消息） */
      discord: { enabled: false, botToken: '', apiBase: 'https://discord.com/api/v10' },
      slack: { enabled: false, appToken: '', botToken: '', apiBase: 'https://slack.com/api' },
      kook: { enabled: false, botToken: '', apiBase: 'https://www.kookapp.cn/api/v3', gatewayBase: 'https://www.kookapp.cn/api/v3' },
      mattermost: { enabled: false, baseUrl: '', botToken: '' },
      misskey: { enabled: false, baseUrl: '', accessToken: '' },
      dingtalk: { enabled: false, clientId: '', clientSecret: '', robotCode: '' },
      qqofficial: { enabled: false, appId: '', clientSecret: '', sandbox: false }
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
    platforms: (function () {
      var out = {};
      ['onebot', 'telegram', 'webhook', 'discord', 'slack', 'kook', 'mattermost', 'misskey', 'dingtalk', 'qqofficial']
        .forEach(function (id) { out[id] = { state: 'off', detail: '未连接', at: 0 }; });
      return out;
    })()
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

  /* ==================== 更多平台适配器 ====================
  /* 共同点：WS 握手用**各自协议内**的字段带令牌（浏览器的 WebSocket 不能自定义请求头），
     REST 回复尽量走"体里带令牌"或平台允许跨域的接口；真被跨域挡住时状态栏与日志会写明是哪一步失败的。 */

  /* ---------- Discord（Gateway WebSocket + REST） ---------- */
  adapters.discord = (function () {
    var OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, INVALID: 9, HELLO: 10, ACK: 11 };
    var sock = null, hb = null, lastSeq = null, closedByUs = false, botId = '';
    function api(path, body) {
      var cfg = config.platforms.discord;
      var base = String(cfg.apiBase || 'https://discord.com/api/v10').replace(/\/+$/, '');
      return global.fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + String(cfg.botToken || '').trim() },
        body: JSON.stringify(body || {})
      }).then(function (r) { return r.json().catch(function () { return null; }); });
    }
    function beat() { if (sock && sock.readyState === 1) sock.send(JSON.stringify({ op: OP.HEARTBEAT, d: lastSeq })); }
    return {
      id: 'discord', label: 'Discord Bot',
      send: function (msg, chunks) {
        return chunks.reduce(function (p, c) {
          return p.then(function () { return api('/channels/' + msg.chatId + '/messages', { content: c }); });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.discord;
        var token = String(cfg.botToken || '').trim();
        if (!token) { setState('discord', 'error', '还没填 Bot Token'); return Promise.resolve(false); }
        closedByUs = false;
        setState('discord', 'connecting', '正在取 Gateway 地址');
        return global.fetch(String(cfg.apiBase || 'https://discord.com/api/v10').replace(/\/+$/, '') + '/gateway/bot', {
          headers: { Authorization: 'Bot ' + token }
        }).then(function (r) { return r.json(); }).then(function (g) {
          if (!g || !g.url) throw new Error('取 Gateway 地址失败：' + JSON.stringify(g).slice(0, 120));
          botId = String((g.user && g.user.id) || '');
          return new Promise(function (resolve) {
            var ws = new global.WebSocket(String(g.url) + '/?v=10&encoding=json');
            sock = ws;
            ws.onmessage = function (ev) {
              var m = null; try { m = JSON.parse(ev.data); } catch (e) { return; }
              if (m.s != null) lastSeq = m.s;
              if (m.op === OP.HELLO) {
                ws.send(JSON.stringify({ op: OP.IDENTIFY, d: { token: token, intents: 33281, properties: { os: 'windows', browser: 'elainachat', device: 'elainachat' } } }));
                if (hb) global.clearInterval(hb);
                hb = global.setInterval(beat, Number((m.d && m.d.heartbeat_interval) || 41250));
                setState('discord', 'on', '已连接（令牌 ' + mask(token) + '）');
                pushLog('ok', 'Discord Gateway 已连接');
                resolve(true);
                return;
              }
              if (m.op === OP.RECONNECT || m.op === OP.INVALID) { setState('discord', 'error', 'Gateway 要求重连（op ' + m.op + '）'); return; }
              if (m.op !== OP.DISPATCH) return;
              if (m.t === 'MESSAGE_CREATE') {
                var d = m.d || {};
                if (!d.content || !d.channel_id) return;
                if (botId && d.author && String(d.author.id) === botId) return;   /* 别回自己 */
                handleIncoming({
                  platform: 'discord', platformLabel: 'Discord',
                  sourceId: String(d.guild_id || d.channel_id), sourceName: String((d.author && d.author.username) || ''),
                  chatId: String(d.channel_id), isGroup: !!d.guild_id,
                  atMe: String(d.content).indexOf('<@' + botId + '>') >= 0 || !d.guild_id,
                  text: String(d.content).replace(new RegExp('<@!?' + botId + '>', 'g'), '').trim()
                });
              }
            };
            ws.onerror = function () { setState('discord', 'error', 'Gateway 连接出错'); };
            ws.onclose = function () {
              if (hb) { global.clearInterval(hb); hb = null; }
              if (sock === ws) sock = null;
              if (closedByUs) { setState('discord', 'off', '已断开'); return; }
              setState('discord', 'error', 'Gateway 已断开');
            };
          });
        }, function (e) {
          setState('discord', 'error', '连接失败：' + ((e && e.message) || e));
          return false;
        });
      },
      stop: function () {
        closedByUs = true;
        if (hb) { global.clearInterval(hb); hb = null; }
        try { if (sock) sock.close(); } catch (e) {}
        sock = null;
        setState('discord', 'off', '已断开');
        return Promise.resolve(true);
      }
    };
  })();

  /* ---------- Slack（Socket Mode） ---------- */
  adapters.slack = (function () {
    var sock = null, closedByUs = false;
    function api(method, url, body, token) {
      return global.fetch(String(config.platforms.slack.apiBase || 'https://slack.com/api').replace(/\/+$/, '') + url, {
        method: method,
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + token },
        body: body ? JSON.stringify(body) : undefined
      }).then(function (r) { return r.json(); });
    }
    return {
      id: 'slack', label: 'Slack（Socket Mode）',
      send: function (msg, chunks) {
        var cfg = config.platforms.slack;
        return chunks.reduce(function (p, c) {
          return p.then(function () { return api('POST', '/chat.postMessage', { channel: msg.chatId || msg.sourceId, text: c }, String(cfg.botToken || '').trim()); });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.slack;
        var app = String(cfg.appToken || '').trim();
        if (!app) { setState('slack', 'error', '还没填 App-Level Token（xapp-…）'); return Promise.resolve(false); }
        closedByUs = false;
        setState('slack', 'connecting', '正在换取 Socket Mode 地址');
        return api('POST', '/apps.connections.open', null, app).then(function (j) {
          if (!j || !j.ok || !j.url) throw new Error((j && j.error) || 'connections.open 失败');
          return new Promise(function (resolve) {
            var ws = new global.WebSocket(j.url);
            sock = ws;
            ws.onopen = function () {
              setState('slack', 'on', 'Socket Mode 已连接（令牌 ' + mask(app) + '）');
              pushLog('ok', 'Slack Socket Mode 已连接');
              resolve(true);
            };
            ws.onmessage = function (ev) {
              var m = null; try { m = JSON.parse(ev.data); } catch (e) { return; }
              if (m.envelope_id) ws.send(JSON.stringify({ envelope_id: m.envelope_id }));   /* 必须先 ack */
              if (!m.payload) return;
              if (m.type === 'disconnect') { setState('slack', 'error', 'Slack 要求重连（disconnect）'); return; }
              var e2 = m.payload.event || {};
              if (m.payload.type !== 'events_api' || e2.type !== 'message' || e2.bot_id || e2.subtype) return;
              handleIncoming({
                platform: 'slack', platformLabel: 'Slack',
                sourceId: String(e2.channel || ''), sourceName: String(e2.user || ''),
                chatId: String(e2.channel || ''), isGroup: !!e2.channel_type && e2.channel_type !== 'im',
                atMe: String(e2.text || '').indexOf('<@') >= 0 || !e2.channel_type || e2.channel_type === 'im',
                text: String(e2.text || '').replace(/<@[^>]+>/g, '').trim()
              });
            };
            ws.onerror = function () { setState('slack', 'error', 'Socket Mode 连接出错'); };
            ws.onclose = function () {
              if (sock === ws) sock = null;
              if (closedByUs) { setState('slack', 'off', '已断开'); return; }
              setState('slack', 'error', 'Socket Mode 已断开');
            };
          });
        }, function (e) {
          setState('slack', 'error', '连接失败：' + ((e && e.message) || e));
          return false;
        });
      },
      stop: function () {
        closedByUs = true;
        try { if (sock) sock.close(); } catch (e) {}
        sock = null;
        setState('slack', 'off', '已断开');
        return Promise.resolve(true);
      }
    };
  })();

  /* ---------- KOOK ---------- */
  adapters.kook = (function () {
    var sock = null, hb = null, closedByUs = false;
    function api(path, body) {
      var cfg = config.platforms.kook;
      return global.fetch(String(cfg.apiBase || 'https://www.kookapp.cn/api/v3').replace(/\/+$/, '') + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + String(cfg.botToken || '').trim() },
        body: JSON.stringify(body || {})
      }).then(function (r) { return r.json(); });
    }
    return {
      id: 'kook', label: 'KOOK',
      send: function (msg, chunks) {
        return chunks.reduce(function (p, c) {
          return p.then(function () { return api('/message/create', { type: msg.isGroup ? 9 : 1, target_id: msg.sourceId, content: c }); });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.kook;
        var token = String(cfg.botToken || '').trim();
        if (!token) { setState('kook', 'error', '还没填 Bot Token'); return Promise.resolve(false); }
        closedByUs = false;
        setState('kook', 'connecting', '正在取 Gateway 地址');
        return api('/gateway/index?compress=0', {}).then(function (j) {
          var url = j && j.data && j.data.url;
          if (!url) throw new Error('取 Gateway 失败：' + JSON.stringify(j).slice(0, 120));
          return new Promise(function (resolve) {
            var ws = new global.WebSocket(url);
            sock = ws;
            ws.onmessage = function (ev) {
              var m = null; try { m = JSON.parse(ev.data); } catch (e) { return; }
              if (m.s === 1) { ws.send(JSON.stringify({ s: 2, sn: m.sn })); return; }        /* hello → 登录 */
              if (m.s === 3) return;                                                          /* pong */
              if (m.s === 5) { setState('kook', 'error', 'KOOK 要求重连'); return; }
              if (m.s !== 0 || !m.d) return;
              if (m.d.code === 0) {
                if (hb) global.clearInterval(hb);
                hb = global.setInterval(function () { if (ws.readyState === 1) ws.send(JSON.stringify({ s: 2, sn: 6 })); }, 30000);
                setState('kook', 'on', '已连接（令牌 ' + mask(token) + '）');
                pushLog('ok', 'KOOK Gateway 已连接');
                resolve(true);
                return;
              }
              if (m.d.type === 1 && m.d.content) {
                var isGroup = m.d.channel_type !== 'PERSON';
                var mention = /^\(met\)\d+\(met\)/.test(String(m.d.content));
                handleIncoming({
                  platform: 'kook', platformLabel: 'KOOK',
                  sourceId: String(isGroup ? m.d.target_id : m.d.author_id), sourceName: String((m.d.author && m.d.author.username) || ''),
                  chatId: String(m.d.target_id || m.d.author_id), isGroup: isGroup, atMe: mention || !isGroup,
                  text: String(m.d.content).replace(/^\(met\)\d+\(met\)/, '').trim()
                });
              }
            };
            ws.onopen = function () { ws.send(JSON.stringify({ s: 1, sn: 0, d: { token: token, compress: 0 } })); };
            ws.onerror = function () { setState('kook', 'error', 'Gateway 连接出错'); };
            ws.onclose = function () {
              if (hb) { global.clearInterval(hb); hb = null; }
              if (sock === ws) sock = null;
              if (closedByUs) { setState('kook', 'off', '已断开'); return; }
              setState('kook', 'error', 'Gateway 已断开');
            };
          });
        }, function (e) {
          setState('kook', 'error', '连接失败：' + ((e && e.message) || e));
          return false;
        });
      },
      stop: function () {
        closedByUs = true;
        if (hb) { global.clearInterval(hb); hb = null; }
        try { if (sock) sock.close(); } catch (e) {}
        sock = null;
        setState('kook', 'off', '已断开');
        return Promise.resolve(true);
      }
    };
  })();

  /* ---------- Mattermost ---------- */
  adapters.mattermost = (function () {
    var sock = null, closedByUs = false, seq = 1;
    function base() { return String(config.platforms.mattermost.baseUrl || '').replace(/\/+$/, ''); }
    function api(path, body) {
      return global.fetch(base() + '/api/v4' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(config.platforms.mattermost.botToken || '').trim() },
        body: JSON.stringify(body || {})
      }).then(function (r) { return r.json(); });
    }
    return {
      id: 'mattermost', label: 'Mattermost',
      send: function (msg, chunks) {
        return chunks.reduce(function (p, c) {
          return p.then(function () { return api('/posts', { channel_id: msg.chatId || msg.sourceId, message: c }); });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.mattermost;
        if (!base()) { setState('mattermost', 'error', '还没填服务器地址'); return Promise.resolve(false); }
        if (!String(cfg.botToken || '').trim()) { setState('mattermost', 'error', '还没填 Bot Token'); return Promise.resolve(false); }
        closedByUs = false;
        setState('mattermost', 'connecting', '正在连接 WebSocket');
        return new Promise(function (resolve) {
          var wsUrl = base().replace(/^http/, 'ws') + '/api/v4/websocket';
          var ws = new global.WebSocket(wsUrl);
          sock = ws;
          ws.onopen = function () {
            ws.send(JSON.stringify({ seq: seq++, action: 'authentication_challenge', data: { token: String(cfg.botToken || '').trim() } }));
            setState('mattermost', 'on', '已连接（令牌 ' + mask(cfg.botToken) + '）');
            pushLog('ok', 'Mattermost WebSocket 已连接');
            resolve(true);
          };
          ws.onmessage = function (ev) {
            var m = null; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.event !== 'posted') return;
            var p = m.data && m.data.post;
            if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return; } }
            if (!p || !p.message) return;
            if (m.data && m.data.sender_name && p.user_id === (m.broadcast && m.broadcast.user_id)) return;
            handleIncoming({
              platform: 'mattermost', platformLabel: 'Mattermost',
              sourceId: String(p.channel_id || ''), sourceName: String(p.user_id || ''),
              chatId: String(p.channel_id || ''), isGroup: true, atMe: true, text: String(p.message || '')
            });
          };
          ws.onerror = function () { setState('mattermost', 'error', 'WebSocket 连接出错'); };
          ws.onclose = function () {
            if (sock === ws) sock = null;
            if (closedByUs) { setState('mattermost', 'off', '已断开'); return; }
            setState('mattermost', 'error', 'WebSocket 已断开');
          };
        });
      },
      stop: function () {
        closedByUs = true;
        try { if (sock) sock.close(); } catch (e) {}
        sock = null;
        setState('mattermost', 'off', '已断开');
        return Promise.resolve(true);
      }
    };
  })();

  /* ---------- Misskey（令牌走 query / body，不需要请求头） ---------- */
  adapters.misskey = (function () {
    var sock = null, closedByUs = false;
    function base() { return String(config.platforms.misskey.baseUrl || '').replace(/\/+$/, ''); }
    return {
      id: 'misskey', label: 'Misskey',
      send: function (msg, chunks) {
        return chunks.reduce(function (p, c) {
          return p.then(function () {
            return global.fetch(base() + '/api/notes/create', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ i: String(config.platforms.misskey.accessToken || '').trim(), text: c, visibility: 'public' })
            }).then(function (r) { return r.json(); });
          });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.misskey;
        var token = String(cfg.accessToken || '').trim();
        if (!base()) { setState('misskey', 'error', '还没填实例地址'); return Promise.resolve(false); }
        if (!token) { setState('misskey', 'error', '还没填访问令牌'); return Promise.resolve(false); }
        closedByUs = false;
        setState('misskey', 'connecting', '正在连接 streaming');
        return new Promise(function (resolve) {
          var ws = new global.WebSocket(base().replace(/^http/, 'ws') + '/streaming?i=' + encodeURIComponent(token));
          sock = ws;
          ws.onopen = function () {
            ws.send(JSON.stringify({ type: 'connect', body: { channel: 'main', id: 'elaina-main' } }));
            setState('misskey', 'on', '已连接（令牌 ' + mask(token) + '）');
            pushLog('ok', 'Misskey streaming 已连接');
            resolve(true);
          };
          ws.onmessage = function (ev) {
            var m = null; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.type !== 'channel' || !m.body) return;
            if (m.body.type !== 'note') return;
            var note = m.body.body || {};
            if (!note.text || !note.user) return;
            var isDm = !!note.visibility && note.visibility === 'specified';
            handleIncoming({
              platform: 'misskey', platformLabel: 'Misskey',
              sourceId: String(note.user.id || ''), sourceName: String(note.user.username || ''),
              chatId: String(note.user.id || ''), isGroup: !isDm, atMe: /@\w+/.test(String(note.text)) || isDm,
              text: String(note.text).replace(/@\w+\s*/g, '').trim()
            });
          };
          ws.onerror = function () { setState('misskey', 'error', 'streaming 连接出错'); };
          ws.onclose = function () {
            if (sock === ws) sock = null;
            if (closedByUs) { setState('misskey', 'off', '已断开'); return; }
            setState('misskey', 'error', 'streaming 已断开');
          };
        });
      },
      stop: function () {
        closedByUs = true;
        try { if (sock) sock.close(); } catch (e) {}
        sock = null;
        setState('misskey', 'off', '已断开');
        return Promise.resolve(true);
      }
    };
  })();

  /* ---------- 钉钉（Stream 模式） ---------- */
  adapters.dingtalk = (function () {
    var sock = null, closedByUs = false;
    function ack(messageId, topic) {
      if (!sock || sock.readyState !== 1) return;
      sock.send(JSON.stringify({ code: 200, headers: { messageId: messageId, topic: topic || '', contentType: 'application/json' }, message: 'OK', data: '{}' }));
    }
    return {
      id: 'dingtalk', label: '钉钉（Stream 模式）',
      send: function (msg, chunks) {
        /* 钉钉回调里带着 sessionWebhook，回消息直接 POST 它即可（不需要再换 token） */
        var url = msg.sessionWebhook;
        if (!url) return Promise.reject(new Error('这条钉钉消息没带 sessionWebhook，无法回复'));
        return chunks.reduce(function (p, c) {
          return p.then(function () {
            return global.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: c } }) });
          });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.dingtalk;
        var id = String(cfg.clientId || '').trim(), secret = String(cfg.clientSecret || '').trim();
        if (!id || !secret) { setState('dingtalk', 'error', '还没填 Client ID / Client Secret'); return Promise.resolve(false); }
        closedByUs = false;
        setState('dingtalk', 'connecting', '正在换取长连接地址');
        return global.fetch('https://api.dingtalk.com/v1.0/gateway/connections/open', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: id, clientSecret: secret, subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }], ua: 'elainachat/1.0' })
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (!j || !j.endpoint || !j.ticket) throw new Error('换取失败：' + JSON.stringify(j).slice(0, 120));
          return new Promise(function (resolve) {
            var ws = new global.WebSocket(j.endpoint + '?ticket=' + encodeURIComponent(j.ticket));
            sock = ws;
            ws.onopen = function () {
              setState('dingtalk', 'on', '已连接（Client ID ' + mask(id) + '）');
              pushLog('ok', '钉钉 Stream 已连接');
              resolve(true);
            };
            ws.onmessage = function (ev) {
              var m = null; try { m = JSON.parse(ev.data); } catch (e) { return; }
              var headers = m.headers || {};
              if (m.type === 'SYSTEM') {
                if (headers.topic === 'ping') ack(headers.messageId, 'pong');
                return;
              }
              if (m.type !== 'CALLBACK') return;
              var data = {};
              try { data = typeof m.data === 'string' ? JSON.parse(m.data) : (m.data || {}); } catch (e) { data = {}; }
              ack(headers.messageId, headers.topic);
              var text = (data.text && data.text.content) || '';
              if (!text) return;
              handleIncoming({
                platform: 'dingtalk', platformLabel: '钉钉',
                sourceId: String(data.conversationId || data.senderStaffId || ''), sourceName: String(data.senderNick || ''),
                chatId: String(data.conversationId || ''), isGroup: String(data.conversationType) === '2',
                atMe: true, sessionWebhook: data.sessionWebhook || '',
                text: String(text).replace(/^\s*/, '').trim()
              });
            };
            ws.onerror = function () { setState('dingtalk', 'error', '长连接出错'); };
            ws.onclose = function () {
              if (sock === ws) sock = null;
              if (closedByUs) { setState('dingtalk', 'off', '已断开'); return; }
              setState('dingtalk', 'error', '长连接已断开');
            };
          });
        }, function (e) {
          setState('dingtalk', 'error', '连接失败：' + ((e && e.message) || e));
          return false;
        });
      },
      stop: function () {
        closedByUs = true;
        try { if (sock) sock.close(); } catch (e) {}
        sock = null;
        setState('dingtalk', 'off', '已断开');
        return Promise.resolve(true);
      }
    };
  })();

  /* ---------- QQ 官方机器人（开放平台 WebSocket） ---------- */
  adapters.qqofficial = (function () {
    var sock = null, hb = null, closedByUs = false, token = '', lastSeq = null;
    function apiHost(sandbox) { return sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com'; }
    function rest(path, body, method) {
      var cfg = config.platforms.qqofficial;
      return global.fetch(apiHost(!!cfg.sandbox) + path, {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'QQBot ' + token, 'X-Union-Appid': String(cfg.appId || '') },
        body: body ? JSON.stringify(body) : undefined
      }).then(function (r) { return r.json().catch(function () { return null; }); });
    }
    return {
      id: 'qqofficial', label: 'QQ 官方机器人',
      send: function (msg, chunks) {
        return chunks.reduce(function (p, c) {
          return p.then(function () {
            return msg.isGroup
              ? rest('/v2/groups/' + msg.sourceId + '/messages', { content: c, msg_type: 0, msg_id: msg.msgId || undefined })
              : rest('/v2/users/' + msg.sourceId + '/messages', { content: c, msg_type: 0, msg_id: msg.msgId || undefined });
          });
        }, Promise.resolve());
      },
      start: function () {
        var cfg = config.platforms.qqofficial;
        /* 已经连着就别再连：否则会留下一条没人管的旧 socket（扫码绑定后已自动连过一次） */
        if (sock) { try { closedByUs = true; sock.close(); } catch (e) {} sock = null; }
        var appId = String(cfg.appId || '').trim(), secret = String(cfg.clientSecret || '').trim();
        if (!appId || !secret) { setState('qqofficial', 'error', '还没填 AppID / AppSecret'); return Promise.resolve(false); }
        closedByUs = false;
        setState('qqofficial', 'connecting', '正在取 access_token');
        return global.fetch('https://bots.qq.com/app/getAppAccessToken', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: appId, clientSecret: secret })
        }).then(function (r) { return r.json(); }).then(function (j) {
          token = String((j && j.access_token) || '');
          if (!token) throw new Error('取 token 失败：' + JSON.stringify(j).slice(0, 120));
          return rest('/gateway', null, 'GET');
        }).then(function (g) {
          var url = g && g.url;
          if (!url) throw new Error('取 Gateway 失败：' + JSON.stringify(g).slice(0, 120));
          return new Promise(function (resolve) {
            var ws = new global.WebSocket(url);
            sock = ws;
            ws.onmessage = function (ev) {
              var m = null; try { m = JSON.parse(ev.data); } catch (e) { return; }
              if (m.s != null) lastSeq = m.s;
              if (m.op === 10) {
                ws.send(JSON.stringify({ op: 2, d: { token: 'QQBot ' + token, intents: (1 << 25) | (1 << 30), shard: [0, 1] } }));
                if (hb) global.clearInterval(hb);
                hb = global.setInterval(function () { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: lastSeq })); }, 30000);
                setState('qqofficial', 'on', '已连接（AppID ' + mask(appId) + '）');
                pushLog('ok', 'QQ 官方机器人已连接');
                resolve(true);
                return;
              }
              if (m.op === 11 || m.op === 0 && !m.t) return;
              if (m.t === 'C2C_MESSAGE_CREATE' || m.t === 'GROUP_AT_MESSAGE_CREATE') {
                var d = m.d || {};
                var isGroup = m.t === 'GROUP_AT_MESSAGE_CREATE';
                if (!d.content) return;
                handleIncoming({
                  platform: 'qqofficial', platformLabel: 'QQ官方',
                  sourceId: String(isGroup ? d.group_openid : (d.author && d.author.user_openid) || ''),
                  sourceName: String((d.author && d.author.username) || ''),
                  chatId: String(isGroup ? d.group_openid : (d.author && d.author.user_openid) || ''),
                  isGroup: isGroup, atMe: true, msgId: String(d.id || ''),
                  text: String(d.content).replace(/<@!?\d+>/, '').trim()
                });
              }
            };
            ws.onerror = function () { setState('qqofficial', 'error', 'Gateway 连接出错'); };
            ws.onclose = function () {
              if (hb) { global.clearInterval(hb); hb = null; }
              if (sock === ws) sock = null;
              if (closedByUs) { setState('qqofficial', 'off', '已断开'); return; }
              setState('qqofficial', 'error', 'Gateway 已断开');
            };
          });
        }, function (e) {
          setState('qqofficial', 'error', '连接失败：' + ((e && e.message) || e));
          return false;
        });
      },
      stop: function () {
        closedByUs = true;
        if (hb) { global.clearInterval(hb); hb = null; }
        try { if (sock) sock.close(); } catch (e) {}
        sock = null;
        setState('qqofficial', 'off', '已断开');
        return Promise.resolve(true);
      }
    };
  })();

  /* ==================== 启停 ==================== */

  function connect(id) {
    var a = adapters[id];
    if (!a) return Promise.resolve(false);
    selId = id;
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
    var ids = onlyId ? [onlyId] : Object.keys(adapters);
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
  /* 字段定义：每个平台要填什么（顺序即界面顺序） */
  var FIELD_DEFS = {
    onebot: [['wsUrl', 'WebSocket 地址', 'ws://127.0.0.1:3001'], ['accessToken', 'Access Token（可空）', '与 NapCat / Lagrange 里一致', true], ['selfId', '机器人 QQ 号（判断被 @）', '10001']],
    telegram: [['botToken', 'Bot Token', '123456:ABC-DEF…', true], ['apiBase', 'API 地址', 'https://api.telegram.org']],
    webhook: [['pollUrl', '拉取地址（GET → {messages:[…]}）', 'http://127.0.0.1:8080/pull'], ['replyUrl', '回复地址（POST {to,text}）', 'http://127.0.0.1:8080/reply'], ['token', 'Bearer 令牌（可空）', '', true], ['intervalMs', '轮询间隔 ms', '3000']],
    discord: [['botToken', 'Bot Token', 'MTIz…', true], ['apiBase', 'API 地址', 'https://discord.com/api/v10']],
    slack: [['appToken', 'App-Level Token（xapp-…）', 'xapp-…', true], ['botToken', 'Bot Token（xoxb-…）', 'xoxb-…', true]],
    kook: [['botToken', 'Bot Token', '', true]],
    mattermost: [['baseUrl', '服务器地址', 'https://mm.example.com'], ['botToken', 'Bot Token', '', true]],
    misskey: [['baseUrl', '实例地址', 'https://misskey.io'], ['accessToken', '访问令牌', '', true]],
    dingtalk: [['clientId', 'Client ID（AppKey）', ''], ['clientSecret', 'Client Secret（AppSecret）', '', true]],
    qqofficial: [['appId', 'AppID', ''], ['clientSecret', 'AppSecret', '', true], ['sandbox', '沙箱环境', '机器人还没发布时必须勾这个，否则收不到消息', false, 'bool']]
  };
  /* 每个平台一句话说明（写清"要什么"和已知限制，别让用户猜） */
  var PLATFORM_HINTS = {
    onebot: '配 NapCat / Lagrange / go-cqhttp 的**正向** WebSocket 地址（它们里开 "WebSocket 服务端"）。',
    telegram: '找 @BotFather 建机器人拿 Token；长轮询，不需要公网地址。',
    webhook: '给自建桥用：GET 拉 {messages:[{from,text,cursor}]}，回消息 POST {to,text}。AstrBot / Satori 都能这样接。',
    discord: 'Discord Developer Portal 建应用取 Bot Token；要开 MESSAGE CONTENT INTENT（在 Bot 页里勾）。',
    slack: '建 App 后开 Socket Mode，拿 App-Level Token（xapp-，connections:write）与 Bot Token（xoxb-，chat:write）。',
    kook: '开发者中心建机器人，取 Bot Token（令牌里已含 Bot 前缀的请只填后面那段）。',
    mattermost: '系统控制台建 Bot 账号取 Token，填服务器根地址（不用带 /api/v4）。',
    misskey: '设置 → API 生成访问令牌（要能读写笔记）；令牌走地址栏，不需要请求头。',
    dingtalk: '开放平台建应用，拿 Client ID / Client Secret；机器人回复走回调里的 sessionWebhook。',
    qqofficial: 'QQ 开放平台建机器人，拿 AppID / AppSecret；沙箱环境请勾上「沙箱」。'
  };
  var selId = 'onebot';
  function chipsHtml() {
    return '<div style="display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 8px">' +
      Object.keys(adapters).map(function (id) {
        var st = (state.platforms[id] || {}).state || 'off';
        var on = id === selId;
        return '<button type="button" class="sw-seg" data-cp-pick="' + id + '" style="min-height:28px;padding:0 10px;' +
          (on ? 'outline:2px solid rgba(124,58,237,.55);' : '') + '">' + dot(st) + esc(adapters[id].label) + '</button>';
      }).join('') + '</div>';
  }
  function detailHtml() {
    var id = selId;
    var a = adapters[id];
    if (!a) return '';
    var st = state.platforms[id] || { state: 'off', detail: '' };
    var cfg = config.platforms[id] || {};
    var btn = (st.state === 'on' || st.state === 'connecting')
      ? '<button type="button" class="sw-seg" data-cp-act="disconnect" data-cp-id="' + id + '" style="min-height:30px;padding:0 12px">断开</button>'
      : '<button type="button" class="sw-seg" data-cp-act="connect" data-cp-id="' + id + '" style="min-height:30px;padding:0 12px">连接</button>';
    var qrBtn = '<button type="button" class="sw-seg" data-cp-act="bridgeQr" data-cp-id="' + id + '" style="min-height:30px;padding:0 12px" title="把这份配置丢给另一台设备（不是 QQ 登录码）">导出配置码</button>';
    /* QQ 官方机器人有官方的扫码绑定流程（见 openQqBind），跟上面那个"传配置"是两回事 */
    var bindBtn = (id === 'qqofficial')
      ? '<button type="button" class="sw-seg" data-cp-act="qqBind" style="min-height:30px;padding:0 12px" title="用手机 QQ 扫码，自动拿 AppID / AppSecret">扫码绑定</button>'
      : '';
    return '<div style="padding:8px 0 2px;border-top:1px solid rgba(120,120,160,.16)">' +
      '<div style="display:flex;align-items:center;gap:8px">' + dot(st.state) +
      '<span class="sw-ttl" style="flex:1">' + esc(a.label) + '</span>' + btn + bindBtn + qrBtn + '</div>' +
      '<div style="font-size:11px;opacity:.8;line-height:1.7;padding:4px 0" id="cpState_' + id + '">' + esc(st.detail || '未连接') + '</div>' +
      (FIELD_DEFS[id] || []).map(function (fd) {
        var rowStyle = 'style="gap:8px;align-items:center"';
        var labelHtml = '<span style="font-size:11.5px;opacity:.85;flex:0 0 138px">' + esc(fd[1]) + '</span>';
        if (fd[4] === 'bool') {
          return '<div class="sw-setting-theme-row" ' + rowStyle + '>' + labelHtml +
            '<label style="display:flex;align-items:center;gap:6px;font-size:11.5px;opacity:.9;cursor:pointer">' +
            '<input type="checkbox" data-cp-field="' + fd[0] + '" data-cp-id="' + id + '"' + (cfg[fd[0]] ? ' checked' : '') + '>' +
            '<span>' + esc(fd[2] || '勾选后走沙箱环境') + '</span></label></div>';
        }
        return '<div class="sw-setting-theme-row" ' + rowStyle + '>' + labelHtml +
          '<input type="' + (fd[3] ? 'password' : 'text') + '" data-cp-field="' + fd[0] + '" data-cp-id="' + id + '" value="' + esc(cfg[fd[0]] == null ? '' : cfg[fd[0]]) + '" placeholder="' + esc(fd[2]) + '" ' +
          'style="flex:1;min-width:0;font-size:11.5px;padding:5px 8px;border-radius:8px;border:1px solid rgba(120,120,160,.28);background:transparent;color:inherit"></div>';
      }).join('') +
      '<div style="font-size:11px;opacity:.7;line-height:1.7;padding-top:4px">' + esc(PLATFORM_HINTS[id] || '') + '</div>' +
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
      chipsHtml() + detailHtml() +
      '<div class="sw-setting-theme-row" style="gap:8px;flex-wrap:wrap;padding-top:8px">' +
      '<button type="button" class="sw-seg" data-cp-act="start" style="min-height:30px;padding:0 12px">全部连接</button>' +
      '<button type="button" class="sw-seg" data-cp-act="stop" style="min-height:30px;padding:0 12px">全部断开</button>' +
      '<button type="button" class="sw-seg" data-cp-act="bridgeScan" style="min-height:30px;padding:0 12px" title="扫另一台设备的配置码，把平台配置搬过来">扫码导入配置</button>' +
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
        else if (act === 'bridgeQr') { showBridgeQr(id); }
        else if (act === 'bridgeScan') { openScanner(); }
        else if (act === 'qqBind') { openQqBind(); }
      });
    });
    body.querySelectorAll('[data-cp-pick]').forEach(function (b) {
      b.addEventListener('click', function () { selId = b.getAttribute('data-cp-pick'); render(); });
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
        /* 勾选框读 checked，其余读 value */
        var val = inp.type === 'checkbox' ? !!inp.checked : inp.value;
        if (pid) { patch.platforms = {}; patch.platforms[pid] = {}; patch.platforms[pid][name] = val; }
        else { patch[name] = name === 'intervalMs' ? Number(inp.value) : val; }
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

  /* ==================== 导出配置码（把一份平台配置在两端之间搬运） ====================
     与「设备互联」的扫码配对同一套路：一端**出示二维码**，另一端**扫一下**（或粘贴口令）就把
     平台配置接过去，省得在两台机器上各敲一遍 ws 地址 / 令牌。
     口令格式：ELAINA-BRIDGE/1:<base64url(JSON)>，内容只有平台配置本身，不含模型密钥。 */
  var BRIDGE_PREFIX = 'ELAINA-BRIDGE/1:';
  function b64urlEncode(s) {
    var b = global.btoa(unescape(encodeURIComponent(String(s))));
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    var t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return decodeURIComponent(escape(global.atob(t)));
  }
  function bridgeText(id) {
    var payload = { v: 1, platform: id, label: (adapters[id] || {}).label || id, config: config.platforms[id] || {} };
    return BRIDGE_PREFIX + b64urlEncode(JSON.stringify(payload));
  }
  /** 收到口令 → 写进配置并直接连上；返回 { ok, platform, label } */
  function acceptBridgeText(text) {
    var raw = String(text || '').trim();
    if (raw.indexOf(BRIDGE_PREFIX) !== 0) return { ok: false, code: 'BAD_PREFIX', text: '这不是 ElainaChat 的建桥口令' };
    var payload = null;
    try { payload = JSON.parse(b64urlDecode(raw.slice(BRIDGE_PREFIX.length))); }
    catch (e) { return { ok: false, code: 'BAD_PAYLOAD', text: '口令解不开：' + ((e && e.message) || e) }; }
    if (!payload || !payload.platform || !adapters[payload.platform]) {
      return { ok: false, code: 'BAD_PLATFORM', text: '口令里的平台不认识：' + (payload && payload.platform) };
    }
    var patch = { platforms: {} };
    patch.platforms[payload.platform] = Object.assign({}, payload.config || {}, { enabled: true });
    saveConfig(patch);
    selId = payload.platform;
    pushLog('ok', '扫码建桥：已接收「' + (payload.label || payload.platform) + '」的配置，正在连接');
    memToast('已接收「' + (payload.label || payload.platform) + '」的建桥配置，正在连接…');
    connect(payload.platform);
    return { ok: true, platform: payload.platform, label: payload.label || payload.platform };
  }
  function qrDataUrl(text) {
    if (typeof global.qrcode !== 'function') return '';
    try {
      /* vendor/qrcode.js 默认拉丁-1 截断，中文会糊：切成 UTF-8 */
      if (global.qrcode.stringToBytesFuncs && global.qrcode.stringToBytesFuncs['UTF-8']) global.qrcode.stringToBytes = global.qrcode.stringToBytesFuncs['UTF-8'];
      var q = global.qrcode(0, 'M');
      q.addData(text);
      q.make();
      return q.createDataURL(6, 8);
    } catch (e) { pushLog('error', '二维码生成失败：' + ((e && e.message) || e)); return ''; }
  }
  function overlayNode(id, inner) {
    var old = document.getElementById(id);
    if (old) old.remove();
    var o = document.createElement('div');
    o.id = id;
    o.style.cssText = 'position:fixed;inset:0;z-index:1300;background:rgba(10,12,20,.72);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(8px);';
    o.innerHTML = inner;
    document.body.appendChild(o);
    return o;
  }
  function showBridgeQr(id) {
    var text = bridgeText(id);
    var img = qrDataUrl(text);
    var label = (adapters[id] || {}).label || id;
    var o = overlayNode('cpBridgeQrOverlay',
      '<div style="width:100%;max-width:420px;border-radius:20px;padding:16px;background:rgba(20,24,36,.9);border:1px solid rgba(255,255,255,.14);color:#e8eefb">' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:8px">导出配置码 · ' + esc(label) + '</div>' +
      '<div style="font-size:11.5px;opacity:.8;line-height:1.7;margin-bottom:10px">在**另一台设备**上打开「设置 → 聊天平台 → 扫码接收桥」，扫这张码即可把这份配置接过去（含地址与令牌）。口令只在两台设备之间传递，不上传任何服务器。</div>' +
      '<div style="text-align:center;background:#fff;border-radius:14px;padding:10px">' +
      (img ? '<img alt="建桥二维码" style="width:260px;height:260px;display:block;margin:0 auto" src="' + img + '">' : '<div style="color:#333;padding:30px 0">二维码库没加载，请用下面的口令</div>') +
      '</div>' +
      '<textarea id="cpBridgeText" readonly style="margin-top:10px;width:100%;height:64px;font-size:11px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e8eefb;padding:6px">' + esc(text) + '</textarea>' +
      '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button type="button" class="sw-seg" data-cp-bridge="copy" style="flex:1;min-height:32px">复制口令</button>' +
      '<button type="button" class="sw-seg" data-cp-bridge="use" data-cp-id="' + id + '" style="flex:1;min-height:32px">本机也用它并连接</button>' +
      '<button type="button" class="sw-seg" data-cp-bridge="close" style="flex:1;min-height:32px">关闭</button>' +
      '</div></div>');
    o.querySelector('[data-cp-bridge="close"]').addEventListener('click', function () { o.remove(); });
    o.addEventListener('click', function (e) { if (e.target === o) o.remove(); });
    o.querySelector('[data-cp-bridge="use"]').addEventListener('click', function () { var pid = this.getAttribute('data-cp-id'); o.remove(); connect(pid); });
    o.querySelector('[data-cp-bridge="copy"]').addEventListener('click', function () {
      var ta = o.querySelector('#cpBridgeText');
      try { ta.select(); document.execCommand('copy'); memToast('口令已复制'); } catch (e) { memToast('复制失败，请手动全选'); }
    });
    return { ok: true, text: text, hasQr: !!img };
  }
  var scanStream = null, scanTimer = null;
  function stopScan() {
    if (scanTimer) { global.clearInterval(scanTimer); scanTimer = null; }
    if (scanStream) { try { scanStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} scanStream = null; }
    var o = document.getElementById('cpScanOverlay');
    if (o) o.remove();
  }
  /** 扫码接收桥：有相机就开相机，没有相机也能粘贴口令（同一个入口） */
  function openScanner() {
    var o = overlayNode('cpScanOverlay',
      '<div style="width:100%;max-width:420px;border-radius:20px;padding:16px;background:rgba(20,24,36,.9);border:1px solid rgba(255,255,255,.14);color:#e8eefb">' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:8px">扫码接收桥</div>' +
      '<div style="position:relative;width:100%;aspect-ratio:1/1;border-radius:14px;overflow:hidden;background:#000">' +
      '<video id="cpScanVideo" playsinline muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>' +
      '<canvas id="cpScanCanvas" style="display:none"></canvas></div>' +
      '<div id="cpScanStatus" style="font-size:11.5px;opacity:.85;margin-top:8px;line-height:1.7">把另一台设备上的建桥二维码放进框内…</div>' +
      '<div style="font-size:11px;opacity:.7;margin-top:8px">没有相机 / 扫不出来？把口令粘到下面：</div>' +
      '<textarea id="cpScanText" placeholder="ELAINA-BRIDGE/1:…" style="width:100%;height:56px;font-size:11px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e8eefb;padding:6px"></textarea>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button type="button" class="sw-seg" data-cp-scan="paste" style="flex:1;min-height:32px">用口令接入</button>' +
      '<button type="button" class="sw-seg" data-cp-scan="close" style="flex:1;min-height:32px">取消</button>' +
      '</div></div>');
    var status = o.querySelector('#cpScanStatus');
    function done(text) {
      var r = acceptBridgeText(text);
      if (!r.ok) { status.textContent = r.text; return; }
      stopScan();
    }
    o.querySelector('[data-cp-scan="close"]').addEventListener('click', stopScan);
    o.addEventListener('click', function (e) { if (e.target === o) stopScan(); });
    o.querySelector('[data-cp-scan="paste"]').addEventListener('click', function () {
      done(String((o.querySelector('#cpScanText') || {}).value || ''));
    });
    var video = o.querySelector('#cpScanVideo');
    var canvas = o.querySelector('#cpScanCanvas');
    if (typeof global.jsQR !== 'function') { status.textContent = '扫码库没加载，请用下面的口令接入。'; return o; }
    if (!global.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = '这个环境没有相机接口，请用下面的口令接入。';
      return o;
    }
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(function (stream) {
      scanStream = stream;
      video.srcObject = stream;
      return video.play();
    }).then(function () {
      scanTimer = global.setInterval(function () {
        if (video.readyState < 2) return;
        var w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return;
        canvas.width = w; canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        var data = ctx.getImageData(0, 0, w, h);
        var code = global.jsQR(data.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code && code.data) done(code.data);
      }, 240);
    }).catch(function (e) {
      status.textContent = '相机打不开（' + ((e && e.message) || e) + '），请用下面的口令接入。';
    });
    return o;
  }

  /* ==================== QQ 官方机器人 · 扫码绑定（照 AstrBot 的流程实现） ====================
     与 astrbot/core/platform/sources/qqofficial/login_registration.py 一致：
       ① POST https://q.qq.com/lite/create_bind_task { key: base64(32B 随机 AES 密钥) } → task_id
       ② 二维码内容 = https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&_wv=2
          这是**网址**，手机 QQ / 相机扫了直接打开绑定页（上一版自定义口令扫不出来就栽在这）
       ③ POST /lite/poll_bind_result { task_id } → status 0 无 / 1 待扫 / 2 完成 / 3 过期
          完成后给 bot_appid + bot_encrypt_secret（base64: 12B nonce + 密文 + 16B GCM tag）
       ④ 用 ① 的密钥做 AES-256-GCM 解密拿到 AppSecret，自动填配置并连接
     q.qq.com 不回 Access-Control-Allow-Origin：安卓靠 CapacitorHttp（原生发请求）绕开，
     PC 靠 desktop-pet/LocalProxy 转发。 */
  var QQ_BIND_HOST = 'https://q.qq.com';
  var QQ_BIND_INTERVAL_MS = 2000;
  var qqBindTask = null;

  function isNativeShell() {
    try { return !!(global.Capacitor || global.__PC_DESKTOP || (navigator && /Android/i.test(String(navigator.userAgent)))); }
    catch (e) { return false; }
  }
  function toBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return global.btoa(s);
  }
  function fromBase64(b64) {
    var s = global.atob(String(b64 || ''));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
    return out;
  }
  function newBindKey() {
    var bytes = new Uint8Array(32);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
    else for (var i = 0; i < 32; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return toBase64(bytes);
  }
  function postJson(url, body) {
    return global.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = JSON.parse(t); } catch (e) { throw new Error('绑定接口返回不是 JSON：' + String(t).slice(0, 80)); }
        if (data && data.retcode !== undefined && Number(data.retcode) !== 0) {
          throw new Error(data.msg || data.message || ('绑定接口失败 retcode=' + data.retcode));
        }
        return data || {};
      });
    });
  }
  /** AES-256-GCM 解密 QQ 回的 AppSecret（12B nonce + 密文 + 16B tag） */
  function decryptQqSecret(encB64, keyB64) {
    var subtle = global.crypto && global.crypto.subtle;
    if (!subtle) return Promise.reject(new Error('这个环境没有 WebCrypto，无法解密 AppSecret'));
    var raw = fromBase64(encB64);
    if (raw.length <= 28) return Promise.reject(new Error('AppSecret 密文格式异常'));
    var nonce = raw.slice(0, 12);
    var tag = raw.slice(raw.length - 16);
    var cipher = raw.slice(12, raw.length - 16);
    var sealed = new Uint8Array(cipher.length + tag.length);
    sealed.set(cipher, 0);
    sealed.set(tag, cipher.length);
    return subtle.importKey('raw', fromBase64(keyB64), { name: 'AES-GCM' }, false, ['decrypt'])
      .then(function (k) { return subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, k, sealed); })
      .then(function (buf) { return new TextDecoder().decode(buf); });
  }
  function stopQqBind(keepTask) {
    if (qqBindTask && qqBindTask.timer) { global.clearInterval(qqBindTask.timer); qqBindTask.timer = null; }
    var o = document.getElementById('cpQqBindOverlay');
    if (o) o.remove();
    if (!keepTask) qqBindTask = null;
  }
  function qqBindStatus(text, kind) {
    var el = document.getElementById('cpQqBindStatus');
    if (el) { el.textContent = text; el.style.color = kind === 'error' ? '#ffb4b4' : (kind === 'ok' ? '#9ff0c4' : '#e8eefb'); }
  }
  function openQqBind() {
    stopQqBind(true);
    var keyB64 = newBindKey();
    var o = overlayNode('cpQqBindOverlay',
      '<div style="width:100%;max-width:420px;border-radius:20px;padding:16px;background:rgba(20,24,36,.92);border:1px solid rgba(255,255,255,.14);color:#e8eefb">' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:8px">扫码绑定 QQ 官方机器人</div>' +
      '<div style="font-size:11.5px;opacity:.82;line-height:1.7;margin-bottom:10px">请用**手机 QQ 的「扫一扫」**扫下面这张码（右上角 ＋ → 扫一扫）。<br>不要用系统相机 / 微信 / 浏览器扫 —— 那个页面要 QQ 内置浏览器的 jsbridge 才能跑，在普通浏览器里会**白屏**。<br>绑定成功后 AppID 与 AppSecret 会自动填好并连接。</div>' +
      '<div id="cpQqBindQrBox" style="text-align:center;background:#fff;border-radius:14px;padding:10px;min-height:120px"><div style="color:#555;padding:40px 0;font-size:12px">正在取二维码…</div></div>' +
      '<div id="cpQqBindLink" style="display:none;font-size:11px;opacity:.75;margin-top:8px;line-height:1.6"></div>' +
      '<div id="cpQqBindStatus" style="font-size:11.5px;margin-top:10px;line-height:1.7">正在创建绑定任务…</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button type="button" class="sw-seg" data-cp-qqbind="refresh" style="flex:1;min-height:32px">换一张</button>' +
      '<button type="button" class="sw-seg" data-cp-qqbind="close" style="flex:1;min-height:32px">取消</button>' +
      '</div></div>');
    o.querySelector('[data-cp-qqbind="close"]').addEventListener('click', function () { stopQqBind(false); });
    o.addEventListener('click', function (e) { if (e.target === o) stopQqBind(false); });
    o.querySelector('[data-cp-qqbind="refresh"]').addEventListener('click', function () { openQqBind(); });

    qqBindTask = { taskId: '', keyB64: keyB64, timer: null };
    postJson(QQ_BIND_HOST + '/lite/create_bind_task', { key: keyB64 }).then(function (data) {
      var taskId = ((data || {}).data || {}).task_id || '';
      if (!taskId) throw new Error('绑定任务没有返回 task_id');
      qqBindTask.taskId = taskId;
      var url = QQ_BIND_HOST + '/qqbot/openclaw/connect.html?task_id=' + encodeURIComponent(taskId) + '&_wv=2';
      var img = qrDataUrl(url);
      var box = document.getElementById('cpQqBindQrBox');
      if (box) {
        box.innerHTML = img
          ? '<img alt="QQ 绑定二维码" style="width:240px;height:240px;display:block;margin:0 auto" src="' + img + '">'
          : '<div style="color:#333;padding:30px 0;font-size:12px">二维码库没加载，请复制链接到手机打开：<br>' + esc(url) + '</div>';
      }
      var linkBox = document.getElementById('cpQqBindLink');
      if (linkBox) {
        linkBox.style.display = 'block';
        linkBox.innerHTML = '扫不动？把这条链接复制到手机 QQ 里打开：<br><span style="word-break:break-all">' + esc(url) + '</span>';
      }
      qqBindStatus('等待手机 QQ 扫码…（二维码几分钟内有效，过期点「换一张」）');
      qqBindTask.timer = global.setInterval(pollQqBind, QQ_BIND_INTERVAL_MS);
      pollQqBind();
    }).catch(function (e) {
      var hint = isNativeShell() ? '' : '（PC 端可能被 CORS 拦：q.qq.com 不回允许跨域头，见下方说明）';
      qqBindStatus('创建绑定任务失败：' + ((e && e.message) || e) + hint, 'error');
      pushLog('error', 'QQ 扫码绑定：创建任务失败 ' + ((e && e.message) || e));
    });
  }
  function pollQqBind() {
    if (!qqBindTask || !qqBindTask.taskId) return;
    postJson(QQ_BIND_HOST + '/lite/poll_bind_result', { task_id: qqBindTask.taskId }).then(function (data) {
      var d = (data || {}).data || {};
      var status = Number(d.status || 0);
      if (status === 0 || status === 1) { qqBindStatus('等待手机 QQ 扫码…'); return; }
      if (status === 3) {
        qqBindStatus('二维码已过期，点「换一张」重新生成。', 'error');
        if (qqBindTask && qqBindTask.timer) { global.clearInterval(qqBindTask.timer); qqBindTask.timer = null; }
        return;
      }
      if (status !== 2) { qqBindStatus('绑定状态未知：' + status); return; }
      var appId = String(d.bot_appid || '').trim();
      var enc = String(d.bot_encrypt_secret || '').trim();
      if (!appId || !enc) { qqBindStatus('扫码成功但没拿到完整凭证', 'error'); return; }
      qqBindStatus('扫码成功，正在解密 AppSecret…', 'ok');
      decryptQqSecret(enc, qqBindTask.keyB64).then(function (secret) {
        var patch = { platforms: {} };
        patch.platforms.qqofficial = Object.assign({}, config.platforms.qqofficial, { appId: appId, clientSecret: secret, enabled: true });
        saveConfig(patch);
        stopQqBind(false);
        pushLog('ok', 'QQ 扫码绑定成功：AppID ' + mask(appId));
        memToast('QQ 机器人绑定成功，正在连接…');
        selId = 'qqofficial';
        try { render(); } catch (e) {}
        connect('qqofficial');
      }).catch(function (e) {
        qqBindStatus('AppSecret 解密失败：' + ((e && e.message) || e), 'error');
        pushLog('error', 'QQ 扫码绑定：解密失败 ' + ((e && e.message) || e));
      });
    }).catch(function (e) { qqBindStatus('轮询失败：' + ((e && e.message) || e), 'error'); });
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
    bridgeText: bridgeText,             /* 生成建桥口令（探针/调试用） */
    acceptBridgeText: acceptBridgeText,  /* 接收建桥口令并连上 */
    showBridgeQr: showBridgeQr,
    openScanner: openScanner,
    openQqBind: openQqBind,              /* QQ 官方扫码绑定 */
    decryptQqSecret: decryptQqSecret,    /* AES-256-GCM 解密 AppSecret（探针用） */
    isRunning: isRunning,
    adapters: Object.keys(adapters)
  };
  pushLog('info', '聊天平台模块就绪（适配器：' + Object.keys(adapters).join(' / ') + '）');
})(window);
