/**
 * Heuristic + configurable column mapping for historical decision imports.
 */

const FIELD_ALIASES = Object.freeze({
  decisionDescription: [
    'decision',
    'decision description',
    'description',
    'title',
    'decision_title',
    'what',
  ],
  decisionMaker: ['decision maker', 'maker', 'owner', 'actor', 'who', 'decided by'],
  decisionDate: ['date', 'decision date', 'when', 'created', 'decision_date'],
  intendedObjective: ['objective', 'goal', 'intended objective', 'purpose', 'why'],
  actionTaken: ['action', 'action taken', 'what was done', 'implementation'],
  outcome: ['outcome', 'result', 'results', 'impact'],
  measurementCriteria: ['measurement', 'criteria', 'kpi', 'metric', 'measurement criteria'],
  successStatus: ['success', 'success status', 'status', 'successful', 'failed'],
  notes: ['notes', 'note', 'comments', 'comment', 'additional notes'],
  sourceReference: ['source', 'reference', 'source reference', 'ref', 'id'],
});

/**
 * @param {string} header
 */
export function normalizeHeader(header) {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Auto-detect mapping from headers to canonical fields.
 *
 * @param {string[]} headers
 * @param {Record<string, string>} [explicitMapping] header -> field
 */
export function detectColumnMapping(headers, explicitMapping = {}) {
  /** @type {Record<string, string>} */
  const mapping = {};
  /** @type {string[]} */
  const unmappedHeaders = [];

  for (const [header, field] of Object.entries(explicitMapping)) {
    mapping[normalizeHeader(header)] = field;
  }

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (!normalized) continue;
    if (mapping[normalized]) continue;

    let matched = false;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.includes(normalized) || aliases.some((alias) => normalized.includes(alias))) {
        mapping[normalized] = field;
        matched = true;
        break;
      }
    }
    if (!matched) {
      unmappedHeaders.push(header);
    }
  }

  return { mapping, unmappedHeaders };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} headers
 * @param {Record<string, string>} mapping normalizedHeader -> field
 */
export function mapRowToDecision(row, headers, mapping) {
  /** @type {Record<string, unknown>} */
  const mapped = {
    decisionDescription: '',
    decisionMaker: '',
    decisionDate: null,
    intendedObjective: '',
    actionTaken: '',
    outcome: '',
    measurementCriteria: '',
    successStatus: null,
    notes: '',
    sourceReference: '',
  };
  /** @type {Record<string, unknown>} */
  const unmapped = {};

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const value = row[header];
    const field = mapping[normalized];
    if (field) {
      mapped[field] = value === undefined || value === null ? mapped[field] : value;
    } else if (normalized) {
      unmapped[header] = value;
    }
  }

  const successRaw = mapped.successStatus;
  if (successRaw !== null && successRaw !== undefined && successRaw !== '') {
    const text = String(successRaw).trim().toLowerCase();
    if (['yes', 'true', '1', 'success', 'successful', 'succeeded'].includes(text)) {
      mapped.successStatus = 'success';
    } else if (['no', 'false', '0', 'fail', 'failed', 'unsuccessful'].includes(text)) {
      mapped.successStatus = 'failed';
    } else if (['unknown', 'n/a', 'na', 'pending'].includes(text)) {
      mapped.successStatus = 'unknown';
    } else {
      mapped.successStatus = String(successRaw);
    }
  } else {
    mapped.successStatus = null;
  }

  if (mapped.decisionDate !== null && mapped.decisionDate !== undefined && mapped.decisionDate !== '') {
    if (mapped.decisionDate instanceof Date) {
      mapped.decisionDate = mapped.decisionDate.toISOString().slice(0, 10);
    } else {
      mapped.decisionDate = String(mapped.decisionDate);
    }
  } else {
    mapped.decisionDate = null;
  }

  for (const key of Object.keys(mapped)) {
    if (key === 'decisionDate' || key === 'successStatus') continue;
    mapped[key] = mapped[key] === undefined || mapped[key] === null ? '' : String(mapped[key]);
  }

  return {
    ...mapped,
    raw: { ...row, __unmapped: unmapped },
  };
}
