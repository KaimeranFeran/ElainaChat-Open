import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentBaseUrl } from '../src/security/gateway-blocklist.ts';

test('官方网关 IP 永远禁止', () => {
  for (const url of ['http://106.14.16.68', 'http://106.14.16.68/v1', 'https://106.14.16.68:8443/api']) {
    const v = checkAgentBaseUrl(url);
    assert.equal(v.blocked, true, url);
    assert.equal(v.reason, 'gateway-host', url);
  }
});

test('官方域名与其子域禁止', () => {
  for (const url of ['https://elainachat.j3.ink/v1', 'https://api.elainachat.j3.ink', 'ELAINACHAT.J3.INK']) {
    const v = checkAgentBaseUrl(url);
    assert.equal(v.blocked, true, url);
  }
});

test('PC 本地反代 127.0.0.1:3500 禁止（其余回环端口放行）', () => {
  for (const url of ['http://127.0.0.1:3500/v1', 'http://localhost:3500', 'http://[::1]:3500']) {
    const v = checkAgentBaseUrl(url);
    assert.equal(v.blocked, true, url);
    assert.equal(v.reason, 'local-proxy', url);
  }
  assert.equal(checkAgentBaseUrl('http://127.0.0.1:8080/v1').blocked, false);
});

test('普通服务商放行', () => {
  for (const url of ['https://api.deepseek.com', 'https://api.anthropic.com/v1', 'https://openrouter.ai/api/v1']) {
    assert.equal(checkAgentBaseUrl(url).blocked, false, url);
  }
});

test('非法 URL 按无效处理（不是静默放行）', () => {
  const v = checkAgentBaseUrl('not a url');
  assert.equal(v.blocked, true);
  assert.equal(v.reason, 'invalid-url');
});

test('空串不拦截（由必填校验负责）', () => {
  assert.equal(checkAgentBaseUrl('').blocked, false);
});
