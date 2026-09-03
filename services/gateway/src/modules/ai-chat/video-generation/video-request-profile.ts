import { BadRequestException } from '@nestjs/common';

export const VIDEO_INPUT_KINDS = [
  'text_to_video',
  'image_to_video',
  'reference_to_video',
  'video_to_video',
] as const;

export type VideoInputKind = (typeof VIDEO_INPUT_KINDS)[number];

export const CANONICAL_VIDEO_MODES = [
  'default',
  'first_frame',
  'first_last_frame',
  'continuation',
] as const;

export type CanonicalVideoMode = (typeof CANONICAL_VIDEO_MODES)[number];

export const CANONICAL_VIDEO_MEDIA_TYPES = [
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'driving_audio',
  'first_clip',
] as const;

export type CanonicalVideoMediaType = (typeof CANONICAL_VIDEO_MEDIA_TYPES)[number];

export type CanonicalVideoMedia = {
  type: CanonicalVideoMediaType;
  url: string;
};

export type VideoRequestProfile = {
  requestedModel: string;
  canonicalModel: string;
  inputKind: VideoInputKind;
  videoMode: CanonicalVideoMode;
  mediaTypes: CanonicalVideoMediaType[];
  resolution: string | null;
  aspectRatio: string | null;
  durationSeconds: number | null;
  generateAudio: boolean | null;
};

export type NormalizedVideoRequest = {
  payload: Record<string, unknown>;
  profile: VideoRequestProfile;
  media: CanonicalVideoMedia[];
};

export type VideoModelAlias = {
  key?: unknown;
  defaults?: unknown;
};

type VideoRouteLike = {
  request_match?: Record<string, unknown> | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeMediaType(value: unknown): CanonicalVideoMediaType | null {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 'first_frame' || normalized === 'image' || normalized === 'image_url') {
    return 'first_frame';
  }
  if (normalized === 'last_frame' || normalized === 'last_image' || normalized === 'last_image_url') {
    return 'last_frame';
  }
  if (normalized === 'reference_image' || normalized === 'reference_images' || normalized === 'reference_image_url') {
    return 'reference_image';
  }
  if (normalized === 'reference_video' || normalized === 'reference_videos' || normalized === 'reference_video_url') {
    return 'reference_video';
  }
  if (normalized === 'driving_audio' || normalized === 'audio' || normalized === 'audio_url') {
    return 'driving_audio';
  }
  if (normalized === 'first_clip' || normalized === 'video' || normalized === 'video_url' || normalized === 'clip') {
    return 'first_clip';
  }
  return null;
}

function mediaUrl(record: Record<string, unknown>): string | null {
  for (const key of ['url', 'uri', 'file_url', 'image_url', 'audio_url', 'video_url', 'data', 'b64_json', 'base64']) {
    const value = stringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function collectCanonicalMedia(payload: Record<string, unknown>): CanonicalVideoMedia[] {
  const input = objectValue(payload.input);
  const video = objectValue(payload.video);
  const inputVideo = objectValue(input.video);
  const output: CanonicalVideoMedia[] = [];
  const seen = new Set<string>();

  const push = (typeValue: unknown, urlValue: unknown) => {
    const type = normalizeMediaType(typeValue);
    const url = stringValue(urlValue);
    if (!type || !url) {
      return;
    }
    const uniqueKey = `${type}\u0000${url}`;
    if (seen.has(uniqueKey)) {
      return;
    }
    seen.add(uniqueKey);
    output.push({ type, url });
  };

  const arrays = [
    payload.media,
    input.media,
    payload.input_media,
    input.input_media,
    video.media,
    inputVideo.media,
  ];
  for (const rawArray of arrays) {
    if (!Array.isArray(rawArray)) {
      continue;
    }
    for (const item of rawArray) {
      const record = objectValue(item);
      push(record.type, mediaUrl(record));
    }
  }

  const pushArray = (values: unknown, type: CanonicalVideoMediaType) => {
    if (!Array.isArray(values)) {
      return;
    }
    for (const value of values) {
      push(type, value);
    }
  };

  pushArray(payload.reference_images, 'reference_image');
  pushArray(payload.reference_image_urls, 'reference_image');
  pushArray(input.reference_images, 'reference_image');
  pushArray(input.reference_image_urls, 'reference_image');
  pushArray(payload.reference_videos, 'reference_video');
  pushArray(payload.reference_video_urls, 'reference_video');
  pushArray(input.reference_videos, 'reference_video');
  pushArray(input.reference_video_urls, 'reference_video');

  const imageArrays = [
    payload.images,
    payload.image_urls,
    input.images,
    input.image_urls,
  ];
  for (const values of imageArrays) {
    if (!Array.isArray(values)) {
      continue;
    }
    values.forEach((value, index) => push(index === 0 ? 'first_frame' : 'last_frame', value));
  }

  push('first_frame', payload.first_frame_url ?? payload.first_frame ?? payload.img_url ?? payload.image_url ?? payload.image);
  push('first_frame', input.first_frame_url ?? input.first_frame ?? input.img_url ?? input.image_url ?? input.image);
  push('last_frame', payload.last_frame_url ?? payload.last_frame ?? payload.last_image_url ?? payload.last_image);
  push('last_frame', input.last_frame_url ?? input.last_frame ?? input.last_image_url ?? input.last_image);
  push('reference_image', payload.reference_image_url ?? payload.reference_image);
  push('reference_image', input.reference_image_url ?? input.reference_image);
  push('reference_video', payload.reference_video_url ?? payload.reference_video);
  push('reference_video', input.reference_video_url ?? input.reference_video);
  push('driving_audio', payload.driving_audio_url ?? payload.driving_audio ?? payload.audio_url);
  push('driving_audio', input.driving_audio_url ?? input.driving_audio ?? input.audio_url);
  push('first_clip', payload.first_clip_url ?? payload.first_clip ?? payload.video_url ?? payload.video);
  push('first_clip', input.first_clip_url ?? input.first_clip ?? input.video_url ?? input.video);

  return output;
}

function normalizeVideoMode(value: unknown): CanonicalVideoMode | null {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!normalized || normalized === 'default' || normalized === 'text_to_video' || normalized === 'reference_guided') {
    return normalized ? 'default' : null;
  }
  if (normalized === 'first_frame' || normalized === 'image_to_video' || normalized === 'i2v') {
    return 'first_frame';
  }
  if (normalized === 'first_last_frame' || normalized === 'first_and_last_frame' || normalized === 'start_end_frame') {
    return 'first_last_frame';
  }
  if (normalized === 'continuation' || normalized === 'video_continuation' || normalized === 'extend') {
    return 'continuation';
  }
  throw new BadRequestException(`unsupported video_mode: ${normalized}`);
}

function normalizeInputKind(value: unknown): VideoInputKind | null {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!normalized) {
    return null;
  }
  if (normalized === 'text_to_video' || normalized === 't2v') {
    return 'text_to_video';
  }
  if (normalized === 'image_to_video' || normalized === 'i2v') {
    return 'image_to_video';
  }
  if (normalized === 'reference_to_video' || normalized === 'r2v') {
    return 'reference_to_video';
  }
  if (normalized === 'video_to_video' || normalized === 'v2v' || normalized === 'continuation') {
    return 'video_to_video';
  }
  throw new BadRequestException(`unsupported input_kind: ${normalized}`);
}

function inferInputKind(mediaTypes: Set<CanonicalVideoMediaType>, videoMode: CanonicalVideoMode): VideoInputKind {
  if (videoMode === 'continuation' || mediaTypes.has('first_clip')) {
    return 'video_to_video';
  }
  if (mediaTypes.has('reference_image') || mediaTypes.has('reference_video')) {
    return 'reference_to_video';
  }
  if (videoMode === 'first_frame' || videoMode === 'first_last_frame' || mediaTypes.has('first_frame') || mediaTypes.has('last_frame')) {
    return 'image_to_video';
  }
  return 'text_to_video';
}

function assertMediaCombination(
  inputKind: VideoInputKind,
  videoMode: CanonicalVideoMode,
  mediaTypes: Set<CanonicalVideoMediaType>,
): void {
  const hasFirstFrame = mediaTypes.has('first_frame');
  const hasLastFrame = mediaTypes.has('last_frame');
  const hasFirstClip = mediaTypes.has('first_clip');
  const hasReference = mediaTypes.has('reference_image') || mediaTypes.has('reference_video');

  if (videoMode === 'continuation' && (!hasFirstClip || hasFirstFrame || hasLastFrame)) {
    throw new BadRequestException('video_mode=continuation requires first_clip and cannot combine first_frame or last_frame');
  }
  if (videoMode === 'first_last_frame' && (!hasFirstFrame || !hasLastFrame || hasFirstClip)) {
    throw new BadRequestException('video_mode=first_last_frame requires first_frame + last_frame and cannot combine first_clip');
  }
  if (videoMode === 'first_frame' && (!hasFirstFrame || hasLastFrame || hasFirstClip)) {
    throw new BadRequestException('video_mode=first_frame requires first_frame and cannot combine last_frame or first_clip');
  }
  if (
    inputKind === 'text_to_video'
    && Array.from(mediaTypes).some((type) => type !== 'driving_audio')
  ) {
    throw new BadRequestException('input_kind=text_to_video only accepts optional driving_audio media');
  }
  if (inputKind === 'image_to_video' && !hasFirstFrame) {
    throw new BadRequestException('input_kind=image_to_video requires first_frame');
  }
  if (inputKind === 'reference_to_video' && !hasReference) {
    throw new BadRequestException('input_kind=reference_to_video requires reference_image or reference_video');
  }
  if (inputKind === 'video_to_video' && !hasFirstClip) {
    throw new BadRequestException('input_kind=video_to_video requires first_clip');
  }
}

function normalizedStringSet(value: unknown): Set<string> {
  return new Set(stringArray(value).map((item) => item.trim().toLowerCase().replace(/[-\s]+/g, '_')));
}

function assertSchemaAllows(
  schema: Record<string, unknown>,
  profile: VideoRequestProfile,
  errorPrefix: string,
): void {
  const inputKinds = normalizedStringSet(schema.input_kinds);
  if (inputKinds.size > 0 && !inputKinds.has(profile.inputKind)) {
    throw new BadRequestException(`${errorPrefix} does not support input_kind=${profile.inputKind}`);
  }
  const videoModes = normalizedStringSet(schema.video_modes);
  if (videoModes.size > 0 && !videoModes.has(profile.videoMode)) {
    throw new BadRequestException(`${errorPrefix} does not support video_mode=${profile.videoMode}`);
  }
  const resolutions = new Set(stringArray(schema.resolutions).map((item) => item.toUpperCase()));
  if (resolutions.size > 0 && profile.resolution && !resolutions.has(profile.resolution.toUpperCase())) {
    throw new BadRequestException(`${errorPrefix} does not support resolution=${profile.resolution}`);
  }
  const aspectRatios = new Set(stringArray(schema.aspect_ratios));
  if (aspectRatios.size > 0 && profile.aspectRatio && !aspectRatios.has(profile.aspectRatio)) {
    throw new BadRequestException(`${errorPrefix} does not support aspect_ratio=${profile.aspectRatio}`);
  }
  const mediaTypes = normalizedStringSet(schema.media_types);
  const unsupportedMediaType = profile.mediaTypes.find((type) => mediaTypes.size > 0 && !mediaTypes.has(type));
  if (unsupportedMediaType) {
    throw new BadRequestException(`${errorPrefix} does not support media type=${unsupportedMediaType}`);
  }
  const requiredMediaTypes = normalizedStringSet(schema.required_media_types);
  const missingMediaType = Array.from(requiredMediaTypes).find((type) => !profile.mediaTypes.includes(type as CanonicalVideoMediaType));
  if (missingMediaType) {
    throw new BadRequestException(`${errorPrefix} requires media type=${missingMediaType}`);
  }
  const minSegmentSeconds = numberValue(schema.min_segment_seconds);
  if (schema.requires_duration === true && profile.durationSeconds === null) {
    throw new BadRequestException(`${errorPrefix} requires duration_seconds`);
  }
  if (minSegmentSeconds !== null && profile.durationSeconds !== null && profile.durationSeconds < minSegmentSeconds) {
    throw new BadRequestException(
      `${errorPrefix} requires at least ${minSegmentSeconds} seconds per segment`,
    );
  }
  const maxSegmentSeconds = numberValue(schema.max_segment_seconds);
  if (maxSegmentSeconds !== null && profile.durationSeconds !== null && profile.durationSeconds > maxSegmentSeconds) {
    throw new BadRequestException(
      `${errorPrefix} supports at most ${maxSegmentSeconds} seconds per segment`,
    );
  }
  if (schema.supports_generate_audio === false && profile.generateAudio === true) {
    throw new BadRequestException(`${errorPrefix} does not support generate_audio=true`);
  }
}

export function normalizeVideoGenerationRequest(
  payload: Record<string, unknown>,
  canonicalModel: string,
  aliasDefaults: Record<string, unknown> = {},
): NormalizedVideoRequest {
  const input = objectValue(payload.input);
  const parameters = objectValue(payload.parameters);
  const video = objectValue(payload.video);
  const inputVideo = objectValue(input.video);
  const requestedModel = stringValue(payload.model) || canonicalModel;
  const media = collectCanonicalMedia(payload);
  const mediaTypes = new Set(media.map((item) => item.type));
  const explicitVideoMode = normalizeVideoMode(
    payload.video_mode
    ?? payload.mode
    ?? input.video_mode
    ?? input.mode
    ?? video.mode
    ?? inputVideo.mode
    ?? aliasDefaults.video_mode
    ?? aliasDefaults.mode,
  );
  const inferredVideoMode: CanonicalVideoMode = mediaTypes.has('first_clip')
    ? 'continuation'
    : mediaTypes.has('first_frame') && mediaTypes.has('last_frame')
      ? 'first_last_frame'
      : mediaTypes.has('first_frame') && !mediaTypes.has('reference_image') && !mediaTypes.has('reference_video')
        ? 'first_frame'
        : 'default';
  const videoMode = explicitVideoMode || inferredVideoMode;
  const explicitInputKind = normalizeInputKind(
    payload.input_kind
    ?? input.input_kind
    ?? aliasDefaults.input_kind,
  );
  const inferredInputKind = inferInputKind(mediaTypes, videoMode);
  const inputKind = explicitInputKind || inferredInputKind;

  if (explicitInputKind && explicitInputKind !== inferredInputKind) {
    throw new BadRequestException(
      `input_kind=${explicitInputKind} conflicts with video_mode/media inferred as ${inferredInputKind}`,
    );
  }

  assertMediaCombination(inputKind, videoMode, mediaTypes);

  const resolution = stringValue(
    payload.resolution
    ?? parameters.resolution
    ?? payload.size
    ?? input.resolution
    ?? input.size,
  );
  const aspectRatio = stringValue(
    payload.aspect_ratio
    ?? payload.aspectRatio
    ?? payload.ratio
    ?? parameters.aspect_ratio
    ?? parameters.aspectRatio
    ?? parameters.ratio
    ?? input.aspect_ratio
    ?? input.aspectRatio
    ?? input.ratio,
  );
  const durationSeconds = numberValue(
    payload.duration,
    payload.seconds,
    payload.duration_seconds,
    input.duration,
    input.seconds,
    input.duration_seconds,
    parameters.duration,
    parameters.seconds,
    parameters.duration_seconds,
  );
  const generateAudio = booleanValue(
    payload.generate_audio
    ?? payload.generateAudio
    ?? input.generate_audio
    ?? input.generateAudio
    ?? parameters.generate_audio
    ?? parameters.generateAudio,
  );
  const profile: VideoRequestProfile = {
    requestedModel,
    canonicalModel,
    inputKind,
    videoMode,
    mediaTypes: Array.from(mediaTypes),
    resolution,
    aspectRatio,
    durationSeconds,
    generateAudio,
  };
  const firstMediaUrl = (type: CanonicalVideoMediaType) => media.find((item) => item.type === type)?.url;
  const mediaUrls = (type: CanonicalVideoMediaType) => media
    .filter((item) => item.type === type)
    .map((item) => item.url);
  const adapterAliases: Record<string, unknown> = {};
  const firstFrameUrl = firstMediaUrl('first_frame');
  const lastFrameUrl = firstMediaUrl('last_frame');
  const firstClipUrl = firstMediaUrl('first_clip');
  const drivingAudioUrl = firstMediaUrl('driving_audio');
  const referenceImages = mediaUrls('reference_image');
  const referenceVideos = mediaUrls('reference_video');
  if (firstFrameUrl) {
    adapterAliases.first_frame_url = firstFrameUrl;
  }
  if (lastFrameUrl) {
    adapterAliases.last_frame_url = lastFrameUrl;
  }
  if (firstClipUrl) {
    adapterAliases.first_clip_url = firstClipUrl;
  }
  if (drivingAudioUrl) {
    adapterAliases.driving_audio_url = drivingAudioUrl;
  }
  if (referenceImages.length > 0) {
    adapterAliases.reference_images = referenceImages;
  }
  if (referenceVideos.length > 0) {
    adapterAliases.reference_videos = referenceVideos;
  }

  return {
    profile,
    media,
    payload: {
      ...payload,
      model: canonicalModel,
      requested_model: requestedModel,
      input_kind: inputKind,
      video_mode: videoMode,
      media,
      ...adapterAliases,
    },
  };
}

export function resolveVideoModelAliasDefaults(
  aliases: VideoModelAlias[] | null | undefined,
  requestedModel: string | null | undefined,
): Record<string, unknown> {
  const normalizedRequested = String(requestedModel || '').trim().toLowerCase();
  if (!normalizedRequested || !Array.isArray(aliases)) {
    return {};
  }
  for (const alias of aliases) {
    const record = objectValue(alias);
    if (String(record.key || '').trim().toLowerCase() !== normalizedRequested) {
      continue;
    }
    return objectValue(record.defaults);
  }
  return {};
}

export function assertVideoModelSupportsProfile(
  generationSchema: Record<string, unknown>,
  profile: VideoRequestProfile,
): void {
  assertSchemaAllows(generationSchema, profile, `video model ${profile.canonicalModel}`);
}

export function videoRouteMatchesProfile(route: VideoRouteLike, profile: VideoRequestProfile): boolean {
  const match = objectValue(route.request_match);
  try {
    assertSchemaAllows(match, profile, 'video route');
    return true;
  } catch (error) {
    if (error instanceof BadRequestException) {
      return false;
    }
    throw error;
  }
}
