import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthState } from '../../src/auth/auth-state.js';
import { ContentType } from '../../src/modules/content/constants.js';
import {
  DEFAULT_STORY_TIMEOUTS,
  HumanInterventionRequiredError,
  PlaywrightStoryPublishingAdapter,
  StoryPublishState,
} from '../../src/modules/content/publishing/playwright-story-adapter.js';
import { STORY_FAILURE_CODES } from '../../src/modules/content/publishing/story/story-states.js';

/**
 * Minimal page double for preflight/auth-ordering tests. It deliberately makes
 * `screenshot` and `setViewportSize` throw so any regression is obvious.
 */
function createFakePage(options = {}) {
  let currentUrl = options.startUrl ?? 'about:blank';
  const events = { goto: [], cdp: [] };
  const cdp = {
    send: vi.fn(async (method, params = {}) => {
      events.cdp.push({ method, params });
      return {};
    }),
  };
  const page = {
    context: () => ({ newCDPSession: async () => cdp }),
    goto: vi.fn(async (target) => {
      events.goto.push(target);
      currentUrl = target;
    }),
    url: () => currentUrl,
    evaluate: vi.fn(async () => ({
      url: currentUrl,
      screenOrientation: 'portrait-primary',
      screenAngle: 0,
      innerWidth: 390,
      innerHeight: 844,
      screenWidth: 390,
      screenHeight: 844,
      devicePixelRatio: 3,
      userAgent: 'fixture',
      platform: 'iPhone',
      maxTouchPoints: 5,
    })),
    waitForTimeout: async () => {},
    reload: vi.fn(async () => {}),
    keyboard: { press: vi.fn(async () => {}) },
    on: vi.fn(),
    off: vi.fn(),
    getByRole: () => ({ first: () => ({ isVisible: async () => false, click: async () => {} }) }),
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
    locator: () => ({ first: () => ({ isVisible: async () => false, click: async () => {} }) }),
    screenshot: vi.fn(() => {
      throw new Error('FORBIDDEN page.screenshot');
    }),
    setViewportSize: vi.fn(() => {
      throw new Error('FORBIDDEN page.setViewportSize');
    }),
  };
  return { page, cdp, events };
}

function authOk() {
  return { state: AuthState.AUTHENTICATED, url: 'https://www.instagram.com/', signals: [] };
}

function storyRequest(media, overrides = {}) {
  return {
    contentId: 'content-1',
    contentType: ContentType.STORY,
    caption: '',
    hashtags: [],
    media,
    idempotencyKey: 'idem-1',
    dryRun: true,
    ...overrides,
  };
}

async function makeTempMedia() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-adapter-unit-'));
  const filePath = path.join(dir, 'story.png');
  await fs.writeFile(filePath, Buffer.from('not-a-real-image-but-a-file'));
  return { dir, filePath };
}

describe('PlaywrightStoryPublishingAdapter Phase 0–4 contract', () => {
  it('exports the legacy surface and canonical Story states', () => {
    expect(typeof HumanInterventionRequiredError).toBe('function');
    expect(StoryPublishState.EDITOR_READY).toBe('EDITOR_READY');
    expect(StoryPublishState.READY_TO_SHARE).toBe('EDITOR_READY');
    expect(StoryPublishState.UPLOAD_FAILED).toBe('PUBLISH_FAILED');
    expect(DEFAULT_STORY_TIMEOUTS.navigationMs).toBeGreaterThan(0);
  });

  it('declares dryRunOnly and publication disabled', () => {
    const { page } = createFakePage();
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      diagnosticsDir: null,
    });
    const caps = adapter.getCapabilities();
    expect(caps.isMock).toBe(false);
    expect(caps.dryRunOnly).toBe(true);
    expect(caps.publicationEnabled).toBe(false);
    expect(caps.phase).toBe('entry-editor');
    expect(caps.surface).toBe('mobile-web-portrait');
    expect(caps.supportedContentTypes).toEqual([ContentType.STORY]);
  });

  it('does not touch the browser when content type is not STORY', async () => {
    const { page, events } = createFakePage();
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      diagnosticsDir: null,
    });
    const result = await adapter.publish(
      storyRequest([{ filePath: '/tmp/nope.png', mimeType: 'image/png' }], {
        contentType: ContentType.POST,
      }),
    );
    expect(result.status).toBe('FAILED');
    expect(result.raw?.machine?.failureCode).toBe(
      STORY_FAILURE_CODES.PREFLIGHT_CONTENT_TYPE_INVALID,
    );
    expect(result.raw?.machine?.state).toBe(StoryPublishState.PUBLISH_FAILED);
    expect(events.goto).toEqual([]);
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(page.setViewportSize).not.toHaveBeenCalled();
  });

  it('requires exactly one local media file', async () => {
    const { page, events } = createFakePage();
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      diagnosticsDir: null,
    });
    const result = await adapter.publish(storyRequest([]));
    expect(result.status).toBe('FAILED');
    expect(result.raw?.machine?.failureCode).toBe(STORY_FAILURE_CODES.PREFLIGHT_MEDIA_INVALID);
    expect(events.goto).toEqual([]);

    const { dir, filePath } = await makeTempMedia();
    try {
      const two = await adapter.publish(
        storyRequest([
          { filePath, mimeType: 'image/png' },
          { filePath, mimeType: 'image/png' },
        ]),
      );
      expect(two.raw?.machine?.failureCode).toBe(
        STORY_FAILURE_CODES.PREFLIGHT_MEDIA_INVALID,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing media file before any browser work', async () => {
    const { page, events } = createFakePage();
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      diagnosticsDir: null,
    });
    const result = await adapter.publish(
      storyRequest([{ filePath: '/tmp/story-file-that-does-not-exist.png', mimeType: 'image/png' }]),
    );
    expect(result.status).toBe('FAILED');
    expect(result.raw?.machine?.failureCode).toBe(STORY_FAILURE_CODES.PREFLIGHT_MEDIA_INVALID);
    expect(result.raw?.machine?.retryable).toBe(true);
    expect(events.goto).toEqual([]);
  });

  it('refuses a real publication without a one-time authorization', async () => {
    const { page, events } = createFakePage();
    const { dir, filePath } = await makeTempMedia();
    try {
      const adapter = new PlaywrightStoryPublishingAdapter({
        getPage: () => page,
        diagnosticsDir: null,
        enablePublication: true,
        expectedAccountHandle: 'mohammad7656336',
        operationStore: {},
      });
      const result = await adapter.publish(
        storyRequest([{ filePath, mimeType: 'image/png' }], { dryRun: false }),
      );
      expect(result.status).toBe('FAILED');
      expect(result.raw?.machine?.failureCode).toBe(
        STORY_FAILURE_CODES.PUBLICATION_NOT_AUTHORIZED,
      );
      expect(events.goto).toEqual([]);
      expect(page.screenshot).not.toHaveBeenCalled();
      expect(page.setViewportSize).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a real publication without a durable operation store', async () => {
    const { page, events } = createFakePage();
    const { dir, filePath } = await makeTempMedia();
    try {
      const adapter = new PlaywrightStoryPublishingAdapter({
        getPage: () => page,
        diagnosticsDir: null,
        enablePublication: true,
        expectedAccountHandle: 'mohammad7656336',
        operationStore: null,
      });
      const result = await adapter.publish(
        storyRequest([{ filePath, mimeType: 'image/png' }], { dryRun: false }),
      );
      expect(result.status).toBe('FAILED');
      expect(result.raw?.machine?.failureCode).toBe(
        STORY_FAILURE_CODES.PUBLICATION_NOT_AUTHORIZED,
      );
      expect(events.goto).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('forbids direct Story URL bases', async () => {
    const { page, events } = createFakePage();
    const { dir, filePath } = await makeTempMedia();
    try {
      const adapter = new PlaywrightStoryPublishingAdapter({
        getPage: () => page,
        baseUrl: 'https://www.instagram.com/create/story',
        diagnosticsDir: null,
      });
      const result = await adapter.publish(
        storyRequest([{ filePath, mimeType: 'image/png' }]),
      );
      expect(result.status).toBe('FAILED');
      expect(result.raw?.machine?.failureCode).toBe('STORY_UI_DIRECT_URL_FORBIDDEN');
      expect(events.goto).toEqual([]);
      expect(page.screenshot).not.toHaveBeenCalled();
      expect(page.setViewportSize).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('evaluates auth only after navigating to Instagram', async () => {
    const { page, events } = createFakePage({ startUrl: 'about:blank' });
    let observedUrl = null;
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      baseUrl: 'https://www.instagram.com',
      diagnosticsDir: null,
      detectAuthStateFn: vi.fn(async (p) => {
        observedUrl = p.url();
        return authOk();
      }),
    });
    const result = await adapter.validateAccount();
    expect(result.ok).toBe(true);
    expect(events.goto[0]).toBe('https://www.instagram.com/');
    expect(observedUrl).toBe('https://www.instagram.com/');
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(page.setViewportSize).not.toHaveBeenCalled();
    expect(
      events.cdp.some((send) => send.method === 'Emulation.setDeviceMetricsOverride'),
    ).toBe(true);
  });
});
