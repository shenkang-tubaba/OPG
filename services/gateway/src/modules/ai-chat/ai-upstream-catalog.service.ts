import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import {
  AiUpstreamCatalogRecord,
  AiUpstreamCostVersion,
  AiPriceVersionStatus,
  AiPriceBook,
} from './ai-product-decoupling.types';

type UpstreamRow = {
  id: string;
  source_id: string;
  upstream_key: string;
  upstream_model: string;
  capability: string;
  billing_scope: string;
  metadata_json: unknown;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

type CostRow = {
  id: string;
  upstream_model_id: string;
  version: number;
  status: AiPriceVersionStatus;
  valid_from: Date;
  valid_to: Date | null;
  currency: string;
  rates_json: unknown;
  source_snapshot_json: unknown;
  content_hash: string;
  reason: string | null;
  actor_user_id: string | null;
};

export type UpstreamCatalogInput = {
  source_id: string;
  upstream_key: string;
  upstream_model: string;
  capability: string;
  billing_scope?: string;
  metadata_json?: Record<string, unknown>;
  is_active?: boolean;
  actor_user_id?: string | null;
};

function recordJson(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsCredentialKey(item));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return /^(apikey|authorization|accesstoken|token|secret|password|privatekey|clientsecret)$/.test(normalized)
      || containsCredentialKey(child);
  });
}

function normalizeUpstreamMetadata(value: unknown): Record<string, unknown> {
  return recordJson(value);
}

function toRecord(row: UpstreamRow): AiUpstreamCatalogRecord {
  return {
    id: row.id,
    source_id: row.source_id,
    upstream_key: row.upstream_key,
    upstream_model: row.upstream_model,
    capability: row.capability,
    billing_scope: row.billing_scope,
    metadata_json: recordJson(row.metadata_json),
    is_active: row.is_active,
    created_at: row.created_at?.toISOString?.() || null,
    updated_at: row.updated_at?.toISOString?.() || null,
  };
}

function toCost(row: CostRow): AiUpstreamCostVersion {
  return {
    id: row.id,
    upstream_model_id: row.upstream_model_id,
    version: Number(row.version),
    status: row.status,
    valid_from: row.valid_from.toISOString(),
    valid_to: row.valid_to?.toISOString() || null,
    currency: row.currency,
    rates_json: recordJson(row.rates_json) as AiPriceBook,
    source_snapshot_json: recordJson(row.source_snapshot_json),
    content_hash: row.content_hash,
    reason: row.reason,
    actor_user_id: row.actor_user_id,
  };
}

@Injectable()
export class AiUpstreamCatalogService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async getById(id: string): Promise<AiUpstreamCatalogRecord | null> {
    const rows = await this.prisma.$queryRawUnsafe<UpstreamRow[]>(
      `SELECT id, source_id, upstream_key, upstream_model, capability, billing_scope,
              metadata_json, is_active, created_at, updated_at
         FROM ai_upstream_models
        WHERE id = $1::uuid
        LIMIT 1`,
      id,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async requireById(id: string): Promise<AiUpstreamCatalogRecord> {
    const value = await this.getById(id);
    if (!value) {
      throw new NotFoundException('Upstream model not found');
    }
    return value;
  }

  async findByIdentity(input: {
    source_id: string;
    upstream_model: string;
    capability: string;
    billing_scope?: string;
  }): Promise<AiUpstreamCatalogRecord | null> {
    const rows = await this.prisma.$queryRawUnsafe<UpstreamRow[]>(
      `SELECT id, source_id, upstream_key, upstream_model, capability, billing_scope,
              metadata_json, is_active, created_at, updated_at
         FROM ai_upstream_models
        WHERE source_id = $1::uuid
          AND upstream_model = $2
          AND capability = $3
        ORDER BY (billing_scope = 'default') DESC, created_at ASC
        LIMIT 1`,
      input.source_id,
      String(input.upstream_model || '').trim(),
      String(input.capability || '').trim().toLowerCase(),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(input: {
    source_id?: string;
    capability?: string;
    include_inactive?: boolean;
  } = {}): Promise<AiUpstreamCatalogRecord[]> {
    const clauses = ['1 = 1'];
    const values: unknown[] = [];
    if (input.source_id) {
      values.push(input.source_id);
      clauses.push(`source_id = $${values.length}::uuid`);
    }
    if (input.capability) {
      values.push(String(input.capability).trim().toLowerCase());
      clauses.push(`capability = $${values.length}`);
    }
    if (!input.include_inactive) {
      clauses.push('is_active = true');
    }
    const rows = await this.prisma.$queryRawUnsafe<UpstreamRow[]>(
      `SELECT id, source_id, upstream_key, upstream_model, capability, billing_scope,
              metadata_json, is_active, created_at, updated_at
         FROM ai_upstream_models
        WHERE ${clauses.join(' AND ')}
        ORDER BY source_id, capability, upstream_key`,
      ...values,
    );
    return rows.map(toRecord);
  }

  /**
   * Creates or updates only the upstream identity. Route-specific adapter
   * fields intentionally stay outside this record so t2v/i2v cannot collide.
   */
  async upsert(input: UpstreamCatalogInput): Promise<AiUpstreamCatalogRecord> {
    const sourceId = String(input.source_id || '').trim();
    const upstreamModel = String(input.upstream_model || '').trim();
    const capability = String(input.capability || '').trim().toLowerCase();
    const upstreamKey = String(input.upstream_key || '').trim();
    // A supplier model is reusable by every public product. Cost versions belong
    // to that supplier model, so a product-specific billing scope must never
    // create a second upstream identity.
    const billingScope = 'default';
    if (!sourceId || !upstreamModel || !capability || !upstreamKey) {
      throw new BadRequestException('source_id, upstream_key, upstream_model and capability are required');
    }
    if (containsCredentialKey(input.metadata_json || {})) {
      throw new BadRequestException('upstream metadata must not contain credentials');
    }
    const hasMetadataInput = input.metadata_json !== undefined;
    const metadata = normalizeUpstreamMetadata(input.metadata_json || {});
    const rows = await this.prisma.$queryRawUnsafe<UpstreamRow[]>(
      `INSERT INTO ai_upstream_models (
         source_id, upstream_key, upstream_model, capability, billing_scope,
         metadata_json, is_active, created_by_user_id, updated_by_user_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8::uuid, $8::uuid)
       ON CONFLICT (source_id, upstream_model, capability, billing_scope)
       DO UPDATE SET
                     metadata_json = CASE WHEN $9::boolean THEN EXCLUDED.metadata_json ELSE ai_upstream_models.metadata_json END,
                     is_active = EXCLUDED.is_active,
                     updated_by_user_id = EXCLUDED.updated_by_user_id,
                     updated_at = now()
       RETURNING id, source_id, upstream_key, upstream_model, capability, billing_scope,
                 metadata_json, is_active, created_at, updated_at`,
      sourceId,
      upstreamKey,
      upstreamModel,
      capability,
      billingScope,
      JSON.stringify(metadata),
      input.is_active !== false,
      input.actor_user_id || null,
      hasMetadataInput,
    );
    if (!rows[0]) {
      throw new BadRequestException('Upstream model could not be saved');
    }
    return toRecord(rows[0]);
  }

  async update(id: string, input: Omit<UpstreamCatalogInput, 'source_id'>): Promise<AiUpstreamCatalogRecord> {
    const existing = await this.requireById(id);
    const upstreamModel = String(input.upstream_model || '').trim();
    const capability = String(input.capability || '').trim().toLowerCase();
    const upstreamKey = String(input.upstream_key || '').trim();
    const billingScope = 'default';
    if (!upstreamModel || !capability || !upstreamKey) {
      throw new BadRequestException('upstream_key, upstream_model and capability are required');
    }
    if (containsCredentialKey(input.metadata_json || {})) {
      throw new BadRequestException('upstream metadata must not contain credentials');
    }
    const metadata = normalizeUpstreamMetadata(
      input.metadata_json === undefined ? existing.metadata_json : input.metadata_json,
    );

    const keyDuplicate = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id
         FROM ai_upstream_models
        WHERE source_id = $1::uuid
          AND upstream_key = $2
          AND id <> $3::uuid
        LIMIT 1`,
      existing.source_id,
      upstreamKey,
      existing.id,
    );
    if (keyDuplicate[0]) {
      throw new BadRequestException('upstream_key already exists for this supplier');
    }

    const identityDuplicate = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id
         FROM ai_upstream_models
        WHERE source_id = $1::uuid
          AND upstream_model = $2
          AND capability = $3
          AND billing_scope = 'default'
          AND id <> $4::uuid
        LIMIT 1`,
      existing.source_id,
      upstreamModel,
      capability,
      existing.id,
    );
    if (identityDuplicate[0]) {
      throw new BadRequestException('supplier already has this upstream model');
    }

    const rows = await this.prisma.$queryRawUnsafe<UpstreamRow[]>(
      `UPDATE ai_upstream_models
          SET upstream_key = $2,
              upstream_model = $3,
              capability = $4,
              billing_scope = $5,
              metadata_json = $6::jsonb,
              is_active = $7,
              updated_by_user_id = $8::uuid,
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING id, source_id, upstream_key, upstream_model, capability, billing_scope,
                  metadata_json, is_active, created_at, updated_at`,
      existing.id,
      upstreamKey,
      upstreamModel,
      capability,
      billingScope,
      JSON.stringify(metadata),
      input.is_active !== false,
      input.actor_user_id || null,
    );
    if (!rows[0]) {
      throw new NotFoundException('Upstream model not found');
    }
    return toRecord(rows[0]);
  }

  async resolveCostVersion(upstreamModelId: string, at = new Date()): Promise<AiUpstreamCostVersion | null> {
    const rows = await this.prisma.$queryRawUnsafe<CostRow[]>(
      `SELECT id, upstream_model_id, version, status, valid_from, valid_to, currency,
              rates_json, source_snapshot_json, content_hash, reason, actor_user_id
         FROM ai_upstream_cost_versions
        WHERE upstream_model_id = $1::uuid
          AND status IN ('active', 'scheduled')
          AND valid_from <= $2::timestamptz
          AND (valid_to IS NULL OR valid_to > $2::timestamptz)
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, valid_from DESC, version DESC
        LIMIT 1`,
      upstreamModelId,
      at,
    );
    return rows[0] ? toCost(rows[0]) : null;
  }
}
