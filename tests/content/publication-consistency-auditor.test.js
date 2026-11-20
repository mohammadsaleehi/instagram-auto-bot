import { describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { ContentRepository } from '../../src/modules/content/content-repository.js';
import { TaskRepository } from '../../src/storage/repositories/task-repository.js';
import {
  ApprovalStatus,
  ContentStatus,
  ContentType,
} from '../../src/modules/content/constants.js';
import { PublicationConsistencyAuditor } from '../../src/modules/content/publishing/publication-consistency-auditor.js';

const NOW = new Date('2026-11-20T00:00:00.000Z');

function setup(overrides = {}) {
  const database = new Database({ filePath: ':memory:' });
  database.open();
  const repository = new ContentRepository(database, { nowFn: () => NOW });
  const content = repository.create({
    id: 'content-audit',
    title: 'Audit Story',
    contentType: ContentType.STORY,
    status: overrides.contentStatus ?? ContentStatus.PUBLISHED,
    approvalStatus: ApprovalStatus.APPROVED,
    idempotencyKey: 'content-publish:audit',
  });
  const operationId = 'op-audit';
  const historyStatus = overrides.historyStatus ?? 'SUCCEEDED';
  database.raw
    .prepare(
      `INSERT INTO story_publish_operations (
        id, content_id, attempt_id, state, state_entered_at, surface,
        media_path, media_checksum_sha256, idempotency_key,
        share_intent_at, share_clicked_at, share_click_result,
        failure_code, retryable, evidence_json, diagnostics_dir,
        created_at, updated_at, completed_at,
        reconciled_at, reconciled_by, reconciliation_reason,
        previous_state, previous_failure_code, publication_outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      operationId,
      content.id,
      'attempt-1',
      overrides.operationState ?? 'PUBLICATION_CONFIRMED',
      '2026-11-19T15:50:25.365Z',
      'mobile-web-portrait',
      '/tmp/js.jpg',
      'checksum-audit',
      'content-publish:audit',
      overrides.shareIntentAt ?? '2026-11-19T15:48:37.377Z',
      overrides.shareClickedAt ?? '2026-11-19T15:48:37.699Z',
      'dispatched',
      overrides.failureCode ?? null,
      overrides.retryable ?? 0,
      JSON.stringify({ accountHandle: 'test_account' }),
      null,
      '2026-11-19T15:48:25.337Z',
      '2026-11-19T15:50:25.365Z',
      '2026-11-19T15:50:25.365Z',
      overrides.reconciledAt ?? '2026-11-19T16:43:21.597Z',
      overrides.reconciledBy ?? 'phase-a-reconciliation',
      'verified',
      'PUBLICATION_UNCERTAIN',
      'SHARE_NOT_CONFIRMED',
      overrides.publicationOutcome ?? 'PUBLICATION_CONFIRMED',
    );

  if (overrides.includeHistory !== false) {
    const history = repository.addPublishingHistory({
      contentId: content.id,
      attemptNumber: 1,
      adapter: 'playwright',
      status: historyStatus,
      idempotencyKey: 'content-publish:audit',
      requestId: operationId,
      dryRun: false,
      result: overrides.historyResult ?? {
        reconciliation: { previousStatus: 'UNCERTAIN', reconciledBy: 'phase-a-reconciliation' },
      },
      completedAt: '2026-11-19T15:50:25.578Z',
    });
    database.raw
      .prepare('UPDATE publishing_history SET publication_outcome = ? WHERE id = ?')
      .run(
        overrides.historyOutcome ??
          (historyStatus === 'SUCCEEDED'
            ? 'PUBLICATION_CONFIRMED'
            : historyStatus === 'UNCERTAIN'
              ? 'PUBLICATION_UNCERTAIN'
              : historyStatus === 'DRY_RUN'
                ? 'READY'
                : 'PUBLISH_FAILED'),
        history.id,
      );
  }

  if (overrides.lifecycleEvent !== false) {
    database.raw
      .prepare(
        `INSERT INTO publication_lifecycle_events (
          id, operation_id, content_id, history_id, task_id, at, actor, event,
          previous_outcome, new_outcome, reason, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'audit-event-1',
        operationId,
        content.id,
        null,
        null,
        '2026-11-19T16:43:21.597Z',
        'migration-007',
        'MIGRATION_BACKFILL',
        null,
        overrides.publicationOutcome ?? 'PUBLICATION_CONFIRMED',
        'backfill',
        '{}',
      );
  }

  if (overrides.duplicateOperation) {
    database.raw
      .prepare(
        `INSERT INTO story_publish_operations (
          id, content_id, attempt_id, state, state_entered_at, surface,
          media_path, media_checksum_sha256, idempotency_key,
          share_intent_at, share_clicked_at, share_click_result,
          failure_code, retryable, evidence_json, diagnostics_dir,
          created_at, updated_at, completed_at, publication_outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'op-audit-duplicate',
        content.id,
        'attempt-1',
        'PUBLICATION_UNCERTAIN',
        '2026-11-19T15:50:25.365Z',
        'mobile-web-portrait',
        '/tmp/js.jpg',
        'checksum-audit',
        'content-publish:audit',
        '2026-11-19T15:48:37.377Z',
        '2026-11-19T15:48:37.699Z',
        'dispatched',
        'SHARE_NOT_CONFIRMED',
        0,
        JSON.stringify({ accountHandle: 'test_account' }),
        null,
        '2026-11-19T15:48:25.337Z',
        '2026-11-19T15:50:25.365Z',
        '2026-11-19T15:50:25.365Z',
        'PUBLICATION_UNCERTAIN',
      );
  }

  const auditor = new PublicationConsistencyAuditor({
    database,
    repository,
    nowFn: () => NOW,
  });
  return { database, repository, content, operationId, auditor };
}

describe('PublicationConsistencyAuditor', () => {
  it('reports a consistent confirmed operation and makes no writes', () => {
    const ctx = setup();
    const before = ctx.database.raw
      .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
      .get(ctx.operationId);
    const result = ctx.auditor.audit({ operationId: ctx.operationId });
    expect(result.ok).toBe(true);
    expect(result.summary.operations).toBe(1);
    expect(result.summary.consistent).toBe(1);
    expect(result.issues).toEqual([]);
    const after = ctx.database.raw
      .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
      .get(ctx.operationId);
    expect(after).toEqual(before);
  });

  it('detects contradictory confirmed records and retryability', () => {
    const ctx = setup({
      contentStatus: ContentStatus.NEEDS_ATTENTION,
      historyStatus: 'UNCERTAIN',
      retryable: 1,
      lifecycleEvent: false,
    });
    const result = ctx.auditor.audit({ operationId: ctx.operationId });
    expect(result.ok).toBe(false);
    expect(result.summary.critical).toBeGreaterThan(0);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'CONFIRMED_OPERATION_CONTENT_NOT_PUBLISHED',
        'CONFIRMED_OPERATION_HISTORY_NOT_SUCCEEDED',
        'SHARE_EVIDENCE_RETRYABLE',
        'CONFIRMED_CONTENT_NOT_PUBLISHED',
        'CONFIRMED_HISTORY_NOT_SUCCEEDED',
      ]),
    );
  });

  it('detects missing publishing history', () => {
    const ctx = setup({ includeHistory: false });
    const result = ctx.auditor.audit({ operationId: ctx.operationId });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'MISSING_PUBLISHING_HISTORY',
    );
  });

  it('detects duplicate Share-intent operations', () => {
    const ctx = setup({ duplicateOperation: true });
    const result = ctx.auditor.audit();
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'DUPLICATE_SHARE_INTENT_OPERATION',
    );
    expect(result.issues.map((issue) => issue.code)).toContain(
      'DUPLICATE_MEDIA_OPERATION',
    );
  });

  it('reports stale side-effect tasks as warnings', () => {
    const ctx = setup();
    const tasks = new TaskRepository(ctx.database);
    const { task } = tasks.create({ type: 'engine.health-check', payload: {} });
    ctx.database.raw
      .prepare(
        `UPDATE tasks SET status = 'RUNNING', side_effect_started = 1,
         claimed_by = 'dead', claimed_at = ? WHERE id = ?`,
      )
      .run(new Date(NOW.getTime() - 120_000).toISOString(), task.id);
    const result = ctx.auditor.audit({ operationId: ctx.operationId, staleTaskMs: 60_000 });
    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'STALE_SIDE_EFFECT_TASK',
    );
    expect(result.summary.warnings).toBeGreaterThan(0);
  });

  it('returns no operations for a nonexistent filter', () => {
    const ctx = setup();
    const result = ctx.auditor.audit({ operationId: 'does-not-exist' });
    expect(result.ok).toBe(true);
    expect(result.summary.operations).toBe(0);
  });
});
