import assert from 'node:assert/strict';
import test from 'node:test';
import { AiPriceBookService } from './ai-price-book.service';

test('cache read and write aliases are charged once from a versioned price book', () => {
  const service = new AiPriceBookService({} as never);
  const quote = service.quoteUpstream({
    id: 'cost-1',
    upstream_model_id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    status: 'active',
    valid_from: '2026-08-27T00:00:00.000Z',
    valid_to: null,
    currency: 'RMB',
    rates_json: {
      input: { rmb: 1 },
      cached_input: { rmb: 0.1 },
      cache_read: { rmb: 0.1 },
      cache_write_5m: { rmb: 1.25 },
      output: { rmb: 3 },
    },
    source_snapshot_json: {},
    content_hash: 'hash',
    reason: null,
    actor_user_id: null,
  }, {
    input_tokens: 57,
    // Old snapshots contain all of these compatibility aliases. The quote
    // must remain correct when they are replayed or audited.
    cached_input_tokens: 54_557,
    cache_read_tokens: 15_953,
    cache_write_tokens: 38_604,
    cache_write_5m_tokens: 38_604,
    cache_creation_tokens: 38_604,
    output_tokens: 31,
  });

  assert.equal(quote.rmb, 0.05);
});

type Call = { kind: 'execute' | 'query'; sql: string; values: unknown[] };

function createVersioningService(kind: 'sell' | 'cost') {
  const calls: Call[] = [];
  const validFrom = new Date('2026-08-10T04:00:00.000Z');
  const tx = {
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
      calls.push({ kind: 'execute', sql, values });
      return 1;
    },
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      calls.push({ kind: 'query', sql, values });
      if (sql.includes('COALESCE(MAX(version), 0)')) return [{ version: 2 }];
      if (sql.includes('SELECT id FROM')) return [];
      if (kind === 'cost' && sql.includes('INSERT INTO ai_upstream_cost_versions')) {
        return [{
          id: 'cost-v2', upstream_model_id: '11111111-1111-4111-8111-111111111111', version: 2,
          status: 'active', valid_from: validFrom, valid_to: null, currency: 'RMB',
          rates_json: { image: { rmb: 0.5 } }, source_snapshot_json: {}, content_hash: 'hash',
          reason: null, actor_user_id: null,
        }];
      }
      if (kind === 'sell' && sql.includes('INSERT INTO ai_model_sell_price_versions')) {
        return [{
          id: 'sell-v2', global_model_id: '22222222-2222-4222-8222-222222222222', app_id: null, version: 2,
          status: 'active', valid_from: validFrom, valid_to: null, currency: 'RMB',
          rates_json: { call: { rmb: 1, points: 100 } }, is_explicitly_free: false, content_hash: 'hash',
          reason: null, actor_user_id: null,
        }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const prisma = { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) };
  return { service: new AiPriceBookService(prisma as never), calls, validFrom };
}

test('activating a replacement upstream cost retires only the effective prior version before inserting the new one', async () => {
  const { service, calls, validFrom } = createVersioningService('cost');
  const upstreamModelId = '11111111-1111-4111-8111-111111111111';

  const saved = await service.createUpstreamCostVersion({
    upstream_model_id: upstreamModelId,
    status: 'active',
    replace_active: true,
    valid_from: validFrom,
    rates_json: { image: { rmb: 0.5 } },
  });

  const retireAt = calls.findIndex((call) => call.kind === 'execute' && call.sql.includes('UPDATE ai_upstream_cost_versions'));
  const overlapAt = calls.findIndex((call) => call.kind === 'query' && call.sql.includes('SELECT id FROM'));
  const insertAt = calls.findIndex((call) => call.kind === 'query' && call.sql.includes('INSERT INTO ai_upstream_cost_versions'));
  const retirement = calls[retireAt];

  assert.equal(saved.version, 2);
  assert.ok(retireAt >= 0);
  assert.ok(retireAt < overlapAt);
  assert.ok(retireAt < insertAt);
  assert.match(retirement.sql, /SET status = 'retired', valid_to = \$2::timestamptz/);
  assert.deepEqual(retirement.values, [upstreamModelId, validFrom]);
});

test('activating a replacement sell price retires the matching product scope only', async () => {
  const { service, calls, validFrom } = createVersioningService('sell');
  const productId = '22222222-2222-4222-8222-222222222222';

  const saved = await service.createSellPriceVersion({
    global_model_id: productId,
    status: 'active',
    replace_active: true,
    valid_from: validFrom,
    rates_json: { call: { rmb: 1, points: 100 } },
  });

  const retirement = calls.find((call) => call.kind === 'execute' && call.sql.includes('UPDATE ai_model_sell_price_versions'));
  assert.equal(saved.version, 2);
  assert.ok(retirement);
  assert.match(retirement.sql, /app_id IS NOT DISTINCT FROM \$2::uuid/);
  assert.deepEqual(retirement.values, [productId, null, validFrom]);
});

test('sell price creation rejects hidden app-specific overrides', async () => {
  const { service, calls, validFrom } = createVersioningService('sell');
  await assert.rejects(
    service.createSellPriceVersion({
      global_model_id: '22222222-2222-4222-8222-222222222222',
      app_id: '33333333-3333-4333-8333-333333333333',
      status: 'active',
      valid_from: validFrom,
      rates_json: { call: { rmb: 1, points: 100 } },
    } as any),
    /App-specific sell prices are not supported/,
  );
  assert.equal(calls.length, 0);
});

test('a replacement request cannot create a finite active window that would leave no successor after retirement', async () => {
  const { service } = createVersioningService('cost');
  await assert.rejects(
    service.createUpstreamCostVersion({
      upstream_model_id: '11111111-1111-4111-8111-111111111111',
      status: 'active',
      replace_active: true,
      valid_from: new Date('2026-08-10T04:00:00.000Z'),
      valid_to: new Date('2026-08-11T04:00:00.000Z'),
      rates_json: { image: { rmb: 0.5 } },
    }),
    /replace_active does not support a finite valid_to window/,
  );
});

test('a reusable token price book accepts contiguous non-overlapping input ranges', async () => {
  const { service } = createVersioningService('sell');
  await service.createSellPriceVersion({
    global_model_id: '22222222-2222-4222-8222-222222222222',
    status: 'active',
    rates_json: {
      dimension_rates: [
        {
          key: 'input-at-most-128k',
          request_match: { request_input_tokens: { max: 128_000 } },
          rates: { input: { rmb: 1, points: 100 }, output: { rmb: 4, points: 400 } },
        },
        {
          key: 'input-128k-to-256k',
          request_match: { request_input_tokens: { min: 128_001, max: 256_000 } },
          rates: { input: { rmb: 2, points: 200 }, output: { rmb: 8, points: 800 } },
        },
        {
          key: 'input-over-256k',
          request_match: { request_input_tokens: { min: 256_001 } },
          rates: { input: { rmb: 4, points: 400 }, output: { rmb: 16, points: 1600 } },
        },
      ],
    },
  });
});

test('token price books reject overlapping or discontinuous ranges before persistence', async () => {
  const { service } = createVersioningService('sell');
  const create = (dimensionRates: Array<Record<string, unknown>>) => service.createSellPriceVersion({
    global_model_id: '22222222-2222-4222-8222-222222222222',
    status: 'active',
    rates_json: { dimension_rates: dimensionRates as never },
  });
  const rate = { input: { rmb: 1, points: 100 } };

  await assert.rejects(create([
    { key: 'first', request_match: { request_input_tokens: { max: 128_000 } }, rates: rate },
    { key: 'overlap', request_match: { request_input_tokens: { min: 128_000 } }, rates: rate },
  ]), /token price rules overlap/);

  await assert.rejects(create([
    { key: 'first', request_match: { request_input_tokens: { max: 128_000 } }, rates: rate },
    { key: 'gap', request_match: { request_input_tokens: { min: 128_002 } }, rates: rate },
  ]), /token price rules have a gap/);
});

test('price books reject invalid numeric rates and token ranges', async () => {
  const { service } = createVersioningService('cost');
  await assert.rejects(service.createUpstreamCostVersion({
    upstream_model_id: '11111111-1111-4111-8111-111111111111',
    rates_json: { input: { rmb: -1 } },
  }), /finite non-negative number/);

  await assert.rejects(service.createUpstreamCostVersion({
    upstream_model_id: '11111111-1111-4111-8111-111111111111',
    rates_json: {
      dimension_rates: [{
        key: 'invalid-range',
        request_match: { request_input_tokens: { min: 100, max: 99 } },
        rates: { input: { rmb: 1 } },
      }],
    },
  }), /max below min/);
});
