import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVariantCoverage } from './ai-execution-plan-validator';
import { AiExecutionCandidate } from './ai-product-decoupling.types';
import { normalizeImageRequestVariant } from './ai-request-variant.normalizer';

function route(overrides: Partial<AiExecutionCandidate> = {}): AiExecutionCandidate {
  return {
    route_id: 'route-1',
    route_key: 'image-2k-a',
    variant_key: 'image:2k',
    match_priority: 10,
    sort_order: 0,
    contract_version: 'image-v1',
    global_model_id: 'model-1',
    app_id: null,
    source_id: 'source-1',
    upstream_model_id: 'upstream-1',
    upstream_model: 'upstream-model',
    endpoint_path: '/images/generations',
    api_type: 'openai-images',
    execution_mode: 'sync',
    request_overrides: {},
    request_match: { resolutions: ['2k'] },
    adapter_config_json: { contract: 'image-v1' },
    source_active: true,
    route_active: true,
    upstream_active: true,
    cost_version: {
      id: 'cost-1', upstream_model_id: 'upstream-1', version: 1, status: 'active',
      valid_from: new Date(0).toISOString(), valid_to: null, currency: 'RMB', rates_json: { image: 1 },
      source_snapshot_json: {}, content_hash: 'hash', reason: null, actor_user_id: null,
    },
    ...overrides,
  };
}

test('coverage accepts a same-variant fallback group', () => {
  const variants = [normalizeImageRequestVariant({ size: '2k' }, 'image')];
  const errors = validateVariantCoverage([
    route(),
    route({ route_id: 'route-2', route_key: 'image-2k-b', sort_order: 1, source_id: 'source-2' }),
  ], variants);
  assert.deepEqual(errors, []);
});

test('coverage rejects cross-variant ambiguity at the same priority', () => {
  const variants = [normalizeImageRequestVariant({ size: '2k' }, 'image')];
  const errors = validateVariantCoverage([
    route(),
    route({ route_id: 'route-4k', route_key: 'image-4k', variant_key: 'image:4k', request_match: { resolutions: ['2k'] } }),
  ], variants);
  assert.equal(errors.some((error) => error.code === 'ambiguous-match'), true);
});

test('coverage rejects a group without a cost card', () => {
  const variants = [normalizeImageRequestVariant({ size: '2k' }, 'image')];
  const errors = validateVariantCoverage([route({ cost_version: null })], variants);
  assert.equal(errors.some((error) => error.code === 'unexecutable-group'), true);
});

