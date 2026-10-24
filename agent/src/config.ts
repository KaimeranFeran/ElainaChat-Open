import { AGENT_ERROR, fail, type ToolResult } from './errors.ts';
import { checkAgentBaseUrl } from './security/gateway-blocklist.ts';

export type AgentProtocol = 'anthropic' | 'openai' | 'openai-responses';
export type AgentAccess = 'approval' | 'full';

export interface AgentModelConfig {
  protocol: AgentProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 是否启用文本 JSON 协议降级（模型不支持原生 tool_calls 时置 true） */
  textProtocolFallback?: boolean;
}

export interface AgentConfig {
  enabled: boolean;
  access: AgentAccess;
  workspace: string;
  model: AgentModelConfig;
  search?: { provider: 'tavily' | 'brave' | 'custom'; apiKey?: string; url?: string };
}

export interface AgentLimits {
  maxSteps: number;
  maxRunMs: number;
  shellTimeoutMs: number;
  approvalTimeoutMs: number;
  outputHeadLines: number;
  outputTailLines: number;
  outputMaxBytes: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 40,
  maxRunMs: 10 * 60 * 1000,
  shellTimeoutMs: 60 * 1000,
  approvalTimeoutMs: 60 * 1000,
  outputHeadLines: 200,
  outputTailLines: 50,
  outputMaxBytes: 8 * 1024,
};

const PROTOCOLS: AgentProtocol[] = ['anthropic', 'openai', 'openai-responses'];

/** 校验 agent 配置：返回 null 表示可用，否则返回结构化失败（code + 用户可读 message） */
export function validateAgentConfig(config: AgentConfig | null | undefined): ToolResult | null {
  if (!config) return fail(AGENT_ERROR.CONFIG_INVALID, 'Agent 尚未配置。请在「设置 → Agent」里填写服务商、协议、模型与 Key。', { needs_user: true });
  if (!config.enabled) return fail(AGENT_ERROR.CONFIG_INVALID, 'Agent 模式未开启。', { needs_user: true });
  const model = config.model;
  if (!model) return fail(AGENT_ERROR.CONFIG_INVALID, 'Agent 缺少模型配置。', { needs_user: true });
  if (!PROTOCOLS.includes(model.protocol)) {
    return fail(AGENT_ERROR.CONFIG_INVALID, 'Agent 协议不受支持：' + String(model.protocol) + '（可用：' + PROTOCOLS.join(' / ') + '）。', { needs_user: true });
  }
  if (!String(model.baseUrl || '').trim()) return fail(AGENT_ERROR.CONFIG_INVALID, 'Agent 缺少服务商地址（baseUrl）。', { needs_user: true });
  if (!String(model.apiKey || '').trim()) return fail(AGENT_ERROR.CONFIG_INVALID, 'Agent 缺少 API Key：Agent 必须使用你自己的 Key（聊天用的官方 Key 不能用于 Agent）。', { needs_user: true });
  if (!String(model.model || '').trim()) return fail(AGENT_ERROR.CONFIG_INVALID, 'Agent 缺少模型名。', { needs_user: true });
  if (!String(config.workspace || '').trim()) return fail(AGENT_ERROR.CONFIG_INVALID, 'Agent 缺少工作区目录。', { needs_user: true });
  const blocked = checkAgentBaseUrl(model.baseUrl);
  if (blocked.blocked) return fail(AGENT_ERROR.GATEWAY_FORBIDDEN, blocked.detail, { needs_user: true });
  return null;
}
