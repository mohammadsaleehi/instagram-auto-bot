import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { AuthState } from '../../../src/auth/auth-state.js';
import { ContentType } from '../../../src/modules/content/constants.js';
import { PlaywrightStoryPublishingAdapter } from '../../../src/modules/content/publishing/playwright-story-adapter.js';
import { StoryPublishState } from '../../../src/modules/content/publishing/story/story-states.js';
import { installStoryFixture, writeRedPng } from './story-fixture.js';

const SYSTEM_CHROME = '/usr/bin/google-chrome-stable';
const TEST_TIMEOUT = 45_000;

/** @type {import('playwright').Browser|null} */
let browser = null;

async function resolveExecutable() {
  for (const candidate of [process.env.STORY_BROWSER_PATH, SYSTEM_CHROME]) {
    if (!candidate) continue;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  try {
    await fs.access(chromium.executablePath());
    return chromium.executablePath();
  } catch {
    return null;
  }
}

beforeAll(async () => {
  const executablePath = await resolveExecutable();
  if (!executablePath) return;
  browser = await chromium.launch({ headless: true, executablePath });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
});

function authOk() {
  return {
    state: AuthState.AUTHENTICATED,
    url: 'http://story.test/',
    signals: ['fixture'],
    reason: 'fixture authenticated',
  };
}

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await installStoryFixture(page);
  return { context, page };
}

function instrumentForbidden(page) {
  const calls = [];
  page.setViewportSize = async () => {
    calls.push('setViewportSize');
    throw new Error('FORBIDDEN page.setViewportSize in Story path');
  };
  page.screenshot = async () => {
    calls.push('screenshot');
    throw new Error('FORBIDDEN page.screenshot in Story path');
  };
  return calls;
}

async function makeAdapter(page, options = {}) {
  const dir = options.dir;
  return new PlaywrightStoryPublishingAdapter({
    getPage: () => page,
    baseUrl: 'http://story.test',
    detectAuthStateFn: options.detectAuthStateFn ?? authOk,
    diagnosticsDir: dir ?? null,
    diagnosticsRetention: 3,
    idFn: () => options.operationId ?? 'op_test_phase04',
    timeouts: { stepPollMs: 50 },
    identityMaxDistance: 60,
    ...options,
  });
}

describe('PlaywrightStoryPublishingAdapter — Phase 0–4 gate', () => {
  it('declares dryRunOnly and publication disabled', async () => {
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => ({}) ,
      diagnosticsDir: null,
    });
    const caps = adapter.getCapabilities();
    expect(caps.dryRunOnly).toBe(true);
    expect(caps.publicationEnabled).toBe(false);
    expect(caps.surface).toBe('mobile-web-portrait');
    expect(caps.phase).toBe('entry-editor');
  });

  it('navigates before evaluating auth and finishes at DRY_RUN without Share', async () => {
    if (!browser) return;
    const { context, page } = await newPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-adapter-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const forbidden = instrumentForbidden(page);
      let authUrl = null;
      const adapter = await makeAdapter(page, {
        dir,
        detectAuthStateFn: () => {
          authUrl = page.url();
          return authOk();
        },
      });

      const result = await adapter.publish({
        contentId: 'content-1',
        contentType: ContentType.STORY,
        caption: '',
        hashtags: [],
        media: [
          {
            filePath: png,
            mimeType: 'image/png',
            mediaKind: 'image',
            byteSize: 100,
          },
        ],
        idempotencyKey: 'idem-1',
        dryRun: true,
      });

      expect(result.status).toBe('DRY_RUN');
      expect(result.simulated).toBe(true);
      expect(result.raw?.shareClicked).toBe(false);
      expect(result.raw?.machine?.state).toBe(StoryPublishState.DRY_RUN_COMPLETE);
      expect(result.raw?.machine?.shareIntentAt).toBeNull();
      expect(result.raw?.machine?.shareInvokedAt).toBeNull();
      expect(result.raw?.surface).toBe('mobile-web-portrait');
      expect(result.raw?.entry?.plus?.pathPrefix).toBe('M21 11h-8V3');
      expect(result.raw?.upload?.via).toBe('filechooser');
      expect(result.raw?.editor?.orientation).toBe('portrait-primary');
      expect(result.raw?.editor?.identity?.ok).toBe(true);
      expect(result.raw?.editor?.shareBox?.y).toBeGreaterThan(600);
      expect(authUrl).toMatch(/^http:\/\/story\.test\//);
      expect(forbidden).toEqual([]);
      expect(await page.evaluate(() => window.__fixtureShareClicks)).toBe(0);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('stops at the editor even when dryRun is false (phase gate)', async () => {
    if (!browser) return;
    const { context, page } = await newPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-adapter-real-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const forbidden = instrumentForbidden(page);
      const adapter = await makeAdapter(page, { dir });

      const result = await adapter.publish({
        contentId: 'content-2',
        contentType: ContentType.STORY,
        caption: '',
        hashtags: [],
        media: [
          {
            filePath: png,
            mimeType: 'image/png',
            mediaKind: 'image',
            byteSize: 100,
          },
        ],
        idempotencyKey: 'idem-2',
        dryRun: false,
      });

      expect(result.status).toBe('DRY_RUN');
      expect(result.raw?.shareClicked).toBe(false);
      expect(result.raw?.machine?.shareIntentAt).toBeNull();
      expect(forbidden).toEqual([]);
      expect(await page.evaluate(() => window.__fixtureShareClicks)).toBe(0);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('fails closed with PUBLISH_FAILED when the header plus is missing', async () => {
    if (!browser) return;
    const { context, page } = await newPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-adapter-plus-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const forbidden = instrumentForbidden(page);
      await page.addInitScript(() => {
        window.__storyFixtureHidePlus = true;
      });
      const adapter = await makeAdapter(page, { dir });
      const result = await adapter.publish({
        contentId: 'content-3',
        contentType: ContentType.STORY,
        caption: '',
        hashtags: [],
        media: [
          {
            filePath: png,
            mimeType: 'image/png',
            mediaKind: 'image',
            byteSize: 100,
          },
        ],
        idempotencyKey: 'idem-3',
        dryRun: true,
      });
      expect(result.status).toBe('FAILED');
      expect(result.raw?.machine?.state).toBe(StoryPublishState.PUBLISH_FAILED);
      expect(result.raw?.machine?.failureCode).toBe('HEADER_PLUS_NOT_FOUND');
      expect(result.raw?.machine?.retryable).toBe(true);
      expect(result.raw?.machine?.shareIntentAt).toBeNull();
      expect(forbidden).toEqual([]);
      expect(await page.evaluate(() => window.__fixtureShareClicks)).toBe(0);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('is dry-run-only through PublishingService capabilities', async () => {
    if (!browser) return;
    const { context, page } = await newPage();
    try {
      const adapter = await makeAdapter(page, { dir: null });
      expect(adapter.getCapabilities().dryRunOnly).toBe(true);
      expect(adapter.getCapabilities().publicationEnabled).toBe(false);
      expect(adapter.getCapabilities().supportedContentTypes).toEqual([ContentType.STORY]);
    } finally {
      await context.close();
    }
  }, TEST_TIMEOUT);
});
