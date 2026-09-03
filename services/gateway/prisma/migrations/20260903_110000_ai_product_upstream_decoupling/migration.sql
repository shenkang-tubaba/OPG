-- Additive schema for product/upstream/routing/pricing separation.
-- Keeps legacy fields intact. Default runtime mode remains legacy until backfill + shadow.

CREATE TABLE IF NOT EXISTS ai_upstream_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
  upstream_key varchar(96) NOT NULL,
  upstream_model varchar(256) NOT NULL,
  capability varchar(32) NOT NULL,
  billing_scope varchar(96) NOT NULL DEFAULT 'default',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL,
  updated_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_upstream_models_source_key_unique UNIQUE (source_id, upstream_key),
  CONSTRAINT ai_upstream_models_identity_unique UNIQUE (source_id, upstream_model, capability, billing_scope)
);

CREATE INDEX IF NOT EXISTS idx_ai_upstream_models_source_capability
  ON ai_upstream_models(source_id, is_active, capability, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_model_sell_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE RESTRICT,
  app_id uuid NULL REFERENCES apps(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz NULL,
  currency varchar(16) NOT NULL DEFAULT 'RMB',
  rates_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_explicitly_free boolean NOT NULL DEFAULT false,
  content_hash varchar(64) NOT NULL,
  reason text NULL,
  actor_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_model_sell_price_versions_scope_version_unique UNIQUE (global_model_id, app_id, version)
);

CREATE INDEX IF NOT EXISTS idx_ai_model_sell_price_versions_lookup
  ON ai_model_sell_price_versions(global_model_id, app_id, status, valid_from DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_sell_price_versions_global_version
  ON ai_model_sell_price_versions(global_model_id, version)
  WHERE app_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_sell_price_versions_app_version
  ON ai_model_sell_price_versions(app_id, global_model_id, version)
  WHERE app_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_upstream_cost_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upstream_model_id uuid NOT NULL REFERENCES ai_upstream_models(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz NULL,
  currency varchar(16) NOT NULL DEFAULT 'RMB',
  rates_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash varchar(64) NOT NULL,
  reason text NULL,
  actor_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_upstream_cost_versions_scope_version_unique UNIQUE (upstream_model_id, version)
);

CREATE INDEX IF NOT EXISTS idx_ai_upstream_cost_versions_lookup
  ON ai_upstream_cost_versions(upstream_model_id, status, valid_from DESC);

CREATE TABLE IF NOT EXISTS ai_configuration_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision bigint NOT NULL UNIQUE,
  status varchar(24) NOT NULL DEFAULT 'draft',
  manifest_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_hash varchar(64) NOT NULL,
  activate_at timestamptz NULL,
  created_by_user_id uuid NULL,
  activated_by_user_id uuid NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_configuration_revisions_active
  ON ai_configuration_revisions(status)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ai_configuration_change_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision bigint NOT NULL,
  resource_type varchar(64) NOT NULL,
  resource_id uuid NULL,
  operation varchar(32) NOT NULL,
  before_hash varchar(64) NULL,
  after_hash varchar(64) NULL,
  actor_user_id uuid NULL,
  reason text NULL,
  validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_configuration_change_audits_revision
  ON ai_configuration_change_audits(revision, created_at DESC);

ALTER TABLE ai_model_source_routes
  ADD COLUMN IF NOT EXISTS upstream_model_id uuid NULL REFERENCES ai_upstream_models(id) ON DELETE RESTRICT;

ALTER TABLE ai_model_source_routes
  ADD COLUMN IF NOT EXISTS variant_key varchar(160) NOT NULL DEFAULT 'default';

ALTER TABLE ai_model_source_routes
  ADD COLUMN IF NOT EXISTS match_priority integer NOT NULL DEFAULT 0;

ALTER TABLE ai_model_source_routes
  ADD COLUMN IF NOT EXISTS contract_version varchar(64) NOT NULL DEFAULT 'legacy-v1';

ALTER TABLE ai_model_source_routes
  ADD COLUMN IF NOT EXISTS adapter_config_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ai_model_source_routes
  ADD COLUMN IF NOT EXISTS execution_mode varchar(16) NULL;

ALTER TABLE ai_model_source_routes
  ADD COLUMN IF NOT EXISTS request_match jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ai_model_source_routes_variant_lookup
  ON ai_model_source_routes(global_model_id, app_id, is_active, variant_key, match_priority DESC, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_ai_model_source_routes_upstream
  ON ai_model_source_routes(upstream_model_id, is_active, sort_order ASC)
  WHERE upstream_model_id IS NOT NULL;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS sell_price_version_id uuid NULL REFERENCES ai_model_sell_price_versions(id) ON DELETE SET NULL;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS upstream_model_id uuid NULL REFERENCES ai_upstream_models(id) ON DELETE SET NULL;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS upstream_cost_version_id uuid NULL REFERENCES ai_upstream_cost_versions(id) ON DELETE SET NULL;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS configuration_revision bigint NULL;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS execution_plan_hash varchar(64) NULL;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS customer_charge_rmb numeric(18,6) NULL;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS snapshot_schema_version varchar(32) NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_upstream_version
  ON ai_usage_logs(app_id, upstream_model_id, created_at DESC)
  WHERE upstream_model_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_configuration_revision
  ON ai_usage_logs(configuration_revision, created_at DESC)
  WHERE configuration_revision IS NOT NULL;

ALTER TABLE ai_async_video_tasks
  ADD COLUMN IF NOT EXISTS global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL;

ALTER TABLE ai_async_video_tasks
  ADD COLUMN IF NOT EXISTS sell_price_version_id uuid NULL REFERENCES ai_model_sell_price_versions(id) ON DELETE SET NULL;

ALTER TABLE ai_async_video_tasks
  ADD COLUMN IF NOT EXISTS variant_key varchar(160) NULL;

ALTER TABLE ai_async_video_tasks
  ADD COLUMN IF NOT EXISTS upstream_model_id uuid NULL REFERENCES ai_upstream_models(id) ON DELETE SET NULL;

ALTER TABLE ai_async_video_tasks
  ADD COLUMN IF NOT EXISTS upstream_cost_version_id uuid NULL REFERENCES ai_upstream_cost_versions(id) ON DELETE SET NULL;

ALTER TABLE ai_async_video_tasks
  ADD COLUMN IF NOT EXISTS contract_version varchar(64) NULL;

ALTER TABLE ai_async_video_tasks
  ADD COLUMN IF NOT EXISTS configuration_revision bigint NULL;

ALTER TABLE ai_async_video_tasks
  ADD COLUMN IF NOT EXISTS execution_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ai_async_video_tasks_variant
  ON ai_async_video_tasks(app_id, model_key, variant_key, status, updated_at DESC)
  WHERE variant_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_async_video_tasks_upstream_version
  ON ai_async_video_tasks(upstream_model_id, status, updated_at DESC)
  WHERE upstream_model_id IS NOT NULL;
