import {
  ApprovalAction,
  ApprovalStatus,
  ContentError,
  ContentStatus,
  ContentType,
  CONTENT_PUBLISH_TASK_TYPE,
  STORY_MEDIA_CONSTRAINTS,
  STORY_TTL_MS,
} from './constants.js';
import { CaptionManager } from './caption-manager.js';
import {
  assertCaptionValid,
  assertReadyForReview,
  assertTitleValid,
  normalizeCaption,
  normalizeContentType,
  normalizeHashtags,
} from './content-validator.js';
import {
  assertTransition,
  editInvalidatesApproval,
} from './content-state-machine.js';
import {
  assertStoryReady,
  inferStoryMediaType,
  normalizeStoryMediaType,
} from './story-validator.js';

/**
 * Business-facing content lifecycle service (drafts, approval, schedule).
 */
export class ContentService {
  /**
   * @param {{
   *   repository: import('./content-repository.js').ContentRepository,
   *   mediaManager: import('./media-manager.js').MediaManager,
   *   publishingService: import('./publishing/publishing-service.js').PublishingService,
   *   scheduleRepository?: import('../../storage/repositories/schedule-repository.js').ScheduleRepository | null,
   *   taskRepository?: import('../../storage/repositories/task-repository.js').TaskRepository | null,
   *   timezone?: string,
   *   nowFn?: () => Date,
   * }} options
   */
  constructor(options) {
    this.repository = options.repository;
    this.mediaManager = options.mediaManager;
    this.publishingService = options.publishingService;
    this.scheduleRepository = options.scheduleRepository ?? null;
    this.taskRepository = options.taskRepository ?? null;
    this.timezone = options.timezone ?? 'Europe/Berlin';
    this._now = options.nowFn ?? (() => new Date());
    this.captions = new CaptionManager();
  }

  /**
   * @param {{
   *   title?: string,
   *   description?: string,
   *   caption?: string,
   *   hashtags?: unknown,
   *   contentType?: string,
   *   mediaPaths?: string[],
   *   storyMediaType?: string,
   *   storyGroupId?: string | null,
   *   sequenceOrder?: number,
   * }} input
   */
  async createDraft(input = {}) {
    const contentType = normalizeContentType(input.contentType ?? 'IMAGE');
    const composed = this.captions.compose(input.caption ?? '', input.hashtags ?? []);
    assertTitleValid(String(input.title ?? ''));
    assertCaptionValid(composed.caption);

    const item = this.repository.create({
      title: String(input.title ?? '').trim(),
      description: String(input.description ?? ''),
      caption: composed.caption,
      hashtags: composed.hashtags,
      contentType,
      status: ContentStatus.DRAFT,
      approvalStatus: ApprovalStatus.NONE,
      metadata:
        contentType === ContentType.STORY
          ? {
              storyGroupId: input.storyGroupId ?? null,
              sequenceOrder: Number(input.sequenceOrder ?? 0),
            }
          : {},
    });

    if (input.mediaPaths?.length) {
      await this.attachMedia(item.id, input.mediaPaths);
    }

    if (contentType === ContentType.STORY) {
      try {
        const refreshed = this.repository.getById(item.id);
        const media = refreshed?.media?.[0];
        if (media) {
          const storyMediaType = input.storyMediaType
            ? normalizeStoryMediaType(input.storyMediaType)
            : inferStoryMediaType(media);
          assertStoryReady(
            {
              contentType: ContentType.STORY,
              media: refreshed.media,
              story: { storyMediaType },
            },
            { constraints: STORY_MEDIA_CONSTRAINTS },
          );
          this.repository.upsertStoryDetails(item.id, {
            storyMediaType,
            storyGroupId: input.storyGroupId ?? null,
            sequenceOrder: Number(input.sequenceOrder ?? 0),
          });
        } else if (input.storyMediaType) {
          this.repository.upsertStoryDetails(item.id, {
            storyMediaType: normalizeStoryMediaType(input.storyMediaType),
            storyGroupId: input.storyGroupId ?? null,
            sequenceOrder: Number(input.sequenceOrder ?? 0),
          });
        }
      } catch (error) {
        this.repository.delete(item.id);
        throw error;
      }
    }

    return this.repository.getById(item.id);
  }

  /**
   * Create a Story draft (contentType=STORY). `--type` maps to Story media kind.
   *
   * @param {{
   *   title?: string,
   *   description?: string,
   *   mediaPaths?: string[],
   *   storyMediaType?: string,
   *   type?: string,
   *   storyGroupId?: string | null,
   *   group?: string | null,
   *   sequenceOrder?: number,
   *   order?: number,
   * }} input
   */
  async createStoryDraft(input = {}) {
    const explicitType = input.storyMediaType ?? input.type;
    return this.createDraft({
      title: input.title,
      description: input.description,
      caption: '',
      hashtags: [],
      contentType: ContentType.STORY,
      mediaPaths: input.mediaPaths,
      storyMediaType: explicitType
        ? normalizeStoryMediaType(explicitType)
        : undefined,
      storyGroupId: input.storyGroupId ?? input.group ?? null,
      sequenceOrder: input.sequenceOrder ?? input.order ?? 0,
    });
  }

  /**
   * @param {string} id
   * @param {{
   *   title?: string,
   *   description?: string,
   *   caption?: string,
   *   hashtags?: unknown,
   *   contentType?: string,
   *   mediaPaths?: string[],
   *   actor?: string,
   * }} patch
   */
  async updateDraft(id, patch = {}) {
    const existing = this.requireContent(id);
    if (
      existing.status === ContentStatus.PUBLISHED ||
      existing.status === ContentStatus.PUBLISHING
    ) {
      throw new ContentError(`Cannot edit content in status ${existing.status}`, {
        code: 'NOT_EDITABLE',
      });
    }

    /** @type {Record<string, unknown>} */
    const updates = {};
    if (patch.title !== undefined) {
      assertTitleValid(String(patch.title));
      updates.title = String(patch.title).trim();
    }
    if (patch.description !== undefined) {
      updates.description = String(patch.description);
    }
    if (patch.contentType !== undefined) {
      updates.contentType = normalizeContentType(patch.contentType);
    }
    if (patch.caption !== undefined || patch.hashtags !== undefined) {
      const composed = this.captions.compose(
        patch.caption !== undefined ? patch.caption : existing.caption,
        patch.hashtags !== undefined ? patch.hashtags : existing.hashtags,
      );
      updates.caption = composed.caption;
      updates.hashtags = composed.hashtags;
    }

    if (editInvalidatesApproval(existing.status)) {
      updates.status = ContentStatus.DRAFT;
      updates.approvalStatus = ApprovalStatus.INVALIDATED;
      updates.scheduledAt = null;
      if (existing.scheduleId && this.scheduleRepository) {
        this.scheduleRepository.update(existing.scheduleId, { enabled: false });
        updates.scheduleId = null;
      }
      this.repository.addApproval({
        contentId: id,
        action: ApprovalAction.INVALIDATE,
        actor: patch.actor ?? 'system',
        note: 'Approval invalidated because content was edited',
      });
    } else if (existing.status === ContentStatus.CANCELLED) {
      assertTransition(existing.status, ContentStatus.DRAFT);
      updates.status = ContentStatus.DRAFT;
      updates.approvalStatus = ApprovalStatus.NONE;
    }

    this.repository.update(id, updates);

    if (patch.mediaPaths) {
      await this.attachMedia(id, patch.mediaPaths);
    }

    return this.repository.getById(id);
  }

  /**
   * @param {string} id
   * @param {ReadonlyArray<string>} mediaPaths
   */
  async attachMedia(id, mediaPaths) {
    const existing = this.requireContent(id);
    const imported = [];
    for (const mediaPath of mediaPaths) {
      const asset = await this.mediaManager.importFile(mediaPath);
      imported.push({
        filePath: asset.filePath,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        mediaKind: asset.mediaKind,
        byteSize: asset.byteSize,
        checksumSha256: asset.checksumSha256,
        width: asset.width,
        height: asset.height,
        durationMs: asset.durationMs,
      });
    }
    this.repository.replaceMedia(id, imported);

    if (existing.contentType === ContentType.STORY) {
      const refreshed = this.repository.getById(id);
      const media = refreshed?.media?.[0];
      if (media) {
        const storyMediaType = inferStoryMediaType(media);
        assertStoryReady(
          {
            contentType: ContentType.STORY,
            media: refreshed.media,
            story: {
              storyMediaType,
              storyGroupId: existing.story?.storyGroupId ?? null,
              sequenceOrder: existing.story?.sequenceOrder ?? 0,
            },
          },
          { constraints: STORY_MEDIA_CONSTRAINTS },
        );
        this.repository.upsertStoryDetails(id, {
          storyMediaType,
          storyGroupId: existing.story?.storyGroupId ?? null,
          sequenceOrder: existing.story?.sequenceOrder ?? 0,
          storyContainerId: null,
          storyPublishedAt: null,
          storyExpiresAt: null,
        });
      }
    }

    return this.repository.getById(id);
  }

  /**
   * @param {string} id
   */
  deleteDraft(id) {
    const existing = this.requireContent(id);
    if (existing.status === ContentStatus.PUBLISHED) {
      throw new ContentError('Published content cannot be deleted', {
        code: 'NOT_DELETABLE',
      });
    }
    if (existing.status === ContentStatus.PUBLISHING) {
      throw new ContentError('Cannot delete content while publishing', {
        code: 'NOT_DELETABLE',
      });
    }
    if (existing.scheduleId && this.scheduleRepository) {
      this.scheduleRepository.update(existing.scheduleId, { enabled: false });
    }
    return this.repository.delete(id);
  }

  /**
   * @param {string} id
   */
  duplicateDraft(id) {
    const existing = this.requireContent(id);
    const copy = this.repository.create({
      title: `${existing.title} (copy)`.trim(),
      description: existing.description,
      caption: existing.caption,
      hashtags: existing.hashtags,
      contentType: existing.contentType,
      status: ContentStatus.DRAFT,
      approvalStatus: ApprovalStatus.NONE,
      metadata: { duplicatedFrom: existing.id },
    });
    if (existing.media.length) {
      this.repository.replaceMedia(
        copy.id,
        existing.media.map((m) => ({
          filePath: m.filePath,
          originalName: m.originalName,
          mimeType: m.mimeType,
          mediaKind: m.mediaKind,
          byteSize: m.byteSize,
          checksumSha256: m.checksumSha256,
          width: m.width,
          height: m.height,
          durationMs: m.durationMs,
          sortOrder: m.sortOrder,
        })),
      );
    }
    if (existing.contentType === ContentType.STORY && existing.story) {
      this.repository.upsertStoryDetails(copy.id, {
        storyMediaType: existing.story.storyMediaType,
        storyGroupId: existing.story.storyGroupId,
        sequenceOrder: existing.story.sequenceOrder,
        storyContainerId: null,
        storyPublishedAt: null,
        storyExpiresAt: null,
      });
    }
    return this.repository.getById(copy.id);
  }

  /**
   * @param {string} id
   */
  preview(id) {
    const item = this.requireContent(id);
    const composed = this.captions.compose(item.caption, item.hashtags);
    return {
      ...item,
      captionPreview: composed.preview,
      suggestions: this.captions.suggest(item.caption),
    };
  }

  /**
   * @param {{ status?: string | string[], contentType?: string, query?: string, limit?: number, offset?: number }} [filters]
   */
  list(filters = {}) {
    return this.repository.list(filters);
  }

  /**
   * @param {string} id
   */
  get(id) {
    return this.requireContent(id);
  }

  /**
   * @param {string} id
   * @param {{ actor?: string, note?: string }} [options]
   */
  submitForReview(id, options = {}) {
    const item = this.requireContent(id);
    assertReadyForReview(item, {
      requireCaption: item.contentType !== ContentType.STORY,
    });
    if (item.contentType === ContentType.STORY) {
      assertStoryReady(item, { constraints: STORY_MEDIA_CONSTRAINTS });
    }
    assertTransition(item.status, ContentStatus.READY_FOR_REVIEW);
    this.repository.update(id, {
      status: ContentStatus.READY_FOR_REVIEW,
      approvalStatus: ApprovalStatus.PENDING,
    });
    this.repository.addApproval({
      contentId: id,
      action: ApprovalAction.SUBMIT_FOR_REVIEW,
      actor: options.actor ?? 'operator',
      note: options.note ?? '',
    });
    return this.repository.getById(id);
  }

  /**
   * @param {string} id
   * @param {{ actor?: string, note?: string }} [options]
   */
  approve(id, options = {}) {
    const item = this.requireContent(id);
    let current = item;
    if (current.status === ContentStatus.DRAFT) {
      current = this.submitForReview(id, options);
    }
    assertReadyForReview(current, {
      requireCaption: current.contentType !== ContentType.STORY,
    });
    if (current.contentType === ContentType.STORY) {
      assertStoryReady(current, { constraints: STORY_MEDIA_CONSTRAINTS });
    }
    assertTransition(current.status, ContentStatus.APPROVED);
    this.repository.update(id, {
      status: ContentStatus.APPROVED,
      approvalStatus: ApprovalStatus.APPROVED,
      lastError: null,
    });
    this.repository.addApproval({
      contentId: id,
      action: ApprovalAction.APPROVE,
      actor: options.actor ?? 'operator',
      note: options.note ?? '',
    });
    return this.repository.getById(id);
  }

  /**
   * @param {string} id
   * @param {{ actor?: string, note?: string }} [options]
   */
  reject(id, options = {}) {
    const item = this.requireContent(id);
    assertTransition(item.status, ContentStatus.REJECTED);
    this.repository.update(id, {
      status: ContentStatus.REJECTED,
      approvalStatus: ApprovalStatus.REJECTED,
    });
    this.repository.addApproval({
      contentId: id,
      action: ApprovalAction.REJECT,
      actor: options.actor ?? 'operator',
      note: options.note ?? '',
    });
    return this.repository.getById(id);
  }

  /**
   * Schedule approved content for future publishing via Phase 2 Scheduler.
   *
   * @param {string} id
   * @param {string | Date} when
   * @param {{ dryRun?: boolean, actor?: string }} [options]
   */
  schedule(id, when, options = {}) {
    const item = this.requireContent(id);
    if (item.status !== ContentStatus.APPROVED && item.status !== ContentStatus.SCHEDULED) {
      throw new ContentError('Only APPROVED content can be scheduled', {
        code: 'NOT_APPROVED',
        details: { status: item.status },
      });
    }
    if (item.approvalStatus !== ApprovalStatus.APPROVED) {
      throw new ContentError('Valid approval required before scheduling', {
        code: 'APPROVAL_REQUIRED',
      });
    }
    if (item.contentType === ContentType.STORY) {
      assertStoryReady(item, { constraints: STORY_MEDIA_CONSTRAINTS });
    }

    const runAt = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(runAt.getTime())) {
      throw new ContentError('Invalid schedule timestamp', {
        code: 'INVALID_SCHEDULE',
      });
    }

    const runAtIso = runAt.toISOString();
    let scheduleId = item.scheduleId;

    if (this.scheduleRepository) {
      const scheduleInput = this.publishingService.buildScheduleInput(id, runAtIso, {
        timezone: this.timezone,
        dryRun: options.dryRun,
      });
      if (scheduleId) {
        const updated = this.scheduleRepository.upsert({
          id: scheduleId,
          ...scheduleInput,
        });
        scheduleId = updated.id;
      } else {
        const created = this.scheduleRepository.upsert(scheduleInput);
        scheduleId = created.id;
      }
    }

    if (item.status === ContentStatus.APPROVED) {
      assertTransition(item.status, ContentStatus.SCHEDULED);
    }

    return this.repository.update(id, {
      status: ContentStatus.SCHEDULED,
      scheduledAt: runAtIso,
      scheduleId,
      lastError: null,
    });
  }

  /**
   * Schedule all APPROVED Stories in a group in sequence order.
   * Uses the existing Phase 2 scheduler (one schedule row per Story).
   * Stagger ensures Instagram receives slides in intended order.
   *
   * @param {string} groupId
   * @param {string | Date} when
   * @param {{ dryRun?: boolean, staggerMs?: number }} [options]
   */
  scheduleStoryGroup(groupId, when, options = {}) {
    const group = String(groupId ?? '').trim();
    if (!group) {
      throw new ContentError('Story group id is required', {
        code: 'INVALID_STORY_GROUP',
      });
    }
    const base = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(base.getTime())) {
      throw new ContentError('Invalid schedule timestamp', {
        code: 'INVALID_SCHEDULE',
      });
    }
    const staggerMs = Math.max(0, Number(options.staggerMs ?? 5_000));
    const stories = this.listStories({ groupId: group }).filter(
      (item) =>
        item.status === ContentStatus.APPROVED ||
        item.status === ContentStatus.SCHEDULED,
    );
    if (!stories.length) {
      throw new ContentError(`No APPROVED Stories found in group "${group}"`, {
        code: 'STORY_GROUP_EMPTY',
        details: { groupId: group },
      });
    }
    return stories.map((item, index) => {
      const runAt = new Date(base.getTime() + index * staggerMs);
      return this.schedule(item.id, runAt, { dryRun: options.dryRun });
    });
  }

  /**
   * @param {string} id
   * @param {string | Date} when
   * @param {{ dryRun?: boolean }} [options]
   */
  reschedule(id, when, options = {}) {
    const item = this.requireContent(id);
    if (item.status !== ContentStatus.SCHEDULED) {
      throw new ContentError('Only SCHEDULED content can be rescheduled', {
        code: 'NOT_SCHEDULED',
      });
    }
    return this.schedule(id, when, options);
  }

  /**
   * @param {string} id
   * @param {{ actor?: string, note?: string }} [options]
   */
  cancel(id, options = {}) {
    const item = this.requireContent(id);
    if (
      item.status === ContentStatus.PUBLISHED ||
      item.status === ContentStatus.PUBLISHING
    ) {
      throw new ContentError(`Cannot cancel content in status ${item.status}`, {
        code: 'NOT_CANCELLABLE',
      });
    }
    assertTransition(item.status, ContentStatus.CANCELLED);
    if (item.scheduleId && this.scheduleRepository) {
      this.scheduleRepository.update(item.scheduleId, { enabled: false });
    }
    return this.repository.update(id, {
      status: ContentStatus.CANCELLED,
      scheduledAt: null,
      scheduleId: null,
      lastError: options.note ?? null,
    });
  }

  /**
   * Enqueue immediate publish through the Phase 2 task queue (or run inline).
   *
   * @param {string} id
   * @param {{ dryRun?: boolean, confirm?: boolean, enqueue?: boolean }} [options]
   */
  async publishNow(id, options = {}) {
    if (!options.confirm && !(options.dryRun ?? false)) {
      throw new ContentError(
        'Immediate publishing requires explicit confirmation (--confirm)',
        { code: 'CONFIRMATION_REQUIRED' },
      );
    }

    const item = this.requireContent(id);
    if (item.status !== ContentStatus.APPROVED && item.status !== ContentStatus.SCHEDULED) {
      throw new ContentError('Content must be APPROVED (or SCHEDULED) before publishing', {
        code: 'NOT_APPROVED',
      });
    }

    if (options.enqueue !== false && this.taskRepository) {
      const { task, created } = this.taskRepository.create({
        type: CONTENT_PUBLISH_TASK_TYPE,
        payload: {
          contentId: id,
          dryRun: Boolean(options.dryRun),
        },
        priority: 80,
        maxAttempts: 1,
        idempotencyKey: item.idempotencyKey ?? `content-publish:${id}`,
      });
      return { enqueued: created, task, content: item, duplicate: !created };
    }

    return {
      enqueued: false,
      ...(await this.publishingService.publishContent(id, {
        dryRun: options.dryRun,
        confirm: options.confirm,
        immediate: true,
      })),
    };
  }

  /**
   * @param {{ missed?: boolean, limit?: number }} [options]
   */
  listCalendar(options = {}) {
    return {
      upcoming: this.repository.listScheduled({
        missed: false,
        limit: options.limit,
        now: this._now(),
      }),
      missed: this.repository.listScheduled({
        missed: true,
        limit: options.limit,
        now: this._now(),
      }),
    };
  }

  /**
   * @param {string} id
   * @param {{ limit?: number }} [options]
   */
  history(id, options = {}) {
    this.requireContent(id);
    return {
      content: this.repository.getById(id),
      approvals: this.repository.listApprovals(id),
      publishing: this.repository.listPublishingHistory(id, options),
    };
  }

  /**
   * List Story items (optionally filtered by group / status).
   *
   * @param {{
   *   status?: string | string[],
   *   groupId?: string,
   *   query?: string,
   *   limit?: number,
   *   offset?: number,
   * }} [filters]
   */
  listStories(filters = {}) {
    return this.repository.listStories(filters);
  }

  /**
   * Require a Story content item.
   *
   * @param {string} id
   */
  requireStory(id) {
    const item = this.requireContent(id);
    if (item.contentType !== ContentType.STORY) {
      throw new ContentError(`Content ${id} is not a Story (type=${item.contentType})`, {
        code: 'NOT_A_STORY',
        details: { contentType: item.contentType },
      });
    }
    return item;
  }

  /**
   * Mark published Stories past their expiry timestamp as EXPIRED.
   * Expiration is tracked separately from publishing success.
   *
   * @param {{ now?: Date, limit?: number }} [options]
   */
  expireDueStories(options = {}) {
    const due = this.repository.listExpiredPublishedStories({
      now: options.now ?? this._now(),
      limit: options.limit,
    });
    /** @type {object[]} */
    const expired = [];
    for (const item of due) {
      assertTransition(item.status, ContentStatus.EXPIRED);
      expired.push(
        this.repository.update(item.id, {
          status: ContentStatus.EXPIRED,
        }),
      );
    }
    return expired;
  }

  /**
   * Preview Story metadata including validation warnings.
   *
   * @param {string} id
   */
  previewStory(id) {
    const item = this.requireStory(id);
    const validation = item.media?.length
      ? assertStoryReady(item, { constraints: STORY_MEDIA_CONSTRAINTS })
      : null;
    const expiresAt = item.story?.storyExpiresAt ?? null;
    const now = this._now().getTime();
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    return {
      ...item,
      storyValidation: validation,
      storyActive:
        item.status === ContentStatus.PUBLISHED &&
        Number.isFinite(expiresMs) &&
        expiresMs > now,
      storyRemainingMs:
        item.status === ContentStatus.PUBLISHED && Number.isFinite(expiresMs)
          ? Math.max(0, expiresMs - now)
          : null,
      storyTtlMs: STORY_TTL_MS,
    };
  }

  /**
   * @param {string} id
   */
  requireContent(id) {
    const item = this.repository.getById(id);
    if (!item) {
      throw new ContentError(`Content not found: ${id}`, {
        code: 'CONTENT_NOT_FOUND',
      });
    }
    return item;
  }
}
