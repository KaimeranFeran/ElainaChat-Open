import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentConfig, DEFAULT_LIMITS, type AgentConfig } from '../src/config.ts';

function base(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    enabled: true,
    access: 'approval',
    workspace: 'C:\\work',
    model: { protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-user', model: 'deepseek-chat' },
    ...over,
  } as AgentConfig;
}

test('合法配置通过', () => {
  assert.equal(validateAgentConfig(base()), null);
});

test('官方网关地址 → GATEWAY_FORBIDDEN', () => {
  const r = validateAgentConfig(base({ model: { protocol: 'openai', baseUrl: 'http://106.14.16.68', apiKey: 'x', model: 'm' } }));
  assert.equal(r?.code, 'GATEWAY_FORBIDDEN');
  assert.equal(r?.needs_user, true);
});

test('本地反代 3500 → GATEWAY_FORBIDDEN', () => {
  const r = validateAgentConfig(base({ model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:3500', apiKey: 'x', model: 'm' } }));
  assert.equal(r?.code, 'GATEWAY_FORBIDDEN');
});

test('缺 Key / 缺模型 / 未开启 → CONFIG_INVALID 且 needs_user', () => {
  const noKey = validateAgentConfig(base({ model: { protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'm' } }));
  assert.equal(noKey?.code, 'CONFIG_INVALID');
  assert.match(String(noKey?.message), /自己的 Key/);
  assert.equal(validateAgentConfig(base({ enabled: false }))?.code, 'CONFIG_INVALID');
});

test('协议白名单', () => {
  const r = validateAgentConfig(base({ model: { protocol: 'gemini' as never, baseUrl: 'https://x.com', apiKey: 'k', model: 'm' } }));
  assert.equal(r?.code, 'CONFIG_INVALID');
  assert.equal(DEFAULT_LIMITS.maxSteps, 40);
});
