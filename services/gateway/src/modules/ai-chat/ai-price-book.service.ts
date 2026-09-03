import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import {
  AiMeteredUsage,
  AiPriceBook,
  AiPriceDimensionRule,
  AiPriceRate,
  AiPriceVersionStatus,
  AiSellPriceVersion,
  AiUpstreamCostVersion,
  CanonicalRequestVariant,
  CustomerChargeQuote,
  UpstreamCostQuote,
} from './ai-product-decoupling.types';
import { hashStableJson, stableJson } from './ai-request-variant.normalizer';
import { selectAiPriceBook } from './ai-price-book.selection';

type RawSqlClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
};

type SellRow = {
  id: string;
  global_model_id: string;
  app_id: string | null;
  version: number;
  status: AiPriceVersionStatus;
  valid_from: Date;
  valid_to: Date | null;
  currency: string;
  rates_json: unknown;
  is_explicitly_free: boolean;
  content_hash: string;
  reason: string | null;
  actor_user_id: string | null;
};

type CostRow = Omit<SellRow, 'global_model_id' | 'app_id' | 'is_explicitly_free'> & {
  upstream_model_id: string;
  source_snapshot_json: unknown;
};

export type PriceVersionInput = {
  global_model_id: string;
  status?: AiPriceVersionStatus;
  /** Ends the currently effective version at valid_from before activating this one. */
  replace_active?: boolean;
  valid_from?: Date;
  valid_to?: Date | null;
  currency?: string;
  rates_json: AiPriceBook;
  is_explicitly_free?: boolean;
  reason?: string | null;
  actor_user_id?: string | null;
};

export type CostVersionInput = {
  upstream_model_id: string;
  status?: AiPriceVersionStatus;
  /** Ends the currently effective version at valid_from before activating this one. */
  replace_active?: boolean;
  valid_from?: Date;
  valid_to?: Date | null;
  currency?: string;
  rates_json: AiPriceBook;
  source_snapshot_json?: Record<string, unknown>;
  reason?: string | null;
  actor_user_id?: string | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toBook(value: unknown): AiPriceBook {
  return objectValue(value) as AiPriceBook;
}

function toSell(row: SellRow): AiSellPriceVersion {
  return {
    id: row.id,
    global_model_id: row.global_model_id,
    app_id: row.app_id,
    version: Number(row.version),
    status: row.status,
    valid_from: row.valid_from.toISOString(),
    valid_to: row.valid_to?.toISOString() || null,
    currency: row.currency,
    rates_json: toBook(row.rates_json),
    is_explicitly_free: row.is_explicitly_free,
    content_hash: row.content_hash,
    reason: row.reason,
    actor_user_id: row.actor_user_id,
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
    rates_json: toBook(row.rates_json),
    source_snapshot_json: objectValue(row.source_snapshot_json),
    content_hash: row.content_hash,
    reason: row.reason,
    actor_user_id: row.actor_user_id,
  };
}

function round(value: number, scale = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** scale;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function configuredRateValue(book: AiPriceBook, key: string, kind: 'rmb' | 'points'): number | null {
  const direct = book[key];
  const candidate = direct && typeof direct === 'object' && !Array.isArray(direct)
    ? (direct as AiPriceRate)[kind]
    : direct;
  const value = asNumber(candidate);
  if (value !== null) return value;
  const aliases = kind === 'rmb'
    ? [`rmb_${key}`, `rmb_per_${key}`, `unit_price_${key}`]
    : [`points_${key}`, `points_per_${key}`];
  for (const alias of aliases) {
    const aliasValue = asNumber(book[alias]);
    if (aliasValue !== null) return aliasValue;
  }
  return null;
}

function rateValue(book: AiPriceBook, key: string, kind: 'rmb' | 'points'): number {
  return configuredRateValue(book, key, kind) ?? 0;
}

function firstConfiguredRateValue(
  book: AiPriceBook,
  keys: string[],
  kind: 'rmb' | 'points',
): number {
  for (const key of keys) {
    const value = configuredRateValue(book, key, kind);
    if (value !== null) return value;
  }
  return 0;
}

function meterAmount(usage: AiMeteredUsage, key: keyof AiMeteredUsage): number {
  const value = Number(usage[key] || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function firstMeterAmount(usage: AiMeteredUsage, keys: Array<keyof AiMeteredUsage>): number {
  for (const key of keys) {
    const amount = meterAmount(usage, key);
    if (amount > 0) return amount;
  }
  return 0;
}

function calculate(book: AiPriceBook, usage: AiMeteredUsage, kind: 'rmb' | 'points'): number {
  const tokenScale = (key: string) => rateValue(book, key, kind) / 1_000_000;
  const firstTokenScale = (keys: string[]) => firstConfiguredRateValue(book, keys, kind) / 1_000_000;
  const cacheReadTokens = firstMeterAmount(usage, ['cache_read_tokens', 'cached_input_tokens']);
  const cacheWrite5mTokens = meterAmount(usage, 'cache_write_5m_tokens');
  const cacheWrite1hTokens = meterAmount(usage, 'cache_write_1h_tokens');
  const genericCacheWriteTokens = cacheWrite5mTokens > 0 || cacheWrite1hTokens > 0
    ? 0
    : firstMeterAmount(usage, ['cache_write_tokens', 'cache_creation_tokens']);
  let total = 0;
  total += meterAmount(usage, 'input_tokens') * tokenScale('input');
  total += cacheReadTokens * firstTokenScale(['cache_read', 'cached_input']);
  total += genericCacheWriteTokens * firstTokenScale(['cache_write', 'cache_creation']);
  total += cacheWrite5mTokens * firstTokenScale(['cache_write_5m', 'cache_write', 'cache_creation']);
  total += cacheWrite1hTokens * firstTokenScale(['cache_write_1h', 'cache_write', 'cache_creation']);
  total += meterAmount(usage, 'output_tokens') * tokenScale('output');
  total += meterAmount(usage, 'calls') * rateValue(book, 'call', kind);
  total += meterAmount(usage, 'minutes') * rateValue(book, 'minute', kind);
  total += meterAmount(usage, 'duration_seconds') * rateValue(book, 'second', kind);
  total += meterAmount(usage, 'images') * rateValue(book, 'image', kind);
  total += meterAmount(usage, 'characters') * rateValue(book, 'character', kind) / 1_000_000;
  return round(total);
}

type TokenPriceRange = {
  key: string;
  groupKey: string;
  min: number;
  max: number;
};

function priceNumber(value: unknown, label: string): void {
  if (value === null || value === undefined || value === '') return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BadRequestException(`${label} must be a finite non-negative number`);
  }
}

function validateRateValues(book: AiPriceBook, label: string): void {
  for (const [meter, raw] of Object.entries(book)) {
    if (meter === 'dimension_rates' || raw === null || raw === undefined) continue;
    if (typeof raw === 'number' || typeof raw === 'string') {
      priceNumber(raw, `${label}.${meter}`);
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException(`${label}.${meter} must be a price rate`);
    }
    const rate = raw as Record<string, unknown>;
    priceNumber(rate.rmb, `${label}.${meter}.rmb`);
    priceNumber(rate.points, `${label}.${meter}.points`);
  }
}

function tokenPriceRange(rule: AiPriceDimensionRule): TokenPriceRange | null {
  const match = rule.request_match || {};
  const tokenKey = Object.prototype.hasOwnProperty.call(match, 'request_input_tokens')
    ? 'request_input_tokens'
    : Object.prototype.hasOwnProperty.call(match, 'prompt_tokens')
      ? 'prompt_tokens'
      : null;
  if (!tokenKey) return null;
  const raw = match[tokenKey];
  let min: number;
  let max: number;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const range = raw as Record<string, unknown>;
    if (range.min === undefined && range.max === undefined) {
      throw new BadRequestException(`token price rule ${rule.key} requires min or max`);
    }
    min = range.min === undefined || range.min === null ? 0 : Number(range.min);
    max = range.max === undefined || range.max === null ? Number.POSITIVE_INFINITY : Number(range.max);
  } else {
    min = Number(raw);
    max = Number(raw);
  }
  if (!Number.isSafeInteger(min) || min < 0) {
    throw new BadRequestException(`token price rule ${rule.key} has an invalid min`);
  }
  if (max !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(max) || max < 0)) {
    throw new BadRequestException(`token price rule ${rule.key} has an invalid max`);
  }
  if (max < min) {
    throw new BadRequestException(`token price rule ${rule.key} has max below min`);
  }
  const remainingMatch = Object.fromEntries(
    Object.entries(match).filter(([key]) => key !== 'request_input_tokens' && key !== 'prompt_tokens'),
  );
  return { key: rule.key, groupKey: stableJson(remainingMatch), min, max };
}

function validateTokenPriceRanges(rules: AiPriceDimensionRule[]): void {
  const groups = new Map<string, TokenPriceRange[]>();
  for (const rule of rules) {
    const range = tokenPriceRange(rule);
    if (!range) continue;
    const group = groups.get(range.groupKey) || [];
    group.push(range);
    groups.set(range.groupKey, group);
  }
  for (const ranges of groups.values()) {
    ranges.sort((left, right) => left.min - right.min || left.max - right.max || left.key.localeCompare(right.key));
    if (ranges[0]?.min !== 0) {
      throw new BadRequestException(`token price rules must start at 0; first rule is ${ranges[0]?.key}`);
    }
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1];
      const current = ranges[index];
      if (current.min <= previous.max) {
        throw new BadRequestException(`token price rules overlap: ${previous.key} and ${current.key}`);
      }
      if (previous.max !== Number.POSITIVE_INFINITY && current.min !== previous.max + 1) {
        throw new BadRequestException(`token price rules have a gap: ${previous.key} and ${current.key}`);
      }
    }
  }
}

@Injectable()
export class AiPriceBookService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  static contentHash(rates: AiPriceBook): string {
    return hashStableJson(rates);
  }

  async resolveSellPrice(
    globalModelId: string,
    at = new Date(),
  ): Promise<AiSellPriceVersion | null> {
    const rows = await this.prisma.$queryRawUnsafe<SellRow[]>(
      `SELECT id, global_model_id, app_id, version, status, valid_from, valid_to,
              currency, rates_json, is_explicitly_free, content_hash, reason, actor_user_id
         FROM ai_model_sell_price_versions
        WHERE global_model_id = $1::uuid
          AND app_id IS NULL
          AND status IN ('active', 'scheduled')
          AND valid_from <= $2::timestamptz
          AND (valid_to IS NULL OR valid_to > $2::timestamptz)
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                 valid_from DESC, version DESC
        LIMIT 1`,
      globalModelId,
      at,
    );
    return rows[0] ? toSell(rows[0]) : null;
  }

  async listEffectiveSellPrices(
    globalModelIds: string[],
    at = new Date(),
  ): Promise<Map<string, AiSellPriceVersion>> {
    const ids = Array.from(new Set(globalModelIds.map((value) => String(value || '').trim()).filter(Boolean)));
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRawUnsafe<SellRow[]>(
      `SELECT DISTINCT ON (global_model_id)
              id, global_model_id, app_id, version, status, valid_from, valid_to,
              currency, rates_json, is_explicitly_free, content_hash, reason, actor_user_id
         FROM ai_model_sell_price_versions
        WHERE global_model_id = ANY($1::uuid[])
          AND app_id IS NULL
          AND status IN ('active', 'scheduled')
          AND valid_from <= $2::timestamptz
          AND (valid_to IS NULL OR valid_to > $2::timestamptz)
        ORDER BY global_model_id,
                 CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                 valid_from DESC, version DESC`,
      ids,
      at,
    );
    return new Map(rows.map((row) => [row.global_model_id, toSell(row)]));
  }

  async getSellPriceById(id: string): Promise<AiSellPriceVersion | null> {
    const rows = await this.prisma.$queryRawUnsafe<SellRow[]>(
      `SELECT id, global_model_id, app_id, version, status, valid_from, valid_to,
              currency, rates_json, is_explicitly_free, content_hash, reason, actor_user_id
         FROM ai_model_sell_price_versions
        WHERE id = $1::uuid
        LIMIT 1`,
      id,
    );
    return rows[0] ? toSell(rows[0]) : null;
  }

  async resolveUpstreamCost(upstreamModelId: string, at = new Date()): Promise<AiUpstreamCostVersion | null> {
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

  async getUpstreamCostById(id: string): Promise<AiUpstreamCostVersion | null> {
    const rows = await this.prisma.$queryRawUnsafe<CostRow[]>(
      `SELECT id, upstream_model_id, version, status, valid_from, valid_to, currency,
              rates_json, source_snapshot_json, content_hash, reason, actor_user_id
         FROM ai_upstream_cost_versions
        WHERE id = $1::uuid
        LIMIT 1`,
      id,
    );
    return rows[0] ? toCost(rows[0]) : null;
  }

  async createSellPriceVersion(input: PriceVersionInput): Promise<AiSellPriceVersion> {
    const requestedAppId = (input as PriceVersionInput & { app_id?: unknown }).app_id;
    if (requestedAppId !== null && requestedAppId !== undefined && String(requestedAppId).trim()) {
      throw new BadRequestException('App-specific sell prices are not supported');
    }
    const status = input.status || 'draft';
    this.validateStatus(status);
    this.validateWindow(input.valid_from, input.valid_to);
    this.validateReplacement(input.replace_active === true, status, input.valid_to);
    this.validatePriceBook(input.rates_json, input.is_explicitly_free === true);
    const validFrom = input.valid_from || new Date();
    const hash = AiPriceBookService.contentHash(input.rates_json);
    const rows = await this.prisma.$transaction(async (tx) => {
      const scopeKey = `sell:${input.global_model_id}:global`;
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, scopeKey);
      if (input.replace_active === true) {
        await this.retireEffectiveActiveVersion(
          tx,
          'ai_model_sell_price_versions',
          input.global_model_id,
          null,
          validFrom,
        );
      }
      const version = await this.nextVersion(tx, 'ai_model_sell_price_versions', input.global_model_id, null);
      await this.assertNoOverlap(tx, 'ai_model_sell_price_versions', input.global_model_id, null, validFrom, input.valid_to || null, status);
      return tx.$queryRawUnsafe<SellRow[]>(
        `INSERT INTO ai_model_sell_price_versions (
           global_model_id, app_id, version, status, valid_from, valid_to, currency,
           rates_json, is_explicitly_free, content_hash, reason, actor_user_id
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $7,
                   $8::jsonb, $9, $10, $11, $12::uuid)
         RETURNING id, global_model_id, app_id, version, status, valid_from, valid_to,
                   currency, rates_json, is_explicitly_free, content_hash, reason, actor_user_id`,
        input.global_model_id,
        null,
        version,
        status,
        validFrom,
        input.valid_to || null,
        input.currency || 'RMB',
        JSON.stringify(input.rates_json),
        input.is_explicitly_free === true,
        hash,
        input.reason || null,
        input.actor_user_id || null,
      );
    });
    if (!rows[0]) throw new BadRequestException('Sell price version could not be created');
    return toSell(rows[0]);
  }

  async createUpstreamCostVersion(input: CostVersionInput): Promise<AiUpstreamCostVersion> {
    const status = input.status || 'draft';
    this.validateStatus(status);
    this.validateWindow(input.valid_from, input.valid_to);
    this.validateReplacement(input.replace_active === true, status, input.valid_to);
    this.validatePriceBook(input.rates_json, false);
    const validFrom = input.valid_from || new Date();
    const hash = AiPriceBookService.contentHash(input.rates_json);
    const rows = await this.prisma.$transaction(async (tx) => {
      const scopeKey = `cost:${input.upstream_model_id}`;
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, scopeKey);
      if (input.replace_active === true) {
        await this.retireEffectiveActiveVersion(
          tx,
          'ai_upstream_cost_versions',
          input.upstream_model_id,
          null,
          validFrom,
        );
      }
      const version = await this.nextVersion(tx, 'ai_upstream_cost_versions', input.upstream_model_id, null);
      await this.assertNoOverlap(tx, 'ai_upstream_cost_versions', input.upstream_model_id, null, validFrom, input.valid_to || null, status);
      return tx.$queryRawUnsafe<CostRow[]>(
        `INSERT INTO ai_upstream_cost_versions (
           upstream_model_id, version, status, valid_from, valid_to, currency,
           rates_json, source_snapshot_json, content_hash, reason, actor_user_id
         ) VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6,
                   $7::jsonb, $8::jsonb, $9, $10, $11::uuid)
         RETURNING id, upstream_model_id, version, status, valid_from, valid_to, currency,
                   rates_json, source_snapshot_json, content_hash, reason, actor_user_id`,
        input.upstream_model_id,
        version,
        status,
        validFrom,
        input.valid_to || null,
        input.currency || 'RMB',
        JSON.stringify(input.rates_json),
        JSON.stringify(input.source_snapshot_json || {}),
        hash,
        input.reason || null,
        input.actor_user_id || null,
      );
    });
    if (!rows[0]) throw new BadRequestException('Upstream cost version could not be created');
    return toCost(rows[0]);
  }

  quoteCustomer(
    version: AiSellPriceVersion | null,
    usage: AiMeteredUsage,
    variant?: CanonicalRequestVariant | null,
  ): CustomerChargeQuote {
    if (!version) {
      return {
        points: 0,
        rmb: 0,
        currency: 'RMB',
        pricing_source: 'legacy',
        sell_price_version_id: null,
        meter_snapshot: { ...usage },
        price_rule_key: null,
        quote_kind: 'list',
        finalized: false,
      };
    }
    if (version.is_explicitly_free) {
      return {
        points: 0,
        rmb: 0,
        currency: version.currency,
        pricing_source: 'explicit-free',
        sell_price_version_id: version.id,
        meter_snapshot: { ...usage },
        price_rule_key: null,
        quote_kind: 'list',
        finalized: false,
      };
    }
    const selected = selectAiPriceBook(version.rates_json, variant, usage);
    return {
      points: calculate(selected.rates, usage, 'points'),
      rmb: calculate(selected.rates, usage, 'rmb'),
      currency: version.currency,
      pricing_source: 'versioned',
      sell_price_version_id: version.id,
      meter_snapshot: { ...usage },
      price_rule_key: selected.price_rule_key,
      quote_kind: 'list',
      finalized: false,
    };
  }

  quoteUpstream(
    version: AiUpstreamCostVersion | null,
    usage: AiMeteredUsage,
    variant?: CanonicalRequestVariant | null,
  ): UpstreamCostQuote {
    if (!version) {
      return { rmb: 0, currency: 'RMB', pricing_source: 'missing', upstream_cost_version_id: null, meter_snapshot: { ...usage }, price_rule_key: null };
    }
    const selected = selectAiPriceBook(version.rates_json, variant, usage);
    return {
      rmb: calculate(selected.rates, usage, 'rmb'),
      currency: version.currency,
      pricing_source: 'versioned',
      upstream_cost_version_id: version.id,
      meter_snapshot: { ...usage },
      price_rule_key: selected.price_rule_key,
    };
  }

  private validateWindow(validFrom?: Date, validTo?: Date | null) {
    if (validFrom && Number.isNaN(validFrom.getTime())) {
      throw new BadRequestException('valid_from must be a valid date');
    }
    if (validTo && Number.isNaN(validTo.getTime())) {
      throw new BadRequestException('valid_to must be a valid date');
    }
    if (validFrom && validTo && validTo <= validFrom) {
      throw new BadRequestException('valid_to must be after valid_from');
    }
  }

  private validateStatus(status: AiPriceVersionStatus) {
    if (!['draft', 'scheduled', 'active', 'retired'].includes(status)) {
      throw new BadRequestException('invalid price version status');
    }
  }

  private validateReplacement(replaceActive: boolean, status: AiPriceVersionStatus, validTo?: Date | null) {
    if (!replaceActive) return;
    if (status !== 'active') {
      throw new BadRequestException('replace_active requires an active price version');
    }
    if (validTo) {
      throw new BadRequestException('replace_active does not support a finite valid_to window');
    }
  }

  private validatePriceBook(book: AiPriceBook, explicitlyFree: boolean) {
    if (explicitlyFree) return;
    if (!book || typeof book !== 'object' || Object.keys(book).length === 0) {
      throw new BadRequestException('price book must contain rates or be explicitly free');
    }
    const serialized = JSON.stringify(book).toLowerCase();
    if (serialized.includes('points_per_yuan') || serialized.includes('estimated_cost')) {
      throw new BadRequestException('price book must not derive customer price from upstream cost');
    }
    validateRateValues(book, 'price book');
    if (Array.isArray(book.dimension_rates)) {
      const keys = new Set<string>();
      for (const rule of book.dimension_rates) {
        const key = String(rule?.key || '').trim();
        const match = rule?.request_match;
        const rates = rule?.rates;
        if (!key || keys.has(key)) {
          throw new BadRequestException('dimension price rules must have unique keys');
        }
        if (!match || typeof match !== 'object' || Array.isArray(match) || !Object.keys(match).length) {
          throw new BadRequestException('dimension price rules require a request match');
        }
        if (!rates || typeof rates !== 'object' || Array.isArray(rates) || !Object.keys(rates).length) {
          throw new BadRequestException('dimension price rules require rates');
        }
        validateRateValues(rates, `dimension price rule ${key}`);
        keys.add(key);
      }
      validateTokenPriceRanges(book.dimension_rates);
    }
  }

  private async nextVersion(client: RawSqlClient, table: 'ai_model_sell_price_versions' | 'ai_upstream_cost_versions', scopeId: string, appId: string | null) {
    const query = table === 'ai_model_sell_price_versions'
      ? `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ${table} WHERE global_model_id = $1::uuid AND app_id IS NOT DISTINCT FROM $2::uuid`
      : `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ${table} WHERE upstream_model_id = $1::uuid`;
    const rows = await client.$queryRawUnsafe<Array<{ version: number | string }>>(query, scopeId, ...(table === 'ai_model_sell_price_versions' ? [appId] : []));
    return Number(rows[0]?.version || 1);
  }

  /**
   * Price books are immutable. Replacing an effective price therefore retires
   * only its effective window; the original row (and every usage-log snapshot
   * that references it) remains available for historical billing.
   */
  private async retireEffectiveActiveVersion(
    client: RawSqlClient,
    table: 'ai_model_sell_price_versions' | 'ai_upstream_cost_versions',
    scopeId: string,
    appId: string | null,
    validFrom: Date,
  ) {
    if (table === 'ai_model_sell_price_versions') {
      await client.$executeRawUnsafe(
        `UPDATE ai_model_sell_price_versions
            SET status = 'retired', valid_to = $3::timestamptz, updated_at = now()
          WHERE global_model_id = $1::uuid
            AND app_id IS NOT DISTINCT FROM $2::uuid
            AND status = 'active'
            AND valid_from < $3::timestamptz
            AND (valid_to IS NULL OR valid_to > $3::timestamptz)`,
        scopeId,
        appId,
        validFrom,
      );
      return;
    }
    await client.$executeRawUnsafe(
      `UPDATE ai_upstream_cost_versions
          SET status = 'retired', valid_to = $2::timestamptz, updated_at = now()
        WHERE upstream_model_id = $1::uuid
          AND status = 'active'
          AND valid_from < $2::timestamptz
          AND (valid_to IS NULL OR valid_to > $2::timestamptz)`,
      scopeId,
      validFrom,
    );
  }

  private async assertNoOverlap(
    client: RawSqlClient,
    table: 'ai_model_sell_price_versions' | 'ai_upstream_cost_versions',
    scopeId: string,
    appId: string | null,
    validFrom: Date,
    validTo: Date | null,
    status: AiPriceVersionStatus,
  ) {
    if (!['active', 'scheduled'].includes(status)) return;
    const rows = table === 'ai_model_sell_price_versions'
      ? await client.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${table}
          WHERE global_model_id = $1::uuid AND app_id IS NOT DISTINCT FROM $2::uuid
            AND status IN ('active', 'scheduled')
            AND valid_from < COALESCE($4::timestamptz, 'infinity'::timestamptz)
            AND COALESCE(valid_to, 'infinity'::timestamptz) > $3::timestamptz
          LIMIT 1`,
        scopeId, appId, validFrom, validTo,
      )
      : await client.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${table}
          WHERE upstream_model_id = $1::uuid
            AND status IN ('active', 'scheduled')
            AND valid_from < COALESCE($3::timestamptz, 'infinity'::timestamptz)
            AND COALESCE(valid_to, 'infinity'::timestamptz) > $2::timestamptz
          LIMIT 1`,
        scopeId, validFrom, validTo,
      );
    if (rows[0]) throw new BadRequestException('price version overlaps an active or scheduled version');
  }
}
