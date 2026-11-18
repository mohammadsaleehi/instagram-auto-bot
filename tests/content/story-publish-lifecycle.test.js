import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/storage/database.js';
import { ScheduleRepository } from '../../src/storage/repositories/schedule-repository.js';
import { TaskRepository } from '../../src/storage/repositories/task-repository.js';
import { createContentManager } from '../../src/modules/content/content-manager.js';
import {
  CONTENT_PUBLISH_TASK_TYPE,
  ContentStatus,
} from '../../src/modules/content/constants.js';
import { parseContentArgs } from '../../src/cli/ui/content-args.js';

const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
  0x00, 0xff, 0xd9,
]);

describe('Story publish lifecycle (browser Phase 1)', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-pub-'));
    tempDirs.push(dir);
    const mediaDir = path.join(dir, 'library');
    const storyMediaDir = path.join(dir, 'stories');
    const database = new Database({ filePath: ':memory:' });
    database.open();
    const scheduleRepository = new ScheduleRepository(database);
    const taskRepository = new TaskRepository(database);
    const manager = createContentManager({
      database,
      config: {
        projectRoot: dir,
        mediaLibraryDir: mediaDir,
        storyMediaDir,
        publishingAdapter: overrides.publishingAdapter ?? 'mock',
        contentDryRun: false,
        appTimezone: 'Europe/Berlin',
        ...overrides.config,
      },
      scheduleRepository,
      taskRepository,
      getPage: overrides.getPage,
      nowFn: () => new Date('2026-11-18T12:00:00.000Z'),
    });
    return { dir, storyMediaDir, taskRepository, ...manager };
  }

  it('publishStoryFromMedia requires confirm, enqueues once, prevents duplicate task', async () => {
    const ctx = setup();
    await ctx.storyMediaInbox.initialize();
    const fileName = 'story-01.jpg';
    fs.writeFileSync(path.join(ctx.storyMediaInbox.pendingDir, fileName), TINY_JPEG);

    await expect(
      ctx.service.publishStoryFromMedia(fileName, { confirm: false, dryRun: false }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });

    const first = await ctx.service.publishStoryFromMedia(fileName, {
      confirm: true,
      dryRun: true,
      enqueue: true,
    });
    expect(first.enqueued).toBe(true);
    expect(first.task.type).toBe(CONTENT_PUBLISH_TASK_TYPE);
    expect(first.task.payload.sourceMediaPath).toContain(fileName);
    expect(first.task.maxAttempts).toBe(1);

    const second = await ctx.service.publishStoryFromMedia(fileName, {
      confirm: true,
      dryRun: true,
      enqueue: true,
    });
    // New content id → new idempotency key; task create still unique per content.
    expect(second.content.id).not.toBe(first.content.id);

    const status = ctx.service.latestStoryPublicationStatus({});
    expect(status.latest).toBeNull();
  });

  it('inline mock publish archives on success and records history', async () => {
    const ctx = setup();
    await ctx.storyMediaInbox.initialize();
    const fileName = 'ok.jpg';
    const pendingPath = path.join(ctx.storyMediaInbox.pendingDir, fileName);
    fs.writeFileSync(pendingPath, TINY_JPEG);

    const result = await ctx.service.publishStoryFromMedia(fileName, {
      confirm: true,
      dryRun: false,
      enqueue: false,
    });

    expect(result.enqueued).toBe(false);
    expect(result.content.status).toBe(ContentStatus.PUBLISHED);
    expect(result.attempt.status).toBe('SUCCEEDED');
    expect(fs.existsSync(pendingPath)).toBe(false);
    const publishedFiles = fs.readdirSync(ctx.storyMediaInbox.publishedDir);
    expect(publishedFiles.some((name) => name.includes(fileName))).toBe(true);

    const status = ctx.service.latestStoryPublicationStatus({
      contentId: result.content.id,
    });
    expect(status.latest.attempt.status).toBe('SUCCEEDED');
  });

  it('UNCERTAIN outcomes leave pending media in place', async () => {
    const ctx = setup();
    ctx.adapter.uncertainNext = true;
    await ctx.storyMediaInbox.initialize();
    const fileName = 'maybe.jpg';
    const pendingPath = path.join(ctx.storyMediaInbox.pendingDir, fileName);
    fs.writeFileSync(pendingPath, TINY_JPEG);

    const result = await ctx.service.publishStoryFromMedia(fileName, {
      confirm: true,
      dryRun: false,
      enqueue: false,
    });

    expect(result.content.status).toBe(ContentStatus.NEEDS_ATTENTION);
    expect(result.attempt.status).toBe('UNCERTAIN');
    expect(fs.existsSync(pendingPath)).toBe(true);
  });

  it('createContentPublishHandler archives after task success', async () => {
    const ctx = setup();
    await ctx.storyMediaInbox.initialize();
    const fileName = 'task.jpg';
    const pendingPath = path.join(ctx.storyMediaInbox.pendingDir, fileName);
    fs.writeFileSync(pendingPath, TINY_JPEG);

    const prepared = await ctx.service.publishStoryFromMedia(fileName, {
      confirm: true,
      dryRun: false,
      enqueue: true,
    });

    const handlerResult = await ctx.publishHandler.execute(
      { markSideEffect: () => {} },
      prepared.task.payload,
      undefined,
    );

    expect(handlerResult.content.status).toBe(ContentStatus.PUBLISHED);
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it('parseContentArgs supports confirm and dry-run for publish CLI', () => {
    const parsed = parseContentArgs([
      'story-01.jpg',
      '--confirm',
      '--dry-run',
      '--title=Launch',
    ]);
    expect(parsed.positionals).toEqual(['story-01.jpg']);
    expect(parsed.flags.confirm).toBe(true);
    expect(parsed.flags.dryRun).toBe(true);
    expect(parsed.flags.title).toBe('Launch');
  });
});
