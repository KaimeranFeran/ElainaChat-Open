import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonDecoder, encodeMessage, MAX_LINE_BYTES } from '../src/protocol/ndjson.ts';

test('编码/解码往返', () => {
  const d = new NdjsonDecoder();
  const msgs = d.push(encodeMessage({ type: 'hello', clientVersion: '2.3.0' }));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'hello');
  assert.equal(msgs[0].clientVersion, '2.3.0');
});

test('跨 chunk 粘包/拆包', () => {
  const d = new NdjsonDecoder();
  assert.deepEqual(d.push('{"type":"a"}\n{"ty'), [{ type: 'a' }]);
  assert.deepEqual(d.push('pe":"b"}\n'), [{ type: 'b' }]);
});

test('CRLF 与空行', () => {
  const d = new NdjsonDecoder();
  assert.deepEqual(d.push('{"type":"x"}\r\n\n'), [{ type: 'x' }]);
});

test('非法 JSON / 缺 type 抛协议错误', () => {
  assert.throws(() => new NdjsonDecoder().push('{oops\n'), /PROTOCOL_INVALID/);
  assert.throws(() => new NdjsonDecoder().push('{"a":1}\n'), /PROTOCOL_INVALID/);
});

test('超长行被拒', () => {
  const big = '{"type":"x","d":"' + 'a'.repeat(MAX_LINE_BYTES) + '"}';
  assert.throws(() => new NdjsonDecoder().push(big), /PROTOCOL_INVALID/);
});
