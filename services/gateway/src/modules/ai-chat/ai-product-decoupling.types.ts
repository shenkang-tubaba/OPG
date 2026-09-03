export type AiDecouplingMode = 'legacy' | 'shadow' | 'enforced';

export type AiBillingIntent = 'customer_billed' | 'internal_non_billable';

export type AiCanonicalCapability =
  | 'chat'
  | 'responses'
  | 'image'
  | 'video'
  | 'audio'
  | 'tts'
  | 'stt'
  | 'embedding'
  | 'moderation';

export type CanonicalVariantDimension = string | number | boolean | null;

export type CanonicalRequestVariant = {
  schema_version: 'ai-request-variant-v1';
  capability: AiCanonicalCapability | string;
  model_key: string;
  dimensions: {
    input_kind?: string | null;
    mode?: string | null;
    resolution?: string | null;
    aspect_ratio?: string | null;
    quality?: string | null;
    media_types?: string[];
    duration_seconds?: number | null;
    generate_audio?: boolean | null;
    [key: string]: CanonicalVariantDimension | string[] | undefined;
  };
  hash: string;
};

export type AiRouteMatch = {
  variant_key?: string;
  match_priority?: number;
  request_match?: Record<string, unknown>;
  contract_version?: string;
};

export type AiUpstreamCatalogRecord = {
  id: string;
  source_id: string;
  upstream_key: string;
  upstream_model: string;
  capability: string;
  billing_scope: string;
  metadata_json: Record<string, unknown>;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

export type AiPriceVersionStatus = 'draft' | 'scheduled' | 'active' | 'retired';

export type AiPriceRate = {
  unit?: 'token' | 'mtoken' | 'call' | 'minute' | 'second' | 'image' | 'character' | string;
  input?: number | string | null;
  cached_input?: number | string | null;
  cache_read?: number | string | null;
  cache_write?: number | string | null;
  cache_creation?: number | string | null;
  output?: number | string | null;
  completion?: number | string | null;
  call?: number | string | null;
  minute?: number | string | null;
  second?: number | string | null;
  image?: number | string | null;
  character?: number | string | null;
  [key: string]: unknown;
};

/**
 * A versioned price rule selected by the canonical request variant.  The
 * product and upstream catalog remain separate: the same matcher can select a
 * customer price or an upstream cost, but never derives one from the other.
 */
export type AiPriceDimensionRule = {
  key: string;
  request_match: Record<string, unknown>;
  rates: AiPriceBook;
};

export type AiPriceBook = {
  dimension_rates?: AiPriceDimensionRule[];
  [key: string]: AiPriceRate | AiPriceDimensionRule[] | number | string | null | undefined;
};

export type AiSellPriceVersion = {
  id: string;
  global_model_id: string;
  app_id: string | null;
  version: number;
  status: AiPriceVersionStatus;
  valid_from: string;
  valid_to: string | null;
  currency: string;
  rates_json: AiPriceBook;
  is_explicitly_free: boolean;
  content_hash: string;
  reason: string | null;
  actor_user_id: string | null;
};

export type AiUpstreamCostVersion = {
  id: string;
  upstream_model_id: string;
  version: number;
  status: AiPriceVersionStatus;
  valid_from: string;
  valid_to: string | null;
  currency: string;
  rates_json: AiPriceBook;
  source_snapshot_json: Record<string, unknown>;
  content_hash: string;
  reason: string | null;
  actor_user_id: string | null;
};

export type AiMeteredUsage = {
  /**
   * Total prompt length before cache accounting. This selects token-tier
   * prices only; it is never itself a billable meter.
   */
  request_input_tokens?: number | null;
  input_tokens?: number | null;
  /** Legacy cache-read alias. It must never be charged in addition to cache_read_tokens. */
  cached_input_tokens?: number | null;
  cache_read_tokens?: number | null;
  /** Generic cache-write fact when a provider does not report a TTL-specific write. */
  cache_write_tokens?: number | null;
  cache_write_5m_tokens?: number | null;
  cache_write_1h_tokens?: number | null;
  /** Legacy cache-write alias. It must never be charged in addition to cache_write_tokens. */
  cache_creation_tokens?: number | null;
  output_tokens?: number | null;
  calls?: number | null;
  minutes?: number | null;
  images?: number | null;
  characters?: number | null;
  duration_seconds?: number | null;
};

export type CustomerChargeQuote = {
  points: number;
  rmb: number;
  currency: string;
  pricing_source: 'versioned' | 'explicit-free' | 'legacy';
  sell_price_version_id: string | null;
  meter_snapshot: AiMeteredUsage;
  price_rule_key?: string | null;
  /**
   * A product price quote is a list/sell fact. It is intentionally not a
   * finalized customer charge until an authorized charge policy produces a
   * separate quote.
   */
  quote_kind: 'list';
  finalized: false;
};

/** Final customer capture produced by a separately authorized charge policy. */
export type AiFinalChargeQuote = {
  points: number;
  rmb: number;
  currency: string;
  pricing_source: 'charge-policy';
  quote_kind: 'charge';
  finalized: true;
  charge_policy_key: string;
  charge_policy_revision: string | null;
  list_price_version_id: string | null;
  meter_snapshot: AiMeteredUsage;
  list_points: number;
  list_rmb: number;
  benefit_subject_kind: 'PERSONAL' | 'TEAM';
  benefit_subject_billing_account_id: string | null;
  benefit_subject_team_id: string | null;
  benefit_subject_user_id: string | null;
  membership_tier: 'FREE' | 'PAID';
  membership_expires_at: string | null;
  membership_sources: string[];
  price_multiplier_bps: number;
  discount_percent: number;
};

export type UpstreamCostQuote = {
  rmb: number;
  currency: string;
  pricing_source: 'versioned' | 'legacy' | 'missing';
  upstream_cost_version_id: string | null;
  meter_snapshot: AiMeteredUsage;
  price_rule_key?: string | null;
};

export type AiExecutionCandidate = {
  route_id: string;
  route_key: string;
  variant_key: string;
  match_priority: number;
  sort_order: number;
  contract_version: string;
  global_model_id: string;
  app_id: string | null;
  source_id: string;
  upstream_model_id: string | null;
  upstream_model: string;
  endpoint_path: string;
  api_type: string;
  execution_mode: string | null;
  request_overrides: Record<string, unknown>;
  request_match: Record<string, unknown>;
  adapter_config_json: Record<string, unknown>;
  source_active: boolean;
  route_active: boolean;
  upstream_active: boolean | null;
  cost_version: AiUpstreamCostVersion | null;
};

export type AiExecutionPlan = {
  schema_version: 'ai-execution-plan-v1';
  mode: AiDecouplingMode;
  billing_intent: AiBillingIntent;
  configuration_revision: number | null;
  plan_hash: string;
  product: {
    global_model_id: string;
    model_key: string;
    capability: string;
    display_name: string;
  };
  variant: CanonicalRequestVariant;
  sell_price: AiSellPriceVersion | null;
  candidates: AiExecutionCandidate[];
  selected_variant_key: string | null;
  warnings: string[];
};

export type AiPricingSnapshotV2 = {
  schema_version: 'ai-pricing-snapshot-v2';
  product_model_id: string;
  product_model_key: string;
  list_price_version_id: string | null;
  list_price_quote: CustomerChargeQuote | null;
  charge_quote: AiFinalChargeQuote | null;
  sell_price_version_id: string | null;
  upstream_model_id: string | null;
  upstream_cost_version_id: string | null;
  route_id: string | null;
  route_key: string | null;
  variant_key: string | null;
  request_variant?: CanonicalRequestVariant | null;
  configuration_revision: number | null;
  execution_plan_hash: string | null;
  /** @deprecated Use list_price_quote and charge_quote separately. */
  customer_charge: null;
  upstream_cost: UpstreamCostQuote | null;
  captured_at: string;
};
