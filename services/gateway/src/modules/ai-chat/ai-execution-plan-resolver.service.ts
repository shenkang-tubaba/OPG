import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import {
  AiBillingIntent,
  AiExecutionCandidate,
  AiExecutionPlan,
  AiSellPriceVersion,
  CanonicalRequestVariant,
} from './ai-product-decoupling.types';
import { AiConfigurationRevisionService } from './ai-configuration-revision.service';
import { AiPriceBookService } from './ai-price-book.service';
import { normalizeRequestVariant, requestVariantMatches, stableJson, hashStableJson } from './ai-request-variant.normalizer';

type ProductRow = {
  id: string;
  global_model_id?: string;
  model_key: string;
  display_name: string;
  capability: string;
  execution_mode: string;
  is_visible: boolean;
  app_is_visible: boolean;
};

type RouteRow = {
  route_id: string;
  route_key: string;
  global_model_id: string;
  app_id: string | null;
  source_id: string;
  route_active: boolean;
  source_active: boolean;
  variant_key: string;
  match_priority: number | string;
  sort_order: number | string;
  contract_version: string;
  upstream_model_id: string | null;
  upstream_model: string | null;
  upstream_active: boolean | null;
  endpoint_path: string | null;
  api_type: string | null;
  execution_mode: string | null;
  request_overrides: unknown;
  request_match: unknown;
  adapter_config_json: unknown;
  cost_version: unknown;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapCandidate(row: RouteRow): AiExecutionCandidate {
  return {
    route_id: row.route_id,
    route_key: row.route_key,
    variant_key: row.variant_key || 'default',
    match_priority: Number(row.match_priority || 0),
    sort_order: Number(row.sort_order || 0),
    contract_version: row.contract_version || 'legacy-v1',
    global_model_id: row.global_model_id,
    app_id: row.app_id,
    source_id: row.source_id,
    upstream_model_id: row.upstream_model_id,
    upstream_model: row.upstream_model || '',
    endpoint_path: row.endpoint_path || '/chat/completions',
    api_type: row.api_type || 'openai-chat-completions',
    execution_mode: row.execution_mode,
    request_overrides: objectValue(row.request_overrides),
    request_match: objectValue(row.request_match),
    adapter_config_json: objectValue(row.adapter_config_json),
    source_active: row.source_active,
    route_active: row.route_active,
    upstream_active: row.upstream_active,
    cost_version: row.cost_version ? objectValue(row.cost_version) as AiExecutionCandidate['cost_version'] : null,
  };
}

@Injectable()
export class AiExecutionPlanResolverService {
  private readonly logger = new Logger(AiExecutionPlanResolverService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly revisions: AiConfigurationRevisionService,
    private readonly priceBooks: AiPriceBookService,
  ) {}

  async resolve(input: {
    app_id: string;
    model_key: string;
    capability?: string;
    payload?: Record<string, unknown>;
    mode?: 'legacy' | 'shadow' | 'enforced';
    billing_intent?: AiBillingIntent;
    allowed_route_keys?: string[];
    now?: Date;
  }): Promise<AiExecutionPlan> {
    const now = input.now || new Date();
    const billingIntent = input.billing_intent || 'customer_billed';
    const product = await this.findProduct(
      input.app_id,
      input.model_key,
      input.capability,
      billingIntent === 'internal_non_billable',
    );
    if (!product) throw new Error(`AI product model ${input.model_key} not found`);
    const variant = normalizeRequestVariant(product.capability, input.payload || {}, product.model_key);
    const mode = input.mode || await this.revisions.resolveMode(input.app_id);
    const revision = await this.revisions.getActiveRevisionNumber();
    if (mode === 'enforced' && revision === null) {
      throw new Error('AI configuration revision is not active');
    }
    const sellPrice = await this.priceBooks.resolveSellPrice(product.id, now);
    if (mode === 'enforced' && billingIntent === 'customer_billed' && !sellPrice) {
      throw new Error(`AI product ${product.model_key} has no active sell price`);
    }
    const routes = await this.loadRoutes(input.app_id, product.id, now);
    const allowedRouteKeys = input.allowed_route_keys?.length
      ? new Set(input.allowed_route_keys.map((value) => String(value || '').trim()).filter(Boolean))
      : null;
    const matched = routes.filter((route) =>
      route.route_active
      && route.source_active
      && (!allowedRouteKeys || allowedRouteKeys.has(route.route_key))
      && requestVariantMatches(variant, route.request_match),
    );
    const groups = new Map<string, AiExecutionCandidate[]>();
    for (const route of matched) {
      const group = groups.get(route.variant_key) || [];
      group.push(route);
      groups.set(route.variant_key, group);
    }
    const groupEntries = Array.from(groups.entries())
      .map(([variantKey, candidates]) => ({
        variantKey,
        candidates: candidates.sort((left, right) => left.sort_order - right.sort_order),
        priority: Math.max(...candidates.map((candidate) => candidate.match_priority)),
      }))
      .sort((left, right) => right.priority - left.priority || left.variantKey.localeCompare(right.variantKey));
    const warnings: string[] = [];
    if (groupEntries.length > 1 && groupEntries[0].priority === groupEntries[1].priority) {
      warnings.push(`ambiguous variant match at priority ${groupEntries[0].priority}`);
    }
    const selected = groupEntries[0] || null;
    if (!selected) warnings.push('no matching variant group');
    const candidates = selected?.candidates || [];
    const executable = candidates.filter((candidate) =>
      candidate.route_active && candidate.source_active && candidate.upstream_model_id && candidate.upstream_active !== false && candidate.cost_version,
    );
    if (mode === 'enforced' && (!selected || warnings.some((warning) => warning.startsWith('ambiguous')) || !executable.length)) {
      throw new Error(`AI execution plan is not executable for ${product.model_key}: ${warnings.join('; ') || 'missing candidate'}`);
    }
    const planCore = {
      schema_version: 'ai-execution-plan-v1' as const,
      mode,
      billing_intent: billingIntent,
      configuration_revision: revision,
      product: {
        global_model_id: product.id,
        model_key: product.model_key,
        display_name: product.display_name,
        capability: product.capability,
      },
      variant,
      sell_price: sellPrice,
      candidates: mode === 'enforced' ? executable : candidates,
      selected_variant_key: selected?.variantKey || null,
      warnings,
    };
    return { ...planCore, plan_hash: hashStableJson(planCore) };
  }

  async compareWithLegacy(input: {
    app_id: string;
    model_key: string;
    capability?: string;
    payload?: Record<string, unknown>;
    legacy_route_key?: string | null;
    legacy_points?: number | null;
  }) {
    const plan = await this.resolve({ ...input, mode: 'shadow' });
    const selected = plan.candidates.find((candidate) => candidate.variant_key === plan.selected_variant_key) || null;
    return {
      plan_hash: plan.plan_hash,
      variant_hash: plan.variant.hash,
      legacy_route_key: input.legacy_route_key || null,
      shadow_route_key: selected?.route_key || null,
      route_match: (input.legacy_route_key || null) === (selected?.route_key || null),
      legacy_points: input.legacy_points ?? null,
      shadow_sell_price_version_id: plan.sell_price?.id || null,
      warnings: plan.warnings,
    };
  }

  private async findProduct(
    appId: string,
    modelKey: string,
    capability?: string,
    includeHidden = false,
  ): Promise<ProductRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<ProductRow[]>(
      `SELECT m.id, m.model_key, m.display_name, m.capability, m.execution_mode,
              m.is_visible, COALESCE(v.is_visible, true) AS app_is_visible
         FROM ai_global_models m
         LEFT JOIN ai_app_model_visibility v
           ON v.app_id = $1::uuid AND v.global_model_id = m.id
        WHERE m.model_key = $2
          AND m.is_active = true
          AND ($3::text IS NULL OR m.capability = $3)
          AND ($4::boolean = true OR (m.is_visible = true AND COALESCE(v.is_visible, true) = true))
        ORDER BY m.is_default DESC, m.updated_at DESC
        LIMIT 1`,
      appId,
      String(modelKey || '').trim(),
      capability ? String(capability).trim().toLowerCase() : null,
      includeHidden,
    );
    return rows[0] || null;
  }

  private async loadRoutes(appId: string, globalModelId: string, at: Date): Promise<AiExecutionCandidate[]> {
    const query = `
      WITH app_routes AS (
        SELECT r.id, r.route_key, r.global_model_id, r.app_id, r.source_id, r.is_active,
               r.variant_key, r.match_priority, r.sort_order, r.contract_version,
               r.upstream_model_id, r.upstream_model, r.endpoint_path, r.api_type,
               r.execution_mode, r.request_overrides, r.request_match, r.adapter_config_json,
               s.is_active AS source_active,
               u.is_active AS upstream_active,
               cv.cost_version
          FROM ai_model_source_routes r
          JOIN ai_global_sources s ON s.id = r.source_id
          LEFT JOIN ai_upstream_models u ON u.id = r.upstream_model_id
          LEFT JOIN LATERAL (
            SELECT jsonb_build_object(
              'id', c.id, 'upstream_model_id', c.upstream_model_id, 'version', c.version,
              'status', c.status, 'valid_from', c.valid_from, 'valid_to', c.valid_to,
              'currency', c.currency, 'rates_json', c.rates_json,
              'source_snapshot_json', c.source_snapshot_json, 'content_hash', c.content_hash,
              'reason', c.reason, 'actor_user_id', c.actor_user_id
            ) AS cost_version
              FROM ai_upstream_cost_versions c
             WHERE c.upstream_model_id = r.upstream_model_id
               AND c.status IN ('active', 'scheduled')
               AND c.valid_from <= $3::timestamptz
               AND (c.valid_to IS NULL OR c.valid_to > $3::timestamptz)
             ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END, c.valid_from DESC, c.version DESC
             LIMIT 1
          ) cv ON true
         WHERE r.app_id = $1::uuid AND r.global_model_id = $2::uuid
      ), global_routes AS (
        SELECT r.id, r.route_key, r.global_model_id, r.app_id, r.source_id, r.is_active,
               r.variant_key, r.match_priority, r.sort_order, r.contract_version,
               r.upstream_model_id, r.upstream_model, r.endpoint_path, r.api_type,
               r.execution_mode, r.request_overrides, r.request_match, r.adapter_config_json,
               s.is_active AS source_active,
               u.is_active AS upstream_active,
               cv.cost_version
          FROM ai_model_source_routes r
          JOIN ai_global_sources s ON s.id = r.source_id
          LEFT JOIN ai_upstream_models u ON u.id = r.upstream_model_id
          LEFT JOIN LATERAL (
            SELECT jsonb_build_object(
              'id', c.id, 'upstream_model_id', c.upstream_model_id, 'version', c.version,
              'status', c.status, 'valid_from', c.valid_from, 'valid_to', c.valid_to,
              'currency', c.currency, 'rates_json', c.rates_json,
              'source_snapshot_json', c.source_snapshot_json, 'content_hash', c.content_hash,
              'reason', c.reason, 'actor_user_id', c.actor_user_id
            ) AS cost_version
              FROM ai_upstream_cost_versions c
             WHERE c.upstream_model_id = r.upstream_model_id
               AND c.status IN ('active', 'scheduled')
               AND c.valid_from <= $3::timestamptz
               AND (c.valid_to IS NULL OR c.valid_to > $3::timestamptz)
             ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END, c.valid_from DESC, c.version DESC
             LIMIT 1
          ) cv ON true
         WHERE r.app_id IS NULL AND r.global_model_id = $2::uuid
      )
      SELECT id AS route_id, route_key, global_model_id, app_id, source_id,
             is_active AS route_active, source_active, variant_key, match_priority,
             sort_order, contract_version, upstream_model_id, upstream_model,
             upstream_active, endpoint_path, api_type, execution_mode, request_overrides,
             request_match, adapter_config_json, cost_version
        FROM app_routes
       WHERE EXISTS (SELECT 1 FROM app_routes)
      UNION ALL
      SELECT id AS route_id, route_key, global_model_id, app_id, source_id,
             is_active AS route_active, source_active, variant_key, match_priority,
             sort_order, contract_version, upstream_model_id, upstream_model,
             upstream_active, endpoint_path, api_type, execution_mode, request_overrides,
             request_match, adapter_config_json, cost_version
        FROM global_routes
       WHERE NOT EXISTS (SELECT 1 FROM app_routes)
       ORDER BY match_priority DESC, sort_order ASC, route_id ASC`;
    const rows = await this.prisma.$queryRawUnsafe<RouteRow[]>(query, appId, globalModelId, at);
    return rows.map(mapCandidate);
  }
}
