import { TaskStatus } from './constants.js';

/**
 * Allowed task status transitions.
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [TaskStatus.PENDING]: Object.freeze(
    new Set([
      TaskStatus.RUNNING,
      TaskStatus.CANCELLED,
      TaskStatus.NEEDS_ATTENTION,
    ]),
  ),
  [TaskStatus.RUNNING]: Object.freeze(
    new Set([
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.PENDING,
      TaskStatus.CANCELLED,
      TaskStatus.NEEDS_ATTENTION,
    ]),
  ),
  [TaskStatus.FAILED]: Object.freeze(new Set([TaskStatus.PENDING])),
  [TaskStatus.NEEDS_ATTENTION]: Object.freeze(
    new Set([TaskStatus.PENDING, TaskStatus.CANCELLED]),
  ),
  [TaskStatus.COMPLETED]: Object.freeze(new Set()),
  [TaskStatus.CANCELLED]: Object.freeze(new Set()),
});

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * @param {string} from
 * @param {string} to
 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
