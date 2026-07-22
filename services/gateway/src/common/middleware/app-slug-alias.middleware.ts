import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { LRUCache } from 'lru-cache';

type AliasCacheEntry = {
  expiresAt: number;
  canonicalSlug: string | null;
};

const POSITIVE_ALIAS_CACHE_TTL_MS = 5 * 60_000;
const NEGATIVE_ALIAS_CACHE_TTL_MS = 30_000;
const MAX_ALIAS_CACHE_ENTRIES = 2_000;
const MAX_INFLIGHT_ALIAS_LOOKUPS = 128;
const slugAliasCache = new LRUCache<string, AliasCacheEntry>({
  max: MAX_ALIAS_CACHE_ENTRIES,
  ttlAutopurge: true,
  updateAgeOnGet: false,
});
const inflightAliasLookups = new Map<string, Promise<string | null>>();

export function clearAppSlugAliasCache() {
  slugAliasCache.clear();
  inflightAliasLookups.clear();
}

export function getAppSlugAliasCacheStats() {
  return {
    size: slugAliasCache.size,
    max: MAX_ALIAS_CACHE_ENTRIES,
    inflight: inflightAliasLookups.size,
    max_inflight: MAX_INFLIGHT_ALIAS_LOOKUPS,
  };
}

function normalizeSlug(value: unknown): string {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug || slug === 'api') {
    return '';
  }
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? slug : '';
}

function isMissingAliasTableError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === '42P01' || String((error as Error)?.message || '').includes('app_slug_aliases');
}

async function resolveCanonicalSlug(prisma: PrismaClient, inputSlug: string): Promise<string | null> {
  const slug = normalizeSlug(inputSlug);
  if (!slug) {
    return null;
  }

  const cached = slugAliasCache.get(slug);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.canonicalSlug;
  }

  const inflight = inflightAliasLookups.get(slug);
  if (inflight) {
    return inflight;
  }

  if (inflightAliasLookups.size >= MAX_INFLIGHT_ALIAS_LOOKUPS) {
    return null;
  }

  const lookup = queryCanonicalSlug(prisma, slug, now);
  inflightAliasLookups.set(slug, lookup);
  try {
    return await lookup;
  } finally {
    inflightAliasLookups.delete(slug);
  }
}

async function queryCanonicalSlug(prisma: PrismaClient, slug: string, now: number): Promise<string | null> {
  try {
    const rows = await (prisma.$queryRawUnsafe(
      `SELECT apps.slug AS canonical_slug
       FROM app_slug_aliases
       JOIN apps ON apps.id = app_slug_aliases.app_id
       WHERE LOWER(app_slug_aliases.slug) = LOWER($1)
         AND app_slug_aliases.is_active = true
         AND apps.status = 'ACTIVE'
       LIMIT 1`,
      slug,
    ) as Promise<Array<{ canonical_slug: string }>>);
    const canonicalSlug = rows[0]?.canonical_slug || null;
    const ttl = canonicalSlug ? POSITIVE_ALIAS_CACHE_TTL_MS : NEGATIVE_ALIAS_CACHE_TTL_MS;
    slugAliasCache.set(slug, { expiresAt: now + ttl, canonicalSlug }, { ttl });
    return canonicalSlug;
  } catch (error) {
    if (isMissingAliasTableError(error)) {
      slugAliasCache.set(
        slug,
        { expiresAt: now + NEGATIVE_ALIAS_CACHE_TTL_MS, canonicalSlug: null },
        { ttl: NEGATIVE_ALIAS_CACHE_TTL_MS },
      );
      return null;
    }
    throw error;
  }
}

function rewriteFirstPathSegment(req: Request, canonicalSlug: string) {
  const url = req.url || '';
  const match = url.match(/^\/([^/?#]+)(\/v[0-9][^?#]*)([?#].*)?$/);
  if (!match) {
    return;
  }
  req.url = `/${canonicalSlug}${match[2]}${match[3] || ''}`;
}

function rewriteQueryApp(req: Request, canonicalSlug: string) {
  const query = req.query as Record<string, unknown> | undefined;
  if (query && typeof query.app === 'string') {
    query.app = canonicalSlug;
  }
}

export function createAppSlugAliasMiddleware(prisma: PrismaClient) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const pathSlug = isTenantVersionedPath(req.path)
        ? normalizeSlug(req.path.split('/').filter(Boolean)[0])
        : '';
      const querySlug = normalizeSlug((req.query as Record<string, unknown> | undefined)?.app);

      if (pathSlug) {
        const canonicalSlug = await resolveCanonicalSlug(prisma, pathSlug);
        if (canonicalSlug && canonicalSlug !== pathSlug) {
          rewriteFirstPathSegment(req, canonicalSlug);
        }
      }

      if (querySlug) {
        const canonicalSlug = await resolveCanonicalSlug(prisma, querySlug);
        if (canonicalSlug && canonicalSlug !== querySlug) {
          rewriteQueryApp(req, canonicalSlug);
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

function isTenantVersionedPath(path: string): boolean {
  return /^\/[a-z0-9][a-z0-9-]{0,63}\/v(?:\d+|\d+beta)(?:\/|$)/i.test(String(path || ''));
}
