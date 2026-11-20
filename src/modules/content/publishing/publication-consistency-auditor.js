import { ContentStatus } from '../constants.js';
import { ContentRepository } from '../content-repository.js';
import {
  PublicationLifecycleService,
  PublicationOutcome,
} from './publication-lifecycle.js';

/**
 * Read-only consistency auditor for durable publication records.
 *
 * It never updates records and never performs an Instagram action. Any repair
 * must be an explicit, separate operation through the lifecycle service.
 */
export class PublicationConsistencyAuditor {
  /**
   * @param {{
   *   database: import('../../../storage/database.js').Database,
   *   repository?: ContentRepository,
   *   lifecycle?: PublicationLifecycleService,
   *   nowFn?: () => Date,
   * }} options
   */
  constructor(options) {
    const database = options.database ?? options.repository?.db;
    if (!database) throw new Error('PublicationConsistencyAuditor requires a database');
    this.db = database;
    this.repository =
      options.repository ?? new ContentRepository(database);
    this.lifecycle =
      options.lifecycle ??
      new PublicationLifecycleService({
        database,
        repository: this.repository,
        nowFn: options.nowFn,
      });
    this._now = options.nowFn ?? (() => new Date());
  }

  /**
   * @param {{ operationId?: string|null, staleTaskMs?: number }} [options]
   * @returns {{
   *   ok: boolean,
   *   generatedAt: string,
   *   summary: {operations: number, consistent: number, critical: number, warnings: number, info: number},
   *   issues: Array<{
   *     severity: 'critical'|'warning'|'info',
   *     code: string,
   *     operationId: string|null,
   *     contentId: string|null,
   *     taskId: string|null,
   *     accountId: string|null,
   *     problem: string,
   *     expected: unknown,
   *     actual: unknown,
   *     suggestedAction: string,
   *   }>,
   * }}
   */
  audit(options = {}) {
    const issues = [];
    const add = (severity, code, problem, details = {}) => {
      issues.push({
        severity,
        code,
        operationId: details.operationId ?? null,
        contentId: details.contentId ?? null,
        taskId: details.taskId ?? null,
        accountId: details.accountId ?? null,
        problem,
        expected: details.expected ?? null,
        actual: details.actual ?? null,
        suggestedAction:
          details.suggestedAction ??
          'Inspect the durable operation and use the lifecycle service for any repair.',
      });
    };

    const operations = options.operationId
      ? this.db.raw
          .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
          .all(String(options.operationId))
      : this.db.raw
          .prepare(
            'SELECT * FROM story_publish_operations ORDER BY created_at ASC, rowid ASC',
          )
          .all();

    const latestOperationByContent = new Map();
    for (const operation of operations) {
      latestOperationByContent.set(operation.content_id, operation.id);
    }

    let consistent = 0;
    const seenOperationIds = new Set();

    for (const operation of operations) {
      if (seenOperationIds.has(operation.id)) {
        add('critical', 'DUPLICATE_OPERATION_ROW', 'Operation ID appears more than once.', {
          operationId: operation.id,
          contentId: operation.content_id,
          expected: 'unique operation ID',
          actual: 'duplicate row',
        });
        continue;
      }
      seenOperationIds.add(operation.id);
      const state = this.lifecycle.getPublicationState({
        operationId: operation.id,
        contentId: operation.content_id,
      });
      const content = state.content;
      const history = state.history;
      const accountId = state.accountId;
      const isLatestForContent =
        latestOperationByContent.get(operation.content_id) === operation.id;
      const base = {
        operationId: operation.id,
        contentId: operation.content_id,
        accountId,
      };
      const before = issues.length;

      if (!content) {
        add('critical', 'MISSING_CONTENT', 'Operation references a missing content item.', {
          ...base,
          expected: operation.content_id,
          actual: null,
          suggestedAction: 'Restore or quarantine the operation; do not publish.',
        });
      }

      if (!history) {
        add('critical', 'MISSING_PUBLISHING_HISTORY', 'Operation has no matching publishing history row.', {
          ...base,
          expected: `request_id=${operation.id}`,
          actual: null,
        });
      }

      const historicalContentCodes = new Set([
        'FAILED_OPERATION_CONTENT_PUBLISHED',
        'UNCERTAIN_OPERATION_CONTENT_NOT_ATTENTION',
        'SUCCEEDED_HISTORY_CONTENT_NOT_PUBLISHED',
      ]);
      for (const contradiction of state.contradictions) {
        // A non-latest attempt is historical. Its own records are still
        // validated, but the content may have been published/resolved by a
        // later operation. Do not flag that as a contradiction.
        if (!isLatestForContent && historicalContentCodes.has(contradiction.code)) {
          continue;
        }
        add('critical', contradiction.code, contradiction.message, {
          ...base,
          expected: 'consistent operation/content/history outcomes',
          actual: state.outcome,
        });
      }

      const canonical = operation.publication_outcome ?? state.outcome;
      if (!operation.publication_outcome) {
        add('warning', 'MISSING_CANONICAL_OUTCOME', 'Operation has no canonical publication_outcome.', {
          ...base,
          expected: state.outcome,
          actual: null,
          suggestedAction: 'Run the lifecycle backfill/migration or transition through the lifecycle service.',
        });
      } else if (state.outcome && operation.publication_outcome !== state.outcome) {
        add('critical', 'OPERATION_OUTCOME_MISMATCH', 'Operation publication_outcome disagrees with its state.', {
          ...base,
          expected: state.outcome,
          actual: operation.publication_outcome,
        });
      }

      if (history) {
        if (!history.publication_outcome) {
          add('warning', 'MISSING_HISTORY_OUTCOME', 'Publishing history has no canonical publication_outcome.', {
            ...base,
            expected: state.outcome,
            actual: null,
          });
        } else if (state.outcome && history.publication_outcome !== state.outcome) {
          add('critical', 'HISTORY_OUTCOME_MISMATCH', 'Publishing history publication_outcome disagrees with the operation.', {
            ...base,
            expected: state.outcome,
            actual: history.publication_outcome,
          });
        }
      }

      if (operation.publication_outcome === PublicationOutcome.PUBLICATION_CONFIRMED) {
        if (
          ![ContentStatus.PUBLISHED, ContentStatus.EXPIRED].includes(content?.status)
        ) {
          add('critical', 'CONFIRMED_CONTENT_NOT_PUBLISHED', 'Confirmed operation content is not PUBLISHED/EXPIRED.', {
            ...base,
            expected: 'PUBLISHED or EXPIRED',
            actual: content?.status ?? null,
          });
        }
        if (history && history.status !== 'SUCCEEDED') {
          add('critical', 'CONFIRMED_HISTORY_NOT_SUCCEEDED', 'Confirmed operation history is not SUCCEEDED.', {
            ...base,
            expected: 'SUCCEEDED',
            actual: history.status,
          });
        }
      }

      if (operation.publication_outcome === PublicationOutcome.PUBLICATION_UNCERTAIN) {
        if (isLatestForContent && content?.status !== ContentStatus.NEEDS_ATTENTION) {
          add('critical', 'UNCERTAIN_CONTENT_NOT_ATTENTION', 'Uncertain operation content is not NEEDS_ATTENTION.', {
            ...base,
            expected: 'NEEDS_ATTENTION',
            actual: content?.status ?? null,
          });
        }
        if (!operation.share_intent_at && !operation.share_clicked_at) {
          add('warning', 'UNCERTAIN_WITHOUT_SHARE_EVIDENCE', 'Uncertain operation has no recorded Share intent/click.', {
            ...base,
            expected: 'Share intent or click evidence',
            actual: null,
            suggestedAction: 'Inspect whether the operation should be PUBLISH_FAILED.',
          });
        }
      }

      if (operation.publication_outcome === PublicationOutcome.PUBLISH_FAILED) {
        if (isLatestForContent && content?.status === ContentStatus.PUBLISHED) {
          add('critical', 'FAILED_CONTENT_PUBLISHED', 'Failed operation content is PUBLISHED.', {
            ...base,
            expected: 'not PUBLISHED',
            actual: content.status,
          });
        }
        if (
          (operation.share_intent_at || operation.share_clicked_at) &&
          !operation.reconciled_at
        ) {
          add('critical', 'FAILED_AFTER_SHARE_WITHOUT_RECONCILIATION', 'Operation has Share evidence but is marked failed.', {
            ...base,
            expected: 'PUBLICATION_UNCERTAIN or verified reconciliation',
            actual: 'PUBLISH_FAILED',
            suggestedAction: 'Do not retry. Reconcile only with conclusive evidence.',
          });
        }
      }

      if (
        (operation.share_intent_at || operation.share_clicked_at) &&
        Number(operation.retryable) === 1
      ) {
        add('critical', 'SHARE_EVIDENCE_RETRYABLE', 'Operation has Share evidence but is retryable.', {
          ...base,
          expected: 0,
          actual: 1,
          suggestedAction: 'Disable automatic retry and inspect the account.',
        });
      }
      if (
        [PublicationOutcome.PUBLICATION_CONFIRMED, PublicationOutcome.PUBLICATION_UNCERTAIN].includes(
          operation.publication_outcome,
        ) &&
        Number(operation.retryable) === 1
      ) {
        add('critical', 'TERMINAL_OUTCOME_RETRYABLE', 'Confirmed/uncertain operation is marked retryable.', {
          ...base,
          expected: 0,
          actual: 1,
        });
      }

      const lifecycleEvents = this.db.raw
        .prepare(
          `SELECT * FROM publication_lifecycle_events
           WHERE operation_id = ? ORDER BY at ASC`,
        )
        .all(operation.id);
      const reconciliationEvents = this.db.raw
        .prepare(
          `SELECT * FROM story_operation_events
           WHERE operation_id = ? AND event = 'RECONCILIATION_COMPLETED'
           ORDER BY at ASC`,
        )
        .all(operation.id);
      if (lifecycleEvents.length === 0 && reconciliationEvents.length === 0) {
        add('warning', 'MISSING_AUDIT_EVENT', 'Operation has no lifecycle or reconciliation audit event.', {
          ...base,
          expected: 'at least one audit event',
          actual: 0,
        });
      }
      for (let i = 1; i < lifecycleEvents.length; i += 1) {
        const previous = lifecycleEvents[i - 1];
        const current = lifecycleEvents[i];
        if (
          previous.new_outcome &&
          current.previous_outcome &&
          previous.new_outcome !== current.previous_outcome
        ) {
          add('warning', 'INVALID_TRANSITION_HISTORY', 'Lifecycle event chain has a broken previous/next outcome.', {
            ...base,
            expected: previous.new_outcome,
            actual: current.previous_outcome,
          });
        }
      }
      const latestEvent = lifecycleEvents[lifecycleEvents.length - 1] ?? null;
      if (
        latestEvent?.new_outcome &&
        operation.publication_outcome &&
        latestEvent.new_outcome !== operation.publication_outcome
      ) {
        add('warning', 'LIFECYCLE_EVENT_OUTCOME_STALE', 'Latest lifecycle event outcome differs from the operation.', {
          ...base,
          expected: operation.publication_outcome,
          actual: latestEvent.new_outcome,
        });
      }

      const historyResult = safeJson(history?.result_json);
      if (historyResult?.reconciliation) {
        if (!operation.reconciled_at || !operation.reconciled_by) {
          add('warning', 'RECONCILIATION_METADATA_MISSING', 'History has reconciliation evidence, but operation metadata is incomplete.', {
            ...base,
            expected: 'reconciled_at and reconciled_by',
            actual: {
              reconciled_at: operation.reconciled_at ?? null,
              reconciled_by: operation.reconciled_by ?? null,
            },
          });
        }
      }

      if (issues.length === before) consistent += 1;
    }

    // Duplicate operation references.
    const duplicateKeys = this.db.raw
      .prepare(
        `SELECT idempotency_key, COUNT(*) AS n
         FROM story_publish_operations
         WHERE idempotency_key IS NOT NULL AND share_intent_at IS NOT NULL
         GROUP BY idempotency_key HAVING COUNT(*) > 1`,
      )
      .all();
    for (const row of duplicateKeys) {
      add('critical', 'DUPLICATE_SHARE_INTENT_OPERATION', 'Multiple operations share an idempotency key and Share intent.', {
        expected: 'one operation per idempotency key',
        actual: { idempotencyKey: row.idempotency_key, count: Number(row.n) },
        suggestedAction: 'Stop. Inspect which operation actually published; never create another.',
      });
    }

    const duplicateMedia = this.db.raw
      .prepare(
        `SELECT content_id, media_checksum_sha256, COUNT(*) AS n
         FROM story_publish_operations
         WHERE media_checksum_sha256 IS NOT NULL AND share_intent_at IS NOT NULL
         GROUP BY content_id, media_checksum_sha256 HAVING COUNT(*) > 1`,
      )
      .all();
    for (const row of duplicateMedia) {
      add('critical', 'DUPLICATE_MEDIA_OPERATION', 'Multiple operations share content/media and a Share intent.', {
        contentId: row.content_id,
        expected: 'one Share operation per content/media',
        actual: { checksum: row.media_checksum_sha256, count: Number(row.n) },
        suggestedAction: 'Stop. Never create another Share for this media.',
      });
    }

    // Stale task detection.
    const staleTaskMs = Number(options.staleTaskMs ?? 60_000);
    const cutoff = new Date(this._now().getTime() - staleTaskMs).toISOString();
    const staleTasks = this.db.raw
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'RUNNING'
           AND claimed_at IS NOT NULL AND claimed_at < ?`,
      )
      .all(cutoff);
    for (const task of staleTasks) {
      add(
        task.side_effect_started ? 'warning' : 'info',
        task.side_effect_started ? 'STALE_SIDE_EFFECT_TASK' : 'STALE_TASK',
        task.side_effect_started
          ? 'A task with a possible external side effect is still RUNNING past the stale threshold.'
          : 'A task is still RUNNING past the stale threshold.',
        {
          taskId: task.id,
          expected: 'recover or finish',
          actual: { status: task.status, claimedAt: task.claimed_at, sideEffectStarted: Boolean(task.side_effect_started) },
          suggestedAction:
            'Inspect the task and operation. Never blind-retry after a Share side effect.',
        },
      );
    }

    const summary = {
      operations: operations.length,
      consistent,
      critical: issues.filter((issue) => issue.severity === 'critical').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
      info: issues.filter((issue) => issue.severity === 'info').length,
    };

    return {
      ok: summary.critical === 0,
      generatedAt: this._now().toISOString(),
      summary,
      issues,
    };
  }
}

function safeJson(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
