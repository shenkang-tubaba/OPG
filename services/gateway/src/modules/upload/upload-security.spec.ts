import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { assertNoStorageScopeOverrides } from './upload-request.policy';
import { cleanupTemporaryUpload, isManagedTemporaryUploadPath } from './temporary-upload';

test('rejects every client-controlled storage scope field', () => {
  for (const field of ['app_slug', 'appSlug', 'app_id', 'appId', 'key_prefix', 'keyPrefix']) {
    assert.throws(
      () => assertNoStorageScopeOverrides({ [field]: 'other-tenant' }),
      /storage tenant and key prefix are determined by the authenticated route/,
    );
  }
  assert.doesNotThrow(() => assertNoStorageScopeOverrides({}));
});

test('buffer compatibility endpoint binds upload to the route app and always removes its temporary file', async () => {
  const filePath = join(tmpdir(), `opg-upload-${randomUUID()}`);
  await writeFile(filePath, Buffer.from('temporary-upload'));
  const calls: unknown[][] = [];
  const failure = new Error('storage failed');
  const uploadService = {
    uploadLocalFile: async (...args: unknown[]) => {
      calls.push(args);
      throw failure;
    },
  };
  const authorization = { assertActorScope: () => undefined };
  const controller = new UploadController(uploadService as any, authorization as any);
  const file = {
    path: filePath,
    originalname: 'sample.bin',
    mimetype: 'application/octet-stream',
  } as Express.Multer.File;

  await assert.rejects(
    controller.uploadFileBuffer(file, { user: { id: 'user-1', appSlug: 'fallback-app' } }, 'route-app', {}),
    failure,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[4], 'route-app');
  assert.equal(calls[0]?.[5], 'uploads/files');
  await assert.rejects(access(filePath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('temporary upload cleanup only recognizes managed files in the operating system temp directory', async () => {
  const filePath = join(tmpdir(), `opg-upload-${randomUUID()}`);
  await writeFile(filePath, Buffer.from('temporary-upload'));
  assert.equal(isManagedTemporaryUploadPath(filePath), true);
  assert.equal(isManagedTemporaryUploadPath(join(process.cwd(), 'opg-upload-00000000-0000-0000-0000-000000000000')), false);

  await cleanupTemporaryUpload({ path: filePath } as Express.Multer.File);
  await assert.rejects(access(filePath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('stream uploads close their owned source stream even when storage returns early', async () => {
  const source = new Readable({
    autoDestroy: false,
    read() {
      this.push(Buffer.from('stream-bytes'));
      this.push(null);
    },
  });
  const service = Object.create(UploadService.prototype) as UploadService;
  Object.assign(service as any, {
    refreshStorageProviderConfig: async () => undefined,
    ossClient: { putStream: async () => ({}) },
    s3Client: null,
    cdnBaseUrl: '',
    ossBucket: '',
    ossEndpoint: '',
  });

  await service.uploadStreamToKey('uploads/test/stream.bin', 'application/octet-stream', source);

  assert.equal(source.destroyed, true);
});
