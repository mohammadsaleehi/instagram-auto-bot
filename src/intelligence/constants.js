/**
 * Intelligence Core domain constants.
 */

export const IntelligenceError = class extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: unknown, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'IntelligenceError';
    this.code = options.code ?? 'INTELLIGENCE_ERROR';
    this.details = options.details ?? null;
  }
};

export const ContextKind = Object.freeze({
  BRAND: 'brand',
  BUSINESS: 'business',
  STRATEGY: 'strategy',
  AUDIENCE: 'audience',
  PRODUCT: 'product',
  PERFORMANCE: 'performance',
  COMPOSITE: 'composite',
});

export const CONTEXT_KINDS = Object.freeze(Object.values(ContextKind));

export const InstructionType = Object.freeze({
  PERFORMANCE_ANALYSIS: 'performance_analysis',
  DECISION: 'decision',
  PLANNING: 'planning',
  EXECUTION: 'execution',
  REPORTING: 'reporting',
  CONTEXT_MANAGEMENT: 'context_management',
  EVALUATION: 'evaluation',
  CLARIFICATION: 'clarification',
  UNKNOWN: 'unknown',
});

export const INSTRUCTION_TYPES = Object.freeze(Object.values(InstructionType));

export const InstructionStatus = Object.freeze({
  RECEIVED: 'RECEIVED',
  PARSED: 'PARSED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  ANALYZING: 'ANALYZING',
  DECIDED: 'DECIDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

export const DecisionStatus = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
  FAILED: 'FAILED',
});

export const PlanStatus = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  READY: 'READY',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

export const PlanStepStatus = Object.freeze({
  PENDING: 'PENDING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  BLOCKED: 'BLOCKED',
});

export const ApprovalStatus = Object.freeze({
  NONE: 'NONE',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  INVALIDATED: 'INVALIDATED',
});

export const ApprovalAction = Object.freeze({
  SUBMIT: 'SUBMIT',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  EXPIRE: 'EXPIRE',
  INVALIDATE: 'INVALIDATE',
});

export const PermissionAction = Object.freeze({
  READ_CONTEXT: 'read_context',
  SEARCH_HISTORY: 'search_history',
  ANALYZE: 'analyze',
  GENERATE_REPORT: 'generate_report',
  CREATE_RECOMMENDATION: 'create_recommendation',
  CREATE_DRAFT: 'create_draft',
  CREATE_PLAN: 'create_plan',
  EXECUTE_INTERNAL_TOOL: 'execute_internal_tool',
  PUBLISH_CONTENT: 'publish_content',
  SEND_MESSAGE: 'send_message',
  CHANGE_PRICE: 'change_price',
  CREATE_DISCOUNT: 'create_discount',
  CHANGE_STRATEGY: 'change_strategy',
  CHANGE_BUDGET: 'change_budget',
  DELETE_CONTENT: 'delete_content',
  SENSITIVE_COMMERCIAL: 'sensitive_commercial',
});

export const AI_PROVIDER = Object.freeze({
  OPENROUTER: 'openrouter',
  MOCK: 'mock',
});

export const INTELLIGENCE_EXECUTE_TASK_TYPE = 'intelligence.execute';

export const DEFAULT_PROMPT_VERSION = 'intelligence.decision.v1';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const DEFAULT_AI_MAX_TOOL_ITERATIONS = 8;
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_AI_MAX_RETRIES = 2;

/** Actions that never require owner approval when permitted. */
export const AUTO_ALLOWED_ACTIONS = Object.freeze([
  PermissionAction.READ_CONTEXT,
  PermissionAction.SEARCH_HISTORY,
  PermissionAction.ANALYZE,
  PermissionAction.GENERATE_REPORT,
  PermissionAction.CREATE_RECOMMENDATION,
  PermissionAction.CREATE_DRAFT,
  PermissionAction.CREATE_PLAN,
  PermissionAction.EXECUTE_INTERNAL_TOOL,
]);

/** Actions that always require owner approval. */
export const APPROVAL_REQUIRED_ACTIONS = Object.freeze([
  PermissionAction.PUBLISH_CONTENT,
  PermissionAction.SEND_MESSAGE,
  PermissionAction.CHANGE_PRICE,
  PermissionAction.CREATE_DISCOUNT,
  PermissionAction.CHANGE_STRATEGY,
  PermissionAction.CHANGE_BUDGET,
  PermissionAction.DELETE_CONTENT,
  PermissionAction.SENSITIVE_COMMERCIAL,
]);
