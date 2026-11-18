import { ContentError, ContentStatus, ApprovalStatus } from './constants.js';

/**
 * Allowed status transitions for content items.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [ContentStatus.DRAFT]: Object.freeze([
    ContentStatus.READY_FOR_REVIEW,
    ContentStatus.CANCELLED,
  ]),
  [ContentStatus.READY_FOR_REVIEW]: Object.freeze([
    ContentStatus.APPROVED,
    ContentStatus.REJECTED,
    ContentStatus.DRAFT,
    ContentStatus.CANCELLED,
  ]),
  [ContentStatus.APPROVED]: Object.freeze([
    ContentStatus.SCHEDULED,
    ContentStatus.PUBLISHING,
    ContentStatus.DRAFT,
    ContentStatus.CANCELLED,
  ]),
  [ContentStatus.REJECTED]: Object.freeze([
    ContentStatus.DRAFT,
    ContentStatus.CANCELLED,
  ]),
  [ContentStatus.SCHEDULED]: Object.freeze([
    ContentStatus.PUBLISHING,
    ContentStatus.APPROVED,
    ContentStatus.CANCELLED,
  ]),
  [ContentStatus.PUBLISHING]: Object.freeze([
    ContentStatus.PUBLISHED,
    ContentStatus.FAILED,
    ContentStatus.NEEDS_ATTENTION,
  ]),
  [ContentStatus.PUBLISHED]: Object.freeze([ContentStatus.EXPIRED]),
  [ContentStatus.FAILED]: Object.freeze([
    ContentStatus.APPROVED,
    ContentStatus.DRAFT,
    ContentStatus.CANCELLED,
  ]),
  [ContentStatus.NEEDS_ATTENTION]: Object.freeze([
    ContentStatus.APPROVED,
    ContentStatus.DRAFT,
    ContentStatus.CANCELLED,
    ContentStatus.PUBLISHED,
  ]),
  [ContentStatus.CANCELLED]: Object.freeze([ContentStatus.DRAFT]),
  [ContentStatus.EXPIRED]: Object.freeze([]),
});

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * @param {string} from
 * @param {string} to
 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new ContentError(`Invalid content status transition: ${from} → ${to}`, {
      code: 'INVALID_STATUS_TRANSITION',
      details: { from, to },
    });
  }
}

/**
 * Editing approved / scheduled content returns the item to DRAFT and invalidates approval.
 * @param {string} status
 * @returns {boolean}
 */
export function editInvalidatesApproval(status) {
  return (
    status === ContentStatus.APPROVED ||
    status === ContentStatus.SCHEDULED ||
    status === ContentStatus.READY_FOR_REVIEW ||
    status === ContentStatus.REJECTED ||
    status === ContentStatus.FAILED ||
    status === ContentStatus.NEEDS_ATTENTION
  );
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isPublishableStatus(status) {
  return status === ContentStatus.APPROVED || status === ContentStatus.SCHEDULED;
}

/**
 * @param {string} approvalStatus
 * @returns {boolean}
 */
export function hasValidApproval(approvalStatus) {
  return approvalStatus === ApprovalStatus.APPROVED;
}
