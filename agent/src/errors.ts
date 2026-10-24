/** agent 侧统一错误码：工具结果与协议错误都用它，避免自由文本导致判定歧义 */
export const AGENT_ERROR = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  GATEWAY_FORBIDDEN: 'GATEWAY_FORBIDDEN',
  PROTOCOL_INVALID: 'PROTOCOL_INVALID',
  TOOL_DENIED: 'TOOL_DENIED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_FAILED: 'TOOL_FAILED',
  INTERACTIVE_BLOCKED: 'INTERACTIVE_BLOCKED',
  STALLED: 'STALLED',
  CANCELLED: 'CANCELLED',
} as const;

export type AgentErrorCode = (typeof AGENT_ERROR)[keyof typeof AGENT_ERROR];

/** 工具结果的统一形状：失败是数据，不是异常 —— 模型据此选择重试/换法/上报 */
export interface ToolResult {
  ok: boolean;
  code: AgentErrorCode | 'OK';
  message: string;
  data?: unknown;
  retryable?: boolean;
  needs_user?: boolean;
  denied?: boolean;
}

export function ok(data?: unknown, message = ''): ToolResult {
  return { ok: true, code: 'OK', message, data };
}

export function fail(code: AgentErrorCode, message: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: false, code, message, retryable: false, ...extra };
}
