import {
  ApprovalStatus,
  ContentError,
  ContentStatus,
  ContentType,
  PublishingAttemptStatus,
  CONTENT_PUBLISH_TASK_TYPE,
  STORY_TTL_MS,
} from '../constants.js';
import { assertTransition } from '../content-state-machine.js';
import { assertCanPublish } from './publishing-validator.js';
import { PublishingHistoryService } from './publishing-history.js';

/**
 * Orchestrates publishing through a PublishingAdapter and persists history.
 * Integrates with the Phase 2 task engine via the content.publish handler.
 */
export class PublishingService {
  /**
   * @param {{
   *   repository: import('../content-repository.js').ContentRepository,
   *   adapter: import('./publishing-adapter.js').PublishingAdapter,
   *   dryRunDefault?: boolean,
   *   nowFn?: () => Date,
   * }} options
   */
  constructor(options) {
    this.repository = options.repository;
    this.adapter = options.adapter;
    this.dryRunDefault = Boolean(options.dryRunDefault);
    this._now = options.nowFn ?? (() => new Date());
    this.history = new PublishingHistoryService(options.repository);
  }

  getCapabilities() {
    return this.adapter.getCapabilities();
  }

  async validateAccount() {
    return this.adapter.validateAccount();
  }

  /**
   * @param {string} contentId
   * @param {{
   *   dryRun?: boolean,
   *   confirm?: boolean,
   *   immediate?: boolean,
   *   signal?: AbortSignal,
   * }} [options]
   */
  async publishContent(contentId, options = {}) {
    const content = this.repository.getById(contentId);
    if (!content) {
      throw new ContentError(`Content not found: ${contentId}`, {
        code: 'CONTENT_NOT_FOUND',
      });
    }

    const caps = this.adapter.getCapabilities();
    const dryRun = options.dryRun ?? this.dryRunDefault ?? caps.dryRunOnly;

    assertCanPublish(content, {
      supportedTypes: caps.supportedContentTypes,
      requireConfirm: Boolean(options.immediate) && !dryRun,
      confirm: options.confirm,
    });

    const idempotencyKey =
      content.idempotencyKey ?? `content-publish:${content.id}`;

    const prior = this.repository.findPublishingHistoryByIdempotency(idempotencyKey);
    if (
      prior &&
      (prior.status === PublishingAttemptStatus.SUCCEEDED ||
        prior.status === PublishingAttemptStatus.DRY_RUN) &&
      prior.externalPublishId
    ) {
      return {
        content: this.repository.getById(contentId),
        attempt: prior,
        duplicate: true,
        simulated: Boolean(prior.dryRun) || caps.isMock,
      };
    }

    if (content.status === ContentStatus.PUBLISHED && content.externalPublishId) {
      throw new ContentError('Content is already published', {
        code: 'ALREADY_PUBLISHED',
        details: { externalPublishId: content.externalPublishId },
      });
    }

    if (content.status !== ContentStatus.PUBLISHING) {
      assertTransition(content.status, ContentStatus.PUBLISHING);
      this.repository.update(contentId, {
        status: ContentStatus.PUBLISHING,
        lastError: null,
        idempotencyKey,
      });
    } else {
      this.repository.update(contentId, { idempotencyKey, lastError: null });
    }

    const attemptNumber = this.repository.nextAttemptNumber(contentId);
    const started = this.repository.addPublishingHistory({
      contentId,
      attemptNumber,
      adapter: caps.name,
      status: PublishingAttemptStatus.STARTED,
      idempotencyKey,
      dryRun,
    });

    const refreshed = this.repository.getById(contentId);
    /** @type {import('./publishing-adapter.js').PublishResult} */
    let result;
    try {
      result = await this.adapter.publish({
        contentId,
        contentType: refreshed.contentType,
        caption: refreshed.caption,
        hashtags: refreshed.hashtags,
        media: refreshed.media,
        idempotencyKey,
        dryRun,
        signal: options.signal,
      });
    } catch (error) {
      result = {
        status: 'UNCERTAIN',
        simulated: caps.isMock,
        externalPublishId: null,
        containerId: null,
        requestId: null,
        message: error instanceof Error ? error.message : String(error),
        raw: { thrown: true },
      };
    }

    return this._finalizeAttempt(contentId, started.id, result, caps);
  }

  /**
   * @param {string} contentId
   * @param {string} historyId
   * @param {import('./publishing-adapter.js').PublishResult} result
   * @param {import('./publishing-adapter.js').PublishingCapabilities} caps
   */
  _finalizeAttempt(contentId, historyId, result, caps) {
    const now = this._now().toISOString();
    const simulated = Boolean(result.simulated) || caps.isMock;
    const dryRun = result.status === 'DRY_RUN';

    // Update history row by inserting completion record details via update SQL
    this.repository.db.raw
      .prepare(
        `UPDATE publishing_history SET
          status = ?,
          request_id = ?,
          container_id = ?,
          external_publish_id = ?,
          dry_run = ?,
          error_json = ?,
          result_json = ?,
          completed_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.requestId,
        result.containerId,
        result.externalPublishId,
        dryRun ? 1 : 0,
        result.status === 'FAILED' || result.status === 'UNCERTAIN'
          ? JSON.stringify({ message: result.message, raw: result.raw })
          : null,
        JSON.stringify({
          ...(result.raw ?? {}),
          simulated,
          message: result.message,
          // Never claim mock/dry-run as a real Instagram publication
          realInstagramPublication: !simulated && !dryRun && result.status === 'SUCCEEDED',
        }),
        now,
        historyId,
      );

    if (result.status === 'SUCCEEDED' && !dryRun) {
      const content = this.repository.getById(contentId);
      this.repository.update(contentId, {
        status: ContentStatus.PUBLISHED,
        publishedAt: now,
        externalPublishId: result.externalPublishId,
        lastError: null,
      });
      if (content?.contentType === ContentType.STORY) {
        const expiresAt = new Date(Date.parse(now) + STORY_TTL_MS).toISOString();
        const existingStory = this.repository.getStoryDetails(contentId);
        this.repository.upsertStoryDetails(contentId, {
          storyMediaType:
            existingStory?.storyMediaType ??
            (content.media?.[0]?.mediaKind === 'video' ? 'VIDEO' : 'IMAGE'),
          storyGroupId: existingStory?.storyGroupId ?? null,
          sequenceOrder: existingStory?.sequenceOrder ?? 0,
          storyContainerId: result.containerId ?? existingStory?.storyContainerId ?? null,
          storyPublishedAt: now,
          storyExpiresAt: expiresAt,
        });
      }
    } else if (result.status === 'DRY_RUN') {
      // Dry-run does not advance to PUBLISHED — restore to APPROVED
      this.repository.update(contentId, {
        status: ContentStatus.APPROVED,
        lastError: null,
      });
      const content = this.repository.getById(contentId);
      if (content?.contentType === ContentType.STORY && result.containerId) {
        const existingStory = this.repository.getStoryDetails(contentId);
        if (existingStory) {
          this.repository.upsertStoryDetails(contentId, {
            storyMediaType: existingStory.storyMediaType,
            storyGroupId: existingStory.storyGroupId,
            sequenceOrder: existingStory.sequenceOrder,
            storyContainerId: result.containerId,
          });
        }
      }
    } else if (result.status === 'UNCERTAIN') {
      this.repository.update(contentId, {
        status: ContentStatus.NEEDS_ATTENTION,
        lastError:
          result.message ??
          'Publication result uncertain — manual review required before retry',
      });
      const content = this.repository.getById(contentId);
      if (content?.contentType === ContentType.STORY && result.containerId) {
        const existingStory = this.repository.getStoryDetails(contentId);
        if (existingStory) {
          this.repository.upsertStoryDetails(contentId, {
            storyMediaType: existingStory.storyMediaType,
            storyGroupId: existingStory.storyGroupId,
            sequenceOrder: existingStory.sequenceOrder,
            storyContainerId: result.containerId,
          });
        }
      }
    } else {
      this.repository.update(contentId, {
        status: ContentStatus.FAILED,
        lastError: result.message ?? 'Publishing failed',
      });
    }

    const attempt = this.repository.getPublishingHistoryById(historyId);
    return {
      content: this.repository.getById(contentId),
      attempt,
      duplicate: false,
      simulated,
    };
  }

  /**
   * Build a one-shot schedule payload for the Phase 2 Scheduler.
   *
   * @param {string} contentId
   * @param {string} runAtIso
   * @param {{ timezone?: string, dryRun?: boolean }} [options]
   */
  buildScheduleInput(contentId, runAtIso, options = {}) {
    return {
      taskType: CONTENT_PUBLISH_TASK_TYPE,
      payload: {
        contentId,
        dryRun: options.dryRun ?? this.dryRunDefault,
      },
      nextRunAt: runAtIso,
      timezone: options.timezone ?? 'Europe/Berlin',
      enabled: true,
      catchUpPolicy: 'skip_missed',
      maxCatchUp: 1,
      priority: 50,
      maxAttempts: 1,
      idempotencyPrefix: `content-publish:${contentId}`,
    };
  }
}

/**
 * Task handler registered with Phase 2 TaskManager.
 *
 * @param {{ publishingService: PublishingService }} deps
 * @returns {import('../../../tasks/types.js').TaskHandler}
 */
export function createContentPublishHandler(deps) {
  return {
    type: CONTENT_PUBLISH_TASK_TYPE,
    description: 'Publish approved content via configured publishing adapter',
    requiresAuth: false,
    externalSideEffect: true,
    async execute(context, payload, signal) {
      const contentId = String(payload.contentId ?? '');
      if (!contentId) {
        throw new ContentError('contentId is required', { code: 'CONTENT_ID_REQUIRED' });
      }
      context.markSideEffect?.(true);
      const result = await deps.publishingService.publishContent(contentId, {
        dryRun: Boolean(payload.dryRun),
        confirm: true,
        immediate: true,
        signal,
      });
      context.markSideEffect?.(false);
      return result;
    },
  };
}
