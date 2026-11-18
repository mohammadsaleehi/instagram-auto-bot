import path from 'node:path';
import { ContentRepository } from './content-repository.js';
import { ContentService } from './content-service.js';
import { MediaManager } from './media-manager.js';
import {
  createPublishingAdapter,
} from './publishing/publishing-adapter.js';
import {
  createMediaPublicUrlResolver,
} from './publishing/media-host.js';
import {
  PublishingService,
  createContentPublishHandler,
} from './publishing/publishing-service.js';
import {
  DEFAULT_MEDIA_LIBRARY_DIR,
  DEFAULT_STORY_MEDIA_DIR,
} from './constants.js';
import { StoryMediaInbox } from './story-media-inbox.js';

/**
 * Factory that wires the content-management module for Application / CLI.
 *
 * @param {{
 *   database: import('../../storage/database.js').Database,
 *   config?: Record<string, unknown>,
 *   scheduleRepository?: import('../../storage/repositories/schedule-repository.js').ScheduleRepository | null,
 *   taskRepository?: import('../../storage/repositories/task-repository.js').TaskRepository | null,
 *   nowFn?: () => Date,
 *   fetchFn?: typeof fetch,
 *   getPage?: (() => import('playwright').Page) | null,
 * }} options
 */
export function createContentManager(options) {
  const config = options.config ?? {};
  const projectRoot = String(config.projectRoot ?? process.cwd());
  const mediaDir = path.isAbsolute(String(config.mediaLibraryDir ?? DEFAULT_MEDIA_LIBRARY_DIR))
    ? String(config.mediaLibraryDir ?? DEFAULT_MEDIA_LIBRARY_DIR)
    : path.resolve(projectRoot, String(config.mediaLibraryDir ?? DEFAULT_MEDIA_LIBRARY_DIR));

  const storyMediaDir = path.isAbsolute(
    String(config.storyMediaDir ?? DEFAULT_STORY_MEDIA_DIR),
  )
    ? String(config.storyMediaDir ?? DEFAULT_STORY_MEDIA_DIR)
    : path.resolve(projectRoot, String(config.storyMediaDir ?? DEFAULT_STORY_MEDIA_DIR));

  const repository = new ContentRepository(options.database, {
    nowFn: options.nowFn,
  });
  const mediaManager = new MediaManager({
    mediaDir,
    constraints: config.mediaConstraints,
  });

  const storyMediaInbox = new StoryMediaInbox({
    storyMediaDir,
    mediaManager,
    nowFn: options.nowFn,
  });

  const mediaHost = createMediaPublicUrlResolver({
    mediaPublicBaseUrl: config.mediaPublicBaseUrl ?? null,
    mediaLibraryDir: mediaDir,
  });

  const adapterName = String(config.publishingAdapter ?? 'mock');
  const needsBrowserPage = adapterName === 'playwright' || adapterName === 'browser';
  const getPage =
    typeof options.getPage === 'function'
      ? options.getPage
      : needsBrowserPage
        ? () => {
            throw new Error(
              'Browser page unavailable. Start the engine with npm start so Playwright Story publishing can use the live session.',
            );
          }
        : undefined;

  const adapter = createPublishingAdapter({
    adapter: adapterName,
    accessToken: config.instagramGraphAccessToken ?? null,
    igUserId: config.instagramBusinessAccountId ?? null,
    loginFlow: config.instagramGraphLoginFlow ?? 'facebook',
    graphApiBaseUrl: config.instagramGraphApiBaseUrl ?? undefined,
    apiVersion: config.instagramGraphApiVersion ?? undefined,
    mediaPublicUrlResolver: mediaHost,
    fetchFn: options.fetchFn,
    getPage,
    baseUrl: config.instagramBaseUrl ?? undefined,
    navigationTimeoutMs: config.navigationTimeoutMs,
  });

  const publishingService = new PublishingService({
    repository,
    adapter,
    dryRunDefault: Boolean(config.contentDryRun ?? true),
    nowFn: options.nowFn,
  });

  const service = new ContentService({
    repository,
    mediaManager,
    publishingService,
    scheduleRepository: options.scheduleRepository ?? null,
    taskRepository: options.taskRepository ?? null,
    timezone: String(config.appTimezone ?? 'Europe/Berlin'),
    nowFn: options.nowFn,
    storyMediaInbox,
  });

  const browserPublish = adapter.getCapabilities().name === 'playwright';

  return {
    repository,
    mediaManager,
    storyMediaInbox,
    mediaHost,
    publishingService,
    service,
    adapter,
    publishHandler: createContentPublishHandler({
      publishingService,
      storyMediaInbox,
      requiresAuth: browserPublish,
    }),
  };
}

export { ContentService } from './content-service.js';
export { ContentRepository } from './content-repository.js';
export { MediaManager } from './media-manager.js';
export { StoryMediaInbox } from './story-media-inbox.js';
