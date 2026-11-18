/**
 * Validate mapped historical decision records before import.
 */

/**
 * @param {Record<string, unknown>} record
 */
export function validateHistoricalRecord(record) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const description = String(record.decisionDescription ?? '').trim();
  if (!description) {
    errors.push('decisionDescription is required');
  }

  const hasActionOrOutcome =
    String(record.actionTaken ?? '').trim() !== '' ||
    String(record.outcome ?? '').trim() !== '';
  if (!hasActionOrOutcome) {
    warnings.push('Record has neither actionTaken nor outcome');
  }

  if (!record.decisionDate) {
    warnings.push('decisionDate is missing');
  }

  const incomplete =
    !description ||
    (!String(record.actionTaken ?? '').trim() && !String(record.outcome ?? '').trim());

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    incomplete,
  };
}

/**
 * @param {Array<Record<string, unknown>>} records
 */
export function detectDuplicates(records) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  /** @type {Array<{ index: number, duplicateOf: number, key: string }>} */
  const duplicates = [];

  records.forEach((record, index) => {
    const key = [
      String(record.decisionDescription ?? '').trim().toLowerCase(),
      String(record.decisionDate ?? ''),
      String(record.actionTaken ?? '').trim().toLowerCase(),
    ].join('|');
    if (!key.replace(/\|/g, '')) {
      return;
    }
    if (seen.has(key)) {
      const first = seen.get(key)?.[0] ?? 0;
      duplicates.push({ index, duplicateOf: first, key });
      seen.get(key)?.push(index);
    } else {
      seen.set(key, [index]);
    }
  });

  return duplicates;
}

/**
 * @param {Array<Record<string, unknown>>} records
 */
export function validateImportBatch(records) {
  const validations = records.map((record, index) => ({
    index,
    ...validateHistoricalRecord(record),
  }));
  const duplicates = detectDuplicates(records);
  const incomplete = validations.filter((item) => item.incomplete).map((item) => item.index);
  const invalid = validations.filter((item) => !item.ok);

  return {
    ok: invalid.length === 0,
    total: records.length,
    validCount: records.length - invalid.length,
    invalid,
    incomplete,
    duplicates,
    validations,
  };
}
