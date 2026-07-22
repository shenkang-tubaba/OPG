import { isCorsOriginAllowed } from './cors-origin-policy';

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function extractSocketAccessToken(...candidates: unknown[]): string | null {
  const rawToken = candidates.map(stringOrUndefined).find(Boolean);
  if (!rawToken) return null;
  if (rawToken.toLowerCase().startsWith('bearer ')) {
    return rawToken.slice(7).trim() || null;
  }
  return rawToken;
}

export function createWebSocketRequestGuard(
  configuredOrigins: readonly string[],
  allowDevelopmentOrigins = false,
) {
  return (
    request: { headers: { origin?: string } },
    callback: (error: string | null | undefined, success: boolean) => void,
  ): void => {
    const allowed = isCorsOriginAllowed(
      request.headers.origin,
      configuredOrigins,
      allowDevelopmentOrigins,
    );
    callback(allowed ? null : 'origin not allowed', allowed);
  };
}

export function resolveWebSocketMaxPayloadBytes(value: string | undefined): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed)) return 1024 * 1024;
  return Math.min(5 * 1024 * 1024, Math.max(16 * 1024, parsed));
}
