import {
  ApprovalStatus,
  ContentError,
  ContentStatus,
  ContentType,
  PublishingAttemptStatus,
  CONTENT_PUBLISH_TASK_TYPE,
} from '../constants.js';
import { assertTransition } from '../content-state-machine.js';
import { assertCanPublish } from './publishing-validator.js';
import { PublishingHistoryService } from './publishing-history.js';
import {
  PublicationLifecycleService,
  PublicationOutcome,
} from './publication-lifecycle.js';

/**
 * Orchestrates publishing through a PublishingAdapter and persists history.
 * Integrates with the Phase 2 task engine via the content.publish handler.
 */
export class PublishingService {
  /**
   * @param {{
   *   repository: import('../content-repository.js').ContentRepository,
   *   adapter: import('./publishing-adapter.js').PublishingAdapter,
   *   lifecycle?: PublicationLifecycleService,
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
    this.lifecycle =
      options.lifecycle ??
      new PublicationLifecycleService({
        database: options.repository.db,
        repository: options.repository,
        nowFn: this._now,
      });
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
    // A dry-run-only adapter can never be promoted to a real attempt by a
    // caller passing `dryRun: false`. The capability is a hard safety gate.
    const dryRun =
      options.dryRun === true ||
      this.dryRunDefault === true ||
      caps.dryRunOnly === true;

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
      const classified = this.lifecycle.classifyThrownError({ contentId, error });
      const canonical = classified.outcome;
      result = {
        status:
          canonical === PublicationOutcome.PUBLISH_FAILED ? 'FAILED' : 'UNCERTAIN',
        simulated: caps.isMock,
        externalPublishId: null,
        containerId: null,
        requestId: classified.operation?.id ?? null,
        message: error instanceof Error ? error.message : String(error),
        raw: {
          thrown: true,
          publicationOutcome: canonical,
          failure: classified.failure,
          shareMayHaveOccurred: classified.shareMayHaveOccurred,
        },
        publication: {
          outcome: canonical,
          verified: false,
          failure: classified.failure,
        },
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
    const simulated = Boolean(result.simulated) || caps.isMock;
    const applied = this.lifecycle.applyAdapterResult({
      contentId,
      historyId,
      operationId: result.requestId ?? null,
      result,
      caps,
      dryRun: result.status === 'DRY_RUN',
    });
    const attempt = this.repository.getPublishingHistoryById(historyId);
    return {
      content: this.repository.getById(contentId),
      attempt,
      duplicate: false,
      simulated,
      publicationOutcome: applied.outcome,
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
 * @param {{
 *   publishingService: PublishingService,
 *   storyMediaInbox?: import('../story-media-inbox.js').StoryMediaInbox | null,
 *   requiresAuth?: boolean,
 * }} deps
 * @returns {import('../../../tasks/types.js').TaskHandler}
 */
export function createContentPublishHandler(deps) {
  const caps = deps.publishingService.getCapabilities();
  const requiresAuth =
    deps.requiresAuth ??
    caps.name === 'playwright';

  return {
    type: CONTENT_PUBLISH_TASK_TYPE,
    description: 'Publish approved content via configured publishing adapter',
    requiresAuth,
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
      await archiveSourceMediaIfRequested(deps.storyMediaInbox, payload, result);
      context.markSideEffect?.(false);
      const lastError = String(result.content?.lastError ?? '');
      const attemptError = JSON.stringify(result.attempt?.error ?? '');
      return {
        ...result,
        humanInterventionRequired:
          result.attempt?.status === PublishingAttemptStatus.UNCERTAIN &&
          `${lastError} ${attemptError}`.toLowerCase().includes('intervention'),
      };
    },
  };
}

/**
 * @param {import('../story-media-inbox.js').StoryMediaInbox | null | undefined} inbox
 * @param {Record<string, unknown>} payload
 * @param {{
 *   attempt?: { status?: string } | null,
 *   content?: { status?: string } | null,
 *   duplicate?: boolean,
 * }} result
 */
async function archiveSourceMediaIfRequested(inbox, payload, result) {
  if (!inbox || !payload.archiveOnComplete || !payload.sourceMediaPath) {
    return;
  }
  if (result.duplicate) {
    return;
  }
  const status = result.attempt?.status ?? result.content?.status;
  const sourcePath = String(payload.sourceMediaPath);
  try {
    if (status === PublishingAttemptStatus.SUCCEEDED) {
      await inbox.archivePublished(sourcePath);
    } else if (status === PublishingAttemptStatus.FAILED) {
      await inbox.archiveFailed(sourcePath);
    }
    // UNCERTAIN / DRY_RUN / NEEDS_ATTENTION: leave the original in place.
  } catch {
    // Archiving must not flip a successful publish into a task failure.
  }
}
