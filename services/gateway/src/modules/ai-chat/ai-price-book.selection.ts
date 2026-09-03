import {
  AiMeteredUsage,
  AiPriceBook,
  AiPriceDimensionRule,
  CanonicalRequestVariant,
} from './ai-product-decoupling.types';
import { requestVariantMatches } from './ai-request-variant.normalizer';

export type AiSelectedPriceBook = {
  rates: AiPriceBook;
  price_rule_key: string | null;
  has_dimension_rates: boolean;
  matched: boolean;
  ambiguous: boolean;
};

function rulesOf(book: AiPriceBook): AiPriceDimensionRule[] {
  return Array.isArray(book.dimension_rates)
    ? book.dimension_rates.filter((rule): rule is AiPriceDimensionRule => Boolean(
      rule
      && typeof rule === 'object'
      && typeof rule.key === 'string'
      && rule.key.trim()
      && rule.request_match
      && typeof rule.request_match === 'object'
      && !Array.isArray(rule.request_match)
      && rule.rates
      && typeof rule.rates === 'object',
    ))
    : [];
}

function specificity(rule: AiPriceDimensionRule): number {
  return Object.entries(rule.request_match).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== '';
  }).length;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[\s-]+/g, '_');
}

function requestInputTokens(usage?: AiMeteredUsage | null): number | null {
  if (!usage) return null;
  const raw = usage.request_input_tokens ?? usage.input_tokens;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function matchesNumericRange(expected: unknown, actual: number): boolean {
  const values = Array.isArray(expected) ? expected : [expected];
  return values.some((candidate) => {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const range = candidate as Record<string, unknown>;
      const min = range.min === undefined || range.min === null ? null : Number(range.min);
      const max = range.max === undefined || range.max === null ? null : Number(range.max);
      return (min === null || (Number.isFinite(min) && actual >= min))
        && (max === null || (Number.isFinite(max) && actual <= max));
    }
    const value = Number(candidate);
    return Number.isFinite(value) && value === actual;
  });
}

function matchesRule(
  rule: AiPriceDimensionRule,
  variant?: CanonicalRequestVariant | null,
  usage?: AiMeteredUsage | null,
): boolean {
  const variantMatch: Record<string, unknown> = {};
  let requiresInputTokenMatch = false;
  for (const [key, expected] of Object.entries(rule.request_match)) {
    const normalized = normalizedKey(key);
    if (normalized === 'request_input_tokens' || normalized === 'prompt_tokens') {
      requiresInputTokenMatch = true;
      const tokens = requestInputTokens(usage);
      if (tokens === null || !matchesNumericRange(expected, tokens)) return false;
      continue;
    }
    variantMatch[key] = expected;
  }
  if (!Object.keys(variantMatch).length) return requiresInputTokenMatch;
  return Boolean(variant && requestVariantMatches(variant, variantMatch));
}

/**
 * Selects a rate card from immutable pricing facts.  If a book is dimensional,
 * lack of a matching rule is intentionally not treated as a zero-priced match.
 */
export function selectAiPriceBook(
  book: AiPriceBook,
  variant?: CanonicalRequestVariant | null,
  usage?: AiMeteredUsage | null,
): AiSelectedPriceBook {
  const rules = rulesOf(book);
  if (!rules.length) {
    return { rates: book, price_rule_key: null, has_dimension_rates: false, matched: true, ambiguous: false };
  }
  const matched = rules
    .filter((rule) => matchesRule(rule, variant, usage))
    .sort((left, right) => specificity(right) - specificity(left) || left.key.localeCompare(right.key));
  const selected = matched[0];
  if (!selected) {
    return { rates: {}, price_rule_key: null, has_dimension_rates: true, matched: false, ambiguous: false };
  }
  return {
    rates: selected.rates,
    price_rule_key: selected.key,
    has_dimension_rates: true,
    matched: true,
    ambiguous: matched.length > 1 && specificity(matched[0]) === specificity(matched[1]),
  };
}

export function hasAiPriceDimensionRules(book: AiPriceBook): boolean {
  return rulesOf(book).length > 0;
}
