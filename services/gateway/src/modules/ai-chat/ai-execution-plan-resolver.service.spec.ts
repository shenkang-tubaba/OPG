import assert from 'node:assert/strict';
import test from 'node:test';
import { AiExecutionPlanResolverService } from './ai-execution-plan-resolver.service';

const product = {
  id: '22222222-2222-4222-8222-222222222222',
  model_key: 'internal-model',
  display_name: 'Internal model',
  capability: 'chat',
  execution_mode: 'sync',
  is_visible: false,
  app_is_visible: false,
};

const route = {
  route_id: '33333333-3333-4333-8333-333333333333',
  route_key: 'internal-route',
  global_model_id: product.id,
  app_id: null,
  source_id: '44444444-4444-4444-8444-444444444444',
  route_active: true,
  source_active: true,
  variant_key: 'chat:default',
  match_priority: 100,
  sort_order: 0,
  contract_version: 'chat-v1',
  upstream_model_id: '55555555-5555-4555-8555-555555555555',
  upstream_model: 'provider-model',
  upstream_active: true,
  endpoint_path: '/chat/completions',
  api_type: 'openai-compatible',
  execution_mode: 'sync',
  request_overrides: {},
  request_match: {},
  adapter_config_json: {},
  cost_version: {
    id: '66666666-6666-4666-8666-666666666666',
    upstream_model_id: '55555555-5555-4555-8555-555555555555',
    version: 1,
    status: 'active',
    valid_from: '2026-08-10T00:00:00.000Z',
    valid_to: null,
    currency: 'RMB',
    rates_json: { call: { rmb: 0.1 } },
    source_snapshot_json: {},
    content_hash: 'cost-hash',
    reason: null,
    actor_user_id: null,
  },
};

function service() {
  const prisma = {
    $queryRawUnsafe: async (_query: string, ...values: any[]) => {
      if (values.length === 4) {
        return values[3] === true ? [product] : [];
      }
      return [route];
    },
  };
  return new AiExecutionPlanResolverService(
    prisma as any,
    { resolveMode: async () => 'enforced', getActiveRevisionNumber: async () => 7 } as any,
    { resolveSellPrice: async () => null } as any,
  );
}

test('customer-billed execution cannot invoke an app-hidden model', async () => {
  await assert.rejects(service().resolve({
    app_id: '11111111-1111-4111-8111-111111111111',
    model_key: 'internal-model',
    capability: 'chat',
    mode: 'enforced',
    billing_intent: 'customer_billed',
  }), /not found/);
});

test('trusted internal execution permits no sell price but still requires a costed allowed route', async () => {
  const plan = await service().resolve({
    app_id: '11111111-1111-4111-8111-111111111111',
    model_key: 'internal-model',
    capability: 'chat',
    mode: 'enforced',
    billing_intent: 'internal_non_billable',
    allowed_route_keys: ['internal-route'],
  });
  assert.equal(plan.billing_intent, 'internal_non_billable');
  assert.equal(plan.sell_price, null);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].cost_version?.id, route.cost_version.id);
});

test('execution planning cannot reintroduce a route filtered by media or voice compatibility', async () => {
  await assert.rejects(service().resolve({
    app_id: '11111111-1111-4111-8111-111111111111',
    model_key: 'internal-model',
    capability: 'chat',
    mode: 'enforced',
    billing_intent: 'internal_non_billable',
    allowed_route_keys: ['different-route'],
  }), /not executable/);
});
