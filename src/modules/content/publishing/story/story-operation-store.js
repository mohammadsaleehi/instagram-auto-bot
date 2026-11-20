import { STORY_FAILURE_CODES, StoryPublishState } from './story-states.js';

/**
 * Durable Story publication attempts.
 *
 * The `share_intent_at` column is the one-way crash-safety boundary: it is
 * written immediately before the single Share click. Once set, the operation
 * is never retryable, even if the browser crashes before recording a result.
 *
 * The intent write is a `BEGIN IMMEDIATE` transaction with a conflict query,
 * so two concurrent callers cannot both obtain a Share intent for the same
 * content, idempotency key, or media checksum.
 */
export class StoryOperationStore {
  /**
   * @param {{
   *   database: import('../../../../storage/database.js').Database,
   *   nowFn?: () => Date,
   * }} options
   */
  constructor(options) {
    if (!options?.database) {
      throw new Error('StoryOperationStore requires a database');
    }
    this.db = options.database;
    this._now = options.nowFn ?? (() => new Date());
  }

  /**
   * Create the durable attempt row before any browser work.
   *
   * @param {{
   *   operationId: string,
   *   contentId: string,
   *   attemptId?: string|null,
   *   state?: string,
   *   mediaPath: string,
   *   mediaChecksumSha256: string,
   *   idempotencyKey: string,
   *   diagnosticsDir?: string|null,
   *   evidence?: Record<string, unknown>|null,
   * }} input
   * @returns {Record<string, unknown>}
   */
  create(input) {
    const now = this._now().toISOString();
    const state = input.state ?? StoryPublishState.NAVIGATING_HOME;
    this.db.raw
      .prepare(
        `INSERT INTO story_publish_operations (
          id, content_id, attempt_id, state, state_entered_at, surface,
          media_path, media_checksum_sha256, idempotency_key, retryable,
          evidence_json, diagnostics_dir, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        input.operationId,
        input.contentId,
        input.attemptId ?? null,
        state,
        now,
        'mobile-web-portrait',
        input.mediaPath,
        input.mediaChecksumSha256,
        input.idempotencyKey,
        input.evidence ? JSON.stringify(input.evidence) : null,
        input.diagnosticsDir ?? null,
        now,
        now,
      );
    return this.get(input.operationId);
  }

  /**
   * @param {string} operationId
   * @returns {Record<string, unknown>|null}
   */
  get(operationId) {
    const row = this.db.raw
      .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
      .get(operationId);
    return row ?? null;
  }

  /**
   * @param {string} operationId
   * @param {string} state
   * @param {{ evidence?: Record<string, unknown>|null, failureCode?: string|null, retryable?: boolean }} [details]
   * @returns {Record<string, unknown>|null}
   */
  updateState(operationId, state, details = {}) {
    const now = this._now().toISOString();
    this.db.raw
      .prepare(
        `UPDATE story_publish_operations SET
          state = ?,
          state_entered_at = ?,
          updated_at = ?,
          evidence_json = COALESCE(?, evidence_json),
          failure_code = COALESCE(?, failure_code),
          retryable = COALESCE(?, retryable)
         WHERE id = ?`,
      )
      .run(
        state,
        now,
        now,
        details.evidence ? JSON.stringify(details.evidence) : null,
        details.failureCode ?? null,
        details.retryable === undefined ? null : details.retryable ? 1 : 0,
        operationId,
      );
    return this.get(operationId);
  }

  /**
   * Atomically obtain the single Share intent. Must be called immediately
   * before the one Share click. Throws if a prior intent exists for this
   * content, idempotency key, or media checksum.
   *
   * @param {{
   *   operationId: string,
   *   contentId: string,
   *   mediaChecksumSha256: string,
   *   idempotencyKey: string,
   *   fromState?: string,
   *   evidence?: Record<string, unknown>|null,
   * }} input
   * @returns {Record<string, unknown>}
   */
  recordShareIntent(input) {
    const now = this._now().toISOString();
    const fromState = input.fromState ?? StoryPublishState.PRE_SHARE_SNAPSHOT;
    this.db.raw.exec('BEGIN IMMEDIATE');
    try {
      const conflict = this.db.raw
        .prepare(
          `SELECT id, state, share_intent_at FROM story_publish_operations
           WHERE id <> ?
             AND share_intent_at IS NOT NULL
             AND (media_checksum_sha256 = ? OR idempotency_key = ? OR content_id = ?)
           LIMIT 1`,
        )
        .get(input.operationId, input.mediaChecksumSha256, input.idempotencyKey, input.contentId);
      if (conflict) {
        const error = new Error(
          `A Share intent is already recorded for this Story (operation ${conflict.id}).`,
        );
        // @ts-expect-error - attach structured code/details
        error.code = STORY_FAILURE_CODES.SHARE_ALREADY_RECORDED;
        // @ts-expect-error - attach structured code/details
        error.details = { conflictOperationId: conflict.id, conflictState: conflict.state };
        throw error;
      }

      const result = this.db.raw
        .prepare(
          `UPDATE story_publish_operations SET
            state = ?,
            state_entered_at = ?,
            share_intent_at = ?,
            updated_at = ?,
            evidence_json = COALESCE(?, evidence_json),
            retryable = 0
           WHERE id = ? AND share_intent_at IS NULL AND state = ?`,
        )
        .run(
          StoryPublishState.SHARE_ARMED,
          now,
          now,
          now,
          input.evidence ? JSON.stringify(input.evidence) : null,
          input.operationId,
          fromState,
        );

      if (Number(result.changes) !== 1) {
        const error = new Error('Share intent was not persisted; refusing to click Share.');
        // @ts-expect-error - attach structured code
        error.code = STORY_FAILURE_CODES.SHARE_INTENT_NOT_PERSISTED;
        throw error;
      }

      this.db.raw.exec('COMMIT');
    } catch (error) {
      try {
        this.db.raw.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw error;
    }
    return this.get(input.operationId);
  }

  /**
   * Record the dispatched click. This does not authorize a second click; it
   * only records that the one click happened.
   *
   * @param {string} operationId
   * @param {string} resultLabel
   * @returns {Record<string, unknown>|null}
   */
  recordShareClicked(operationId, resultLabel = 'dispatched') {
    const now = this._now().toISOString();
    const result = this.db.raw
      .prepare(
        `UPDATE story_publish_operations SET
          state = ?,
          state_entered_at = ?,
          share_clicked_at = ?,
          share_click_result = ?,
          updated_at = ?
         WHERE id = ? AND share_clicked_at IS NULL`,
      )
      .run(StoryPublishState.SHARE_INVOKED, now, now, resultLabel, now, operationId);
    if (Number(result.changes) !== 1) {
      const error = new Error('Share was already recorded for this operation.');
      // @ts-expect-error - attach structured code
      error.code = STORY_FAILURE_CODES.SHARE_ALREADY_RECORDED;
      throw error;
    }
    return this.get(operationId);
  }

  /**
   * @param {{
   *   operationId: string,
   *   state: string,
   *   failureCode?: string|null,
   *   evidence?: Record<string, unknown>|null,
   *   shareClickResult?: string|null,
   * }} input
   * @returns {Record<string, unknown>|null}
   */
  finish(input) {
    const now = this._now().toISOString();
    const retryable = input.state === StoryPublishState.PUBLISH_FAILED;
    this.db.raw
      .prepare(
        `UPDATE story_publish_operations SET
          state = ?,
          state_entered_at = ?,
          failure_code = ?,
          retryable = ?,
          evidence_json = COALESCE(?, evidence_json),
          share_click_result = COALESCE(?, share_click_result),
          completed_at = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.state,
        now,
        input.failureCode ?? null,
        retryable ? 1 : 0,
        input.evidence ? JSON.stringify(input.evidence) : null,
        input.shareClickResult ?? null,
        now,
        now,
        input.operationId,
      );
    return this.get(input.operationId);
  }

  /**
   * Preflight helper: has any operation already obtained a Share intent for
   * this media checksum?
   *
   * @param {string} mediaChecksumSha256
   * @returns {Record<string, unknown>|null}
   */
  findShareIntentByMediaChecksum(mediaChecksumSha256) {
    return (
      this.db.raw
        .prepare(
          `SELECT * FROM story_publish_operations
           WHERE media_checksum_sha256 = ? AND share_intent_at IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(mediaChecksumSha256) ?? null
    );
  }
}
