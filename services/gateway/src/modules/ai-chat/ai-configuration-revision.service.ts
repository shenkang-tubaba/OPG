import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AiDecouplingMode } from './ai-product-decoupling.types';
import { hashStableJson, stableJson } from './ai-request-variant.normalizer';

type RevisionRow = {
  id: string;
  revision: number | string;
  status: string;
  manifest_json: unknown;
  manifest_hash: string;
  activate_at: Date | null;
  created_at: Date;
  activated_at: Date | null;
};

type AppReadinessRow = {
  global_model_id: string;
  model_key: string;
  capability: string;
  sell_price_version_id: string | null;
  executable_route_id: string | null;
};

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeMode(value: unknown): AiDecouplingMode {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'shadow' || mode === 'enforced' ? mode : 'legacy';
}

function manifestValidation(manifest: Record<string, unknown>) {
  const errors: string[] = [];
  if (Object.keys(manifest).length === 0) errors.push('manifest must not be empty');
  const sensitive = /(?:api[_-]?key|authorization|access[_-]?token|token|secret|password|private[_-]?key)/i;
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
      if (sensitive.test(key)) errors.push(`manifest contains sensitive field ${path}.${key}`);
      visit(child, `${path}.${key}`);
    });
  };
  visit(manifest, '$');
  return { valid: errors.length === 0, errors };
}

@Injectable()
export class AiConfigurationRevisionService {
  private readonly logger = new Logger(AiConfigurationRevisionService.name);
  private cachedRevision: { revision: number | null; expiresAt: number } | null = null;
  private readonly cacheTtlMs = 5_000;

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async resolveMode(appId?: string | null): Promise<AiDecouplingMode> {
    const emergency = normalizeMode(process.env.AI_PRODUCT_UPSTREAM_DECOUPLING_MODE);
    const hasExplicitEnvironment = !!String(process.env.AI_PRODUCT_UPSTREAM_DECOUPLING_MODE || '').trim();
    if (hasExplicitEnvironment) return emergency;
    if (appId) {
      try {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ extra_json: unknown }>>(
          `SELECT extra_json FROM app_settings WHERE app_id = $1::uuid LIMIT 1`,
          appId,
        );
        const root = jsonObject(rows[0]?.extra_json);
        const policy = jsonObject(root.ai_product_upstream_decoupling);
        if (policy.mode) return normalizeMode(policy.mode);
      } catch (error: any) {
        // App settings are an optional rollout surface. A missing/old schema
        // must never make legacy traffic fail.
        this.logger.debug(`decoupling mode lookup skipped: ${error?.message || error}`);
      }
    }
    return 'legacy';
  }

  async getActiveRevisionNumber(forceRefresh = false): Promise<number | null> {
    const now = Date.now();
    if (!forceRefresh && this.cachedRevision && this.cachedRevision.expiresAt > now) {
      return this.cachedRevision.revision;
    }
    try {
      await this.promoteDueRevision();
      const rows = await this.prisma.$queryRawUnsafe<Array<{ revision: number | string }>>(
        `SELECT revision
           FROM ai_configuration_revisions
          WHERE status = 'active'
            AND (activate_at IS NULL OR activate_at <= now())
          ORDER BY revision DESC
          LIMIT 1`,
      );
      const revision = rows[0] ? Number(rows[0].revision) : null;
      this.cachedRevision = { revision: Number.isFinite(revision as number) ? revision : null, expiresAt: now + this.cacheTtlMs };
      return this.cachedRevision.revision;
    } catch (error: any) {
      this.logger.debug(`configuration revision lookup skipped: ${error?.message || error}`);
      return null;
    }
  }

  private async promoteDueRevision(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended('ai_configuration_revisions', 0))`,
      );
      const due = await tx.$queryRawUnsafe<Array<{ revision: number | string; manifest_hash: string }>>(
        `SELECT revision, manifest_hash
           FROM ai_configuration_revisions
          WHERE status = 'scheduled' AND activate_at IS NOT NULL AND activate_at <= now()
          ORDER BY revision ASC
          LIMIT 1
          FOR UPDATE`,
      );
      if (!due[0]) return;
      const revision = Number(due[0].revision);
      await tx.$executeRawUnsafe(
        `UPDATE ai_configuration_revisions
            SET status = 'retired', updated_at = now()
          WHERE status = 'active' AND revision <> $1`,
        revision,
      );
      await tx.$executeRawUnsafe(
        `UPDATE ai_configuration_revisions
            SET status = 'active', activated_at = COALESCE(activated_at, now()), updated_at = now()
          WHERE revision = $1 AND status = 'scheduled'`,
        revision,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO ai_configuration_change_audits (
           revision, resource_type, operation, after_hash, reason, validation_json
         ) VALUES ($1, 'configuration_revision', 'activate_due', $2, 'scheduled activation', '{}'::jsonb)`,
        revision,
        due[0].manifest_hash,
      );
    });
  }

  async createStagedRevision(input: {
    manifest: Record<string, unknown>;
    actor_user_id?: string | null;
    reason?: string | null;
    activate_at?: Date | null;
  }): Promise<{ revision: number; manifest_hash: string; status: string }> {
    const manifest = jsonObject(input.manifest);
    const validation = manifestValidation(manifest);
    if (!validation.valid) throw new Error(`configuration manifest invalid: ${validation.errors.join('; ')}`);
    const manifestHash = hashStableJson(manifest);
    const status = input.activate_at ? 'scheduled' : 'staged';
    const revision = await this.prisma.$transaction(async (tx) => {
      // Serialize revision allocation so two administrators cannot publish
      // the same monotonic revision under concurrent requests.
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended('ai_configuration_revisions', 0))`,
      );
      const rows = await tx.$queryRawUnsafe<Array<{ revision: number | string }>>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM ai_configuration_revisions`,
      );
      const nextRevision = Number(rows[0]?.revision || 1);
      await tx.$executeRawUnsafe(
        `INSERT INTO ai_configuration_revisions (
           revision, status, manifest_json, manifest_hash, activate_at,
           created_by_user_id, reason
         ) VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6::uuid, $7)`,
        nextRevision,
        status,
        stableJson(manifest),
        manifestHash,
        input.activate_at || null,
        input.actor_user_id || null,
        input.reason || null,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO ai_configuration_change_audits (
           revision, resource_type, operation, after_hash, actor_user_id, reason, validation_json
         ) VALUES ($1, 'configuration_revision', 'create', $2, $3::uuid, $4, $5::jsonb)`,
        nextRevision,
        manifestHash,
        input.actor_user_id || null,
        input.reason || null,
        stableJson({ valid: true }),
      );
      return nextRevision;
    });
    return { revision, manifest_hash: manifestHash, status };
  }

  async validateRevision(revision: number) {
    const rows = await this.prisma.$queryRawUnsafe<RevisionRow[]>(
      `SELECT id, revision, status, manifest_json, manifest_hash, activate_at, created_at, activated_at
         FROM ai_configuration_revisions
        WHERE revision = $1
        LIMIT 1`,
      revision,
    );
    const target = rows[0];
    if (!target) throw new Error(`configuration revision ${revision} not found`);
    const manifest = jsonObject(target.manifest_json);
    const validation = manifestValidation(manifest);
    const hashMatches = hashStableJson(manifest) === target.manifest_hash;
    return {
      revision,
      status: target.status,
      manifest_hash: target.manifest_hash,
      hash_matches: hashMatches,
      valid: validation.valid && hashMatches,
      errors: hashMatches ? validation.errors : [...validation.errors, 'manifest hash mismatch'],
    };
  }

  async validateAppReadiness(appId: string, at = new Date()) {
    const rows = await this.prisma.$queryRawUnsafe<AppReadinessRow[]>(
      `WITH products AS (
         SELECT m.id, m.model_key, m.capability
           FROM ai_global_models m
           LEFT JOIN ai_app_model_visibility v
             ON v.app_id = $1::uuid AND v.global_model_id = m.id
          WHERE m.is_active = true
            AND m.is_visible = true
            AND COALESCE(v.is_visible, true) = true
       )
       SELECT p.id AS global_model_id,
              p.model_key,
              p.capability,
              sell.id AS sell_price_version_id,
              executable.id AS executable_route_id
         FROM products p
         LEFT JOIN LATERAL (
           SELECT price.id
             FROM ai_model_sell_price_versions price
            WHERE price.global_model_id = p.id
              AND (price.app_id = $1::uuid OR price.app_id IS NULL)
              AND price.status IN ('active', 'scheduled')
              AND price.valid_from <= $2::timestamptz
              AND (price.valid_to IS NULL OR price.valid_to > $2::timestamptz)
            ORDER BY CASE WHEN price.app_id = $1::uuid THEN 0 ELSE 1 END,
                     CASE WHEN price.status = 'active' THEN 0 ELSE 1 END,
                     price.valid_from DESC,
                     price.version DESC
            LIMIT 1
         ) sell ON true
         LEFT JOIN LATERAL (
           SELECT route.id
             FROM ai_model_source_routes route
             JOIN ai_global_sources source
               ON source.id = route.source_id AND source.is_active = true
             JOIN ai_upstream_models upstream
               ON upstream.id = route.upstream_model_id AND upstream.is_active = true
            WHERE route.global_model_id = p.id
              AND route.is_active = true
              AND (
                route.app_id = $1::uuid
                OR (
                  route.app_id IS NULL
                  AND NOT EXISTS (
                    SELECT 1
                      FROM ai_model_source_routes app_route
                     WHERE app_route.global_model_id = p.id
                       AND app_route.app_id = $1::uuid
                  )
                )
              )
              AND EXISTS (
                SELECT 1
                  FROM ai_upstream_cost_versions cost
                 WHERE cost.upstream_model_id = upstream.id
                   AND cost.status IN ('active', 'scheduled')
                   AND cost.valid_from <= $2::timestamptz
                   AND (cost.valid_to IS NULL OR cost.valid_to > $2::timestamptz)
              )
            ORDER BY route.match_priority DESC, route.sort_order ASC, route.id ASC
            LIMIT 1
         ) executable ON true
        ORDER BY p.capability ASC, p.model_key ASC`,
      appId,
      at,
    );
    const gaps = rows.flatMap((row) => {
      const modelGaps: Array<{ model_key: string; capability: string; issue: string }> = [];
      if (!row.sell_price_version_id) {
        modelGaps.push({ model_key: row.model_key, capability: row.capability, issue: 'missing_active_sell_price' });
      }
      if (!row.executable_route_id) {
        modelGaps.push({ model_key: row.model_key, capability: row.capability, issue: 'missing_costed_executable_route' });
      }
      return modelGaps;
    });
    const reportCore = {
      app_id: appId,
      checked_at: at.toISOString(),
      visible_product_count: rows.length,
      ready_product_count: rows.filter((row) => row.sell_price_version_id && row.executable_route_id).length,
      gaps,
    };
    return {
      ...reportCore,
      valid: gaps.length === 0,
      report_hash: hashStableJson(reportCore),
    };
  }

  async activateRevision(revision: number, actorUserId?: string | null, reason?: string | null) {
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<RevisionRow[]>(
        `SELECT id, revision, status, manifest_json, manifest_hash, activate_at, created_at, activated_at
           FROM ai_configuration_revisions
          WHERE revision = $1
          FOR UPDATE`,
        revision,
      );
      const target = rows[0];
      if (!target) throw new Error(`configuration revision ${revision} not found`);
      if (!['staged', 'scheduled', 'active'].includes(target.status)) {
        throw new Error(`configuration revision ${revision} cannot be activated from ${target.status}`);
      }
      const validation = manifestValidation(jsonObject(target.manifest_json));
      if (!validation.valid || hashStableJson(jsonObject(target.manifest_json)) !== target.manifest_hash) {
        throw new Error(`configuration revision ${revision} failed validation: ${validation.errors.join('; ') || 'manifest hash mismatch'}`);
      }
      if (target.activate_at && target.activate_at.getTime() > Date.now()) {
        // Scheduling must not retire the currently active revision before the
        // agreed activation time. The polling path promotes it atomically.
        if (target.status !== 'scheduled') {
          await tx.$executeRawUnsafe(
            `UPDATE ai_configuration_revisions
                SET status = 'scheduled', updated_at = now()
              WHERE revision = $1`,
            revision,
          );
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO ai_configuration_change_audits (
             revision, resource_type, operation, after_hash, actor_user_id, reason, validation_json
           ) VALUES ($1, 'configuration_revision', 'schedule', $2, $3::uuid, $4, '{}'::jsonb)`,
          revision,
          target.manifest_hash,
          actorUserId || null,
          reason || null,
        );
        return { revision, manifest_hash: target.manifest_hash, status: 'scheduled' };
      }
      await tx.$executeRawUnsafe(
        `UPDATE ai_configuration_revisions
            SET status = 'retired', updated_at = now()
          WHERE status = 'active' AND revision <> $1`,
        revision,
      );
      await tx.$executeRawUnsafe(
        `UPDATE ai_configuration_revisions
            SET status = 'active', activate_at = COALESCE(activate_at, now()),
                activated_by_user_id = $2::uuid, activated_at = now(), updated_at = now()
          WHERE revision = $1`,
        revision,
        actorUserId || null,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO ai_configuration_change_audits (
           revision, resource_type, operation, after_hash, actor_user_id, reason, validation_json
         ) VALUES ($1, 'configuration_revision', 'activate', $2, $3::uuid, $4, '{}'::jsonb)`,
        revision,
        target.manifest_hash,
        actorUserId || null,
        reason || null,
      );
      return { revision, manifest_hash: target.manifest_hash, status: 'active' };
    });
    this.cachedRevision = result.status === 'active'
      ? { revision: result.revision, expiresAt: Date.now() + this.cacheTtlMs }
      : { revision: null, expiresAt: 0 };
    return result;
  }

  async recordAudit(input: {
    revision: number;
    resource_type: string;
    resource_id?: string | null;
    operation: string;
    before_hash?: string | null;
    after_hash?: string | null;
    actor_user_id?: string | null;
    reason?: string | null;
    validation_json?: Record<string, unknown>;
  }) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_configuration_change_audits (
         revision, resource_type, resource_id, operation, before_hash, after_hash,
         actor_user_id, reason, validation_json
       ) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::uuid, $8, $9::jsonb)`,
      input.revision,
      input.resource_type,
      input.resource_id || null,
      input.operation,
      input.before_hash || null,
      input.after_hash || null,
      input.actor_user_id || null,
      input.reason || null,
      stableJson(input.validation_json || {}),
    );
  }
}
