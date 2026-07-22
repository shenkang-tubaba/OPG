import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWebSocketRequestGuard,
  extractSocketAccessToken,
  resolveWebSocketMaxPayloadBytes,
} from './websocket-security-policy';

test('accepts socket tokens only from values explicitly supplied by trusted auth channels', () => {
  assert.equal(extractSocketAccessToken('Bearer auth-token', undefined), 'auth-token');
  assert.equal(extractSocketAccessToken(undefined, 'Bearer header-token'), 'header-token');
  assert.equal(extractSocketAccessToken(undefined, undefined), null);
});

test('rejects an untrusted Origin before Engine.IO creates a session', () => {
  const guard = createWebSocketRequestGuard(['https://opg.example.com']);
  let allowed: boolean | undefined;

  guard({ headers: { origin: 'https://evil.example' } }, (_error, success) => {
    allowed = success;
  });

  assert.equal(allowed, false);
});

test('bounds websocket payload size configuration', () => {
  assert.equal(resolveWebSocketMaxPayloadBytes(undefined), 1024 * 1024);
  assert.equal(resolveWebSocketMaxPayloadBytes('1'), 16 * 1024);
  assert.equal(resolveWebSocketMaxPayloadBytes('99999999'), 5 * 1024 * 1024);
});
