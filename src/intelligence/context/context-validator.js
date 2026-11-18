import { CONTEXT_KINDS, ContextKind, IntelligenceError } from '../constants.js';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} kind
 * @param {Record<string, unknown>} payload
 */
export function validateContextPayload(kind, payload) {
  if (!CONTEXT_KINDS.includes(kind)) {
    throw new IntelligenceError(`Unsupported context kind: ${kind}`, {
      code: 'INVALID_CONTEXT_KIND',
      details: { kind, allowed: CONTEXT_KINDS },
    });
  }
  if (!isPlainObject(payload)) {
    throw new IntelligenceError('Context payload must be a plain object', {
      code: 'INVALID_CONTEXT_PAYLOAD',
    });
  }

  const requiredByKind = {
    [ContextKind.BRAND]: ['brandName'],
    [ContextKind.BUSINESS]: ['products'],
    [ContextKind.STRATEGY]: ['primaryInstagramObjectives'],
    [ContextKind.AUDIENCE]: ['segments'],
    [ContextKind.PRODUCT]: ['products'],
    [ContextKind.PERFORMANCE]: [],
    [ContextKind.COMPOSITE]: [],
  };

  const required = requiredByKind[kind] ?? [];
  const missing = required.filter((key) => {
    const value = payload[key];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string' && value.trim() === '') return true;
    if (Array.isArray(value) && value.length === 0) return true;
    return false;
  });

  if (missing.length > 0) {
    throw new IntelligenceError(`Context payload missing required fields: ${missing.join(', ')}`, {
      code: 'CONTEXT_VALIDATION_FAILED',
      details: { kind, missing },
    });
  }

  return true;
}

/**
 * Normalize common brand/business/strategy shapes.
 *
 * @param {string} kind
 * @param {Record<string, unknown>} payload
 */
export function normalizeContextPayload(kind, payload) {
  const base = { ...payload };
  if (kind === ContextKind.BRAND) {
    return {
      brandName: String(base.brandName ?? base.name ?? ''),
      businessCategory: String(base.businessCategory ?? ''),
      brandDescription: String(base.brandDescription ?? base.description ?? ''),
      brandIdentity: base.brandIdentity ?? {},
      communicationTone: String(base.communicationTone ?? ''),
      targetAudience: base.targetAudience ?? [],
      uniqueSellingPropositions: base.uniqueSellingPropositions ?? [],
      contentGuidelines: base.contentGuidelines ?? [],
      brandRestrictions: base.brandRestrictions ?? [],
      officialLinks: base.officialLinks ?? {},
      contactInformation: base.contactInformation ?? {},
      ...base,
    };
  }
  if (kind === ContextKind.BUSINESS) {
    return {
      products: base.products ?? [],
      services: base.services ?? [],
      productPriorities: base.productPriorities ?? [],
      salesObjectives: base.salesObjectives ?? [],
      marketingObjectives: base.marketingObjectives ?? [],
      activeCampaigns: base.activeCampaigns ?? [],
      approvedCommercialOffers: base.approvedCommercialOffers ?? [],
      budgetConstraints: base.budgetConstraints ?? {},
      operationalRestrictions: base.operationalRestrictions ?? [],
      relevantBusinessInformation: base.relevantBusinessInformation ?? {},
      ...base,
    };
  }
  if (kind === ContextKind.STRATEGY) {
    return {
      primaryInstagramObjectives: base.primaryInstagramObjectives ?? [],
      shortTermObjectives: base.shortTermObjectives ?? [],
      longTermObjectives: base.longTermObjectives ?? [],
      marketingPriorities: base.marketingPriorities ?? [],
      contentPublishingPolicies: base.contentPublishingPolicies ?? [],
      targetAudience: base.targetAudience ?? [],
      aiDecisionMakingBoundaries: base.aiDecisionMakingBoundaries ?? [],
      successMetrics: base.successMetrics ?? [],
      kpis: base.kpis ?? [],
      ...base,
    };
  }
  return base;
}
