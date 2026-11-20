import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { StoryBrowserSession } from '../../../src/modules/content/publishing/story/story-browser-session.js';
import { StoryDiagnostics } from '../../../src/modules/content/publishing/story/story-diagnostics.js';
import { StoryEntry } from '../../../src/modules/content/publishing/story/story-entry.js';
import { StoryUpload } from '../../../src/modules/content/publishing/story/story-upload.js';
import { StoryEditor } from '../../../src/modules/content/publishing/story/story-editor.js';
import { STORY_FAILURE_CODES } from '../../../src/modules/content/publishing/story/story-states.js';
import {
  installStoryFixture,
  writeRedPng,
} from './story-fixture.js';

const SYSTEM_CHROME = '/usr/bin/google-chrome-stable';
const TEST_TIMEOUT = 40_000;

/** @type {import('playwright').Browser|null} */
let browser = null;
let executablePath = null;

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
  executablePath = await resolveExecutable();
  if (!executablePath) return;
  browser = await chromium.launch({ headless: true, executablePath });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
});

async function newStoryPage() {
  if (!browser) return null;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await installStoryFixture(page);
  await page.goto('http://story.test/', { waitUntil: 'domcontentloaded' });
  return { context, page };
}

async function newSession(page, diagnosticsDir = null) {
  const diagnostics = diagnosticsDir
    ? new StoryDiagnostics({ rootDir: diagnosticsDir, operationId: 'op-test' })
    : null;
  const session = new StoryBrowserSession({
    page,
    diagnostics,
    timeouts: { stepPollMs: 50 },
  });
  await session.initialize();
  return { session, diagnostics };
}

async function enterAndUpload(page, session, filePath) {
  const entry = new StoryEntry({ page, session, timeouts: { stepPollMs: 50, fileChooserMs: 1_200 } });
  const entryResult = await entry.enter();
  expect(entryResult.ok).toBe(true);
  expect(entryResult.chooser).toBeTruthy();

  const upload = new StoryUpload({ page, session, timeouts: { stepPollMs: 50 } });
  const uploadResult = await upload.upload({
    chooser: entryResult.chooser,
    filePath,
    fileName: path.basename(filePath),
  });
  expect(uploadResult.ok).toBe(true);
  return { entryResult, uploadResult };
}

describe('Story browser integration (real Playwright + CDP)', () => {
  it('keeps portrait while capturing diagnostics through CDP only', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-diag-'));
    try {
      const forbidden = [];
      // Prove the Story path cannot call the two APIs that flip orientation.
      page.setViewportSize = async () => {
        forbidden.push('setViewportSize');
        throw new Error('FORBIDDEN page.setViewportSize');
      };
      page.screenshot = async () => {
        forbidden.push('screenshot');
        throw new Error('FORBIDDEN page.screenshot');
      };

      const { session } = await newSession(page, dir);
      const before = await session.assertPortrait('before-capture');
      expect(before.ok).toBe(true);
      expect(before.environment.screenOrientation).toBe('portrait-primary');

      const captured = await session.capture('orientation-proof', { note: 'cdp-only' });
      expect(captured?.screenshotPath).toBeTruthy();
      expect(await fs.stat(captured.screenshotPath)).toBeTruthy();

      const after = await session.assertPortrait('after-capture');
      expect(after.ok).toBe(true);
      expect(after.environment.screenOrientation).toBe('portrait-primary');
      expect(forbidden).toEqual([]);
      expect((await session.capture('second-proof'))?.screenshotPath).toBeTruthy();
      expect((await session.assertPortrait('after-second')).ok).toBe(true);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('restores portrait before entry by reloading, never by resizing', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    try {
      const { session } = await newSession(page);
      await session.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 844,
        height: 390,
        deviceScaleFactor: 3,
        mobile: true,
        screenWidth: 844,
        screenHeight: 390,
        screenOrientation: { type: 'landscapePrimary', angle: 0 },
      });
      const landscape = await session.assertPortrait('landscape');
      expect(landscape.ok).toBe(false);
      expect(landscape.environment.screenOrientation).toBe('landscape-primary');

      const stabilized = await session.stabilizePortrait({ maxReloads: 2 });
      expect(stabilized.ok).toBe(true);
      expect(stabilized.reloads).toBeGreaterThan(0);
      expect(stabilized.environment.screenOrientation).toBe('portrait-primary');
    } finally {
      await context.close();
    }
  }, TEST_TIMEOUT);

  it('enters via header + -> Story -> filechooser and reaches a verified editor', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-flow-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const { session } = await newSession(page, dir);
      const { entryResult, uploadResult } = await enterAndUpload(page, session, png);

      expect(entryResult.plus.pathPrefix).toBe('M21 11h-8V3');
      expect(entryResult.plus.box.x).toBeLessThan(entryResult.plus.notificationsBox.x);
      expect(entryResult.menu.some((option) => option.kind === 'story')).toBe(true);
      expect(uploadResult.via).toBe('filechooser');
      expect(uploadResult.url).toMatch(/\/create\/story\/?$/);

      const editor = new StoryEditor({
        page,
        session,
        cdp: session.cdp,
        timeouts: { stepPollMs: 50 },
        identityMaxDistance: 60,
      });
      const ready = await editor.waitForReady({
        sourceFilePath: png,
        sourceMime: 'image/png',
      });
      expect(ready.ok).toBe(true);
      expect(ready.evidence?.orientation).toBe('portrait-primary');
      expect(ready.evidence?.shareBox.y).toBeGreaterThan(600);
      expect(ready.evidence?.canvas.backing).toEqual({ width: 1170, height: 2532 });
      expect(ready.evidence?.identity.ok).toBe(true);
      expect(ready.evidence?.identity.distance).toBeLessThanOrEqual(60);
      expect(ready.evidence?.postIdentityOrientation).toBe('portrait-primary');
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('dismisses delayed onboarding modals before using the header +', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-modal-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const { session } = await newSession(page, dir);
      await page.evaluate(() => window.__fixture.showOnboardingModals());

      const entry = new StoryEntry({
        page,
        session,
        timeouts: { stepPollMs: 50, fileChooserMs: 1_200 },
      });
      const result = await entry.enter();
      expect(result.ok).toBe(true);
      expect(result.chooser).toBeTruthy();
      expect(await page.locator('.fixture-onboarding').count()).toBe(0);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('clicks the verified Share control exactly once and refuses a second click', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-share-once-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const { session } = await newSession(page, dir);
      await enterAndUpload(page, session, png);

      const editor = new StoryEditor({
        page,
        session,
        cdp: session.cdp,
        timeouts: { stepPollMs: 50 },
        identityMaxDistance: 60,
      });
      const ready = await editor.waitForReady({
        sourceFilePath: png,
        sourceMime: 'image/png',
      });
      expect(ready.ok).toBe(true);

      const first = await editor.clickShareOnce();
      expect(first.ok).toBe(true);
      expect(first.dispatched).toBe(true);
      expect(await page.evaluate(() => window.__fixtureShareClicks)).toBe(1);

      const second = await editor.clickShareOnce();
      expect(second.ok).toBe(false);
      expect(second.dispatched).toBe(false);
      expect(second.failureCode).toBe(STORY_FAILURE_CODES.SHARE_ALREADY_RECORDED);
      expect(await page.evaluate(() => window.__fixtureShareClicks)).toBe(1);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('rejects a rotate warning even when it contains "add to your story"', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-rotate-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const { session } = await newSession(page);
      await enterAndUpload(page, session, png);
      await page.evaluate(() => window.__fixture.showRotate());
      await page.evaluate(() => window.__fixture.hideShare());

      const editor = new StoryEditor({
        page,
        session,
        cdp: session.cdp,
        timeouts: { stepPollMs: 50 },
      });
      const check = await editor.quickCheck();
      expect(check.ok).toBe(false);
      expect(check.terminal).toBe(true);
      expect(check.failureCode).toBe(STORY_FAILURE_CODES.ROTATE_OVERLAY_PRESENT);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('rejects text-only "Add to your story" with no real button', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-text-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const { session } = await newSession(page);
      await enterAndUpload(page, session, png);
      await page.evaluate(() => window.__fixture.showTextOnly());

      const editor = new StoryEditor({
        page,
        session,
        cdp: session.cdp,
        timeouts: { stepPollMs: 50 },
      });
      const check = await editor.quickCheck();
      expect(check.ok).toBe(false);
      expect(check.failureCode).toBe(STORY_FAILURE_CODES.SHARE_CONTROL_NOT_FOUND);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('fails preview identity when the editor shows a different image', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-identity-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const { session } = await newSession(page);
      await enterAndUpload(page, session, png);
      await page.evaluate(() => window.__fixture.paintBlue());

      const editor = new StoryEditor({
        page,
        session,
        cdp: session.cdp,
        timeouts: { stepPollMs: 50 },
        identityMaxDistance: 24,
      });
      const ready = await editor.waitForReady({
        sourceFilePath: png,
        sourceMime: 'image/png',
        timeoutMs: 2_000,
      });
      expect(ready.ok).toBe(false);
      expect(ready.failureCode).toBe(STORY_FAILURE_CODES.PREVIEW_IDENTITY_MISMATCH);
      expect(ready.evidence?.identity.distance).toBeGreaterThan(24);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('fails closed when the editor orientation is landscape', async () => {
    if (!browser) return;
    const { context, page } = await newStoryPage();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-landscape-'));
    const png = path.join(dir, 'red.png');
    try {
      await writeRedPng(png);
      const { session } = await newSession(page);
      await enterAndUpload(page, session, png);
      await session.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 844,
        height: 390,
        deviceScaleFactor: 3,
        mobile: true,
        screenWidth: 844,
        screenHeight: 390,
        screenOrientation: { type: 'landscapePrimary', angle: 0 },
      });

      const editor = new StoryEditor({
        page,
        session,
        cdp: session.cdp,
        timeouts: { stepPollMs: 50 },
      });
      const check = await editor.quickCheck();
      expect(check.ok).toBe(false);
      expect(check.terminal).toBe(true);
      expect(check.failureCode).toBe(STORY_FAILURE_CODES.ORIENTATION_NOT_PORTRAIT);
    } finally {
      await context.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it('returns deterministic entry failure codes', async () => {
    if (!browser) return;
    const cases = [
      {
        name: 'missing plus',
        mutate: () => window.__fixture.hidePlus(),
        code: STORY_FAILURE_CODES.HEADER_PLUS_NOT_FOUND,
      },
      {
        name: 'missing Story option',
        mutate: () => window.__fixture.removeStoryOption(),
        code: STORY_FAILURE_CODES.CREATE_MENU_STORY_MISSING,
      },
      {
        name: 'no filechooser',
        mutate: () => window.__fixture.suppressChooser(),
        code: STORY_FAILURE_CODES.FILECHOOSER_NOT_OPENED,
      },
    ];

    for (const testCase of cases) {
      const { context, page } = await newStoryPage();
      try {
        await page.evaluate(testCase.mutate);
        const { session } = await newSession(page);
        const entry = new StoryEntry({ page, session, timeouts: { stepPollMs: 50, fileChooserMs: 1_200 } });
        const result = await entry.enter();
        expect(result.ok, testCase.name).toBe(false);
        expect(result.failureCode, testCase.name).toBe(testCase.code);
      } finally {
        await context.close();
      }
    }
  }, TEST_TIMEOUT);
});
