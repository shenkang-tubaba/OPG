import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureRawBody,
  DEFAULT_HTTP_JSON_BODY_LIMIT,
  isSignedPaymentWebhookPath,
} from './raw-body-policy';

test('keeps the default JSON limit compatible with current OPG clients', () => {
  assert.equal(DEFAULT_HTTP_JSON_BODY_LIMIT, '20mb');
});

test('matches only provider and method SaaS payment callbacks', () => {
  assert.equal(isSignedPaymentWebhookPath('/api/v1/payments/callbacks/stripe/default'), true);
  assert.equal(isSignedPaymentWebhookPath('/demo/v1/payments/callbacks/provider/method?source=notify'), true);
  assert.equal(isSignedPaymentWebhookPath('/api/v1/payments/callbacks/apple'), false);
  assert.equal(isSignedPaymentWebhookPath('/demo/v1/payments/callbacks/wechat-notify'), false);
  assert.equal(isSignedPaymentWebhookPath('/api/v1/payments/orders/page-pay'), false);
});

test('retains the parser buffer without allocating a second copy', () => {
  const req: { rawBody?: Buffer } = {};
  const buffer = Buffer.from('{"ok":true}');

  captureRawBody(req as any, undefined, buffer);

  assert.equal(req.rawBody, buffer);
});
