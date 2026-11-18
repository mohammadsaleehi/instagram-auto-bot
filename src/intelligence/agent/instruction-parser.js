import { InstructionType, PermissionAction } from '../constants.js';

/**
 * Convert free-form owner commands into structured instruction objects.
 * Does not invent missing business facts; flags ambiguities instead.
 *
 * @param {string} rawText
 * @param {{ hasBrand?: boolean, hasBusiness?: boolean, hasStrategy?: boolean }} [contextAvailability]
 */
export function parseInstruction(rawText, contextAvailability = {}) {
  const text = String(rawText ?? '').trim();
  /** @type {string[]} */
  const ambiguities = [];
  /** @type {string[]} */
  const missingPrerequisites = [];
  /** @type {string[]} */
  const requiredPermissions = [];

  if (!text) {
    return {
      type: InstructionType.CLARIFICATION,
      target: null,
      period: null,
      requestedOutput: [],
      objective: null,
      ambiguities: ['Instruction text is empty'],
      missingPrerequisites: ['Provide a non-empty command'],
      requiredPermissions: [],
      rawText: text,
    };
  }

  const lower = text.toLowerCase();
  let type = InstructionType.UNKNOWN;
  if (/(analy[sz]e|compare|why|performance|pattern)/.test(lower)) {
    type = InstructionType.PERFORMANCE_ANALYSIS;
  } else if (/(plan|roadmap|steps|execution plan)/.test(lower)) {
    type = InstructionType.PLANNING;
  } else if (/(execute|implement|run|do )/.test(lower)) {
    type = InstructionType.EXECUTION;
  } else if (/(report|summarize|summary)/.test(lower)) {
    type = InstructionType.REPORTING;
  } else if (/(decide|decision|choose|select)/.test(lower)) {
    type = InstructionType.DECISION;
  } else if (/(context|brand|strategy|import)/.test(lower)) {
    type = InstructionType.CONTEXT_MANAGEMENT;
  } else if (/(evaluat|outcome|learn)/.test(lower)) {
    type = InstructionType.EVALUATION;
  }

  // Mixed analysis + plan commands are common in Phase 1 scenarios.
  if (
    type === InstructionType.PERFORMANCE_ANALYSIS &&
    /(plan|recommend|operational)/.test(lower)
  ) {
    type = InstructionType.PLANNING;
  }

  let target = null;
  if (/stor(y|ies)/.test(lower)) target = 'stories';
  else if (/reel/.test(lower)) target = 'reels';
  else if (/carousel/.test(lower)) target = 'carousels';
  else if (/post|feed|content/.test(lower)) target = 'content';
  else if (/account/.test(lower)) target = 'account';

  /** @type {{ current: string | null, comparison: string | null } | null} */
  let period = null;
  if (/last\s+7\s+days|past\s+week|previous\s+week|last\s+week/.test(lower)) {
    period = {
      current: 'last_7_days',
      comparison: /compar|previous|prior/.test(lower) ? 'previous_7_days' : null,
    };
  } else if (/last\s+30\s+days|past\s+month|last\s+month/.test(lower)) {
    period = {
      current: 'last_30_days',
      comparison: /compar|previous|prior/.test(lower) ? 'previous_30_days' : null,
    };
  } else if (/compar/.test(lower)) {
    period = { current: null, comparison: null };
    ambiguities.push('Comparison period was requested but not fully specified');
  }

  /** @type {string[]} */
  const requestedOutput = [];
  if (/analy/.test(lower)) requestedOutput.push('analysis');
  if (/conclusion|conclude|identify/.test(lower)) requestedOutput.push('conclusions');
  if (/recommend/.test(lower)) requestedOutput.push('recommendations');
  if (/plan/.test(lower)) requestedOutput.push('plan');
  if (/decision|decide/.test(lower)) requestedOutput.push('decision');
  if (requestedOutput.length === 0) requestedOutput.push('analysis');

  if (!target && type !== InstructionType.CONTEXT_MANAGEMENT) {
    ambiguities.push('Target entity is not explicit (stories, reels, content, account, etc.)');
  }
  if ((type === InstructionType.PERFORMANCE_ANALYSIS || type === InstructionType.PLANNING) && !period) {
    ambiguities.push('Time period is not explicit');
  }

  if (contextAvailability.hasBrand === false) {
    missingPrerequisites.push('Brand context is not registered');
  }
  if (contextAvailability.hasBusiness === false) {
    missingPrerequisites.push('Business context is not registered');
  }
  if (contextAvailability.hasStrategy === false) {
    missingPrerequisites.push('Strategy context is not registered');
  }

  requiredPermissions.push(PermissionAction.ANALYZE);
  if (requestedOutput.includes('plan') || type === InstructionType.PLANNING) {
    requiredPermissions.push(PermissionAction.CREATE_PLAN);
  }
  if (requestedOutput.includes('recommendations')) {
    requiredPermissions.push(PermissionAction.CREATE_RECOMMENDATION);
  }

  const needsClarification =
    type === InstructionType.UNKNOWN ||
    (ambiguities.length > 0 && missingPrerequisites.length > 0 && !target && !period);

  return {
    type: needsClarification && type === InstructionType.UNKNOWN
      ? InstructionType.CLARIFICATION
      : type,
    target,
    period,
    requestedOutput: [...new Set(requestedOutput)],
    objective: text,
    ambiguities,
    missingPrerequisites,
    requiredPermissions: [...new Set(requiredPermissions)],
    rawText: text,
  };
}
