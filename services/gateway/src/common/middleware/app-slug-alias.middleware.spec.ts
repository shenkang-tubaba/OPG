import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  clearAppSlugAliasCache,
  createAppSlugAliasMiddleware,
  getAppSlugAliasCacheStats,
} from './app-slug-alias.middleware';

function request(path: string, query: Record<string, unknown> = {}) {
  return { path, url: path, query } as any;
}

function runMiddleware(middleware: ReturnType<typeof createAppSlugAliasMiddleware>, req: any) {
  return new Promise<void>((resolve, reject) => {
    void middleware(req, {} as any, (error?: unknown) => error ? reject(error) : resolve());
  });
}

beforeEach(() => clearAppSlugAliasCache());

test('does not query aliases for arbitrary non-versioned paths', async () => {
  let queries = 0;
  const middleware = createAppSlugAliasMiddleware({
    $queryRawUnsafe: async () => {
      queries += 1;
      return [];
    },
  } as any);

  await runMiddleware(middleware, request('/random-probe'));

  assert.equal(queries, 0);
  assert.equal(getAppSlugAliasCacheStats().size, 0);
});

test('coalesces concurrent lookups and rewrites tenant versioned paths', async () => {
  let queries = 0;
  const middleware = createAppSlugAliasMiddleware({
    $queryRawUnsafe: async () => {
      queries += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [{ canonical_slug: 'canonical-app' }];
    },
  } as any);
  const requests = Array.from({ length: 20 }, () => request('/old-app/v1/users/me'));

  await Promise.all(requests.map((req) => runMiddleware(middleware, req)));

  assert.equal(queries, 1);
  assert.equal(getAppSlugAliasCacheStats().size, 1);
  requests.forEach((req) => assert.equal(req.url, '/canonical-app/v1/users/me'));
});

test('keeps negative alias entries within the configured maximum', async () => {
  const middleware = createAppSlugAliasMiddleware({ $queryRawUnsafe: async () => [] } as any);
  const total = getAppSlugAliasCacheStats().max + 250;

  for (let index = 0; index < total; index += 1) {
    await runMiddleware(middleware, request(`/tenant-${index}/v1/health`));
  }

  assert.equal(getAppSlugAliasCacheStats().size, getAppSlugAliasCacheStats().max);
});
