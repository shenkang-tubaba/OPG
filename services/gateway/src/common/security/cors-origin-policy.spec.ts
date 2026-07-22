import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCorsOriginAllowed } from './cors-origin-policy';

const configuredOrigins = ['https://opg.example.com', 'https://*.apps.example.com'];

test('allows exact and explicitly configured wildcard origins', () => {
  assert.equal(isCorsOriginAllowed('https://opg.example.com', configuredOrigins), true);
  assert.equal(isCorsOriginAllowed('https://tenant.apps.example.com', configuredOrigins), true);
});

test('rejects unrelated, malformed, and wildcard-root origins', () => {
  assert.equal(isCorsOriginAllowed('https://evil.example', configuredOrigins), false);
  assert.equal(isCorsOriginAllowed('https://opg.example.com.evil.example', configuredOrigins), false);
  assert.equal(isCorsOriginAllowed('https://apps.example.com', configuredOrigins), false);
  assert.equal(isCorsOriginAllowed('not-an-origin', configuredOrigins), false);
});

test('keeps private development origins disabled in production mode', () => {
  assert.equal(isCorsOriginAllowed('http://localhost:5173', configuredOrigins, false), false);
  assert.equal(isCorsOriginAllowed('https://demo.127-0-0-1.sslip.io', configuredOrigins, false), false);
  assert.equal(isCorsOriginAllowed('http://localhost:5173', configuredOrigins, true), true);
  assert.equal(isCorsOriginAllowed('https://demo.127-0-0-1.sslip.io', configuredOrigins, true), true);
});

test('allows requests without Origin for non-browser clients', () => {
  assert.equal(isCorsOriginAllowed(undefined, configuredOrigins), true);
});
