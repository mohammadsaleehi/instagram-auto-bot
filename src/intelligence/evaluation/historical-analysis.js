/**
 * Lightweight historical pattern helpers used by evaluation foundations.
 */

/**
 * @param {Array<{
 *   decisionDescription?: string,
 *   successStatus?: string | null,
 *   outcome?: string,
 * }>} records
 */
export function summarizeHistoricalOutcomes(records) {
  const total = records.length;
  const success = records.filter((item) => item.successStatus === 'success').length;
  const failed = records.filter((item) => item.successStatus === 'failed').length;
  const unknown = total - success - failed;

  /** @type {Map<string, number>} */
  const descriptionCounts = new Map();
  for (const item of records) {
    const key = String(item.decisionDescription ?? '').trim().toLowerCase();
    if (!key) continue;
    descriptionCounts.set(key, (descriptionCounts.get(key) ?? 0) + 1);
  }

  const recurring = [...descriptionCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([description, count]) => ({ description, count }));

  return {
    total,
    success,
    failed,
    unknown,
    recurring,
  };
}
