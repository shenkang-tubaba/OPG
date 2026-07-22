export type CorsOriginCallback = (error: Error | null, allow?: boolean) => void;

function normalizeExactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function matchesWildcardOrigin(origin: URL, rule: string): boolean {
  const match = rule.trim().match(/^(https?):\/\/\*\.([a-z0-9.-]+)(?::(\d+))?$/i);
  if (!match) return false;

  const [, protocol, rawDomain, port] = match;
  const domain = rawDomain.toLowerCase();
  const hostname = origin.hostname.toLowerCase();
  return origin.protocol === `${protocol.toLowerCase()}:`
    && hostname.endsWith(`.${domain}`)
    && hostname !== domain
    && (port ? origin.port === port : !origin.port);
}

function isDevelopmentOrigin(origin: URL): boolean {
  if (!['http:', 'https:'].includes(origin.protocol)) return false;
  const hostname = origin.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname.endsWith('.local')
    || hostname.endsWith('.sslip.io');
}

export function isCorsOriginAllowed(
  origin: string | undefined,
  configuredOrigins: readonly string[],
  allowDevelopmentOrigins = false,
): boolean {
  if (!origin) return true;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin.trim());
  } catch {
    return false;
  }
  if (parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) return false;
  if (allowDevelopmentOrigins && isDevelopmentOrigin(parsedOrigin)) return true;

  const normalizedOrigin = parsedOrigin.origin.toLowerCase();
  for (const rawRule of configuredOrigins) {
    const rule = rawRule.trim();
    if (!rule) continue;
    if (rule === '*') return true;
    if (rule.includes('*')) {
      if (matchesWildcardOrigin(parsedOrigin, rule)) return true;
      continue;
    }
    if (normalizeExactOrigin(rule) === normalizedOrigin) return true;
  }
  return false;
}

export function createCorsOriginCallback(
  configuredOrigins: readonly string[],
  allowDevelopmentOrigins = false,
) {
  return (origin: string | undefined, callback: CorsOriginCallback): void => {
    callback(null, isCorsOriginAllowed(origin, configuredOrigins, allowDevelopmentOrigins));
  };
}
