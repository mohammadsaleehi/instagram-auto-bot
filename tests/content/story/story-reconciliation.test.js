import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../../src/storage/database.js';
import { ContentRepository } from '../../../src/modules/content/content-repository.js';
import {
  ApprovalStatus,
  ContentStatus,
  ContentType,
} from '../../../src/modules/content/constants.js';
import { StoryReconciliationService } from '../../../src/modules/content/publishing/story/story-reconciliation.js';

const OPERATION_ID = 'op-reconcile-1';
const CONTENT_ID = 'content-reconcile-1';
const SHARE_INTENT_AT = '2026-11-19T15:48:37.377Z';
const SHARE_CLICKED_AT = '2026-11-19T15:48:37.699Z';
const ORIGINAL_COMPLETED_AT = '2026-11-19T15:50:25.365Z';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function setup(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-reconcile-'));
  const mediaPath = path.join(dir, 'js.jpg');
  const mediaBytes = Buffer.from('authorized-story-image-bytes');
  await fs.writeFile(mediaPath, mediaBytes);
  const checksum = sha256(mediaBytes);

  const database = new Database({ filePath: ':memory:' });
  database.open();
  const repository = new ContentRepository(database, {
    nowFn: () => new Date('2026-11-19T16:00:00.000Z'),
  });
  const content = repository.create({
    id: CONTENT_ID,
    title: 'Story js.jpg',
    contentType: ContentType.STORY,
    caption: '',
    status: overrides.contentStatus ?? ContentStatus.NEEDS_ATTENTION,
    approvalStatus: ApprovalStatus.APPROVED,
    idempotencyKey: 'content-publish:reconcile',
  });
  repository.replaceMedia(content.id, [
    {
      filePath: mediaPath,
      originalName: 'js.jpg',
      mimeType: 'image/jpeg',
      mediaKind: 'image',
      byteSize: mediaBytes.length,
      checksumSha256: checksum,
      width: 1366,
      height: 768,
    },
  ]);
  repository.upsertStoryDetails(content.id, {
    storyMediaType: 'IMAGE',
    storyGroupId: null,
    sequenceOrder: 0,
    storyContainerId: 'dry_story_stale',
  });

  const verification = {
    ok: true,
    appeared: true,
    viewerOpened: true,
    storyId: null,
    storyIds: [],
    timeLabels: ['5m'],
    identity: { ok: true, distance: 5.23, cover: 5.23, contain: 14.61 },
    profileUrl: 'https://www.instagram.com/test_account/',
    viewerUrl: 'https://www.instagram.com/stories/test_account/',
    viewerMedia: {
      tag: 'IMG',
      box: { x: 0, y: 0, width: 390, height: 844 },
      naturalWidth: 1170,
      naturalHeight: 2532,
      srcHost: 'scontent.example',
      usedDataUrl: false,
    },
    capturedAt: '2026-11-19T15:53:37.699Z',
    ...overrides.verification,
  };
  const evidence = {
    accountHandle: overrides.accountHandle ?? 'test_account',
    authorization: {
      scope: 'single-story-publication',
      operationId: OPERATION_ID,
      contentId: CONTENT_ID,
      mediaChecksumSha256: checksum,
      maxShares: 1,
    },
    media: { checksumSha256: checksum, fileName: 'js.jpg' },
    observed: {
      leftEditor: true,
      url: 'https://www.instagram.com/',
      elapsedMs: 11_014,
      bodySnippet: 'Your story was added to Instagram',
      ...overrides.observed,
    },
    verification: overrides.verification ?? verification,
    independentVerification: overrides.independentVerification ?? verification,
  };

  const operationState = overrides.operationState ?? 'PUBLICATION_UNCERTAIN';
  const shareIntentAt =
    overrides.shareIntentAt === undefined ? SHARE_INTENT_AT : overrides.shareIntentAt;
  const shareClickedAt =
    overrides.shareClickedAt === undefined ? SHARE_CLICKED_AT : overrides.shareClickedAt;
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
      OPERATION_ID,
      CONTENT_ID,
      'attempt-1',
      operationState,
      ORIGINAL_COMPLETED_AT,
      'mobile-web-portrait',
      mediaPath,
      checksum,
      'content-publish:reconcile',
      shareIntentAt,
      shareClickedAt,
      shareClickedAt ? 'dispatched' : null,
      operationState === 'PUBLICATION_UNCERTAIN' ? 'SHARE_NOT_CONFIRMED' : null,
      0,
      JSON.stringify(evidence),
      dir,
      '2026-11-19T15:48:25.337Z',
      ORIGINAL_COMPLETED_AT,
      ORIGINAL_COMPLETED_AT,
    );

  repository.addPublishingHistory({
    contentId: CONTENT_ID,
    attemptNumber: 1,
    adapter: 'playwright',
    status: overrides.historyStatus ?? 'UNCERTAIN',
    idempotencyKey: 'content-publish:reconcile',
    requestId: OPERATION_ID,
    dryRun: false,
    error: { message: 'Story publication outcome is uncertain.' },
    result: { message: 'Story publication outcome is uncertain.', observed: evidence.observed },
    completedAt: ORIGINAL_COMPLETED_AT,
  });

  const service = new StoryReconciliationService({
    database,
    repository,
    nowFn: () => new Date('2026-11-19T16:02:14.745Z'),
    idFn: () => 'event-1',
  });

  return {
    dir,
    mediaPath,
    checksum,
    database,
    repository,
    service,
    operationId: OPERATION_ID,
    contentId: CONTENT_ID,
    cleanup: async () => {
      database.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function operation(database) {
  return database.raw
    .prepare('SELECT * FROM story_publish_operations WHERE id = ?')
    .get(OPERATION_ID);
}

function history(database) {
  return database.raw
    .prepare(
      'SELECT * FROM publishing_history WHERE content_id = ? AND request_id = ?',
    )
    .get(CONTENT_ID, OPERATION_ID);
}

describe('StoryReconciliationService', () => {
  it('reconciles the uncertain operation transactionally and preserves share/attempt history', async () => {
    const ctx = await setup();
    try {
      const result = await ctx.service.reconcile(ctx.operationId, {
        actor: 'phase-a-test',
        reason: 'independent viewer and image identity verified',
        expectedAccountHandle: 'test_account',
        sourceMediaPath: ctx.mediaPath,
      });

      expect(result.ok).toBe(true);
      expect(result.classification).toBe('PUBLISHED');
      expect(result.publishedAt).toBe(SHARE_CLICKED_AT);
      expect(result.eventId).toBe('event-1');
      expect(result.checks.every((check) => check.ok)).toBe(true);

      const op = operation(ctx.database);
      expect(op.state).toBe('PUBLICATION_CONFIRMED');
      expect(op.failure_code).toBeNull();
      expect(op.retryable).toBe(0);
      expect(op.share_intent_at).toBe(SHARE_INTENT_AT);
      expect(op.share_clicked_at).toBe(SHARE_CLICKED_AT);
      expect(op.completed_at).toBe(ORIGINAL_COMPLETED_AT);
      expect(op.reconciled_at).toBe('2026-11-19T16:02:14.745Z');
      expect(op.reconciled_by).toBe('phase-a-test');
      expect(op.reconciliation_reason).toBe(
        'independent viewer and image identity verified',
      );
      expect(op.previous_state).toBe('PUBLICATION_UNCERTAIN');
      expect(op.previous_failure_code).toBe('SHARE_NOT_CONFIRMED');

      const content = ctx.repository.getById(ctx.contentId);
      expect(content.status).toBe(ContentStatus.PUBLISHED);
      expect(content.publishedAt).toBe(SHARE_CLICKED_AT);
      expect(content.lastError).toBeNull();
      expect(content.story.storyPublishedAt).toBe(SHARE_CLICKED_AT);
      expect(content.story.storyExpiresAt).toBe('2026-11-20T15:48:37.699Z');
      expect(content.story.storyContainerId).toBeNull();

      const row = history(ctx.database);
      expect(row.status).toBe('SUCCEEDED');
      expect(row.dry_run).toBe(0);
      expect(row.error_json).toBeNull();
      const resultJson = JSON.parse(row.result_json);
      expect(resultJson.message).toBe('Story publication outcome is uncertain.');
      expect(resultJson.reconciliation.previousStatus).toBe('UNCERTAIN');
      expect(resultJson.reconciliation.publishedAt).toBe(SHARE_CLICKED_AT);
      expect(resultJson.reconciliation.originalShareIntentAt).toBe(SHARE_INTENT_AT);
      expect(resultJson.reconciliation.originalShareClickedAt).toBe(SHARE_CLICKED_AT);
      expect(resultJson.reconciliation.previousStoryContainerId).toBe(
        'dry_story_stale',
      );

      const events = ctx.database.raw
        .prepare('SELECT * FROM story_operation_events WHERE operation_id = ?')
        .all(ctx.operationId);
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('RECONCILIATION_COMPLETED');
      expect(events[0].actor).toBe('phase-a-test');
      expect(events[0].previous_state).toBe('PUBLICATION_UNCERTAIN');
      expect(events[0].new_state).toBe('PUBLICATION_CONFIRMED');
    } finally {
      await ctx.cleanup();
    }
  });

  it('is idempotent and does not duplicate the audit event', async () => {
    const ctx = await setup();
    try {
      const options = {
        actor: 'phase-a-test',
        reason: 'verified',
        expectedAccountHandle: 'test_account',
      };
      const first = await ctx.service.reconcile(ctx.operationId, options);
      expect(first.ok).toBe(true);
      const second = await ctx.service.reconcile(ctx.operationId, options);
      expect(second.ok).toBe(true);
      expect(second.classification).toBe('PUBLISHED');
      expect(second.alreadyReconciled).toBe(true);

      const events = ctx.database.raw
        .prepare('SELECT COUNT(*) AS n FROM story_operation_events WHERE operation_id = ?')
        .get(ctx.operationId);
      expect(Number(events.n)).toBe(1);
    } finally {
      await ctx.cleanup();
    }
  });

  it('validates without writing in dry-run mode', async () => {
    const ctx = await setup();
    try {
      const result = await ctx.service.reconcile(ctx.operationId, {
        actor: 'phase-a-test',
        reason: 'verified',
        expectedAccountHandle: 'test_account',
        sourceMediaPath: ctx.mediaPath,
        dryRun: true,
      });
      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.wouldChange).toBe(true);
      expect(operation(ctx.database).state).toBe('PUBLICATION_UNCERTAIN');
      expect(
        ctx.database.raw
          .prepare('SELECT COUNT(*) AS n FROM story_operation_events')
          .get().n,
      ).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it('classifies a pre-Share failure as PUBLISH_FAILED without touching content', async () => {
    const ctx = await setup({
      operationState: 'PUBLISH_FAILED',
      historyStatus: 'FAILED',
      shareIntentAt: null,
      shareClickedAt: null,
    });
    try {
      const result = await ctx.service.reconcile(ctx.operationId, {
        actor: 'phase-a-test',
        reason: 'no share was dispatched',
      });
      expect(result.ok).toBe(false);
      expect(result.classification).toBe('PUBLISH_FAILED');
      expect(result.reason).toBe('no-share-intent-or-click');
      expect(operation(ctx.database).state).toBe('PUBLISH_FAILED');
      expect(ctx.repository.getById(ctx.contentId).status).toBe(
        ContentStatus.NEEDS_ATTENTION,
      );
      const events = ctx.database.raw
        .prepare('SELECT * FROM story_operation_events WHERE operation_id = ?')
        .all(ctx.operationId);
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('RECONCILIATION_REJECTED');
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects insufficient or contradictory verification evidence', async () => {
    const ctx = await setup({
      verification: {
        ok: false,
        appeared: false,
        viewerOpened: false,
        identity: { ok: false, distance: 40 },
        reason: 'no-story-ring',
      },
    });
    try {
      const result = await ctx.service.reconcile(ctx.operationId, {
        actor: 'phase-a-test',
        reason: 'verification failed',
        expectedAccountHandle: 'test_account',
      });
      expect(result.ok).toBe(false);
      expect(result.classification).toBe('PUBLICATION_UNCERTAIN');
      expect(result.reason).toMatch(/evidence-not-sufficient/);
      expect(operation(ctx.database).state).toBe('PUBLICATION_UNCERTAIN');
      expect(history(ctx.database).status).toBe('UNCERTAIN');
      expect(ctx.repository.getById(ctx.contentId).status).toBe(
        ContentStatus.NEEDS_ATTENTION,
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects an account mismatch', async () => {
    const ctx = await setup();
    try {
      const result = await ctx.service.reconcile(ctx.operationId, {
        actor: 'phase-a-test',
        reason: 'wrong account guard',
        expectedAccountHandle: 'other-account',
      });
      expect(result.ok).toBe(false);
      expect(result.classification).toBe('PUBLICATION_UNCERTAIN');
      expect(result.checks.find((check) => check.name === 'account-identity')?.ok).toBe(
        false,
      );
      expect(operation(ctx.database).state).toBe('PUBLICATION_UNCERTAIN');
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects a source media checksum mismatch', async () => {
    const ctx = await setup();
    try {
      const otherPath = path.join(ctx.dir, 'other.jpg');
      await fs.writeFile(otherPath, Buffer.from('different-bytes'));
      const result = await ctx.service.reconcile(ctx.operationId, {
        actor: 'phase-a-test',
        reason: 'wrong media guard',
        expectedAccountHandle: 'test_account',
        sourceMediaPath: otherPath,
      });
      expect(result.ok).toBe(false);
      expect(result.classification).toBe('PUBLICATION_UNCERTAIN');
      expect(
        result.checks.find((check) => check.name === 'source-media-checksum')?.ok,
      ).toBe(false);
      expect(operation(ctx.database).state).toBe('PUBLICATION_UNCERTAIN');
    } finally {
      await ctx.cleanup();
    }
  });

  it('rolls back atomically if the commit hook fails', async () => {
    const ctx = await setup();
    try {
      const result = await ctx.service.reconcile(ctx.operationId, {
        actor: 'phase-a-test',
        reason: 'transaction rollback test',
        expectedAccountHandle: 'test_account',
        testHooks: {
          beforeCommit: () => {
            throw new Error('simulated commit failure');
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/transaction-failed/);
      expect(operation(ctx.database).state).toBe('PUBLICATION_UNCERTAIN');
      expect(history(ctx.database).status).toBe('UNCERTAIN');
      expect(ctx.repository.getById(ctx.contentId).status).toBe(
        ContentStatus.NEEDS_ATTENTION,
      );
      expect(
        ctx.database.raw
          .prepare('SELECT COUNT(*) AS n FROM story_operation_events')
          .get().n,
      ).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it('rejects contradictory history status without overwriting it', async () => {
    const ctx = await setup({ historyStatus: 'FAILED' });
    try {
      const result = await ctx.service.reconcile(ctx.operationId, {
        actor: 'phase-a-test',
        reason: 'contradictory history guard',
        expectedAccountHandle: 'test_account',
      });
      expect(result.ok).toBe(false);
      expect(result.classification).toBe('PUBLICATION_UNCERTAIN');
      expect(history(ctx.database).status).toBe('FAILED');
      expect(operation(ctx.database).state).toBe('PUBLICATION_UNCERTAIN');
    } finally {
      await ctx.cleanup();
    }
  });
});
