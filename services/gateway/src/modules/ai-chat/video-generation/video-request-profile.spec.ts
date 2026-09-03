import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertVideoModelSupportsProfile,
  normalizeVideoGenerationRequest,
  resolveVideoModelAliasDefaults,
  videoRouteMatchesProfile,
} from './video-request-profile';

const MODEL_ALIASES = [
  { key: 'wan2.7-t2v-video', defaults: { input_kind: 'text_to_video' } },
  { key: 'wan2.7-i2v-video', defaults: { input_kind: 'image_to_video' } },
  { key: 'wan2.7-r2v-video', defaults: { input_kind: 'reference_to_video' } },
];

test('new API uses one canonical model name for text-to-video', () => {
  const normalized = normalizeVideoGenerationRequest({
    model: 'wan2.7',
    prompt: 'a camera moves through a rainy street',
  }, 'wan2.7');

  assert.equal(normalized.profile.requestedModel, 'wan2.7');
  assert.equal(normalized.profile.canonicalModel, 'wan2.7');
  assert.equal(normalized.profile.inputKind, 'text_to_video');
  assert.equal(normalized.profile.videoMode, 'default');
  assert.equal(normalized.payload.model, 'wan2.7');
  assert.deepEqual(normalized.payload.media, []);
});

test('legacy text-to-video requests may keep optional driving audio', () => {
  const normalized = normalizeVideoGenerationRequest({
    model: 'wan2.7-t2v-video',
    prompt: 'lip sync to the supplied audio',
    audio_url: 'https://example.test/voice.mp3',
  }, 'wan2.7', resolveVideoModelAliasDefaults(MODEL_ALIASES, 'wan2.7-t2v-video'));

  assert.equal(normalized.profile.inputKind, 'text_to_video');
  assert.equal(normalized.profile.videoMode, 'default');
  assert.equal(normalized.payload.driving_audio_url, 'https://example.test/voice.mp3');
});

test('new API infers first-last-frame mode from canonical media', () => {
  const normalized = normalizeVideoGenerationRequest({
    model: 'wan2.7',
    prompt: 'smooth transition',
    media: [
      { type: 'first_frame', url: 'https://example.test/first.png' },
      { type: 'last_frame', url: 'https://example.test/last.png' },
    ],
  }, 'wan2.7');

  assert.equal(normalized.profile.inputKind, 'image_to_video');
  assert.equal(normalized.profile.videoMode, 'first_last_frame');
  assert.equal(normalized.payload.first_frame_url, 'https://example.test/first.png');
  assert.equal(normalized.payload.last_frame_url, 'https://example.test/last.png');
});

test('new API normalizes continuation media for provider adapters', () => {
  const normalized = normalizeVideoGenerationRequest({
    model: 'seedance-2.0',
    prompt: 'continue the motion',
    media: [
      { type: 'first_clip', url: 'https://example.test/clip.mp4' },
    ],
  }, 'seedance-2.0');

  assert.equal(normalized.profile.inputKind, 'video_to_video');
  assert.equal(normalized.profile.videoMode, 'continuation');
  assert.equal(normalized.payload.first_clip_url, 'https://example.test/clip.mp4');
});

test('legacy T2V model alias remains compatible and resolves to the canonical model', () => {
  const requestedModel = 'wan2.7-t2v-video';
  const normalized = normalizeVideoGenerationRequest(
    { model: requestedModel, prompt: 'legacy text request' },
    'wan2.7',
    resolveVideoModelAliasDefaults(MODEL_ALIASES, requestedModel),
  );

  assert.equal(normalized.profile.requestedModel, requestedModel);
  assert.equal(normalized.profile.canonicalModel, 'wan2.7');
  assert.equal(normalized.profile.inputKind, 'text_to_video');
  assert.equal(normalized.payload.model, 'wan2.7');
  assert.equal(normalized.payload.requested_model, requestedModel);
});

test('legacy I2V aliases and fields remain compatible', () => {
  const requestedModel = 'wan2.7-i2v-video';
  const normalized = normalizeVideoGenerationRequest(
    {
      model: requestedModel,
      prompt: 'legacy image request',
      video_mode: 'first_last_frame',
      first_frame_url: 'https://example.test/first.png',
      last_frame_url: 'https://example.test/last.png',
    },
    'wan2.7',
    resolveVideoModelAliasDefaults(MODEL_ALIASES, requestedModel),
  );

  assert.equal(normalized.profile.inputKind, 'image_to_video');
  assert.equal(normalized.profile.videoMode, 'first_last_frame');
  assert.deepEqual(normalized.profile.mediaTypes, ['first_frame', 'last_frame']);
});

test('legacy R2V aliases and reference_images remain compatible', () => {
  const requestedModel = 'wan2.7-r2v-video';
  const normalized = normalizeVideoGenerationRequest(
    {
      model: requestedModel,
      prompt: 'legacy reference request',
      reference_images: ['https://example.test/ref.png'],
    },
    'wan2.7',
    resolveVideoModelAliasDefaults(MODEL_ALIASES, requestedModel),
  );

  assert.equal(normalized.profile.inputKind, 'reference_to_video');
  assert.equal(normalized.profile.videoMode, 'default');
  assert.deepEqual(normalized.payload.reference_images, ['https://example.test/ref.png']);
});

test('route matching only keeps routes compatible with the inferred mode', () => {
  const normalized = normalizeVideoGenerationRequest({
    model: 'wan2.7',
    first_frame_url: 'https://example.test/first.png',
  }, 'wan2.7');

  assert.equal(videoRouteMatchesProfile({
    request_match: {
      input_kinds: ['text_to_video'],
      video_modes: ['default'],
    },
  }, normalized.profile), false);
  assert.equal(videoRouteMatchesProfile({
    request_match: {
      input_kinds: ['image_to_video'],
      video_modes: ['first_frame', 'first_last_frame', 'continuation'],
    },
  }, normalized.profile), true);
});

test('model capability validation rejects unsupported resolution', () => {
  const normalized = normalizeVideoGenerationRequest({
    model: 'wan2.7',
    prompt: '4k request',
    resolution: '4K',
  }, 'wan2.7');

  assert.throws(
    () => assertVideoModelSupportsProfile({
      input_kinds: ['text_to_video'],
      video_modes: ['default'],
      resolutions: ['720P', '1080P'],
    }, normalized.profile),
    /does not support resolution=4K/,
  );
});

test('model capability validation enforces duration and audio capability limits', () => {
  const normalized = normalizeVideoGenerationRequest({
    model: 'wan2.7',
    prompt: 'long request',
    duration: 20,
    generate_audio: true,
  }, 'wan2.7');

  assert.throws(
    () => assertVideoModelSupportsProfile({
      input_kinds: ['text_to_video'],
      video_modes: ['default'],
      max_segment_seconds: 15,
      supports_generate_audio: false,
    }, normalized.profile),
    /supports at most 15 seconds per segment/,
  );
});

test('model capability validation enforces required media and duration ranges', () => {
  const withoutVideo = normalizeVideoGenerationRequest({
    model: 'gemini-omni-flash',
    prompt: 'transfer the reference motion',
    duration_seconds: 6,
    reference_images: ['https://example.test/reference.png'],
  }, 'gemini-omni-flash');

  assert.throws(
    () => assertVideoModelSupportsProfile({
      input_kinds: ['reference_to_video'],
      video_modes: ['default'],
      required_media_types: ['reference_video'],
      requires_duration: true,
      min_segment_seconds: 4,
      max_segment_seconds: 10,
    }, withoutVideo.profile),
    /requires media type=reference_video/,
  );

  const tooShort = normalizeVideoGenerationRequest({
    model: 'gemini-omni-flash',
    prompt: 'transfer the reference motion',
    duration_seconds: 3,
    reference_video: 'https://example.test/reference.mp4',
  }, 'gemini-omni-flash');

  assert.throws(
    () => assertVideoModelSupportsProfile({
      input_kinds: ['reference_to_video'],
      video_modes: ['default'],
      required_media_types: ['reference_video'],
      requires_duration: true,
      min_segment_seconds: 4,
      max_segment_seconds: 10,
    }, tooShort.profile),
    /requires at least 4 seconds per segment/,
  );
});

test('conflicting explicit mode and media are rejected before provider invocation', () => {
  assert.throws(
    () => normalizeVideoGenerationRequest({
      model: 'wan2.7',
      input_kind: 'text_to_video',
      first_frame_url: 'https://example.test/first.png',
    }, 'wan2.7'),
    /conflicts with video_mode\/media inferred as image_to_video/,
  );
});
