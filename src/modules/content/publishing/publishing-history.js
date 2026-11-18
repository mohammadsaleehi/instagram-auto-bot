/**
 * Thin helper around publishing_history persistence.
 */
export class PublishingHistoryService {
  /**
   * @param {import('../content-repository.js').ContentRepository} repository
   */
  constructor(repository) {
    this.repository = repository;
  }

  /**
   * @param {string} contentId
   * @param {{ limit?: number }} [options]
   */
  list(contentId, options = {}) {
    return this.repository.listPublishingHistory(contentId, options);
  }

  /**
   * @param {string} idempotencyKey
   */
  findByIdempotencyKey(idempotencyKey) {
    return this.repository.findPublishingHistoryByIdempotency(idempotencyKey);
  }
}
