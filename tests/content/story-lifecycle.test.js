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
  ContentType,
  STORY_TTL_MS,
  CONTENT_PUBLISH_TASK_TYPE,
} from '../../src/modules/content/constants.js';
import { MockPublishingAdapter } from '../../src/modules/content/publishing/publishing-adapter.js';

/** Minimal JPEG (SOI + APP0 + SOF0 1x1 + EOI) — magic-byte detectable */
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b,
  0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);

/** Minimal valid 1x1 PNG (invalid for Stories) */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('Story lifecycle', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-'));
    tempDirs.push(dir);
    const mediaDir = path.join(dir, 'media');
    const imagePath = path.join(dir, 'story.jpg');
    fs.writeFileSync(imagePath, TINY_JPEG);
    const pngPath = path.join(dir, 'story.png');
    fs.writeFileSync(pngPath, TINY_PNG);

    const database = new Database({ filePath: ':memory:' });
    database.open();
    const scheduleRepository = new ScheduleRepository(database);
    const taskRepository = new TaskRepository(database);
    const nowFn = overrides.nowFn ?? (() => new Date('2026-11-17T12:00:00.000Z'));
    const manager = createContentManager({
      database,
      config: {
        projectRoot: dir,
        mediaLibraryDir: mediaDir,
        publishingAdapter: 'mock',
        contentDryRun: false,
        appTimezone: 'Europe/Berlin',
        ...overrides.config,
      },
      scheduleRepository,
      taskRepository,
      nowFn,
    });

    return {
      dir,
      imagePath,
      pngPath,
      database,
      scheduleRepository,
      taskRepository,
      nowFn,
      ...manager,
    };
  }

  it('creates a Story draft with story_details and rejects PNG', async () => {
    const ctx = setup();
    const draft = await ctx.service.createStoryDraft({
      title: 'Product Introduction',
      type: 'IMAGE',
      mediaPaths: [ctx.imagePath],
      group: 'launch',
      order: 2,
    });

    expect(draft.contentType).toBe(ContentType.STORY);
    expect(draft.status).toBe(ContentStatus.DRAFT);
    expect(draft.story).toMatchObject({
      storyMediaType: 'IMAGE',
      storyGroupId: 'launch',
      sequenceOrder: 2,
    });

    await expect(
      ctx.service.createStoryDraft({
        title: 'Bad PNG',
        type: 'IMAGE',
        mediaPaths: [ctx.pngPath],
      }),
    ).rejects.toThrow(/JPEG/i);

    ctx.database.close();
  });

  it('approves Stories without captions and invalidates approval on edit', async () => {
    const ctx = setup();
    const draft = await ctx.service.createStoryDraft({
      title: 'Offer',
      mediaPaths: [ctx.imagePath],
    });

    const approved = ctx.service.approve(draft.id, { actor: 'alice' });
    expect(approved.status).toBe(ContentStatus.APPROVED);
    expect(approved.approvalStatus).toBe(ApprovalStatus.APPROVED);

    const edited = await ctx.service.updateDraft(approved.id, {
      title: 'Offer v2',
      actor: 'alice',
    });
    expect(edited.status).toBe(ContentStatus.DRAFT);
    expect(edited.approvalStatus).toBe(ApprovalStatus.INVALIDATED);
    ctx.database.close();
  });

  it('requires confirmation for immediate non-dry-run Story publish', async () => {
    const ctx = setup();
    const draft = await ctx.service.createStoryDraft({
      title: 'Now',
      mediaPaths: [ctx.imagePath],
    });
    ctx.service.approve(draft.id);

    await expect(
      ctx.service.publishNow(draft.id, { dryRun: false, confirm: false }),
    ).rejects.toThrow(/confirmation/i);

    ctx.database.close();
  });

  it('schedules Stories through the Phase 2 scheduler with ordering preserved', async () => {
    const ctx = setup();
    const first = await ctx.service.createStoryDraft({
      title: 'Slide 1',
      mediaPaths: [ctx.imagePath],
      group: 'seq',
      order: 0,
    });
    const second = await ctx.service.createStoryDraft({
      title: 'Slide 2',
      mediaPaths: [ctx.imagePath],
      group: 'seq',
      order: 1,
    });
    ctx.service.approve(first.id);
    ctx.service.approve(second.id);

    const when = new Date('2026-11-18T10:00:00+01:00');
    const scheduled = ctx.service.schedule(first.id, when);
    expect(scheduled.status).toBe(ContentStatus.SCHEDULED);
    expect(ctx.scheduleRepository.getById(scheduled.scheduleId)?.taskType).toBe(
      CONTENT_PUBLISH_TASK_TYPE,
    );

    const listed = ctx.service.listStories({ groupId: 'seq' });
    expect(listed.map((item) => item.title)).toEqual(['Slide 1', 'Slide 2']);

    const cancelled = ctx.service.cancel(first.id);
    expect(cancelled.status).toBe(ContentStatus.CANCELLED);
    ctx.database.close();
  });

  it('schedules a Story group sequence with stagger and duplicates story_details', async () => {
    const ctx = setup();
    const first = await ctx.service.createStoryDraft({
      title: 'G1',
      mediaPaths: [ctx.imagePath],
      group: 'campaign',
      order: 0,
    });
    const second = await ctx.service.createStoryDraft({
      title: 'G2',
      mediaPaths: [ctx.imagePath],
      group: 'campaign',
      order: 1,
    });
    ctx.service.approve(first.id);
    ctx.service.approve(second.id);

    const when = new Date('2026-11-18T10:00:00.000Z');
    const scheduled = ctx.service.scheduleStoryGroup('campaign', when, {
      staggerMs: 10_000,
    });
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0].scheduledAt).toBe('2026-11-18T10:00:00.000Z');
    expect(scheduled[1].scheduledAt).toBe('2026-11-18T10:00:10.000Z');
    expect(scheduled.every((item) => item.status === ContentStatus.SCHEDULED)).toBe(
      true,
    );

    const copy = ctx.service.duplicateDraft(first.id);
    expect(copy.contentType).toBe(ContentType.STORY);
    expect(copy.status).toBe(ContentStatus.DRAFT);
    expect(copy.story).toMatchObject({
      storyMediaType: 'IMAGE',
      storyGroupId: 'campaign',
      sequenceOrder: 0,
      storyPublishedAt: null,
      storyExpiresAt: null,
    });
    ctx.database.close();
  });

  it('dry-run never marks a Story as PUBLISHED', async () => {
    const ctx = setup({ config: { contentDryRun: true } });
    const draft = await ctx.service.createStoryDraft({
      title: 'Dry Story',
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
    expect(result.content.story?.storyExpiresAt).toBeNull();
    ctx.database.close();
  });

  it('mock Story publish persists expiry metadata and blocks duplicates', async () => {
    const ctx = setup();
    const draft = await ctx.service.createStoryDraft({
      title: 'Live sim',
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
    expect(first.content.story?.storyPublishedAt).toBeTruthy();
    expect(first.content.story?.storyExpiresAt).toBe(
      new Date(Date.parse(first.content.publishedAt) + STORY_TTL_MS).toISOString(),
    );

    await expect(
      ctx.publishingService.publishContent(draft.id, {
        dryRun: false,
        confirm: true,
        immediate: true,
      }),
    ).rejects.toThrow(/already published/i);

    ctx.database.close();
  });

  it('marks Stories EXPIRED after TTL without claiming Highlight actions', async () => {
    let now = new Date('2026-11-17T12:00:00.000Z');
    const ctx = setup({ nowFn: () => now });
    const draft = await ctx.service.createStoryDraft({
      title: 'Expire me',
      mediaPaths: [ctx.imagePath],
    });
    ctx.service.approve(draft.id);
    await ctx.publishingService.publishContent(draft.id, {
      dryRun: false,
      confirm: true,
      immediate: true,
    });

    now = new Date(now.getTime() + STORY_TTL_MS + 1000);
    const expired = ctx.service.expireDueStories({ now });
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe(ContentStatus.EXPIRED);
    expect(expired[0].contentType).toBe(ContentType.STORY);
    ctx.database.close();
  });

  it('moves uncertain Story publications to NEEDS_ATTENTION', async () => {
    const ctx = setup();
    ctx.publishingService.adapter = new MockPublishingAdapter({ uncertainNext: true });
    const draft = await ctx.service.createStoryDraft({
      title: 'Uncertain Story',
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
});
