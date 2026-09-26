import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiRouteAudiencePolicyService,
  normalizeAiRouteAudiencePolicy,
  validateAiRouteAudiencePolicy,
} from './ai-route-audience-policy.service';

function route(routeKey: string, access: 'ALL' | 'FREE_ONLY' | 'PAID_ONLY', enabled = true) {
  return {
    route_key: routeKey,
    membership_route_enabled: enabled,
    audience_policy: {
      schema_version: 'ai-route-audience-policy-v1' as const,
      membership_access: access,
    },
  };
}

test('disabled models preserve the existing route order without filtering', () => {
  const service = new AiRouteAudiencePolicyService();
  const routes = [route('paid', 'PAID_ONLY', false), route('free', 'FREE_ONLY', false)];
  const result = service.filter({ routes, billing_intent: 'customer_billed', audience_tier: 'FREE' });
  assert.deepEqual(result.routes.map((item) => item.route_key), ['paid', 'free']);
  assert.equal(result.decision.bypass_reason, 'model_disabled');
});

test('free and paid subjects receive only eligible routes while preserving order', () => {
  const service = new AiRouteAudiencePolicyService();
  const routes = [route('paid', 'PAID_ONLY'), route('shared', 'ALL'), route('free', 'FREE_ONLY')];
  assert.deepEqual(
    service.filter({ routes, billing_intent: 'customer_billed', audience_tier: 'FREE' }).routes.map((item) => item.route_key),
    ['shared', 'free'],
  );
  assert.deepEqual(
    service.filter({ routes, billing_intent: 'customer_billed', audience_tier: 'PAID' }).routes.map((item) => item.route_key),
    ['paid', 'shared'],
  );
});

test('internal non-billable calls bypass membership filtering explicitly', () => {
  const service = new AiRouteAudiencePolicyService();
  const routes = [route('paid', 'PAID_ONLY'), route('free', 'FREE_ONLY')];
  const result = service.filter({ routes, billing_intent: 'internal_non_billable', audience_tier: null });
  assert.deepEqual(result.routes.map((item) => item.route_key), ['paid', 'free']);
  assert.equal(result.decision.bypass_reason, 'internal_non_billable');
});

test('customer calls fail closed when no route is eligible', () => {
  const service = new AiRouteAudiencePolicyService();
  assert.throws(
    () => service.filter({ routes: [route('paid', 'PAID_ONLY')], billing_intent: 'customer_billed', audience_tier: 'FREE' }),
    (error: any) => error?.getResponse?.().code === 'AI_MODEL_AUDIENCE_ROUTE_UNAVAILABLE',
  );
});

test('route audience policy normalization is backward compatible and writes validate strictly', () => {
  assert.deepEqual(normalizeAiRouteAudiencePolicy(undefined), {
    schema_version: 'ai-route-audience-policy-v1',
    membership_access: 'ALL',
  });
  assert.equal(validateAiRouteAudiencePolicy({ membership_access: 'paid_only' }).membership_access, 'PAID_ONLY');
  assert.throws(() => validateAiRouteAudiencePolicy({ membership_access: 'unknown' }));
});
