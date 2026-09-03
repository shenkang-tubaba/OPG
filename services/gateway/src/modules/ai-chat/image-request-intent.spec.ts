import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeImageRequestIntent } from './image-request-intent';

test('image intent prefers an explicit product tier while preserving provider pixels', () => {
  assert.deepEqual(normalizeImageRequestIntent({
    resolution: '1K',
    size: '768x1024',
    aspectRatio: '3:4',
  }), {
    resolution: '1k',
    quality: 'high',
    aspectRatio: '3:4',
    size: '768x1024',
  });
});

test('image intent infers common legacy sizes without requiring a resolution field', () => {
  const intent = normalizeImageRequestIntent({ image_size: '1536×2048' });
  assert.equal(intent.resolution, '2k');
  assert.equal(intent.aspectRatio, '3:4');
  assert.equal(intent.size, '1536x2048');
  assert.equal(intent.quality, 'high');
});

test('image intent accepts nested aliases and compiles missing provider pixels', () => {
  const intent = normalizeImageRequestIntent({
    parameters: { resolution: '4K', aspect_ratio: '16/9', quality: 'HD' },
  });
  assert.deepEqual(intent, {
    resolution: '4k',
    quality: 'high',
    aspectRatio: '16:9',
    size: '3840x2160',
  });
});

test('image intent tolerates unknown and missing optional fields', () => {
  assert.deepEqual(normalizeImageRequestIntent({ size: '1600x1200', extra: true }), {
    resolution: '1k',
    quality: 'high',
    aspectRatio: '1:1',
    size: '1600x1200',
  });
});
