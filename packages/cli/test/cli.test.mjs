import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cliEntry = new URL('../dist/index.js', import.meta.url).pathname;

function runCli(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`CLI exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function createProject() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'opg-cli-test-'));
  await mkdir(path.join(cwd, '.opg'));
  await writeFile(path.join(cwd, '.opg/opg.config.json'), JSON.stringify({
    baseUrl: 'https://opg.example.com',
    app: 'app-a',
    profile: 'default',
  }));
  await writeFile(path.join(cwd, '.opg/credentials.json'), JSON.stringify({
    currentProfile: 'default',
    profiles: {
      default: {
        baseUrl: 'https://opg.example.com',
        app: 'app-a',
        apiKey: 'legacy-a',
        platformToken: 'not-a-jwt',
        apps: {
          'app-a': { apiKey: 'key-a' },
          'app-b': { apiKey: 'key-b' },
        },
      },
    },
  }));
  return cwd;
}

test('help and project initialization work without network access', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'opg-cli-init-'));
  try {
    const help = await runCli(['--help'], cwd);
    assert.match(help.stdout, /OPG CLI/);
    await runCli(['init', '--base-url', 'https://opg.example.com'], cwd);
    const config = JSON.parse(await readFile(path.join(cwd, '.opg/opg.config.json'), 'utf8'));
    assert.equal(config.baseUrl, 'https://opg.example.com');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('app switching selects the matching app credential', async () => {
  const cwd = await createProject();
  try {
    await runCli(['app', 'use', 'app-b'], cwd);
    const credentials = JSON.parse(await readFile(path.join(cwd, '.opg/credentials.json'), 'utf8'));
    assert.equal(credentials.profiles.default.app, 'app-b');
    assert.equal(credentials.profiles.default.apiKey, 'key-b');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('app switching and browser grant beat a stale init placeholder', async () => {
  const cwd = await createProject();
  const received = [];
  const server = createServer((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await writeFile(path.join(cwd, '.env.local'), `OPG_BASE_URL=${baseUrl}\nOPG_APP_SLUG=app-a\nOPG_API_KEY=rbx_replace_me\n`);
    await runCli(['app', 'use', 'app-b'], cwd);
    await runCli(['request', '--path', '/users/me'], cwd);
    assert.deepEqual(received, [{ url: '/app-b/v1/users/me', authorization: 'Bearer key-b' }]);
  } finally {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('management commands reach the SDK platform routes', async () => {
  const cwd = await createProject();
  const received = [];
  const server = createServer((request, response) => {
    received.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await writeFile(path.join(cwd, '.opg/opg.config.json'), JSON.stringify({ baseUrl, app: 'app-a', profile: 'default' }));
    await runCli(['platform', 'observability', 'requests', '--app-id', 'app-a', '--status-min', '500'], cwd);
    await runCli(['platform', 'ai', 'sources', 'list'], cwd);
    await runCli(['platform', 'site', 'get', '--app-id', 'app-a'], cwd);
    await runCli(['platform', 'settings', 'storage', 'list'], cwd);
    await runCli(['platform', 'jobs', 'list', '--app-id', 'app-a'], cwd);
    assert.deepEqual(received, [
      '/api/v1/platform-admin/apps/app-a/observability/request-events?status_min=500',
      '/api/v1/platform-admin/ai/sources',
      '/api/v1/platform-admin/apps/app-a/site',
      '/api/v1/platform-admin/storage/providers',
      '/api/v1/platform-admin/apps/app-a/tasks',
    ]);
  } finally {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('plain login requests platform authorization even when an app is selected', async () => {
  const cwd = await createProject();
  const paths = [];
  const server = createServer(async (request, response) => {
    paths.push(request.url);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/api/v1/sdk/auth/sessions') {
      response.end(JSON.stringify({ state: 'test-state', login_url: 'https://opg.example.com/sdk-login', expires_at: new Date(Date.now() + 60_000).toISOString() }));
      setTimeout(() => { fetch(`${body.callback_url}?state=test-state&code=test-code`).catch(() => {}); }, 10);
      return;
    }
    response.end(JSON.stringify({ auth: { platform_token: 'platform-token', platform_refresh_token: 'refresh-token' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await writeFile(path.join(cwd, '.opg/opg.config.json'), JSON.stringify({ baseUrl, app: 'app-a', profile: 'default' }));
    await runCli(['login', '--open', 'false'], cwd);
    assert.deepEqual(paths, ['/api/v1/sdk/auth/sessions', '/api/v1/sdk/auth/token']);
    const saved = JSON.parse(await readFile(path.join(cwd, '.opg/credentials.json'), 'utf8'));
    assert.equal(saved.profiles.default.platformToken, 'platform-token');
  } finally {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Codex MCP config pins the CLI version and never writes a token placeholder', async () => {
  const cwd = await createProject();
  try {
    await runCli(['codex', 'install'], cwd);
    const config = JSON.parse(await readFile(path.join(cwd, '.opg/codex-mcp.json'), 'utf8'));
    const server = config.mcpServers.opg;
    assert.match(server.args[1], /^@jamba\/opg-cli@\d+\.\d+\.\d+$/);
    assert.equal('OPG_PLATFORM_TOKEN' in server.env, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('MCP catalog exposes synchronized product tools', async () => {
  const cwd = await createProject();
  const child = spawn(process.execPath, [cliEntry, 'mcp'], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'opg-cli-offline-test', version: '0.0.0' },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const deadline = Date.now() + 10_000;
    while (!stdout.includes('"id":2') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(stdout, /opg_app_request/, stderr);
    assert.match(stdout, /opg_platform_app_acquisition_report/, stderr);
    assert.match(stdout, /opg_platform_ai_voice_operation/, stderr);
    assert.match(stdout, /opg_platform_request_events/, stderr);
    assert.match(stdout, /opg_platform_audit_events/, stderr);
    assert.match(stdout, /opg_platform_ai_provider_health/, stderr);
    assert.match(stdout, /opg_schema_policy_upsert/, stderr);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    await rm(cwd, { recursive: true, force: true });
  }
});

test('generic app request sends auth, query, and idempotency headers', async () => {
  const received = {};
  const server = createServer((request, response) => {
    received.url = request.url;
    received.authorization = request.headers.authorization;
    received.idempotencyKey = request.headers['idempotency-key'];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const cwd = await createProject();
  try {
    const result = await runCli([
      'request',
      '--path', '/users/me',
      '--query', '{"include":"roles"}',
      '--idempotency-key', 'read-user',
    ], cwd, {
      OPG_BASE_URL: `http://127.0.0.1:${address.port}`,
      OPG_APP_SLUG: 'app-b',
      OPG_API_KEY: 'key-b',
    });
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    assert.equal(received.url, '/app-b/v1/users/me?include=roles');
    assert.equal(received.authorization, 'Bearer key-b');
    assert.equal(received.idempotencyKey, 'read-user');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
});
