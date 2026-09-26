import assert from 'node:assert/strict';
import test from 'node:test';
import { AiChatService } from './ai-chat.service';
import { AiRouteAudiencePolicyService } from './ai-route-audience-policy.service';
import { AiPriceBookService } from './ai-price-book.service';

const appId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

function route(key: string, access: 'ALL' | 'FREE_ONLY' | 'PAID_ONLY') {
  return {
    app_id: appId,
    route_key: key,
    membership_route_enabled: true,
    audience_policy: { schema_version: 'ai-route-audience-policy-v1', membership_access: access },
    execution_plan_hash: 'original-plan',
  };
}

test('membership candidates are filtered before a scheduler can see a paid route', async () => {
  const service = Object.create(AiChatService.prototype) as any;
  service.aiRouteAudiencePolicy = new AiRouteAudiencePolicyService();
  service.prisma = {
    user: { findFirst: async () => ({ membershipType: 'FREE', membershipExpiresAt: null }) },
    $queryRawUnsafe: async () => [{ active: false }],
  };
  const context: Record<string, unknown> = { user_id: userId };
  const eligible = await service.applyRouteAudiencePolicy([
    route('premium', 'PAID_ONLY'), route('shared', 'ALL'), route('free', 'FREE_ONLY'),
  ], context);
  assert.deepEqual(eligible.map((item: { route_key: string }) => item.route_key), ['shared', 'free']);
  assert.equal((context.route_audience_decision as any).input_candidate_count, 3);
  assert.equal((context.route_audience_decision as any).audience_tier, 'FREE');
  assert.notEqual(eligible[0].execution_plan_hash, 'original-plan');
});

test('AI membership entitlement and expired app membership use the same frozen tier', async () => {
  const service = Object.create(AiChatService.prototype) as any;
  service.aiRouteAudiencePolicy = new AiRouteAudiencePolicyService();
  service.prisma = {
    user: { findFirst: async () => ({ membershipType: 'PREMIUM', membershipExpiresAt: new Date('2020-01-01') }) },
    $queryRawUnsafe: async () => [{ active: true }],
  };
  const context: Record<string, unknown> = { user_id: userId };
  const eligible = await service.applyRouteAudiencePolicy([
    route('premium', 'PAID_ONLY'), route('free', 'FREE_ONLY'),
  ], context);
  assert.deepEqual(eligible.map((item: { route_key: string }) => item.route_key), ['premium']);
  assert.equal(context.audience_tier, 'PAID');
});

test('versioned free prices cannot fall back to legacy points', () => {
  const service = Object.create(AiChatService.prototype) as any;
  const charge = service.resolvePointsCharge(
    { pricing_mode: 'per_call', points_per_call: 50 },
    { billed_units: 1, estimated_cost_rmb: 5, points_cost_override: 0, charge_rmb_override: 0 },
    100,
  );
  assert.equal(charge.points, 0);
});

test('enforced usage keeps product charge separate from upstream cost', async () => {
  const service = Object.create(AiChatService.prototype) as any;
  const priceBook = new AiPriceBookService({} as any);
  (priceBook as any).getSellPriceById = async () => ({
    id: 'sell-v1', currency: 'RMB', rates_json: { call: { rmb: 0.2, points: 7 } }, is_explicitly_free: false,
  });
  (priceBook as any).getUpstreamCostById = async () => ({
    id: 'cost-v1', currency: 'RMB', rates_json: { call: { rmb: 0.6 } },
  });
  service.aiPriceBookService = priceBook;
  const billing: Record<string, unknown> = {
    billed_units: 1, unit_price_mode: 'per_call', estimated_cost_rmb: 99,
  };
  const snapshot = await service.applyVersionedUsagePricing({
    app_id: appId, model_id: 'product', model_key: 'public', route_key: 'shared', capability: 'chat',
    decoupling_mode: 'enforced', sell_price_version_id: 'sell-v1', upstream_cost_version_id: 'cost-v1',
    upstream_model_id: 'upstream',
  }, billing, {}, {});
  assert.equal(billing.points_cost_override, 7);
  assert.equal(billing.charge_rmb_override, 0.2);
  assert.equal(billing.estimated_cost_rmb, 0.6);
  assert.equal(snapshot.customer_quote.sell_price_version_id, 'sell-v1');
  assert.equal(snapshot.upstream_cost.upstream_cost_version_id, 'cost-v1');
});

test('async video lookup keeps its original route, version and request variant', async () => {
  const service = Object.create(AiChatService.prototype) as any;
  service.aiRouteAudiencePolicy = new AiRouteAudiencePolicyService();
  service.aiRoutingService = {
    resolveModelRouteCandidatesByCapability: async () => [{
      route_key: 'video-route', source: { id: 'source' }, upstream_model: 'video-v1',
      membership_route_enabled: true, audience_policy: { membership_access: 'PAID_ONLY' },
    }],
  };
  const variant = { schema_version: 'ai-request-variant-v1', dimensions: { resolution: '1080p' } };
  const selected = await service.resolveAsyncTaskRoute('app', {
    model_key: 'video', source_id: 'source', upstream_model: 'video-v1',
    metadata_json: { route_snapshot: {
      route_key: 'video-route', membership_route_enabled: false,
      sell_price_version_id: 'sell-at-create', upstream_cost_version_id: 'cost-at-create',
      request_variant: variant, decoupling_mode: 'enforced',
    } },
  }, {});
  assert.equal(selected.membership_route_enabled, false);
  assert.equal(selected.sell_price_version_id, 'sell-at-create');
  assert.equal(selected.upstream_cost_version_id, 'cost-at-create');
  assert.deepEqual(selected.request_variant, variant);
});
