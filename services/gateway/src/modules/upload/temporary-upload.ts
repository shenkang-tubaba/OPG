import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { basename, dirname, resolve } from 'path';

export function temporaryUploadStorage() {
  return diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, callback) => callback(null, `opg-upload-${randomUUID()}`),
  });
}

export async function cleanupTemporaryUpload(file: Express.Multer.File | null | undefined): Promise<void> {
  if (!file?.path) {
    return;
  }
  await unlink(file.path).catch(() => undefined);
}

export function isManagedTemporaryUploadPath(filePath: unknown): filePath is string {
  const normalized = String(filePath || '').trim();
  if (!normalized) return false;
  const absolute = resolve(normalized);
  return dirname(absolute) === resolve(tmpdir())
    && /^opg-upload-[0-9a-f-]{36}$/i.test(basename(absolute));
}
