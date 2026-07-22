import { BadRequestException } from '@nestjs/common';

export type StorageScopeOverrideBody = {
  app_slug?: unknown;
  appSlug?: unknown;
  app_id?: unknown;
  appId?: unknown;
  key_prefix?: unknown;
  keyPrefix?: unknown;
};

const STORAGE_SCOPE_OVERRIDE_FIELDS: Array<keyof StorageScopeOverrideBody> = [
  'app_slug',
  'appSlug',
  'app_id',
  'appId',
  'key_prefix',
  'keyPrefix',
];

export function assertNoStorageScopeOverrides(body: StorageScopeOverrideBody | null | undefined): void {
  const attempted = STORAGE_SCOPE_OVERRIDE_FIELDS.filter((field) => body?.[field] !== undefined);
  if (attempted.length > 0) {
    throw new BadRequestException('storage tenant and key prefix are determined by the authenticated route');
  }
}
