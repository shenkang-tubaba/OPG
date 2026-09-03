import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';

type LegacyModelRow = {
  id: string;
  model_key: string;
  display_name: string;
  capability: string;
  execution_mode: string;
  pricing_mode: string;
  rmb_per_mtoken: unknown;
  rmb_per_call: unknown;
  rmb_per_minute: unknown;
  input_rmb_per_mtoken: unknown;
  cached_input_rmb_per_mtoken: unknown;
  cache_write_5m_rmb_per_mtoken: unknown;
  cache_write_1h_rmb_per_mtoken: unknown;
  output_rmb_per_mtoken: unknown;
  points_per_mtoken: unknown;
  points_per_call: unknown;
  points_per_minute: unknown;
  points_input_per_mtoken: unknown;
  points_cached_input_per_mtoken: unknown;
  points_cache_write_5m_per_mtoken: unknown;
  points_cache_write_1h_per_mtoken: unknown;
  points_output_per_mtoken: unknown;
  default_source_id: string;
  upstream_model: string;
  request_overrides: unknown;
  generation_schema: unknown;
  model_aliases: unknown;
  is_active: boolean;
};

type LegacyRouteRow = {
  id: string;
  app_id: string | null;
  global_model_id: string;
  source_id: string;
  upstream_model_id: string | null;
  route_key: string;
  upstream_model: string | null;
  endpoint_path: string | null;
  api_type: string | null;
  request_overrides: unknown;
  request_match: unknown;
  execution_mode: string | null;
  is_active: boolean;
};

type ExistingUpstreamRow = { id: string; content_hash?: string };

type UpstreamPlan = {
  sourceId: string;
  upstreamModel: string;
  capability: string;
  billingScope: string;
  routes: LegacyRouteRow[];
  models: Map<string, LegacyModelRow>;
  routeCostBooks: Map<string, Record<string, unknown> | null>;
};

type ResolvedLegacyCost =
  | { status: 'missing'; modelIds: string[] }
  | { status: 'conflict'; modelIds: string[] }
  | { status: 'resolved'; modelIds: string[]; rates: Record<string, number>; contentHash: string };

export type BackfillOptions = {
  dryRun: boolean;
  /**
   * Populate only the new upstream catalog and additive route references.
   * This is the compatibility-safe mode for databases still served by legacy
   * code: it deliberately does not create price versions or alter legacy
   * route fields.
   */
  catalogOnly?: boolean;
  appId?: string;
  productId?: string;
  resumeFrom?: string;
  pointsPerYuan?: number;
};

export type BackfillReport = {
  generated_at: string;
  dry_run: boolean;
  filters: BackfillOptions;
  summary: {
    products: number;
    routes: number;
    upstreams_created: number;
    routes_linked: number;
    sell_versions_created: number;
    cost_versions_created: number;
    conflicts: number;
    skipped: number;
    warnings: number;
  };
  items: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  critical_mappings: Array<Record<string, unknown>>;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
}

function preferNonZeroRate(primary: unknown, fallback: unknown): number {
  return numberValue(primary) || numberValue(fallback);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

type LegacyImageRate = {
  key: string;
  request_match: Record<string, unknown>;
  preferred_route_key: string | null;
  sell: { rmb: number; points: number };
  cost_rmb: number;
};

type LegacyVideoRate = {
  key: string;
  request_match: Record<string, unknown>;
  sell: { rmb: number; points: number };
  cost_rmb: number;
};

function pointsToRmb(points: number, pointsPerYuan: number): number {
  return points > 0 && pointsPerYuan > 0 ? points / pointsPerYuan : 0;
}

function normalizeImageQuality(value: string): string {
  const quality = value.trim().toLowerCase();
  if (quality === 'standard' || quality === 'normal') return 'medium';
  if (quality === 'hd') return 'high';
  return quality || 'medium';
}

function normalizeImageResolution(value: string): string {
  const raw = value.trim().toLowerCase().replace(/\s+/g, '').replace(/×/g, 'x');
  if (raw === '1024' || raw === '1024x1024') return '1k';
  if (raw === '2048' || raw === '2048x2048') return '2k';
  if (raw === '4096' || raw === '4096x4096') return '4k';
  return raw;
}

function normalizeVideoResolution(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '').replace(/×/g, 'x');
}

function legacyImageRates(model: LegacyModelRow, pointsPerYuan: number): LegacyImageRate[] {
  const pricing = objectValue(objectValue(model.request_overrides).pricing);
  const matrix = objectValue(pricing.image_quality_resolution_rates || pricing.image_resolution_rates);
  const entries: LegacyImageRate[] = [];
  for (const [rawQuality, resolutions] of Object.entries(matrix)) {
    for (const [rawResolution, rateValue] of Object.entries(objectValue(resolutions))) {
      const rate = objectValue(rateValue);
      const quality = normalizeImageQuality(rawQuality);
      const resolution = normalizeImageResolution(rawResolution);
      const points = numberValue(rate.points_per_call ?? rate.points ?? rate.sell_points_per_call);
      const explicitSellRmb = numberValue(rate.sell_rmb_per_call ?? rate.price_rmb_per_call ?? rate.rmb_per_call);
      const cost = numberValue(rate.cost_rmb_per_call ?? rate.upstream_cost_rmb_per_call);
      entries.push({
        key: `image:${quality}:${resolution}`,
        request_match: { qualities: [quality], resolutions: [resolution] },
        preferred_route_key: String(rate.preferred_route_key || '').trim() || null,
        sell: { rmb: explicitSellRmb || pointsToRmb(points, pointsPerYuan), points },
        cost_rmb: cost,
      });
    }
  }
  return entries;
}

function legacyVideoRates(model: LegacyModelRow, pointsPerYuan: number): LegacyVideoRate[] {
  const pricing = objectValue(objectValue(model.request_overrides).pricing);
  const matrix = objectValue(pricing.video_resolution_rates);
  return Object.entries(matrix).flatMap(([rawResolution, rawRate]) => {
    const rate = objectValue(rawRate);
    const resolution = normalizeVideoResolution(rawResolution);
    if (!resolution) return [];
    const points = numberValue(rate.points_per_second ?? rate.points ?? rate.sell_points_per_second);
    const explicitSellRmb = numberValue(rate.sell_rmb_per_second ?? rate.price_rmb_per_second ?? rate.rmb_per_second);
    const cost = numberValue(rate.cost_rmb_per_second ?? rate.upstream_cost_rmb_per_second);
    return [{
      key: `video:${resolution}`,
      request_match: { resolutions: [resolution] },
      sell: { rmb: explicitSellRmb || pointsToRmb(points, pointsPerYuan), points },
      cost_rmb: cost,
    }];
  });
}

export function buildLegacySellRates(model: LegacyModelRow, pointsPerYuan = 100) {
  const imageRates = model.capability === 'image' ? legacyImageRates(model, pointsPerYuan) : [];
  if (imageRates.length) {
    return {
      dimension_rates: imageRates
        .filter((rate) => rate.sell.points > 0 || rate.sell.rmb > 0)
        .map((rate) => ({
          key: rate.key,
          request_match: rate.request_match,
          rates: { image: rate.sell },
        })),
    };
  }
  const videoRates = model.capability === 'video' ? legacyVideoRates(model, pointsPerYuan) : [];
  if (videoRates.length) {
    return {
      dimension_rates: videoRates
        .filter((rate) => rate.sell.points > 0 || rate.sell.rmb > 0)
        .map((rate) => ({
          key: rate.key,
          request_match: rate.request_match,
          rates: { second: rate.sell },
        })),
    };
  }
  const inputPoints = preferNonZeroRate(model.points_input_per_mtoken, model.points_per_mtoken);
  const cachedInputPoints = numberValue(model.points_cached_input_per_mtoken);
  const cacheWrite5mPoints = numberValue(model.points_cache_write_5m_per_mtoken);
  const cacheWrite1hPoints = numberValue(model.points_cache_write_1h_per_mtoken);
  const outputPoints = preferNonZeroRate(model.points_output_per_mtoken, model.points_per_mtoken);
  const callPoints = numberValue(model.points_per_call);
  const minutePoints = numberValue(model.points_per_minute);
  return {
    input: { rmb: pointsToRmb(inputPoints, pointsPerYuan), points: inputPoints },
    cached_input: { rmb: pointsToRmb(cachedInputPoints, pointsPerYuan), points: cachedInputPoints },
    cache_write_5m: { rmb: pointsToRmb(cacheWrite5mPoints, pointsPerYuan), points: cacheWrite5mPoints },
    cache_write_1h: { rmb: pointsToRmb(cacheWrite1hPoints, pointsPerYuan), points: cacheWrite1hPoints },
    output: { rmb: pointsToRmb(outputPoints, pointsPerYuan), points: outputPoints },
    call: { rmb: pointsToRmb(callPoints, pointsPerYuan), points: callPoints },
    minute: { rmb: pointsToRmb(minutePoints, pointsPerYuan), points: minutePoints },
  };
}

export function buildLegacyCostRates(model: LegacyModelRow) {
  return {
    input: preferNonZeroRate(model.input_rmb_per_mtoken, model.rmb_per_mtoken),
    cached_input: numberValue(model.cached_input_rmb_per_mtoken),
    cache_write_5m: numberValue(model.cache_write_5m_rmb_per_mtoken),
    cache_write_1h: numberValue(model.cache_write_1h_rmb_per_mtoken),
    output: preferNonZeroRate(model.output_rmb_per_mtoken, model.rmb_per_mtoken),
    call: numberValue(model.rmb_per_call),
    minute: numberValue(model.rmb_per_minute),
  };
}

export function buildLegacyRouteCostBook(model: LegacyModelRow, route: LegacyRouteRow): Record<string, unknown> | null {
  const imageRates = model.capability === 'image' ? legacyImageRates(model, 0) : [];
  if (imageRates.length) {
    const routeRates = imageRates.filter((rate) => rate.preferred_route_key === route.route_key && rate.cost_rmb > 0);
    if (!routeRates.length) return null;
    const costs = new Set(routeRates.map((rate) => String(rate.cost_rmb)));
    if (costs.size === 1) return { image: { rmb: routeRates[0].cost_rmb } };
    return {
      dimension_rates: routeRates.map((rate) => ({
        key: rate.key,
        request_match: rate.request_match,
        rates: { image: { rmb: rate.cost_rmb } },
      })),
    };
  }
  const videoRates = model.capability === 'video' ? legacyVideoRates(model, 0) : [];
  if (videoRates.length) {
    const costs = videoRates.filter((rate) => rate.cost_rmb > 0);
    if (!costs.length) return null;
    return {
      dimension_rates: costs.map((rate) => ({
        key: rate.key,
        request_match: rate.request_match,
        rates: { second: { rmb: rate.cost_rmb } },
      })),
    };
  }
  const rates = buildLegacyCostRates(model);
  return hasPositiveRate(rates) ? rates : null;
}

function hasPositiveRate(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasPositiveRate(item));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((item) => hasPositiveRate(item));
  return numberValue(value) > 0;
}

export function resolveLegacyCost(models: LegacyModelRow[]): ResolvedLegacyCost {
  const candidates = models
    .map((model) => ({ model, rates: buildLegacyCostRates(model) }))
    .filter(({ rates }) => hasPositiveRate(rates));
  if (!candidates.length) return { status: 'missing', modelIds: models.map((model) => model.id) };

  const distinct = new Map<string, { rates: Record<string, number>; modelIds: string[] }>();
  for (const candidate of candidates) {
    const hash = contentHash(candidate.rates);
    const existing = distinct.get(hash);
    if (existing) existing.modelIds.push(candidate.model.id);
    else distinct.set(hash, { rates: candidate.rates, modelIds: [candidate.model.id] });
  }
  if (distinct.size !== 1) return { status: 'conflict', modelIds: candidates.map(({ model }) => model.id) };
  const [hash, resolved] = Array.from(distinct.entries())[0];
  return { status: 'resolved', contentHash: hash, rates: resolved.rates, modelIds: resolved.modelIds };
}

function resolveUpstreamPlanCost(plan: UpstreamPlan): ResolvedLegacyCost {
  const candidates = Array.from(plan.routeCostBooks.entries())
    .filter(([, rates]): rates is Record<string, unknown> => Boolean(rates && hasPositiveRate(rates)))
    .map(([routeId, rates]) => ({ routeId, rates }));
  if (!candidates.length) {
    return { status: 'missing', modelIds: Array.from(plan.models.keys()) };
  }
  const distinct = new Map<string, { rates: Record<string, number>; modelIds: string[] }>();
  for (const candidate of candidates) {
    const hash = contentHash(candidate.rates);
    const existing = distinct.get(hash);
    if (existing) existing.modelIds.push(candidate.routeId);
    else distinct.set(hash, { rates: candidate.rates as Record<string, number>, modelIds: [candidate.routeId] });
  }
  if (distinct.size !== 1) {
    return { status: 'conflict', modelIds: candidates.map((candidate) => candidate.routeId) };
  }
  const [hash, resolved] = Array.from(distinct.entries())[0];
  return { status: 'resolved', contentHash: hash, rates: resolved.rates, modelIds: resolved.modelIds };
}

export function routeVariant(route: LegacyRouteRow, capability: string, model?: LegacyModelRow) {
  const match = objectValue(route.request_match);
  const key = route.route_key.toLowerCase();
  if (capability === 'image') {
    const configuredRate = model
      ? legacyImageRates(model, 0).find((rate) => rate.preferred_route_key === route.route_key)
      : null;
    const configuredResolution = Array.isArray(configuredRate?.request_match.resolutions)
      ? String(configuredRate?.request_match.resolutions[0] || '')
      : null;
    const resolution = configuredResolution || (key.includes('4k') || key.includes('4096') ? '4k'
      : key.includes('2k') || key.includes('2048') ? '2k'
        : key.includes('1k') || key.includes('1024') ? '1k' : null);
    return {
      variant_key: resolution ? `image:${resolution}` : 'image:default',
      request_match: resolution ? { resolutions: [resolution] } : match,
    };
  }
  if (capability === 'video') {
    const inputs = Array.isArray(match.input_kinds) ? match.input_kinds.map(String) : [];
    const modes = Array.isArray(match.video_modes) ? match.video_modes.map(String) : [];
    const resolutions = Array.isArray(match.resolutions) ? match.resolutions.map(String) : [];
    const suffix = [inputs[0] || 'any', modes[0] || 'any', resolutions[0] || 'any'].join(':');
    return { variant_key: `video:${suffix}`, request_match: match };
  }
  return { variant_key: 'default', request_match: match };
}

function adapterConfig(route: LegacyRouteRow) {
  const overrides = objectValue(route.request_overrides);
  const allowed = ['runninghub_schema', 'provider_schema', 'request_template', 'response_mapping', 'async', 'execution_mode', 'contract_version'];
  return allowed.reduce<Record<string, unknown>>((result, key) => {
    if (overrides[key] !== undefined) result[key] = overrides[key];
    return result;
  }, {});
}

export function parseArgs(argv: string[]): BackfillOptions {
  const result: BackfillOptions = { dryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') result.dryRun = false;
    if (arg === '--dry-run') result.dryRun = true;
    if (arg === '--catalog-only') result.catalogOnly = true;
    if (arg === '--app') result.appId = argv[++index];
    if (arg === '--product') result.productId = argv[++index];
    if (arg === '--resume-from') result.resumeFrom = argv[++index];
    if (arg === '--points-per-yuan') result.pointsPerYuan = numberValue(argv[++index]);
  }
  return result;
}

export async function runBackfill(prisma: PrismaClient, options: BackfillOptions): Promise<BackfillReport> {
  const report: BackfillReport = {
    generated_at: new Date().toISOString(),
    dry_run: options.dryRun,
    filters: options,
    summary: { products: 0, routes: 0, upstreams_created: 0, routes_linked: 0, sell_versions_created: 0, cost_versions_created: 0, conflicts: 0, skipped: 0, warnings: 0 },
    items: [],
    conflicts: [],
    warnings: [],
    critical_mappings: [],
  };
  const productClauses = [options.catalogOnly ? 'true' : 'm.is_active = true'];
  const productValues: unknown[] = [];
  if (options.productId) { productValues.push(options.productId); productClauses.push(`m.id = $${productValues.length}::uuid`); }
  const models = await prisma.$queryRawUnsafe<LegacyModelRow[]>(
    `SELECT m.* FROM ai_global_models m WHERE ${productClauses.join(' AND ')} ORDER BY m.id`,
    ...productValues,
  );
  const configuredPointRates = options.pointsPerYuan && options.pointsPerYuan > 0
    ? [options.pointsPerYuan]
    : await prisma.$queryRawUnsafe<Array<{ points_per_yuan: unknown }>>(
      `SELECT DISTINCT points_per_yuan
         FROM app_ai_points_settings
        WHERE points_per_yuan IS NOT NULL AND points_per_yuan > 0`,
    ).then((rows) => rows.map((row) => numberValue(row.points_per_yuan)).filter((value) => value > 0));
  const uniquePointRates = Array.from(new Set(configuredPointRates));
  const pointsPerYuan = uniquePointRates.length === 1 ? uniquePointRates[0] : null;
  if (!pointsPerYuan) {
    report.conflicts.push({
      code: uniquePointRates.length ? 'ambiguous-points-per-yuan' : 'missing-points-per-yuan',
      values: uniquePointRates,
    });
    report.summary.conflicts += 1;
  }
  const routes = await prisma.$queryRawUnsafe<LegacyRouteRow[]>(
    `SELECT r.id, r.app_id, r.global_model_id, r.source_id, r.upstream_model_id, r.route_key, r.upstream_model,
            r.endpoint_path, r.api_type, r.request_overrides, r.request_match, r.execution_mode, r.is_active
       FROM ai_model_source_routes r
      WHERE ($1::uuid IS NULL OR r.app_id = $1::uuid OR r.app_id IS NULL)
      ORDER BY r.global_model_id, r.app_id NULLS FIRST, r.sort_order, r.id`,
    options.appId || null,
  );
  report.summary.products = models.length;
  report.summary.routes = routes.length;
  const modelById = new Map(models.map((model) => [model.id, model]));
  for (const model of models) {
    const normalizedKey = model.model_key.toLowerCase();
    if (normalizedKey.includes('qwen3.7') || normalizedKey.includes('qwen-3.7') || normalizedKey.includes('qwen3_7')) {
      report.critical_mappings.push({ product_model_id: model.id, model_key: model.model_key, display_name: model.display_name, expected_upstream: 'GPT 5.6 Luna' });
    }
    if (normalizedKey.includes('gpt-5.5') || normalizedKey.includes('gpt5.5') || normalizedKey.includes('gpt_5_5')) {
      report.critical_mappings.push({ product_model_id: model.id, model_key: model.model_key, display_name: model.display_name, expected_upstream: 'GPT 5.6 Terra' });
    }
  }
  const upstreamPlan = new Map<string, UpstreamPlan>();
  for (const route of routes) {
    const model = modelById.get(route.global_model_id);
    if (!model || (options.resumeFrom && model.id < options.resumeFrom)) { report.summary.skipped += 1; continue; }
    const upstreamModel = String(route.upstream_model || model.upstream_model || '').trim();
    if (!upstreamModel) {
      report.warnings.push({ code: 'missing-upstream-model', route_id: route.id, model_id: model.id, model_key: model.model_key });
      report.summary.warnings += 1;
      report.summary.skipped += 1;
      continue;
    }
    const routeCostBook = buildLegacyRouteCostBook(model, route);
    // The identity is the actual supplier model, not a public product's legacy
    // price facts. One supplier model can be selected by many product routes.
    const billingScope = 'default';
    const identity = `${route.source_id}\u0000${upstreamModel}\u0000${model.capability}`;
    const existing = upstreamPlan.get(identity);
    if (!existing) {
      upstreamPlan.set(identity, {
        sourceId: route.source_id,
        upstreamModel,
        capability: model.capability,
        billingScope,
        routes: [],
        models: new Map(),
        routeCostBooks: new Map(),
      });
    }
    const plan = upstreamPlan.get(identity)!;
    plan.routes.push(route);
    plan.models.set(model.id, model);
    plan.routeCostBooks.set(route.id, routeCostBook);
  }

  const costResolutions = new Map<string, ResolvedLegacyCost>();
  for (const [identity, plan] of upstreamPlan) {
    costResolutions.set(identity, resolveUpstreamPlanCost(plan));
  }

  if (options.catalogOnly || !options.dryRun) {
    for (const [identity, plan] of upstreamPlan) {
      const upstreamKey = `legacy:${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`;
      const planModels = Array.from(plan.models.values());
      const costResolution = costResolutions.get(identity);
      const item: Record<string, unknown> = {
        identity, upstream_key: upstreamKey, source_id: plan.sourceId, upstream_model: plan.upstreamModel,
        capability: plan.capability, billing_scope: plan.billingScope,
        route_ids: plan.routes.map((route) => route.id), model_ids: planModels.map((model) => model.id),
      };
      if (planModels.some((model) => !hasPositiveRate(buildLegacySellRates(model, pointsPerYuan || 0)))) {
        report.warnings.push({ code: 'missing-sell-rates', identity, model_ids: planModels.filter((model) => !hasPositiveRate(buildLegacySellRates(model, pointsPerYuan || 0))).map((model) => model.id) });
        report.summary.warnings += 1;
      }
      if (Array.from(plan.routeCostBooks.values()).every((rates) => !rates || !hasPositiveRate(rates))) {
        report.warnings.push({ code: 'missing-cost-rates', identity, model_ids: planModels.map((model) => model.id) });
        report.summary.warnings += 1;
      }
      if (costResolution?.status === 'conflict') {
        report.conflicts.push({ code: 'cost-conflict', identity, model_ids: costResolution.modelIds });
        report.summary.conflicts += 1;
        continue;
      }
      if (!options.dryRun) {
        await prisma.$transaction(async (tx) => {
          const upstreamRows = await tx.$queryRawUnsafe<ExistingUpstreamRow[]>(
            `INSERT INTO ai_upstream_models (source_id, upstream_key, upstream_model, capability, billing_scope, metadata_json, created_by_user_id, updated_by_user_id)
             VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, NULL, NULL)
             ON CONFLICT (source_id, upstream_model, capability, billing_scope) DO UPDATE
               SET
                   metadata_json = ai_upstream_models.metadata_json || EXCLUDED.metadata_json,
                   updated_at = now()
             RETURNING id`,
            plan.sourceId, upstreamKey, plan.upstreamModel, plan.capability, plan.billingScope,
            JSON.stringify({ legacy_backfill: true, billing_scope_source: 'supplier-model-capability' }),
          );
          const upstreamId = upstreamRows[0]?.id;
          if (!upstreamId) throw new Error(`upstream upsert failed for ${identity}`);
          report.summary.upstreams_created += 1;
          for (const route of plan.routes) {
            const variant = routeVariant(route, plan.capability, modelById.get(route.global_model_id));
            const linked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `UPDATE ai_model_source_routes
                  SET upstream_model_id = $1::uuid,
                      variant_key = $2,
                      request_match = $3::jsonb,
                      match_priority = $4,
                      adapter_config_json = $5::jsonb,
                      contract_version = $6
                WHERE id = $7::uuid
                  AND (
                    upstream_model_id IS DISTINCT FROM $1::uuid
                    OR variant_key IS DISTINCT FROM $2
                    OR request_match IS DISTINCT FROM $3::jsonb
                    OR match_priority IS DISTINCT FROM $4
                    OR adapter_config_json IS DISTINCT FROM $5::jsonb
                    OR contract_version IS DISTINCT FROM $6
                  )
              RETURNING id`,
              upstreamId, variant.variant_key, JSON.stringify(variant.request_match),
              variant.request_match && Object.keys(variant.request_match).length ? 100 : 0,
              JSON.stringify(adapterConfig(route)),
              String(objectValue(route.request_overrides).contract_version || 'legacy-v1'), route.id,
            );
            report.summary.routes_linked += linked.length;
            route.upstream_model_id = upstreamId;
          }
        });
      }
      report.items.push(item);
    }
    if (options.catalogOnly) return report;
  }

  if (!pointsPerYuan) {
    return report;
  }

  const sellPlans = models.filter((model) => !options.resumeFrom || model.id >= options.resumeFrom).filter((model) => {
    const sellRates = buildLegacySellRates(model, pointsPerYuan);
    if (hasPositiveRate(sellRates)) return true;
    report.conflicts.push({ code: 'missing-sell-rates', model_id: model.id, model_key: model.model_key });
    report.summary.conflicts += 1;
    report.summary.skipped += 1;
    return false;
  });
  const costPlans: Array<{ identity: string; plan: UpstreamPlan; upstreamModelId: string; resolution: Extract<ResolvedLegacyCost, { status: 'resolved' }> }> = [];
  for (const [identity, plan] of upstreamPlan) {
    const resolution = costResolutions.get(identity) || resolveUpstreamPlanCost(plan);
    if (resolution.status === 'missing') {
      report.conflicts.push({ code: 'missing-cost-rates', identity, model_ids: resolution.modelIds });
      report.summary.conflicts += 1;
      report.summary.skipped += 1;
      continue;
    }
    if (resolution.status === 'conflict') {
      report.conflicts.push({ code: 'cost-conflict', identity, model_ids: resolution.modelIds });
      report.summary.conflicts += 1;
      report.summary.skipped += 1;
      continue;
    }
    const upstreamModelIds = Array.from(new Set(plan.routes.map((route) => route.upstream_model_id).filter((id): id is string => Boolean(id))));
    if (upstreamModelIds.length !== 1) {
      report.conflicts.push({ code: upstreamModelIds.length ? 'ambiguous-upstream-link' : 'missing-upstream-link', identity, route_ids: plan.routes.map((route) => route.id), upstream_model_ids: upstreamModelIds });
      report.summary.conflicts += 1;
      report.summary.skipped += 1;
      continue;
    }
    costPlans.push({ identity, plan, upstreamModelId: upstreamModelIds[0], resolution });
  }
  for (const model of sellPlans) {
    const sellRates = buildLegacySellRates(model, pointsPerYuan);
    report.items.push({ kind: 'sell-price', model_id: model.id, model_key: model.model_key, sell_rate_hash: contentHash(sellRates) });
  }
  for (const costPlan of costPlans) {
    report.items.push({ kind: 'upstream-cost', identity: costPlan.identity, upstream_model_id: costPlan.upstreamModelId, upstream_model: costPlan.plan.upstreamModel, cost_rate_hash: costPlan.resolution.contentHash, source_model_ids: costPlan.resolution.modelIds });
  }
  if (options.dryRun) return report;

  await prisma.$transaction(async (tx) => {
    for (const model of sellPlans) {
      const sellRates = buildLegacySellRates(model, pointsPerYuan);
      const sellHash = contentHash(sellRates);
      const existingSell = await tx.$queryRawUnsafe<Array<{ id: string; status: string; reason: string | null }>>(
        `SELECT id, status, reason
           FROM ai_model_sell_price_versions
          WHERE global_model_id = $1::uuid AND app_id IS NULL AND content_hash = $2
          ORDER BY version DESC
          LIMIT 1`,
        model.id, sellHash,
      );
      if (existingSell[0]?.status === 'active') continue;
      const activeSell = await tx.$queryRawUnsafe<Array<{ id: string; reason: string | null }>>(
        `SELECT id, reason
           FROM ai_model_sell_price_versions
          WHERE global_model_id = $1::uuid AND app_id IS NULL
            AND status = 'active' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
          ORDER BY valid_from DESC, version DESC
          LIMIT 1`,
        model.id,
      );
      if (activeSell[0] && activeSell[0].reason !== 'legacy backfill') {
        report.conflicts.push({ code: 'manual-sell-price-present', model_id: model.id, model_key: model.model_key });
        report.summary.conflicts += 1;
        continue;
      }
      if (activeSell[0]) {
        await tx.$executeRawUnsafe(
          `UPDATE ai_model_sell_price_versions
              SET status = 'retired', valid_to = now()
            WHERE id = $1::uuid`,
          activeSell[0].id,
        );
      }
      const versionRows = await tx.$queryRawUnsafe<Array<{ version: number }>>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ai_model_sell_price_versions WHERE global_model_id = $1::uuid AND app_id IS NULL`,
        model.id,
      );
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO ai_model_sell_price_versions (global_model_id, app_id, version, status, valid_from, currency, rates_json, content_hash, reason)
         VALUES ($1::uuid, NULL, $2, 'active', now(), 'RMB', $3::jsonb, $4, 'legacy sell-price reconciliation') RETURNING id`,
        model.id, Number(versionRows[0]?.version || 1), JSON.stringify(sellRates), sellHash,
      );
      report.summary.sell_versions_created += inserted[0]?.id ? 1 : 0;
    }
    for (const costPlan of costPlans) {
      const existingCost = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        `SELECT id, status FROM ai_upstream_cost_versions WHERE upstream_model_id = $1::uuid AND content_hash = $2 ORDER BY version DESC LIMIT 1`,
        costPlan.upstreamModelId, costPlan.resolution.contentHash,
      );
      if (existingCost[0]?.status === 'active') continue;
      const activeCost = await tx.$queryRawUnsafe<Array<{ id: string; reason: string | null }>>(
        `SELECT id, reason
           FROM ai_upstream_cost_versions
          WHERE upstream_model_id = $1::uuid
            AND status = 'active' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
          ORDER BY valid_from DESC, version DESC
          LIMIT 1`,
        costPlan.upstreamModelId,
      );
      if (activeCost[0] && activeCost[0].reason !== 'legacy backfill') {
        report.conflicts.push({ code: 'manual-upstream-cost-present', identity: costPlan.identity, upstream_model_id: costPlan.upstreamModelId });
        report.summary.conflicts += 1;
        continue;
      }
      if (activeCost[0]) {
        await tx.$executeRawUnsafe(
          `UPDATE ai_upstream_cost_versions
              SET status = 'retired', valid_to = now()
            WHERE id = $1::uuid`,
          activeCost[0].id,
        );
      }
      const versionRows = await tx.$queryRawUnsafe<Array<{ version: number }>>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ai_upstream_cost_versions WHERE upstream_model_id = $1::uuid`,
        costPlan.upstreamModelId,
      );
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO ai_upstream_cost_versions (upstream_model_id, version, status, valid_from, currency, rates_json, source_snapshot_json, content_hash, reason)
         VALUES ($1::uuid, $2, 'active', now(), 'RMB', $3::jsonb, $4::jsonb, $5, 'legacy upstream-cost reconciliation') RETURNING id`,
        costPlan.upstreamModelId, Number(versionRows[0]?.version || 1), JSON.stringify(costPlan.resolution.rates),
        JSON.stringify({ source: 'ai_global_models', model_ids: costPlan.resolution.modelIds }), costPlan.resolution.contentHash,
      );
      report.summary.cost_versions_created += inserted[0]?.id ? 1 : 0;
    }
  });
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; use docs/production-database-access.md for production read-only access');
  const prisma = new PrismaClient();
  try {
    const report = await runBackfill(prisma, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!options.catalogOnly && report.summary.conflicts > 0) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
