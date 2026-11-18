import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { AuthState } from '../../src/auth/auth-state.js';
import {
  HumanInterventionRequiredError,
  PlaywrightStoryPublishingAdapter,
} from '../../src/modules/content/publishing/playwright-story-adapter.js';
import { ContentType } from '../../src/modules/content/constants.js';

/**
 * @param {Record<string, unknown>} [overrides]
 */
function createFakePage(overrides = {}) {
  const visible = new Set(overrides.visible ?? []);
  const fileInputs = overrides.fileInputs ?? [
    {
      count: async () => 1,
      first: () => ({
        setInputFiles: vi.fn(async () => {}),
        isVisible: async () => true,
        click: vi.fn(async () => {}),
      }),
      setInputFiles: vi.fn(async () => {}),
    },
  ];

  return {
    url: () => overrides.url ?? 'https://www.instagram.com/',
    goto: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    locator: vi.fn((selector) => {
      const match = [...visible].some((item) => selector.includes?.(item) || selector === item);
      const isFile = String(selector).includes('input[type="file"]');
      if (isFile && fileInputs[0]) {
        return {
          count: async () => 1,
          first: () => fileInputs[0].first(),
        };
      }
      return {
        count: async () => (match ? 1 : 0),
        first: () => ({
          isVisible: async () => match,
          click: vi.fn(async () => {
            if (overrides.onClick) {
              overrides.onClick(selector);
            }
          }),
          getAttribute: async () => overrides.profileHref ?? null,
        }),
        filter: () => ({
          first: () => ({
            getAttribute: async () => overrides.profileHref ?? null,
          }),
        }),
      };
    }),
    ...overrides.page,
  };
}

describe('PlaywrightStoryPublishingAdapter', () => {
  const media = [
    {
      filePath: path.join('/tmp', 'story-01.jpg'),
      mimeType: 'image/jpeg',
      mediaKind: 'image',
      byteSize: 100,
    },
  ];

  it('dry-run validates session and does not share', async () => {
    const page = createFakePage();
    const detectAuthStateFn = vi.fn(async () => ({
      state: AuthState.AUTHENTICATED,
      url: page.url(),
      signals: [],
      reason: 'ok',
    }));
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      detectAuthStateFn,
      idFn: () => 'test',
    });

    const result = await adapter.publish({
      contentId: 'c1',
      contentType: ContentType.STORY,
      caption: '',
      hashtags: [],
      media,
      idempotencyKey: 'k1',
      dryRun: true,
    });

    expect(result.status).toBe('DRY_RUN');
    expect(result.simulated).toBe(true);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('fails closed when not authenticated', async () => {
    const page = createFakePage();
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      detectAuthStateFn: async () => ({
        state: AuthState.LOGIN_REQUIRED,
        url: page.url(),
        signals: ['login_form_visible'],
        reason: 'login required',
      }),
    });

    const result = await adapter.publish({
      contentId: 'c1',
      contentType: ContentType.STORY,
      caption: '',
      hashtags: [],
      media,
      idempotencyKey: 'k2',
      dryRun: false,
    });

    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/not ready/i);
  });

  it('requires human intervention on checkpoint', async () => {
    const page = createFakePage();
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      detectAuthStateFn: async () => ({
        state: AuthState.VERIFICATION_REQUIRED,
        url: 'https://www.instagram.com/challenge/',
        signals: ['challenge_indicators_visible'],
        reason: 'challenge',
      }),
    });

    await expect(
      adapter.publish({
        contentId: 'c1',
        contentType: ContentType.STORY,
        caption: '',
        hashtags: [],
        media,
        idempotencyKey: 'k3',
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(HumanInterventionRequiredError);
  });

  it('rejects non-story content types', async () => {
    const page = createFakePage();
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      detectAuthStateFn: async () => ({
        state: AuthState.AUTHENTICATED,
        url: page.url(),
        signals: [],
        reason: 'ok',
      }),
    });

    const result = await adapter.publish({
      contentId: 'c1',
      contentType: ContentType.IMAGE,
      caption: '',
      hashtags: [],
      media,
      idempotencyKey: 'k4',
      dryRun: false,
    });

    expect(result.status).toBe('FAILED');
  });

  it('returns UNCERTAIN when preview never appears after upload', async () => {
    const setInputFiles = vi.fn(async () => {});
    const page = createFakePage({
      visible: [],
      fileInputs: [
        {
          count: async () => 1,
          first: () => ({
            setInputFiles,
            isVisible: async () => true,
            click: vi.fn(async () => {}),
          }),
        },
      ],
    });
    page.locator = vi.fn((selector) => {
      if (String(selector).includes('input[type="file"]')) {
        return {
          count: async () => 1,
          first: () => ({
            setInputFiles,
            isVisible: async () => true,
            click: vi.fn(async () => {}),
          }),
        };
      }
      return {
        count: async () => 0,
        first: () => ({
          isVisible: async () => false,
          click: vi.fn(async () => {}),
          getAttribute: async () => null,
        }),
        filter: () => ({
          first: () => ({ getAttribute: async () => null }),
        }),
      };
    });

    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => page,
      detectAuthStateFn: async () => ({
        state: AuthState.AUTHENTICATED,
        url: page.url(),
        signals: [],
        reason: 'ok',
      }),
      uploadTimeoutMs: 50,
      navigationTimeoutMs: 50,
      idFn: () => 'uncertain',
    });

    const result = await adapter.publish({
      contentId: 'c1',
      contentType: ContentType.STORY,
      caption: '',
      hashtags: [],
      media,
      idempotencyKey: 'k5',
      dryRun: false,
    });

    expect(result.status).toBe('UNCERTAIN');
    expect(result.message).toMatch(/manual review/i);
    expect(setInputFiles).toHaveBeenCalled();
  });

  it('deduplicates by idempotency key after success', async () => {
    const adapter = new PlaywrightStoryPublishingAdapter({
      getPage: () => createFakePage(),
      detectAuthStateFn: async () => ({
        state: AuthState.AUTHENTICATED,
        url: 'https://www.instagram.com/',
        signals: [],
        reason: 'ok',
      }),
      idFn: () => 'dup',
    });
    adapter.publishedKeys.add('same-key');

    const result = await adapter.publish({
      contentId: 'c1',
      contentType: ContentType.STORY,
      caption: '',
      hashtags: [],
      media,
      idempotencyKey: 'same-key',
      dryRun: false,
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.raw?.duplicate).toBe(true);
  });
});
