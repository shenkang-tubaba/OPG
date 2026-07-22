import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  OpgApiError,
  OpgTransportError,
  createOpgClient,
  createOpgPlatformClient,
  readOpgLocalConfig,
} from '../dist/index.js';

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { 'content-type': 'application/json', ...(init.headers || {}) },
});

test('safe requests retry transient failures and preserve the final response', async () => {
  let attempts = 0;
  const client = createOpgClient({
    baseUrl: 'https://opg.example.com',
    app: 'demo',
    apiKey: 'opg_dev_test',
    fetch: async () => {
      attempts += 1;
      return attempts < 3 ? jsonResponse({ message: 'busy' }, { status: 503 }) : jsonResponse({ ok: true });
    },
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10 },
  });

  assert.deepEqual(await client.ai.models(), { ok: true });
  assert.equal(attempts, 3);
});

test('write requests only retry when an idempotency key is present', async () => {
  let attempts = 0;
  const client = createOpgClient({
    baseUrl: 'https://opg.example.com',
    app: 'demo',
    fetch: async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ message: 'busy' }, { status: 503 }) : jsonResponse({ ok: true });
    },
    retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
  });

  await assert.rejects(() => client.request('/write', { method: 'POST', body: {} }), OpgApiError);
  assert.equal(attempts, 1);

  attempts = 0;
  assert.deepEqual(await client.request('/write', {
    method: 'POST',
    body: {},
    idempotencyKey: 'test-operation',
  }), { ok: true });
  assert.equal(attempts, 2);
});

test('timeouts and API errors expose structured diagnostics', async () => {
  const timeoutClient = createOpgClient({
    baseUrl: 'https://opg.example.com',
    app: 'demo',
    timeoutMs: 100,
    retry: false,
    fetch: async (_url, init) => await new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('timeout signal did not fire')), 1_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      }, { once: true });
    }),
  });
  await assert.rejects(
    () => timeoutClient.ai.models(),
    (error) => error instanceof OpgTransportError && error.code === 'REQUEST_TIMEOUT',
  );

  const errorClient = createOpgClient({
    baseUrl: 'https://opg.example.com',
    app: 'demo',
    retry: false,
    fetch: async () => jsonResponse(
      { code: 'RATE_LIMITED', message: 'slow down', request_id: 'req_123' },
      { status: 429, headers: { 'retry-after': '2', 'x-request-id': 'req_header' } },
    ),
  });
  await assert.rejects(
    () => errorClient.ai.models(),
    (error) => error instanceof OpgApiError
      && error.code === 'RATE_LIMITED'
      && error.requestId === 'req_header'
      && error.retryAfterMs === 2000,
  );
});

test('new product capabilities resolve to the expected backend routes', async () => {
  const calls = [];
  const platform = createOpgPlatformClient({
    baseUrl: 'https://opg.example.com',
    platformToken: 'jwt',
    retry: false,
    fetch: async (url, init) => {
      calls.push([String(url), init?.method || 'GET']);
      return jsonResponse({ ok: true });
    },
  });

  await platform.apps.forms.createLogicRule('app-1', 'form-1', {});
  await platform.apps.forms.createAction('app-1', 'form-1', {});
  await platform.apps.acquisition.summary('app-1');
  await platform.apps.schema.upsertPolicy('app-1', 'customers', {});
  await platform.apps.ai.grantPoints('app-1', {});
  await platform.apps.users.unlinkEmail('app-1', 'user-1');
  await platform.sms.testSend('app-1', {});
  await platform.ai.voices.retryClone('voice-1');

  assert.deepEqual(calls.map(([url, method]) => [new URL(url).pathname, method]), [
    ['/api/v1/platform-admin/apps/app-1/forms/form-1/logic-rules', 'POST'],
    ['/api/v1/platform-admin/apps/app-1/forms/form-1/actions', 'POST'],
    ['/api/v1/platform-admin/apps/app-1/acquisition/summary', 'GET'],
    ['/api/v1/platform-admin/apps/app-1/schema/tables/customers/policies', 'POST'],
    ['/api/v1/platform-admin/apps/app-1/ai/points/grant', 'POST'],
    ['/api/v1/platform-admin/apps/app-1/users/user-1/unlink-email', 'POST'],
    ['/api/v1/platform-admin/apps/app-1/sms/test-send', 'POST'],
    ['/api/v1/platform-admin/ai/voices/voice-1/retry-clone', 'POST'],
  ]);
});

test('local config selects app-scoped credentials without leaking another app key', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'opg-sdk-config-'));
  try {
    await mkdir(path.join(cwd, '.opg'));
    await writeFile(path.join(cwd, '.opg/opg.config.json'), JSON.stringify({
      baseUrl: 'https://opg.example.com',
      app: 'app-b',
      profile: 'default',
    }));
    await writeFile(path.join(cwd, '.opg/credentials.json'), JSON.stringify({
      currentProfile: 'default',
      profiles: {
        default: {
          app: 'app-a',
          apiKey: 'key-a-legacy',
          apps: {
            'app-a': { apiKey: 'key-a' },
            'app-b': { apiKey: 'key-b' },
          },
        },
      },
    }));
    const config = await readOpgLocalConfig({ cwd });
    assert.equal(config.app, 'app-b');
    assert.equal(config.apiKey, 'key-b');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
