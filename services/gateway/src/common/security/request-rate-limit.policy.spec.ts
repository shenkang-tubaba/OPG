import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestRateLimitPolicy } from './request-rate-limit.policy';

test('uses conservative defaults for request cost classes', () => {
  const policy = createRequestRateLimitPolicy({});

  assert.deepEqual(policy.default, { limit: 300, ttl: 60_000 });
  assert.deepEqual(policy.login, { limit: 10, ttl: 60_000 });
  assert.deepEqual(policy.verification, { limit: 5, ttl: 600_000 });
  assert.deepEqual(policy.upload, { limit: 10, ttl: 60_000 });
  assert.deepEqual(policy.publicWrite, { limit: 30, ttl: 60_000 });
});

test('bounds environment overrides to safe ranges', () => {
  const policy = createRequestRateLimitPolicy({
    HTTP_RATE_LIMIT_PER_MINUTE: '999999',
    AUTH_LOGIN_RATE_LIMIT_PER_MINUTE: '0',
  });

  assert.equal(policy.default.limit, 10_000);
  assert.equal(policy.login.limit, 1);
});
