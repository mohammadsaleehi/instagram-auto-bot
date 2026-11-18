import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/storage/database.js';
import { ScheduleRepository } from '../../src/storage/repositories/schedule-repository.js';
import { TaskRepository } from '../../src/storage/repositories/task-repository.js';
import { createContentManager } from '../../src/modules/content/content-manager.js';
import {
  ApprovalStatus,
  ContentStatus,
  CONTENT_PUBLISH_TASK_TYPE,
} from '../../src/modules/content/constants.js';
import { MockPublishingAdapter } from '../../src/modules/content/publishing/publishing-adapter.js';

/** Minimal valid 1x1 PNG */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('Content lifecycle', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-'));
    tempDirs.push(dir);
    const mediaDir = path.join(dir, 'media');
    const imagePath = path.join(dir, 'photo.png');
    fs.writeFileSync(imagePath, TINY_PNG);

    const database = new Database({ filePath: ':memory:' });
    database.open();
    const scheduleRepository = new ScheduleRepository(database);
    const taskRepository = new TaskRepository(database);
    const manager = createContentManager({
      database,
      config: {
        projectRoot: dir,
        mediaLibraryDir: mediaDir,
        publishingAdapter: 'mock',
        contentDryRun: false,
        appTimezone: 'Europe/Berlin',
      },
      scheduleRepository,
      taskRepository,
    });

    return { dir, imagePath, database, scheduleRepository, taskRepository, ...manager };
  }

  it('creates, edits, lists, and deletes drafts', async () => {
    const ctx = setup();
    const created = await ctx.service.createDraft({
      title: 'Hello',
      caption: 'Caption body',
      hashtags: ['launch', 'bot'],
      contentType: 'IMAGE',
      mediaPaths: [ctx.imagePath],
    });

    expect(created.status).toBe(ContentStatus.DRAFT);
    expect(created.hashtags).toEqual(['#launch', '#bot']);
    expect(created.media).toHaveLength(1);
    expect(created.media[0].mimeType).toBe('image/png');

    const edited = await ctx.service.updateDraft(created.id, {
      title: 'Hello edited',
      caption: 'Updated',
    });
    expect(edited.title).toBe('Hello edited');
    expect(edited.caption).toBe('Updated');

    const listed = ctx.service.list({ query: 'edited' });
    expect(listed).toHaveLength(1);

    const dup = ctx.service.duplicateDraft(created.id);
    expect(dup.id).not.toBe(created.id);
    expect(dup.status).toBe(ContentStatus.DRAFT);

    expect(ctx.service.deleteDraft(dup.id)).toBe(true);
    ctx.database.close();
  });

  it('requires approval and invalidates approval after edit', async () => {
    const ctx = setup();
    const draft = await ctx.service.createDraft({
      title: 'Post',
      caption: 'Ready',
      contentType: 'IMAGE',
      mediaPaths: [ctx.imagePath],
    });

    const approved = ctx.service.approve(draft.id, { actor: 'alice' });
    expect(approved.status).toBe(ContentStatus.APPROVED);
    expect(approved.approvalStatus).toBe(ApprovalStatus.APPROVED);

    const edited = await ctx.service.updateDraft(approved.id, {
      caption: 'Changed after approval',
      actor: 'alice',
    });
    expect(edited.status).toBe(ContentStatus.DRAFT);
    expect(edited.approvalStatus).toBe(ApprovalStatus.INVALIDATED);

    const history = ctx.service.history(approved.id);
    expect(history.approvals.some((row) => row.action === 'INVALIDATE')).toBe(true);
    ctx.database.close();
  });

  it('schedules, reschedules, and cancels with Phase 2 schedules', async () => {
    const ctx = setup();
    const draft = await ctx.service.createDraft({
      title: 'Scheduled',
      caption: 'Later',
      contentType: 'IMAGE',
      mediaPaths: [ctx.imagePath],
    });
    ctx.service.approve(draft.id);

    const when = new Date('2026-12-01T09:00:00+01:00');
    const scheduled = ctx.service.schedule(draft.id, when);
    expect(scheduled.status).toBe(ContentStatus.SCHEDULED);
    expect(scheduled.scheduleId).toBeTruthy();
    expect(ctx.scheduleRepository.getById(scheduled.scheduleId)?.taskType).toBe(
      CONTENT_PUBLISH_TASK_TYPE,
    );

    const later = new Date('2026-12-02T09:00:00+01:00');
    const rescheduled = ctx.service.reschedule(draft.id, later);
    expect(rescheduled.scheduledAt).toBe(later.toISOString());

    const calendar = ctx.service.listCalendar();
    expect(calendar.upcoming.some((item) => item.id === draft.id)).toBe(true);

    const cancelled = ctx.service.cancel(draft.id, { note: 'changed plans' });
    expect(cancelled.status).toBe(ContentStatus.CANCELLED);
    expect(ctx.scheduleRepository.getById(scheduled.scheduleId)?.enabled).toBe(false);
    ctx.database.close();
  });

  it('mock-publishes with idempotency and never labels simulation as real', async () => {
    const ctx = setup();
    const draft = await ctx.service.createDraft({
      title: 'Publish me',
      caption: 'Live',
      contentType: 'IMAGE',
      mediaPaths: [ctx.imagePath],
    });
    ctx.service.approve(draft.id);

    const first = await ctx.publishingService.publishContent(draft.id, {
      dryRun: false,
      confirm: true,
      immediate: true,
    });
    expect(first.content.status).toBe(ContentStatus.PUBLISHED);
    expect(first.simulated).toBe(true);
    expect(first.attempt.result.realInstagramPublication).toBe(false);
    expect(String(first.content.externalPublishId)).toMatch(/^mock_pub_/);

    await expect(
      ctx.publishingService.publishContent(draft.id, {
        dryRun: false,
        confirm: true,
        immediate: true,
      }),
    ).rejects.toThrow(/already published/i);

    ctx.database.close();
  });

  it('moves uncertain publications to NEEDS_ATTENTION without blind retry success', async () => {
    const ctx = setup();
    ctx.publishingService.adapter = new MockPublishingAdapter({ uncertainNext: true });

    const draft = await ctx.service.createDraft({
      title: 'Uncertain',
      caption: 'Maybe',
      contentType: 'IMAGE',
      mediaPaths: [ctx.imagePath],
    });
    ctx.service.approve(draft.id);

    const result = await ctx.publishingService.publishContent(draft.id, {
      dryRun: false,
      confirm: true,
      immediate: true,
    });
    expect(result.content.status).toBe(ContentStatus.NEEDS_ATTENTION);
    expect(result.attempt.status).toBe('UNCERTAIN');
    ctx.database.close();
  });

  it('dry-run does not mark content as published', async () => {
    const ctx = setup();
    const draft = await ctx.service.createDraft({
      title: 'Dry',
      caption: 'Run',
      contentType: 'IMAGE',
      mediaPaths: [ctx.imagePath],
    });
    ctx.service.approve(draft.id);

    const result = await ctx.publishingService.publishContent(draft.id, {
      dryRun: true,
      confirm: true,
      immediate: true,
    });
    expect(result.content.status).toBe(ContentStatus.APPROVED);
    expect(result.attempt.status).toBe('DRY_RUN');
    expect(result.content.externalPublishId).toBeNull();
    ctx.database.close();
  });

  it('enqueues content.publish via task repository with idempotency', async () => {
    const ctx = setup();
    const draft = await ctx.service.createDraft({
      title: 'Queue',
      caption: 'Now',
      contentType: 'IMAGE',
      mediaPaths: [ctx.imagePath],
    });
    ctx.service.approve(draft.id);

    const first = await ctx.service.publishNow(draft.id, {
      dryRun: true,
      confirm: true,
      enqueue: true,
    });
    expect(first.enqueued).toBe(true);
    expect(first.task.type).toBe(CONTENT_PUBLISH_TASK_TYPE);

    const second = await ctx.service.publishNow(draft.id, {
      dryRun: true,
      confirm: true,
      enqueue: true,
    });
    expect(second.enqueued).toBe(false);
    expect(second.duplicate).toBe(true);
    ctx.database.close();
  });
});
