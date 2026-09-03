import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashStableJson,
  normalizeImageRequestVariant,
  normalizeRequestVariant,
  requestVariantMatches,
} from './ai-request-variant.normalizer';
import { AiPriceBookService } from './ai-price-book.service';
import { AiSellPriceVersion } from './ai-product-decoupling.types';

test('canonical image variants normalize resolution aliases and remain stable', () => {
  const first = normalizeImageRequestVariant({ size: '2048x2048', quality: 'HD' }, 'red-image');
  const second = normalizeImageRequestVariant({ quality: 'high', resolution: '2K' }, 'red-image');
  assert.equal(first.dimensions.resolution, '2k');
  assert.equal(first.dimensions.quality, 'high');
  assert.equal(first.hash, second.hash);
});

test('canonical image defaults select high quality at the 1K product tier', () => {
  const variant = normalizeImageRequestVariant({}, 'red-image');
  assert.equal(variant.dimensions.resolution, '1k');
  assert.equal(variant.dimensions.quality, 'high');
});

test('canonical image routing does not let provider pixels override an explicit product tier', () => {
  const variant = normalizeImageRequestVariant({
    resolution: '1K',
    size: '768x1024',
    aspectRatio: '3:4',
  }, 'red-image');
  assert.equal(variant.dimensions.resolution, '1k');
  assert.equal(requestVariantMatches(variant, { resolutions: ['1k'] }), true);
});

test('canonical video variants reuse the existing video profile contract', () => {
  const variant = normalizeRequestVariant('video', {
    model: 'red-video',
    prompt: 'hello',
    image_url: 'https://example.test/frame.png',
    video_mode: 'first_frame',
    resolution: '1080p',
  }, 'red-video');
  assert.equal(variant.dimensions.input_kind, 'image_to_video');
  assert.equal(variant.dimensions.mode, 'first_frame');
  assert.equal(variant.dimensions.resolution, '1080p');
  assert.ok(Array.isArray(variant.dimensions.media_types));
});

test('route matching stays inside one canonical variant group', () => {
  const variant = normalizeImageRequestVariant({ size: '2k', quality: 'high' }, 'red-image');
  assert.equal(requestVariantMatches(variant, { resolutions: ['2048x2048'], qualities: ['hd'] }), true);
  assert.equal(requestVariantMatches(variant, { resolutions: ['4k'] }), false);
});

test('stable hash ignores object insertion order', () => {
  assert.equal(hashStableJson({ b: 2, a: 1 }), hashStableJson({ a: 1, b: 2 }));
});

test('customer quote is independent from upstream cost fields', () => {
  const service = new AiPriceBookService(null as never);
  const sell: AiSellPriceVersion = {
    id: 'sell-1',
    global_model_id: 'model-1',
    app_id: null,
    version: 1,
    status: 'active',
    valid_from: new Date(0).toISOString(),
    valid_to: null,
    currency: 'RMB',
    rates_json: { input: { points: 100, rmb: 0.5 }, output: { points: 200, rmb: 1 } },
    is_explicitly_free: false,
    content_hash: 'hash',
    reason: null,
    actor_user_id: null,
  };
  const quote = service.quoteCustomer(sell, { input_tokens: 1_000_000, output_tokens: 500_000 });
  assert.equal(quote.points, 200);
  assert.equal(quote.rmb, 1);
  assert.equal(quote.sell_price_version_id, 'sell-1');
  assert.equal(quote.quote_kind, 'list');
  assert.equal(quote.finalized, false);
});

test('customer quote chooses a quality and resolution price rule', () => {
  const service = new AiPriceBookService(null as never);
  const sell: AiSellPriceVersion = {
    id: 'sell-image', global_model_id: 'model-image', app_id: null, version: 1,
    status: 'active', valid_from: new Date(0).toISOString(), valid_to: null,
    currency: 'RMB', is_explicitly_free: false, content_hash: 'hash', reason: null, actor_user_id: null,
    rates_json: {
      dimension_rates: [
        {
          key: 'image:high:4k',
          request_match: { qualities: ['high'], resolutions: ['4k'] },
          rates: { image: { points: 150, rmb: 1.5 } },
        },
      ],
    },
  };
  const quote = service.quoteCustomer(
    sell,
    { images: 1 },
    normalizeImageRequestVariant({ quality: 'hd', size: '4096x4096' }, 'red-image'),
  );
  assert.equal(quote.points, 150);
  assert.equal(quote.rmb, 1.5);
  assert.equal(quote.price_rule_key, 'image:high:4k');
});

test('customer quote selects token price tiers from total prompt length', () => {
  const service = new AiPriceBookService(null as never);
  const sell: AiSellPriceVersion = {
    id: 'sell-token-tier', global_model_id: 'model-token-tier', app_id: null, version: 1,
    status: 'active', valid_from: new Date(0).toISOString(), valid_to: null,
    currency: 'RMB', is_explicitly_free: false, content_hash: 'hash', reason: null, actor_user_id: null,
    rates_json: {
      dimension_rates: [
        {
          key: 'prompt-at-most-256k',
          request_match: { request_input_tokens: { max: 256_000 } },
          rates: { input: { points: 200, rmb: 2 }, output: { points: 800, rmb: 8 } },
        },
        {
          key: 'prompt-over-256k',
          request_match: { request_input_tokens: { min: 256_001 } },
          rates: { input: { points: 600, rmb: 6 }, output: { points: 2_400, rmb: 24 } },
        },
      ],
    },
  };
  const short = service.quoteCustomer(sell, {
    request_input_tokens: 256_000,
    input_tokens: 256_000,
    output_tokens: 1_000_000,
  });
  const long = service.quoteCustomer(sell, {
    request_input_tokens: 256_001,
    input_tokens: 256_001,
    output_tokens: 1_000_000,
  });
  const unknownLength = service.quoteCustomer(sell, { input_tokens: 10_000, output_tokens: 1_000 });

  assert.equal(short.price_rule_key, 'prompt-at-most-256k');
  assert.equal(short.points, 851.2);
  assert.equal(long.price_rule_key, 'prompt-over-256k');
  assert.equal(long.points, 2_553.6006);
  assert.equal(unknownLength.price_rule_key, 'prompt-at-most-256k');
});
