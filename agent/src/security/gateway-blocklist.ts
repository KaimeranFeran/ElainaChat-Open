/**
 * 官方网关黑名单：agent 一律不允许走我们的网关（聊天可以走，agent 不行）。
 *
 * 为什么需要：官方网关是我们付钱的基础设施；agent 任务会产生大量长上下文与工具循环，
 * 一旦被指向网关，等于拿我们的额度替用户跑 agent。所以这里**硬禁止**：
 * 命中即 agent 不可用（不是提示后仍可继续）。
 *
 * 开源版与此逻辑相同；开源版额外要求「必须自备服务商」，见 config.ts。
 */

/** 官方网关主机（含历史域名）：精确匹配 + 其子域 */
const BLOCKED_HOSTS = ['106.14.16.68', 'elainachat.j3.ink'];

/** 允许枚举的 host 别名（统一小写、去尾点） */
function normalizeHost(host: string): string {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

function isBlockedHost(host: string): boolean {
  const h = normalizeHost(host);
  return BLOCKED_HOSTS.some((blocked) => h === blocked || h.endsWith('.' + blocked));
}

/** 本机回环地址（PC 本地代理会把这些转发到官方网关） */
function isLoopback(host: string): boolean {
  const h = normalizeHost(host);
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
}

export interface BlocklistVerdict {
  blocked: boolean;
  reason: 'gateway-host' | 'local-proxy' | 'invalid-url' | '';
  detail: string;
}

/**
 * 判断某个 agent baseUrl 是否指向官方网关。
 * - 官方域名/IP：永远禁止
 * - 回环地址 3500 端口：PC 本地代理（转发到网关），同样禁止
 * - 非法 URL：按配置无效处理（调用方给 CONFIG_INVALID）
 */
export function checkAgentBaseUrl(rawBaseUrl: string): BlocklistVerdict {
  const raw = String(rawBaseUrl || '').trim();
  if (!raw) return { blocked: false, reason: '', detail: '' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { blocked: true, reason: 'invalid-url', detail: 'Agent 的 baseUrl 不是合法 URL：' + raw };
  }
  if (isBlockedHost(url.hostname)) {
    return {
      blocked: true,
      reason: 'gateway-host',
      detail: 'Agent 不允许使用官方网关（' + url.hostname + '）。请在「设置 → Agent」里填写你自己的模型服务商地址。',
    };
  }
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (isLoopback(url.hostname) && port === 3500) {
    return {
      blocked: true,
      reason: 'local-proxy',
      detail: '127.0.0.1:3500 是 ElainaChat 的本地反代（会转发到官方网关），Agent 不能用它。',
    };
  }
  return { blocked: false, reason: '', detail: '' };
}
