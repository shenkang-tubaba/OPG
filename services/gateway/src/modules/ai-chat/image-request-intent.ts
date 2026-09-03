export type ImageResolutionTier = '1k' | '2k' | '4k';

export type NormalizedImageRequestIntent = {
  resolution: ImageResolutionTier;
  quality: string;
  aspectRatio: string;
  size: string;
};

const IMAGE_SIZES: Record<ImageResolutionTier, Record<string, string>> = {
  '1k': {
    '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536',
    '4:3': '1024x768', '3:4': '768x1024', '5:4': '1280x1024',
    '4:5': '1024x1280', '16:9': '1536x864', '9:16': '864x1536',
    '2:1': '2048x1024', '1:2': '1024x2048', '3:1': '1536x512',
    '1:3': '512x1536', '21:9': '2016x864', '9:21': '864x2016',
  },
  '2k': {
    '1:1': '2048x2048', '3:2': '2048x1360', '2:3': '1360x2048',
    '4:3': '2048x1536', '3:4': '1536x2048', '5:4': '2560x2048',
    '4:5': '2048x2560', '16:9': '2048x1152', '9:16': '1152x2048',
    '2:1': '2688x1344', '1:2': '1344x2688', '3:1': '3072x1024',
    '1:3': '1024x3072', '21:9': '2688x1152', '9:21': '1152x2688',
  },
  '4k': {
    '1:1': '2880x2880', '3:2': '3520x2336', '2:3': '2336x3520',
    '4:3': '3312x2480', '3:4': '2480x3312', '5:4': '3216x2576',
    '4:5': '2576x3216', '16:9': '3840x2160', '9:16': '2160x3840',
    '2:1': '3840x1920', '1:2': '1920x3840', '3:1': '3840x1280',
    '1:3': '1280x3840', '21:9': '3840x1648', '9:21': '1648x3840',
  },
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

function firstString(...values: unknown[]): string | null {
  return values.map(stringValue).find(Boolean) || null;
}

function normalizeSize(value: unknown): string | null {
  const text = stringValue(value)?.toLowerCase().replace(/\s+/g, '').replace(/×/g, 'x');
  const match = text?.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
  return `${Number(match[1])}x${Number(match[2])}`;
}

function normalizeAspectRatio(value: unknown): string | null {
  const text = stringValue(value)
    ?.replace(/\s+/g, '')
    .replace(/[：x]/g, ':')
    .replace(/\//g, ':');
  const match = text?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
  return `${Number(match[1])}:${Number(match[2])}`;
}

function normalizeQuality(value: unknown): string | null {
  const normalized = stringValue(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized || normalized === 'auto') return null;
  if (normalized === 'hd') return 'high';
  if (normalized === 'standard' || normalized === 'normal') return 'medium';
  return normalized;
}

function findSizeProfile(size: string): { resolution: ImageResolutionTier; aspectRatio: string } | null {
  for (const resolution of ['1k', '2k', '4k'] as const) {
    const match = Object.entries(IMAGE_SIZES[resolution]).find(([, candidate]) => candidate === size);
    if (match) return { resolution, aspectRatio: match[0] };
  }
  return null;
}

function normalizeResolutionTier(value: unknown): ImageResolutionTier | null {
  const normalized = stringValue(value)?.toLowerCase().replace(/\s+/g, '');
  if (normalized === '1k' || normalized === '1024' || normalized === '1024x1024') return '1k';
  if (normalized === '2k' || normalized === '2048' || normalized === '2048x2048') return '2k';
  if (normalized === '4k' || normalized === '4096' || normalized === '4096x4096') return '4k';
  const size = normalizeSize(normalized);
  return size ? findSizeProfile(size)?.resolution || null : null;
}

export function normalizeImageRequestIntent(
  payload: Record<string, unknown>,
): NormalizedImageRequestIntent {
  const imageConfig = objectValue(payload.image_config ?? payload.imageConfig);
  const input = objectValue(payload.input);
  const parameters = objectValue(payload.parameters);
  const rawSize = firstString(
    payload.size, payload.image_size, payload.imageSize,
    imageConfig.size, imageConfig.image_size, input.size, parameters.size,
  );
  const explicitSize = normalizeSize(rawSize);
  const width = Number(payload.width ?? imageConfig.width ?? input.width ?? parameters.width);
  const height = Number(payload.height ?? imageConfig.height ?? input.height ?? parameters.height);
  const dimensionSize = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? normalizeSize(`${width}x${height}`)
    : null;
  const requestedSize = explicitSize || dimensionSize;
  const sizeProfile = requestedSize ? findSizeProfile(requestedSize) : null;
  const resolution = normalizeResolutionTier(firstString(
    payload.resolution, imageConfig.resolution, input.resolution, parameters.resolution,
  )) || normalizeResolutionTier(rawSize) || sizeProfile?.resolution || '1k';
  const aspectRatio = normalizeAspectRatio(firstString(
    payload.aspectRatio, payload.aspect_ratio,
    imageConfig.aspectRatio, imageConfig.aspect_ratio,
    input.aspectRatio, input.aspect_ratio,
    parameters.aspectRatio, parameters.aspect_ratio,
  )) || sizeProfile?.aspectRatio || '1:1';
  const quality = normalizeQuality(firstString(
    payload.quality, imageConfig.quality, input.quality, parameters.quality,
  )) || 'high';
  return {
    resolution,
    quality,
    aspectRatio,
    size: requestedSize || IMAGE_SIZES[resolution][aspectRatio] || IMAGE_SIZES[resolution]['1:1'],
  };
}
