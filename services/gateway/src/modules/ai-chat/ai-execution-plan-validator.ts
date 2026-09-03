import { BadRequestException } from '@nestjs/common';
import {
  AiExecutionCandidate,
  CanonicalRequestVariant,
} from './ai-product-decoupling.types';
import { requestVariantMatches } from './ai-request-variant.normalizer';

export type VariantCoverageError = {
  code: string;
  variant_key?: string;
  message: string;
};

export function validateVariantCoverage(
  routes: AiExecutionCandidate[],
  supportedVariants: CanonicalRequestVariant[],
): VariantCoverageError[] {
  const errors: VariantCoverageError[] = [];
  const groups = new Map<string, AiExecutionCandidate[]>();
  for (const route of routes) {
    const group = groups.get(route.variant_key) || [];
    group.push(route);
    groups.set(route.variant_key, group);
  }
  for (const [variantKey, group] of groups) {
    const contracts = new Set(group.map((route) => route.contract_version));
    if (contracts.size > 1) {
      errors.push({ code: 'contract-mismatch', variant_key: variantKey, message: `variant ${variantKey} has incompatible contract versions` });
    }
    if (group.every((route) => !route.upstream_model_id || !route.upstream_active || !route.source_active || !route.route_active || !route.cost_version)) {
      errors.push({ code: 'unexecutable-group', variant_key: variantKey, message: `variant ${variantKey} has no executable candidate` });
    }
  }
  for (const variant of supportedVariants) {
    const matchingGroups = Array.from(groups.entries()).filter(([, group]) =>
      group.some((route) => requestVariantMatches(variant, route.request_match)),
    );
    if (!matchingGroups.length) {
      errors.push({ code: 'coverage-gap', message: `no variant group matches ${variant.hash}` });
      continue;
    }
    const priorities = matchingGroups.map(([, group]) => Math.max(...group.map((route) => route.match_priority)));
    const maxPriority = Math.max(...priorities);
    const winners = matchingGroups.filter(([, group]) => Math.max(...group.map((route) => route.match_priority)) === maxPriority);
    if (winners.length > 1) {
      errors.push({ code: 'ambiguous-match', message: `multiple variant groups match ${variant.hash} at priority ${maxPriority}` });
    }
  }
  return errors;
}

export function assertVariantCoverage(
  routes: AiExecutionCandidate[],
  supportedVariants: CanonicalRequestVariant[],
) {
  const errors = validateVariantCoverage(routes, supportedVariants);
  if (errors.length) {
    throw new BadRequestException({ message: 'AI variant coverage validation failed', errors });
  }
  return { valid: true as const, errors: [] as VariantCoverageError[] };
}

