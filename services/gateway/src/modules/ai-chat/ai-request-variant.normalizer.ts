import { createHash } from 'crypto';
import {
  normalizeVideoGenerationRequest,
} from './video-generation/video-request-profile';
import {
  AiCanonicalCapability,
  CanonicalRequestVariant,
  CanonicalVariantDimension,
} from './ai-product-decoupling.types';
import { normalizeImageRequestIntent } from './image-request-intent';

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeToken(value: unknown): string | null {
  const text = stringValue(value);
  return text ? text.toLowerCase().replace(/[\s-]+/g, '_') : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function normalizeResolution(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  const normalized = raw.toLowerCase().replace(/\s+/g, '').replace(/×/g, 'x');
  const aliases: Record<string, string> = {
    '1k': '1k',
    '1024': '1k',
    '1024x1024': '1k',
    'square_hd': '1k',
    '2k': '2k',
    '2048': '2k',
    '2048x2048': '2k',
    '4k': '4k',
    '4096': '4k',
    '4096x4096': '4k',
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  const dimensions = normalized.match(/^(\d{2,5})x(\d{2,5})$/);
  return dimensions ? `${dimensions[1]}x${dimensions[2]}` : normalized;
}

function normalizeQuality(value: unknown): string | null {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return null;
  }
  const aliases: Record<string, string> = {
    // Legacy image rate cards use "medium".  Preserve that as the canonical
    // value so old quality × resolution price facts migrate without relabeling.
    standard: 'medium',
    normal: 'medium',
    low: 'low',
    medium: 'medium',
    high: 'high',
    hd: 'high',
    ultra: 'ultra',
  };
  return aliases[normalized] || normalized;
}

function normalizeAspectRatio(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  const normalized = raw.toLowerCase().replace(/\s+/g, '');
  const match = normalized.match(/^(\d+(?:\.\d+)?)[/:x](\d+(?:\.\d+)?)$/);
  if (!match) {
    return normalized;
  }
  const left = Number(match[1]);
  const right = Number(match[2]);
  return Number.isFinite(left) && Number.isFinite(right) && right > 0
    ? `${left / right}`
    : normalized;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = stableValue((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function hashStableJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function buildVariant(
  capability: AiCanonicalCapability | string,
  modelKey: string,
  dimensions: Record<string, CanonicalVariantDimension | string[] | undefined>,
): CanonicalRequestVariant {
  const normalizedDimensions = Object.keys(dimensions)
    .sort()
    .reduce<Record<string, CanonicalVariantDimension | string[] | undefined>>((result, key) => {
      const value = dimensions[key];
      if (value !== undefined && value !== null && value !== '') {
        result[key] = value;
      } else if (key === 'input_kind' || key === 'mode' || key === 'resolution' || key === 'quality') {
        result[key] = null;
      }
      return result;
    }, {});
  const withoutHash = {
    schema_version: 'ai-request-variant-v1' as const,
    capability,
    model_key: modelKey,
    dimensions: normalizedDimensions,
  };
  return { ...withoutHash, hash: hashStableJson(withoutHash) };
}

export function normalizeImageRequestVariant(
  payload: Record<string, unknown>,
  modelKey: string,
): CanonicalRequestVariant {
  const imageConfig = objectValue(payload.image_config ?? payload.imageConfig);
  const intent = normalizeImageRequestIntent(payload);
  return buildVariant('image', modelKey, {
    resolution: intent.resolution,
    quality: intent.quality,
    aspect_ratio: normalizeAspectRatio(intent.aspectRatio),
    output_format: normalizeToken(payload.response_format ?? payload.output_format ?? imageConfig.output_format),
  });
}

export function normalizeVideoRequestVariant(
  payload: Record<string, unknown>,
  modelKey: string,
  aliasDefaults: Record<string, unknown> = {},
): CanonicalRequestVariant {
  const normalized = normalizeVideoGenerationRequest(payload, modelKey, aliasDefaults);
  const profile = normalized.profile;
  return buildVariant('video', modelKey, {
    input_kind: profile.inputKind,
    mode: profile.videoMode,
    resolution: normalizeResolution(profile.resolution),
    aspect_ratio: normalizeAspectRatio(profile.aspectRatio),
    media_types: [...profile.mediaTypes].sort(),
    duration_seconds: profile.durationSeconds,
    generate_audio: profile.generateAudio,
  });
}

export function normalizeRequestVariant(
  capabilityInput: string,
  payload: Record<string, unknown>,
  modelKey: string,
  options: { videoAliases?: Record<string, unknown> } = {},
): CanonicalRequestVariant {
  const capability = String(capabilityInput || 'chat').trim().toLowerCase();
  if (capability === 'image') {
    return normalizeImageRequestVariant(payload, modelKey);
  }
  if (capability === 'video') {
    return normalizeVideoRequestVariant(payload, modelKey, options.videoAliases || {});
  }
  return buildVariant(capability, modelKey, {
    input_kind: normalizeToken(payload.input_kind ?? payload.inputKind),
    mode: normalizeToken(payload.mode),
  });
}

function valuesForMatch(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim().toLowerCase()).filter(Boolean);
  }
  const normalized = normalizeToken(value);
  return normalized ? [normalized] : [];
}

function matchesScalar(expected: unknown, actual: unknown): boolean {
  const expectedValues = valuesForMatch(expected);
  if (!expectedValues.length) {
    return true;
  }
  const actualValues = valuesForMatch(actual);
  return actualValues.some((candidate) => expectedValues.includes(candidate));
}

function matchesNumber(expected: unknown, actual: unknown): boolean {
  if (expected === undefined || expected === null || expected === '') {
    return true;
  }
  const actualNumber = finiteNumber(actual);
  if (actualNumber === null) {
    return false;
  }
  if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
    const range = expected as Record<string, unknown>;
    const min = finiteNumber(range.min);
    const max = finiteNumber(range.max);
    return (min === null || actualNumber >= min) && (max === null || actualNumber <= max);
  }
  return valuesForMatch(expected).some((value) => Number(value) === actualNumber);
}

export function requestVariantMatches(
  variant: CanonicalRequestVariant,
  requestMatch: Record<string, unknown> | null | undefined,
): boolean {
  const match = requestMatch && typeof requestMatch === 'object' ? requestMatch : {};
  const dimensions = variant.dimensions;
  for (const [rawKey, expected] of Object.entries(match)) {
    const key = rawKey.toLowerCase().replace(/[\s-]+/g, '_');
    if (key === 'input_kinds' || key === 'input_kind') {
      if (!matchesScalar(expected, dimensions.input_kind)) return false;
    } else if (key === 'video_modes' || key === 'video_mode' || key === 'mode') {
      if (!matchesScalar(expected, dimensions.mode)) return false;
    } else if (key === 'resolutions' || key === 'resolution' || key === 'sizes') {
      const expectedValues = valuesForMatch(expected).map(normalizeResolution).filter(Boolean);
      const actual = normalizeResolution(dimensions.resolution);
      if (expectedValues.length && (!actual || !expectedValues.includes(actual))) return false;
    } else if (key === 'qualities' || key === 'quality') {
      const expectedValues = valuesForMatch(expected).map(normalizeQuality).filter(Boolean);
      const actual = normalizeQuality(dimensions.quality);
      if (expectedValues.length && (!actual || !expectedValues.includes(actual))) return false;
    } else if (key === 'aspect_ratios' || key === 'aspect_ratio') {
      const expectedValues = valuesForMatch(expected).map(normalizeAspectRatio).filter(Boolean);
      const actual = normalizeAspectRatio(dimensions.aspect_ratio);
      if (expectedValues.length && (!actual || !expectedValues.includes(actual))) return false;
    } else if (key === 'media_types' || key === 'required_media_types') {
      const required = valuesForMatch(expected);
      const actual = Array.isArray(dimensions.media_types) ? dimensions.media_types : [];
      if (required.some((item) => !actual.includes(item))) return false;
    } else if (key === 'duration_seconds' || key === 'duration') {
      if (!matchesNumber(expected, dimensions.duration_seconds)) return false;
    } else if (key === 'generate_audio') {
      if (expected !== undefined && expected !== null && Boolean(expected) !== Boolean(dimensions.generate_audio)) return false;
    } else if (key in dimensions) {
      if (!matchesScalar(expected, dimensions[key])) return false;
    }
  }
  return true;
}
