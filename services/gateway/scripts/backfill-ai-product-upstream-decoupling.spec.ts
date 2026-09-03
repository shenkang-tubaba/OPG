import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLegacyCostRates, buildLegacyRouteCostBook, buildLegacySellRates, contentHash, parseArgs, resolveLegacyCost, routeVariant } from './backfill-ai-product-upstream-decoupling';

const model: any = {
  rmb_per_mtoken: 0.2, rmb_per_call: 0, rmb_per_minute: 0,
  input_rmb_per_mtoken: 0.05, cached_input_rmb_per_mtoken: 0.005,
  cache_write_5m_rmb_per_mtoken: 0.0625, cache_write_1h_rmb_per_mtoken: 0.0625,
  output_rmb_per_mtoken: 0.3,
  points_per_mtoken: 20, points_per_call: 0, points_per_minute: 0,
  points_input_per_mtoken: 5, points_cached_input_per_mtoken: 1,
  points_cache_write_5m_per_mtoken: 2, points_cache_write_1h_per_mtoken: 2,
  points_output_per_mtoken: 30,
};

test('legacy backfill keeps customer and upstream books separate', () => {
  const sell = buildLegacySellRates(model);
  const cost = buildLegacyCostRates(model);
  assert.equal(sell.input.rmb, 0.05);
  assert.equal(sell.output.rmb, 0.3);
  assert.equal(sell.input.points, 5);
  assert.equal(cost.input, 0.05);
  assert.equal(cost.output, 0.3);
  assert.notEqual(contentHash(sell), contentHash(cost));
});

test('legacy generic rates remain a fallback when Decimal-compatible detailed fields are zero', () => {
  const sell = buildLegacySellRates({
    ...model,
    input_rmb_per_mtoken: { valueOf: () => 0 },
    output_rmb_per_mtoken: { valueOf: () => 0 },
    points_input_per_mtoken: { valueOf: () => 0 },
    points_output_per_mtoken: { valueOf: () => 0 },
  } as any);
  assert.equal(sell.input.rmb, 0.2);
  assert.equal(sell.output.rmb, 0.2);
  assert.equal(sell.input.points, 20);
  assert.equal(sell.output.points, 20);
});

test('legacy content hash is deterministic', () => {
  assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }));
});

test('upstream cost keeps one known legacy rate when another product has no legacy cost', () => {
  const result = resolveLegacyCost([
    { ...model, id: 'priced' },
    { ...model, id: 'unpriced', rmb_per_mtoken: 0, input_rmb_per_mtoken: 0, cached_input_rmb_per_mtoken: 0, cache_write_5m_rmb_per_mtoken: 0, cache_write_1h_rmb_per_mtoken: 0, output_rmb_per_mtoken: 0 },
  ] as any);
  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') assert.deepEqual(result.modelIds, ['priced']);
});

test('upstream cost reports distinct positive legacy costs instead of choosing one', () => {
  const result = resolveLegacyCost([
    { ...model, id: 'first' },
    { ...model, id: 'second', output_rmb_per_mtoken: 0.5 },
  ] as any);
  assert.deepEqual(result, { status: 'conflict', modelIds: ['first', 'second'] });
});

test('catalog-only mode is explicit and defaults to dry-run', () => {
  assert.deepEqual(parseArgs(['--catalog-only']), { dryRun: true, catalogOnly: true });
  assert.deepEqual(parseArgs(['--catalog-only', '--apply']), { dryRun: false, catalogOnly: true });
});

test('image pricing migrates quality and resolution selling rules separately from upstream route cost', () => {
  const imageModel = {
    ...model,
    capability: 'image',
    request_overrides: {
      pricing: {
        image_quality_resolution_rates: {
          medium: {
            '2K': {
              points_per_call: 35,
              cost_rmb_per_call: 0.25,
              preferred_route_key: 'image-2k',
            },
          },
          high: {
            '2K': {
              points_per_call: 45,
              cost_rmb_per_call: 0.3,
              preferred_route_key: 'image-2k',
            },
          },
        },
      },
    },
  } as any;
  const sell = buildLegacySellRates(imageModel, 100);
  assert.deepEqual(sell, {
    dimension_rates: [
      {
        key: 'image:medium:2k',
        request_match: { qualities: ['medium'], resolutions: ['2k'] },
        rates: { image: { points: 35, rmb: 0.35 } },
      },
      {
        key: 'image:high:2k',
        request_match: { qualities: ['high'], resolutions: ['2k'] },
        rates: { image: { points: 45, rmb: 0.45 } },
      },
    ],
  });
  assert.deepEqual(buildLegacyRouteCostBook(imageModel, { route_key: 'image-2k' } as any), {
    dimension_rates: [
      {
        key: 'image:medium:2k',
        request_match: { qualities: ['medium'], resolutions: ['2k'] },
        rates: { image: { rmb: 0.25 } },
      },
      {
        key: 'image:high:2k',
        request_match: { qualities: ['high'], resolutions: ['2k'] },
        rates: { image: { rmb: 0.3 } },
      },
    ],
  });
});

test('image route variants use the historical preferred route mapping when route keys omit resolution', () => {
  const imageModel = {
    ...model,
    capability: 'image',
    request_overrides: {
      pricing: {
        image_quality_resolution_rates: {
          medium: {
            '2K': { points_per_call: 35, cost_rmb_per_call: 0.25, preferred_route_key: 'provider-hd-count' },
          },
        },
      },
    },
  } as any;
  assert.deepEqual(routeVariant({ route_key: 'provider-hd-count', request_match: {} } as any, 'image', imageModel), {
    variant_key: 'image:2k', request_match: { resolutions: ['2k'] },
  });
});

test('video pricing migrates resolution rules in per-second units', () => {
  const videoModel = {
    ...model,
    capability: 'video',
    request_overrides: {
      pricing: {
        video_resolution_rates: {
          '720P': {
            points_per_second: 71.31285,
            cost_rmb_per_second: 0.35656425,
            sell_rmb_per_second: 0.7131285,
          },
          '4K': {
            points_per_second: 135.834,
            cost_rmb_per_second: 0.67917,
            sell_rmb_per_second: 1.35834,
          },
        },
      },
    },
  } as any;
  assert.deepEqual(buildLegacySellRates(videoModel, 100), {
    dimension_rates: [
      {
        key: 'video:720p',
        request_match: { resolutions: ['720p'] },
        rates: { second: { rmb: 0.7131285, points: 71.31285 } },
      },
      {
        key: 'video:4k',
        request_match: { resolutions: ['4k'] },
        rates: { second: { rmb: 1.35834, points: 135.834 } },
      },
    ],
  });
  assert.deepEqual(buildLegacyRouteCostBook(videoModel, { route_key: 'gemini-omni' } as any), {
    dimension_rates: [
      {
        key: 'video:720p',
        request_match: { resolutions: ['720p'] },
        rates: { second: { rmb: 0.35656425 } },
      },
      {
        key: 'video:4k',
        request_match: { resolutions: ['4k'] },
        rates: { second: { rmb: 0.67917 } },
      },
    ],
  });
});
