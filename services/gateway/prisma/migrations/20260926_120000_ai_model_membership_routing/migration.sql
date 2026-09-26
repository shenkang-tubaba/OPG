ALTER TABLE ai_global_models
  ADD COLUMN IF NOT EXISTS membership_route_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE ai_model_source_routes
  ADD COLUMN IF NOT EXISTS audience_policy_json jsonb NOT NULL DEFAULT
    '{"schema_version":"ai-route-audience-policy-v1","membership_access":"ALL"}'::jsonb;

ALTER TABLE ai_model_source_routes
  DROP CONSTRAINT IF EXISTS ai_model_source_routes_audience_policy_object_check;

ALTER TABLE ai_model_source_routes
  ADD CONSTRAINT ai_model_source_routes_audience_policy_object_check
  CHECK (jsonb_typeof(audience_policy_json) = 'object');
