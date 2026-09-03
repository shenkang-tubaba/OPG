import assert from 'node:assert/strict';
import test from 'node:test';
import { AiConfigurationRevisionService } from './ai-configuration-revision.service';

test('app readiness reports visible commercial gaps without treating hidden products as required', async () => {
  const queries: unknown[][] = [];
  const prisma = {
    $queryRawUnsafe: async (...args: unknown[]) => {
      queries.push(args);
      return [
        {
          global_model_id: 'model-ready',
          model_key: 'public-chat',
          capability: 'chat',
          sell_price_version_id: 'sell-1',
          executable_route_id: 'route-1',
        },
        {
          global_model_id: 'model-gap',
          model_key: 'public-video',
          capability: 'video',
          sell_price_version_id: null,
          executable_route_id: null,
        },
      ];
    },
  };
  const service = new AiConfigurationRevisionService(prisma as any);
  const report = await service.validateAppReadiness(
    '11111111-1111-4111-8111-111111111111',
    new Date('2026-08-10T00:00:00.000Z'),
  );

  assert.equal(report.valid, false);
  assert.equal(report.visible_product_count, 2);
  assert.equal(report.ready_product_count, 1);
  assert.deepEqual(report.gaps, [
    { model_key: 'public-video', capability: 'video', issue: 'missing_active_sell_price' },
    { model_key: 'public-video', capability: 'video', issue: 'missing_costed_executable_route' },
  ]);
  assert.equal(report.report_hash.length, 64);
  assert.match(String(queries[0][0]), /m\.is_visible = true/);
});
