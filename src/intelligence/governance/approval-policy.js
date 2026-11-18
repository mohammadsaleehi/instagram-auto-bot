import {
  APPROVAL_REQUIRED_ACTIONS,
  AUTO_ALLOWED_ACTIONS,
  PermissionAction,
} from '../constants.js';

/**
 * Default owner-centric approval policy for Phase 1.
 */
export function createDefaultApprovalPolicy() {
  return {
    version: 1,
    autoAllowed: [...AUTO_ALLOWED_ACTIONS],
    approvalRequired: [...APPROVAL_REQUIRED_ACTIONS],
    denied: [],
    notes:
      'Phase 1 establishes governance only. External Instagram publishing and messaging remain blocked until later phases.',
  };
}

/**
 * @param {string} action
 * @param {ReturnType<typeof createDefaultApprovalPolicy>} policy
 */
export function classifyAction(action, policy) {
  const normalized = String(action);
  if (policy.denied.includes(normalized)) {
    return { allowed: false, approvalRequired: false, reason: 'Action is denied by policy' };
  }
  if (policy.approvalRequired.includes(normalized)) {
    return {
      allowed: true,
      approvalRequired: true,
      reason: 'Owner approval is required before execution',
    };
  }
  if (policy.autoAllowed.includes(normalized)) {
    return {
      allowed: true,
      approvalRequired: false,
      reason: 'Action is permitted without approval',
    };
  }
  // Unknown actions require approval by default.
  return {
    allowed: true,
    approvalRequired: true,
    reason: 'Unknown action requires owner approval by default',
  };
}

export { PermissionAction };
