import { describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { ContentRepository } from '../../src/modules/content/content-repository.js';
import {
  ApprovalStatus,
  ContentStatus,
  ContentType,
} from '../../src/modules/content/constants.js';
import {
  PublicationLifecycleService,
  PublicationOutcome,
  assertPublicationTransition,
  derivePublicationOutcome,
} from '../../src/modules/content/publishing/publication-lifecycle.js';
import { classifyPublicationFailure } from '../../src/modules/content/publishing/publication-failure-classification.js';

const O = PublicationOutcome;
const NOW = new Date('2026-11-20T00:00:00.000Z');

function setup(overrides = {}) {
  const database = new Database({ filePath: ':memory:' });
  database.open();
  const repository = new ContentRepository(database, { nowFn: () => NOW });
  const content = repository.create({
    id: 'content-phase-b',
    title: 'Phase B Story',
    contentType: ContentType.STORY,
    status: overrides.contentStatus ?? ContentStatus.PUBLISHING,
    approvalStatus: ApprovalStatus.APPROVED,
    idempotencyKey: 'content-publish:phase-b',
  });
  const operationId = 'op-phase-b';
  if (overrides.hasOperation !== false) {
    database.raw
      .prepare(
        `INSERT INTO story_publish_operations (
          id, content_id, attempt_id, state, state_entered_at, surface,
          media_path, media_checksum_sha256, idempotency_key,
          share_intent_at, share_clicked_at, share_click_result,
          failure_code, retryable, evidence_json, diagnostics_dir,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        content.id,
        'attempt-1',
        overrides.operationState ?? 'SURFACE_READY',
        '2026-11-19T15:48:25.337Z',
        'mobile-web-portrait',
        '/tmp/js.jpg',
        'checksum-phase-b',
        'content-publish:phase-b',
        overrides.shareIntentAt ?? null,
        overrides.shareClickedAt ?? null,
        overrides.shareClickResult ?? null,
        overrides.failureCode ?? null,
        overrides.retryable ?? 0,
        JSON.stringify({ accountHandle: 'test_account' }),
        null,
        '2026-11-19T15:48:25.337Z',
        '2026-11-19T15:50:25.365Z',
        overrides.completedAt ?? null,
      );
  }
  const history = repository.addPublishingHistory({
    contentId: content.id,
    attemptNumber: 1,
    adapter: 'mock',
    status: overrides.historyStatus ?? 'STARTED',
    idempotencyKey: 'content-publish:phase-b',
    requestId: operationId,
    dryRun: overrides.historyStatus === 'DRY_RUN',
    completedAt: overrides.completedAt ?? null,
  });
  let idCounter = 0;
  const service = new PublicationLifecycleService({
    database,
    repository,
    nowFn: () => NOW,
    idFn: () => `lifecycle-event-${++idCounter}`,
  });
  return {
    database,
    repository,
    content,
    operationId: overrides.hasOperation === false ? null : operationId,
    history,
    service,
    events: () =>
      database.raw
        .prepare('SELECT * FROM publication_lifecycle_events ORDER BY at ASC')
        .all(),
    operation: () =>
      database.raw
        .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
        .get(operationId),
    historyRow: () =>
      database.raw
        .prepare('SELECT * FROM publishing_history WHERE id = ?')
        .get(history.id),
  };
}

function readyContext() {
  return setup({
    contentStatus: ContentStatus.APPROVED,
    historyStatus: 'DRY_RUN',
    operationState: 'EDITOR_READY',
    completedAt: null,
  });
}

function publishingContext(overrides = {}) {
  return setup({
    contentStatus: ContentStatus.PUBLISHING,
    historyStatus: 'STARTED',
    operationState: 'SURFACE_READY',
    ...overrides,
  });
}

function uncertainContext(overrides = {}) {
  return setup({
    contentStatus: ContentStatus.NEEDS_ATTENTION,
    historyStatus: 'UNCERTAIN',
    operationState: 'PUBLICATION_UNCERTAIN',
    shareIntentAt: '2026-11-19T15:48:37.377Z',
    shareClickedAt: '2026-11-19T15:48:37.699Z',
    shareClickResult: 'dispatched',
    failureCode: 'SHARE_NOT_CONFIRMED',
    completedAt: '2026-11-19T15:50:25.365Z',
    ...overrides,
  });
}

function confirmedContext(overrides = {}) {
  return setup({
    contentStatus: ContentStatus.PUBLISHED,
    historyStatus: 'SUCCEEDED',
    operationState: 'PUBLICATION_CONFIRMED',
    shareIntentAt: '2026-11-19T15:48:37.377Z',
    shareClickedAt: '2026-11-19T15:48:37.699Z',
    shareClickResult: 'dispatched',
    completedAt: '2026-11-19T15:50:25.365Z',
    ...overrides,
  });
}

function failedContext(overrides = {}) {
  return setup({
    contentStatus: ContentStatus.FAILED,
    historyStatus: 'FAILED',
    operationState: 'PUBLISH_FAILED',
    failureCode: 'HEADER_PLUS_NOT_FOUND',
    completedAt: '2026-11-19T15:42:23.772Z',
    ...overrides,
  });
}

function cancelledContext(overrides = {}) {
  return setup({
    contentStatus: ContentStatus.CANCELLED,
    historyStatus: 'CANCELLED',
    operationState: 'ABORTED',
    completedAt: '2026-11-19T15:42:23.772Z',
    ...overrides,
  });
}

describe('canonical publication lifecycle', () => {
  it('maps entity statuses to canonical outcomes without treating task completion as publication', () => {
    const confirmed = confirmedContext();
    const state = confirmed.service.getPublicationState({
      operationId: confirmed.operationId,
      contentId: confirmed.content.id,
    });
    expect(state.outcome).toBe(O.PUBLICATION_CONFIRMED);
    expect(state.contradictions).toEqual([]);

    const fromTask = derivePublicationOutcome({
      task: { status: 'COMPLETED' },
    });
    expect(fromTask.outcome).toBeNull();
    expect(fromTask.source).toBe('task');

    const inconsistent = setup({
      contentStatus: ContentStatus.NEEDS_ATTENTION,
      historyStatus: 'UNCERTAIN',
      operationState: 'PUBLICATION_CONFIRMED',
    });
    const derived = derivePublicationOutcome({
      operation: inconsistent.operation(),
      content: inconsistent.repository.getById(inconsistent.content.id),
      history: inconsistent.historyRow(),
    });
    expect(derived.outcome).toBe(O.PUBLICATION_CONFIRMED);
    expect(derived.contradictions.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'CONFIRMED_OPERATION_CONTENT_NOT_PUBLISHED',
        'CONFIRMED_OPERATION_HISTORY_NOT_SUCCEEDED',
      ]),
    );
  });

  it('enforces the legal transition matrix and special guards', () => {
    expect(() => assertPublicationTransition(O.PENDING, O.VALIDATING)).not.toThrow();
    expect(() =>
      assertPublicationTransition(O.READY, O.PUBLISHING, {
        authorizationValidated: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertPublicationTransition(O.PUBLISHING, O.PUBLICATION_CONFIRMED, {
        verifiedEvidence: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertPublicationTransition(O.PUBLISHING, O.PUBLICATION_UNCERTAIN),
    ).not.toThrow();
    expect(() =>
      assertPublicationTransition(O.PUBLISHING, O.PUBLISH_FAILED, {
        allowConclusiveFailure: true,
        conclusiveNoPublication: true,
      }),
    ).not.toThrow();

    expect(() =>
      assertPublicationTransition(O.PUBLISHING, O.PUBLISH_FAILED),
    ).toThrow(/CONCLUSIVE_FAILURE_EVIDENCE_REQUIRED/);
    expect(() =>
      assertPublicationTransition(O.PUBLICATION_UNCERTAIN, O.PUBLICATION_CONFIRMED),
    ).toThrow(/RECONCILIATION_REQUIRED/);
    expect(() =>
      assertPublicationTransition(O.PUBLISHING, O.PUBLICATION_CONFIRMED),
    ).toThrow(/VERIFIED_EVIDENCE_REQUIRED/);
    expect(() =>
      assertPublicationTransition(O.READY, O.CANCELLED, {
        shareIntentRecorded: true,
      }),
    ).toThrow(/CANCEL_AFTER_SHARE_FORBIDDEN/);
    expect(() =>
      assertPublicationTransition(O.PUBLISH_FAILED, O.READY),
    ).toThrow(/EXPLICIT_RETRY_REQUIRED/);
    expect(() =>
      assertPublicationTransition(O.PUBLISHING, O.READY),
    ).toThrow(/DRY_RUN_RESTORE_REQUIRED/);
    expect(() =>
      assertPublicationTransition(O.PUBLICATION_CONFIRMED, O.PUBLISH_FAILED),
    ).toThrow(/INVALID_PUBLICATION_TRANSITION/);
    expect(() =>
      assertPublicationTransition(O.CANCELLED, O.PUBLISHING),
    ).toThrow(/INVALID_PUBLICATION_TRANSITION/);
  });

  it('transitions READY -> PUBLISHING and writes an atomic lifecycle event', () => {
    const ctx = readyContext();
    const result = ctx.service.transitionPublication({
      operationId: ctx.operationId,
      contentId: ctx.content.id,
      historyId: ctx.history.id,
      to: O.PUBLISHING,
      actor: 'test',
      reason: 'start publication',
      authorizationValidated: true,
    });
    expect(result.outcome).toBe(O.PUBLISHING);
    expect(ctx.repository.getById(ctx.content.id).status).toBe(ContentStatus.PUBLISHING);
    expect(ctx.historyRow().status).toBe('STARTED');
    expect(ctx.events()).toHaveLength(1);
    expect(ctx.events()[0].new_outcome).toBe(O.PUBLISHING);
    expect(ctx.operation().publication_outcome).toBe(O.PUBLISHING);
  });

  it('confirms publication only with verified evidence and updates all records', () => {
    const ctx = publishingContext();
    const result = ctx.service.confirmPublication({
      operationId: ctx.operationId,
      contentId: ctx.content.id,
      historyId: ctx.history.id,
      actor: 'test',
      reason: 'verified publication',
      verifiedEvidence: true,
    });
    expect(result.outcome).toBe(O.PUBLICATION_CONFIRMED);
    const content = ctx.repository.getById(ctx.content.id);
    expect(content.status).toBe(ContentStatus.PUBLISHED);
    expect(content.publishedAt).toBeTruthy();
    expect(content.story.storyPublishedAt).toBeTruthy();
    expect(content.story.storyExpiresAt).toBeTruthy();
    const operation = ctx.operation();
    expect(operation.state).toBe('PUBLICATION_CONFIRMED');
    expect(operation.publication_outcome).toBe(O.PUBLICATION_CONFIRMED);
    expect(operation.failure_code).toBeNull();
    expect(operation.retryable).toBe(0);
    const history = ctx.historyRow();
    expect(history.status).toBe('SUCCEEDED');
    expect(history.publication_outcome).toBe(O.PUBLICATION_CONFIRMED);
    expect(ctx.events()[0].previous_outcome).toBe(O.PUBLISHING);
    expect(ctx.events()[0].new_outcome).toBe(O.PUBLICATION_CONFIRMED);
  });

  it('marks PUBLISHING as uncertain without retry and marks pre-Share failure as failed', () => {
    const uncertain = publishingContext();
    uncertain.service.markPublicationUncertain({
      operationId: uncertain.operationId,
      contentId: uncertain.content.id,
      historyId: uncertain.history.id,
      actor: 'test',
      reason: 'share result uncertain',
    });
    expect(uncertain.repository.getById(uncertain.content.id).status).toBe(
      ContentStatus.NEEDS_ATTENTION,
    );
    expect(uncertain.historyRow().status).toBe('UNCERTAIN');
    expect(uncertain.operation().publication_outcome).toBe(O.PUBLICATION_UNCERTAIN);
    expect(uncertain.operation().retryable).toBe(0);
    expect(uncertain.operation().failure_code).toBeTruthy();

    const failed = publishingContext();
    failed.service.markPublicationFailed({
      operationId: failed.operationId,
      contentId: failed.content.id,
      historyId: failed.history.id,
      actor: 'test',
      reason: 'pre-share failure',
      allowConclusiveFailure: true,
      conclusiveNoPublication: true,
    });
    expect(failed.repository.getById(failed.content.id).status).toBe(
      ContentStatus.FAILED,
    );
    expect(failed.historyRow().status).toBe('FAILED');
    expect(failed.operation().publication_outcome).toBe(O.PUBLISH_FAILED);
    expect(failed.operation().retryable).toBe(1);
  });

  it('refuses post-Share failure without conclusive evidence and blocks reconfirmation', () => {
    const ctx = publishingContext({
      shareIntentAt: '2026-11-19T15:48:37.377Z',
      shareClickedAt: '2026-11-19T15:48:37.699Z',
      shareClickResult: 'dispatched',
      operationState: 'SHARE_INVOKED',
    });
    expect(() =>
      ctx.service.markPublicationFailed({
        operationId: ctx.operationId,
        contentId: ctx.content.id,
        historyId: ctx.history.id,
        actor: 'test',
        reason: 'post-share failure',
      }),
    ).toThrow(/CONCLUSIVE_FAILURE_EVIDENCE_REQUIRED/);

    const confirmed = confirmedContext();
    const result = confirmed.service.confirmPublication({
      operationId: confirmed.operationId,
      contentId: confirmed.content.id,
      historyId: confirmed.history.id,
      actor: 'test',
      reason: 'already confirmed',
    });
    expect(result.alreadyConfirmed).toBe(true);
  });

  it('requires reconciliation for uncertain -> confirmed and records reconciliation metadata', () => {
    const ctx = uncertainContext();
    expect(() =>
      ctx.service.transitionPublication({
        operationId: ctx.operationId,
        contentId: ctx.content.id,
        historyId: ctx.history.id,
        to: O.PUBLICATION_CONFIRMED,
        verifiedEvidence: true,
        actor: 'test',
        reason: 'no reconciliation flag',
      }),
    ).toThrow(/RECONCILIATION_REQUIRED/);

    const result = ctx.service.transitionPublication({
      operationId: ctx.operationId,
      contentId: ctx.content.id,
      historyId: ctx.history.id,
      to: O.PUBLICATION_CONFIRMED,
      verifiedEvidence: true,
      allowReconciliation: true,
      actor: 'reconciler',
      reason: 'verified viewer evidence',
    });
    expect(result.outcome).toBe(O.PUBLICATION_CONFIRMED);
    expect(ctx.repository.getById(ctx.content.id).status).toBe(ContentStatus.PUBLISHED);
    expect(ctx.historyRow().status).toBe('SUCCEEDED');
    const operation = ctx.operation();
    expect(operation.reconciled_by).toBe('reconciler');
    expect(operation.previous_state).toBe('PUBLICATION_UNCERTAIN');
    expect(operation.share_intent_at).toBe('2026-11-19T15:48:37.377Z');
    expect(operation.share_clicked_at).toBe('2026-11-19T15:48:37.699Z');
    expect(operation.completed_at).toBe('2026-11-19T15:50:25.365Z');
  });

  it('rolls back all lifecycle updates when the transaction fails', () => {
    const ctx = publishingContext();
    expect(() =>
      ctx.service.confirmPublication({
        operationId: ctx.operationId,
        contentId: ctx.content.id,
        historyId: ctx.history.id,
        actor: 'test',
        reason: 'rollback',
        verifiedEvidence: true,
        testHooks: {
          beforeCommit: () => {
            throw new Error('simulated commit failure');
          },
        },
      }),
    ).toThrow(/simulated commit failure/);
    expect(ctx.repository.getById(ctx.content.id).status).toBe(ContentStatus.PUBLISHING);
    expect(ctx.historyRow().status).toBe('STARTED');
    expect(ctx.operation().publication_outcome).toBeNull();
    expect(ctx.events()).toHaveLength(0);
  });

  it('applies adapter results with dry-run, simulated success, uncertain, and failure semantics', () => {
    const dry = publishingContext();
    dry.service.applyAdapterResult({
      contentId: dry.content.id,
      historyId: dry.history.id,
      operationId: dry.operationId,
      result: {
        status: 'DRY_RUN',
        requestId: dry.operationId,
        simulated: true,
        containerId: 'dry-container',
        message: 'dry run',
        raw: { dryRun: true },
      },
      caps: { name: 'mock', isMock: true },
      dryRun: true,
    });
    expect(dry.repository.getById(dry.content.id).status).toBe(ContentStatus.APPROVED);
    expect(dry.historyRow().status).toBe('DRY_RUN');
    expect(dry.operation().publication_outcome).toBe(O.READY);

    const success = publishingContext();
    success.service.applyAdapterResult({
      contentId: success.content.id,
      historyId: success.history.id,
      operationId: success.operationId,
      result: {
        status: 'SUCCEEDED',
        requestId: success.operationId,
        simulated: true,
        message: 'simulated success',
        raw: { simulated: true },
        publication: {
          outcome: O.PUBLICATION_CONFIRMED,
          verified: false,
          simulated: true,
        },
      },
      caps: { name: 'mock', isMock: true },
    });
    expect(success.repository.getById(success.content.id).status).toBe(
      ContentStatus.PUBLISHED,
    );
    expect(success.historyRow().status).toBe('SUCCEEDED');

    const uncertain = publishingContext();
    uncertain.service.applyAdapterResult({
      contentId: uncertain.content.id,
      historyId: uncertain.history.id,
      operationId: uncertain.operationId,
      result: {
        status: 'UNCERTAIN',
        requestId: uncertain.operationId,
        simulated: true,
        message: 'uncertain',
        raw: { uncertain: true },
        publication: {
          outcome: O.PUBLICATION_UNCERTAIN,
          verified: false,
          simulated: true,
        },
      },
      caps: { name: 'mock', isMock: true },
    });
    expect(uncertain.repository.getById(uncertain.content.id).status).toBe(
      ContentStatus.NEEDS_ATTENTION,
    );
    expect(uncertain.historyRow().status).toBe('UNCERTAIN');

    const failed = publishingContext();
    failed.service.applyAdapterResult({
      contentId: failed.content.id,
      historyId: failed.history.id,
      operationId: failed.operationId,
      result: {
        status: 'FAILED',
        requestId: failed.operationId,
        simulated: true,
        message: 'failed before share',
        raw: { failed: true },
        publication: {
          outcome: O.PUBLISH_FAILED,
          verified: false,
          simulated: true,
        },
      },
      caps: { name: 'mock', isMock: true },
    });
    expect(failed.repository.getById(failed.content.id).status).toBe(
      ContentStatus.FAILED,
    );
    expect(failed.historyRow().status).toBe('FAILED');
    expect(failed.operation().retryable).toBe(1);
  });

  it('never turns a post-Share adapter failure into PUBLISH_FAILED', () => {
    const ctx = publishingContext({
      operationState: 'SHARE_INVOKED',
      shareIntentAt: '2026-11-19T15:48:37.377Z',
      shareClickedAt: '2026-11-19T15:48:37.699Z',
      shareClickResult: 'dispatched',
    });
    ctx.service.applyAdapterResult({
      contentId: ctx.content.id,
      historyId: ctx.history.id,
      operationId: ctx.operationId,
      result: {
        status: 'FAILED',
        requestId: ctx.operationId,
        message: 'browser crashed after share',
        raw: { failed: true },
        publication: {
          outcome: O.PUBLISH_FAILED,
          verified: false,
        },
      },
      caps: { name: 'playwright', isMock: false },
    });
    expect(ctx.repository.getById(ctx.content.id).status).toBe(
      ContentStatus.NEEDS_ATTENTION,
    );
    expect(ctx.historyRow().status).toBe('UNCERTAIN');
    expect(ctx.operation().publication_outcome).toBe(O.PUBLICATION_UNCERTAIN);
    expect(ctx.operation().retryable).toBe(0);
  });

  it('classifies thrown errors by Share evidence', () => {
    const preShare = publishingContext();
    const pre = preShare.service.classifyThrownError({
      contentId: preShare.content.id,
      error: new Error('browser launch failed'),
    });
    expect(pre.shareMayHaveOccurred).toBe(false);
    expect(pre.outcome).toBe(O.PUBLISH_FAILED);

    const postShare = publishingContext({
      operationState: 'SHARE_INVOKED',
      shareIntentAt: '2026-11-19T15:48:37.377Z',
      shareClickedAt: '2026-11-19T15:48:37.699Z',
      shareClickResult: 'dispatched',
    });
    const post = postShare.service.classifyThrownError({
      contentId: postShare.content.id,
      error: new Error('browser crashed after share'),
    });
    expect(post.shareMayHaveOccurred).toBe(true);
    expect(post.outcome).toBe(O.PUBLICATION_UNCERTAIN);
  });

  it('centralizes failure classification semantics', () => {
    const preview = classifyPublicationFailure('PREVIEW_MISMATCH');
    expect(preview.outcome).toBe(O.PUBLISH_FAILED);
    expect(preview.shareMayHaveOccurred).toBe(false);
    expect(preview.retryable).toBe(false);

    const crash = classifyPublicationFailure('BROWSER_CRASH_AFTER_SHARE');
    expect(crash.outcome).toBe(O.PUBLICATION_UNCERTAIN);
    expect(crash.shareMayHaveOccurred).toBe(true);
    expect(crash.retryable).toBe(false);
    expect(crash.manualIntervention).toBe(true);

    const duplicate = classifyPublicationFailure('DUPLICATE_STORY');
    expect(duplicate.outcome).toBe(O.PUBLICATION_UNCERTAIN);
    expect(duplicate.recoveryAction).toMatch(/Never create a duplicate Story/i);
  });
});
