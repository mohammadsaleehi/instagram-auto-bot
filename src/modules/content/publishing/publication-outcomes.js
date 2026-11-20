/**
 * Canonical publication outcomes shared by content, history, operations,
 * adapters, workers, CLI, and the consistency auditor.
 *
 * These are publication semantics, not a replacement for entity-specific
 * statuses. Content status, attempt status, task status, and Story state keep
 * their own responsibilities and map into these outcomes.
 */
export const PublicationOutcome = Object.freeze({
  PENDING: 'PENDING',
  VALIDATING: 'VALIDATING',
  READY: 'READY',
  PUBLISHING: 'PUBLISHING',
  PUBLICATION_CONFIRMED: 'PUBLICATION_CONFIRMED',
  PUBLICATION_UNCERTAIN: 'PUBLICATION_UNCERTAIN',
  PUBLISH_FAILED: 'PUBLISH_FAILED',
  CANCELLED: 'CANCELLED',
});

export const PUBLICATION_OUTCOMES = Object.freeze(Object.values(PublicationOutcome));

export const PUBLICATION_TERMINAL_OUTCOMES = Object.freeze([
  PublicationOutcome.PUBLICATION_CONFIRMED,
  PublicationOutcome.CANCELLED,
]);

export const PUBLICATION_POST_SHARE_OUTCOMES = Object.freeze([
  PublicationOutcome.PUBLISHING,
  PublicationOutcome.PUBLICATION_CONFIRMED,
  PublicationOutcome.PUBLICATION_UNCERTAIN,
]);
