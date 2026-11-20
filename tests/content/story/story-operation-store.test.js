import { describe, expect, it } from 'vitest';
import { Database } from '../../../src/storage/database.js';
import { ContentRepository } from '../../../src/modules/content/content-repository.js';
import {
  ApprovalStatus,
  ContentStatus,
  ContentType,
} from '../../../src/modules/content/constants.js';
import { StoryOperationStore } from '../../../src/modules/content/publishing/story/story-operation-store.js';
import {
  SHARE_AUTHORIZATION_SCOPE,
  createShareAuthorization,
  validateShareAuthorization,
} from '../../../src/modules/content/publishing/story/story-share-authorization.js';
import { StoryPublishState } from '../../../src/modules/content/publishing/story/story-states.js';

const NOW = new Date('2026-11-19T16:00:00.000Z');
const CHECKSUM = '37b4a25445630e990a75caf6611dda4d5a5bc0e3c344fc7d811f586bad6b4026';

function setup() {
  const database = new Database({ filePath: ':memory:' });
  database.open();
  const repository = new ContentRepository(database, { nowFn: () => NOW });
  const content = repository.create({
    id: 'story-1',
    contentType: ContentType.STORY,
    caption: '',
    status: ContentStatus.APPROVED,
    approvalStatus: ApprovalStatus.APPROVED,
  });
  const store = new StoryOperationStore({ database, nowFn: () => NOW });
  return { database, repository, content, store };
}

function createOperation(store, operationId, overrides = {}) {
  return store.create({
    operationId,
    contentId: 'story-1',
    attemptId: 'attempt-1',
    state: StoryPublishState.NAVIGATING_HOME,
    mediaPath: '/tmp/js.jpg',
    mediaChecksumSha256: CHECKSUM,
    idempotencyKey: 'content-publish:story-1',
    diagnosticsDir: '/tmp/diag',
    evidence: { phase: 'test' },
    ...overrides,
  });
}

describe('StoryOperationStore', () => {
  it('persists a durable operation before Share and records the intent once', () => {
    const { database, store } = setup();
    try {
      const operation = createOperation(store, 'op-1');
      expect(operation.state).toBe(StoryPublishState.NAVIGATING_HOME);
      expect(operation.share_intent_at).toBeNull();
      expect(operation.share_clicked_at).toBeNull();
      expect(operation.retryable).toBe(0);

      store.updateState('op-1', StoryPublishState.PRE_SHARE_SNAPSHOT);
      const intent = store.recordShareIntent({
        operationId: 'op-1',
        contentId: 'story-1',
        mediaChecksumSha256: CHECKSUM,
        idempotencyKey: 'content-publish:story-1',
        fromState: StoryPublishState.PRE_SHARE_SNAPSHOT,
        evidence: { authorization: { maxShares: 1 } },
      });
      expect(intent.state).toBe(StoryPublishState.SHARE_ARMED);
      expect(intent.share_intent_at).toBe(NOW.toISOString());
      expect(intent.retryable).toBe(0);

      expect(() =>
        store.recordShareIntent({
          operationId: 'op-1',
          contentId: 'story-1',
          mediaChecksumSha256: CHECKSUM,
          idempotencyKey: 'content-publish:story-1',
          fromState: StoryPublishState.PRE_SHARE_SNAPSHOT,
        }),
      ).toThrow();

      store.recordShareClicked('op-1');
      const clicked = store.get('op-1');
      expect(clicked.state).toBe(StoryPublishState.SHARE_INVOKED);
      expect(clicked.share_clicked_at).toBe(NOW.toISOString());
      expect(clicked.share_click_result).toBe('dispatched');
      expect(() => store.recordShareClicked('op-1')).toThrow(/already/i);

      store.finish({
        operationId: 'op-1',
        state: StoryPublishState.PUBLICATION_CONFIRMED,
        evidence: { verified: true },
      });
      const finished = store.get('op-1');
      expect(finished.completed_at).toBe(NOW.toISOString());
      expect(finished.state).toBe(StoryPublishState.PUBLICATION_CONFIRMED);
    } finally {
      database.close();
    }
  });

  it('blocks a second operation for the same media checksum or idempotency key', () => {
    const { database, store } = setup();
    try {
      createOperation(store, 'op-a');
      store.updateState('op-a', StoryPublishState.PRE_SHARE_SNAPSHOT);
      store.recordShareIntent({
        operationId: 'op-a',
        contentId: 'story-1',
        mediaChecksumSha256: CHECKSUM,
        idempotencyKey: 'content-publish:story-1',
        fromState: StoryPublishState.PRE_SHARE_SNAPSHOT,
      });

      createOperation(store, 'op-b', { idempotencyKey: 'content-publish:story-1-retry' });
      store.updateState('op-b', StoryPublishState.PRE_SHARE_SNAPSHOT);
      expect(() =>
        store.recordShareIntent({
          operationId: 'op-b',
          contentId: 'story-1',
          mediaChecksumSha256: CHECKSUM,
          idempotencyKey: 'content-publish:story-1-retry',
          fromState: StoryPublishState.PRE_SHARE_SNAPSHOT,
        }),
      ).toThrow(/already recorded/i);

      expect(store.findShareIntentByMediaChecksum(CHECKSUM)?.id).toBe('op-a');
    } finally {
      database.close();
    }
  });

  it('refuses a Share intent when the operation is not in the pre-share state', () => {
    const { database, store } = setup();
    try {
      createOperation(store, 'op-pre');
      expect(() =>
        store.recordShareIntent({
          operationId: 'op-pre',
          contentId: 'story-1',
          mediaChecksumSha256: CHECKSUM,
          idempotencyKey: 'content-publish:story-1',
          fromState: StoryPublishState.PRE_SHARE_SNAPSHOT,
        }),
      ).toThrow(/not persisted/i);
      expect(store.get('op-pre')?.share_intent_at).toBeNull();
    } finally {
      database.close();
    }
  });
});

describe('one-time Share authorization', () => {
  const authorization = createShareAuthorization({
    operationId: 'op-1',
    contentId: 'story-1',
    mediaChecksumSha256: CHECKSUM,
    ttlMs: 60_000,
    nowFn: () => NOW,
  });

  it('accepts exactly the authorized operation, content, media, and one Share', () => {
    expect(authorization.scope).toBe(SHARE_AUTHORIZATION_SCOPE);
    expect(authorization.maxShares).toBe(1);
    expect(
      validateShareAuthorization(authorization, {
        operationId: 'op-1',
        contentId: 'story-1',
        mediaChecksumSha256: CHECKSUM,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects wrong operation, content, media, scope, share count, and expiry', () => {
    const cases = [
      { input: { operationId: 'op-2', contentId: 'story-1', mediaChecksumSha256: CHECKSUM }, reason: 'operation-mismatch' },
      { input: { operationId: 'op-1', contentId: 'story-2', mediaChecksumSha256: CHECKSUM }, reason: 'content-mismatch' },
      { input: { operationId: 'op-1', contentId: 'story-1', mediaChecksumSha256: 'deadbeef' }, reason: 'media-checksum-mismatch' },
    ];
    for (const item of cases) {
      expect(
        validateShareAuthorization(authorization, { ...item.input, now: NOW }),
      ).toEqual({ ok: false, reason: item.reason });
    }
    expect(
      validateShareAuthorization(
        { ...authorization, scope: 'other' },
        { operationId: 'op-1', contentId: 'story-1', mediaChecksumSha256: CHECKSUM, now: NOW },
      ),
    ).toEqual({ ok: false, reason: 'invalid-scope' });
    expect(
      validateShareAuthorization(
        { ...authorization, maxShares: 2 },
        { operationId: 'op-1', contentId: 'story-1', mediaChecksumSha256: CHECKSUM, now: NOW },
      ),
    ).toEqual({ ok: false, reason: 'max-shares-must-be-one' });
    expect(
      validateShareAuthorization(authorization, {
        operationId: 'op-1',
        contentId: 'story-1',
        mediaChecksumSha256: CHECKSUM,
        now: new Date('2026-11-20T00:00:00.000Z'),
      }),
    ).toEqual({ ok: false, reason: 'authorization-expired' });
    expect(
      validateShareAuthorization(null, {
        operationId: 'op-1',
        contentId: 'story-1',
        mediaChecksumSha256: CHECKSUM,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'missing-authorization' });
  });
});
