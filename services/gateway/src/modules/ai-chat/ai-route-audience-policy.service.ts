import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';

export const AI_ROUTE_AUDIENCE_POLICY_SCHEMA_VERSION = 'ai-route-audience-policy-v1' as const;
export type AiCustomerAudienceTier = 'FREE' | 'PAID';
export type AiRouteMembershipAccess = 'ALL' | 'FREE_ONLY' | 'PAID_ONLY';

export type AiRouteAudiencePolicy = {
  schema_version: typeof AI_ROUTE_AUDIENCE_POLICY_SCHEMA_VERSION;
  membership_access: AiRouteMembershipAccess;
};

export type AiRouteAudienceDecision = {
  schema_version: 'ai-route-audience-decision-v1';
  enabled: boolean;
  bypass_reason: 'model_disabled' | 'internal_non_billable' | null;
  audience_tier: AiCustomerAudienceTier | null;
  policy_hash: string;
  input_candidate_count: number;
  eligible_candidate_count: number;
  eligible_route_keys: string[];
  excluded_route_keys: string[];
};

type AudienceRoute = {
  route_key: string;
  membership_route_enabled?: boolean;
  audience_policy?: AiRouteAudiencePolicy | Record<string, unknown> | null;
};

const DEFAULT_POLICY: AiRouteAudiencePolicy = {
  schema_version: AI_ROUTE_AUDIENCE_POLICY_SCHEMA_VERSION,
  membership_access: 'ALL',
};

export function normalizeAiRouteAudiencePolicy(value: unknown): AiRouteAudiencePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_POLICY };
  const source = value as Record<string, unknown>;
  const membershipAccess = String(source.membership_access || 'ALL').trim().toUpperCase();
  return {
    schema_version: AI_ROUTE_AUDIENCE_POLICY_SCHEMA_VERSION,
    membership_access: membershipAccess === 'FREE_ONLY' || membershipAccess === 'PAID_ONLY'
      ? membershipAccess
      : 'ALL',
  };
}

export function validateAiRouteAudiencePolicy(value: unknown): AiRouteAudiencePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('audience_policy must be an object');
  }
  const source = value as Record<string, unknown>;
  const schemaVersion = String(source.schema_version || AI_ROUTE_AUDIENCE_POLICY_SCHEMA_VERSION).trim();
  const membershipAccess = String(source.membership_access || '').trim().toUpperCase();
  if (schemaVersion !== AI_ROUTE_AUDIENCE_POLICY_SCHEMA_VERSION) {
    throw new BadRequestException(`unsupported audience_policy schema_version: ${schemaVersion}`);
  }
  if (!['ALL', 'FREE_ONLY', 'PAID_ONLY'].includes(membershipAccess)) {
    throw new BadRequestException('audience_policy.membership_access must be ALL, FREE_ONLY, or PAID_ONLY');
  }
  return {
    schema_version: AI_ROUTE_AUDIENCE_POLICY_SCHEMA_VERSION,
    membership_access: membershipAccess as AiRouteMembershipAccess,
  };
}

@Injectable()
export class AiRouteAudiencePolicyService {
  filter<T extends AudienceRoute>(input: {
    routes: T[];
    billing_intent: 'customer_billed' | 'internal_non_billable';
    audience_tier: AiCustomerAudienceTier | null;
  }): { routes: T[]; decision: AiRouteAudienceDecision } {
    const enabled = input.routes[0]?.membership_route_enabled === true;
    const normalized = input.routes.map((route) => ({
      route,
      policy: normalizeAiRouteAudiencePolicy(route.audience_policy),
    }));
    const bypassReason = !enabled
      ? 'model_disabled'
      : input.billing_intent === 'internal_non_billable'
        ? 'internal_non_billable'
        : null;
    if (bypassReason) {
      return {
        routes: input.routes,
        decision: this.decision(input.routes, [], input.audience_tier, enabled, bypassReason, normalized),
      };
    }
    if (input.audience_tier !== 'FREE' && input.audience_tier !== 'PAID') {
      throw new ServiceUnavailableException({
        code: 'AI_COMMERCIAL_SUBJECT_UNAVAILABLE',
        message: 'AI commercial subject could not be resolved',
        retryable: true,
      });
    }
    const eligible: T[] = [];
    const excluded: T[] = [];
    normalized.forEach(({ route, policy }) => {
      const allowed = policy.membership_access === 'ALL'
        || (input.audience_tier === 'FREE' && policy.membership_access === 'FREE_ONLY')
        || (input.audience_tier === 'PAID' && policy.membership_access === 'PAID_ONLY');
      (allowed ? eligible : excluded).push(route);
    });
    if (eligible.length === 0) {
      throw new ServiceUnavailableException({
        code: 'AI_MODEL_AUDIENCE_ROUTE_UNAVAILABLE',
        message: 'No AI upstream route is available for this account tier',
        retryable: false,
      });
    }
    return {
      routes: eligible,
      decision: this.decision(eligible, excluded, input.audience_tier, true, null, normalized),
    };
  }

  private decision<T extends AudienceRoute>(
    eligible: T[],
    excluded: T[],
    audienceTier: AiCustomerAudienceTier | null,
    enabled: boolean,
    bypassReason: AiRouteAudienceDecision['bypass_reason'],
    normalized: Array<{ route: T; policy: AiRouteAudiencePolicy }>,
  ): AiRouteAudienceDecision {
    const policyCore = {
      enabled,
      audience_tier: audienceTier,
      routes: normalized.map(({ route, policy }) => ({ route_key: route.route_key, ...policy })),
    };
    return {
      schema_version: 'ai-route-audience-decision-v1',
      enabled,
      bypass_reason: bypassReason,
      audience_tier: audienceTier,
      policy_hash: createHash('sha256').update(JSON.stringify(policyCore)).digest('hex'),
      input_candidate_count: normalized.length,
      eligible_candidate_count: eligible.length,
      eligible_route_keys: eligible.map((route) => route.route_key),
      excluded_route_keys: excluded.map((route) => route.route_key),
    };
  }
}
