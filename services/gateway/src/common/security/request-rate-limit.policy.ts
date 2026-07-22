export type RequestRateLimitRule = {
  limit: number;
  ttl: number;
};

export type RequestRateLimitPolicy = {
  default: RequestRateLimitRule;
  login: RequestRateLimitRule;
  verification: RequestRateLimitRule;
  upload: RequestRateLimitRule;
  publicWrite: RequestRateLimitRule;
};

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function createRequestRateLimitPolicy(env: NodeJS.ProcessEnv): RequestRateLimitPolicy {
  return {
    default: {
      limit: boundedInteger(env.HTTP_RATE_LIMIT_PER_MINUTE, 300, 10, 10_000),
      ttl: 60_000,
    },
    login: {
      limit: boundedInteger(env.AUTH_LOGIN_RATE_LIMIT_PER_MINUTE, 10, 1, 1_000),
      ttl: 60_000,
    },
    verification: {
      limit: boundedInteger(env.AUTH_VERIFICATION_RATE_LIMIT_PER_10_MINUTES, 5, 1, 1_000),
      ttl: 10 * 60_000,
    },
    upload: {
      limit: boundedInteger(env.UPLOAD_RATE_LIMIT_PER_MINUTE, 10, 1, 1_000),
      ttl: 60_000,
    },
    publicWrite: {
      limit: boundedInteger(env.PUBLIC_WRITE_RATE_LIMIT_PER_MINUTE, 30, 1, 5_000),
      ttl: 60_000,
    },
  };
}

export const REQUEST_RATE_LIMIT_POLICY = createRequestRateLimitPolicy(process.env);
