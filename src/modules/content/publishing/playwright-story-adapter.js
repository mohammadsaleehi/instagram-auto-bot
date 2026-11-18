import path from 'node:path';
import { AuthState, detectAuthState } from '../../../auth/auth-state.js';
import {
  BROWSER_STORY_MEDIA_CONSTRAINTS,
  ContentError,
  ContentType,
} from '../constants.js';
import { STORY_UI } from './story-ui-selectors.js';

/**
 * @typedef {import('./publishing-adapter.js').PublishRequest} PublishRequest
 * @typedef {import('./publishing-adapter.js').PublishResult} PublishResult
 */

export class HumanInterventionRequiredError extends ContentError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown> }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      code: 'HUMAN_INTERVENTION_REQUIRED',
      details: options.details,
    });
    this.name = 'HumanInterventionRequiredError';
  }
}

/**
 * Browser-based Instagram Story publisher using the existing Playwright page.
 * Does not use Graph API. Does not bypass checkpoints / CAPTCHA / 2FA.
 * Implements the PublishingAdapter interface without importing it (avoids cycles).
 */
export class PlaywrightStoryPublishingAdapter {
  /**
   * @param {{
   *   getPage: () => import('playwright').Page,
   *   baseUrl?: string,
   *   detectAuthStateFn?: typeof detectAuthState,
   *   navigationTimeoutMs?: number,
   *   uploadTimeoutMs?: number,
   *   idFn?: () => string,
   *   allowRealPublish?: boolean,
   * }} options
   */
  constructor(options) {
    if (typeof options.getPage !== 'function') {
      throw new ContentError('PlaywrightStoryPublishingAdapter requires getPage()', {
        code: 'BROWSER_PAGE_REQUIRED',
      });
    }
    this.getPage = options.getPage;
    this.baseUrl = (options.baseUrl ?? 'https://www.instagram.com').replace(/\/$/, '');
    this._detectAuthState = options.detectAuthStateFn ?? detectAuthState;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
    this._id = options.idFn ?? (() => `pw_${Date.now()}`);
    this.allowRealPublish = options.allowRealPublish !== false;
    /** @type {Set<string>} */
    this.publishedKeys = new Set();
  }

  getCapabilities() {
    return {
      name: 'playwright',
      isMock: false,
      dryRunOnly: false,
      supportedContentTypes: [ContentType.STORY],
      constraints: BROWSER_STORY_MEDIA_CONSTRAINTS,
      requiredPermissions: ['authenticated-browser-session'],
      documentationUrl: 'local://playwright-story-publishing',
    };
  }

  async validateAccount() {
    const page = this._requirePage();
    const auth = await this._detectAuthState(page);
    if (auth.state === AuthState.AUTHENTICATED) {
      return {
        ok: true,
        message: 'Browser session is authenticated for Story publishing',
        details: { authState: auth.state, url: auth.url },
      };
    }
    if (auth.state === AuthState.VERIFICATION_REQUIRED) {
      return {
        ok: false,
        message:
          'Instagram verification / checkpoint detected. Complete it in the browser, then retry.',
        details: { authState: auth.state, url: auth.url, signals: auth.signals },
      };
    }
    return {
      ok: false,
      message: `Instagram session is not ready (state=${auth.state}). Log in and retry.`,
      details: { authState: auth.state, url: auth.url, signals: auth.signals },
    };
  }

  /**
   * @param {PublishRequest & { sourceMediaPath?: string }} request
   * @returns {Promise<PublishResult>}
   */
  async publish(request) {
    this._throwIfAborted(request.signal);

    if (request.contentType !== ContentType.STORY) {
      return this._failed(
        `Playwright adapter publishes Stories only (got ${request.contentType})`,
        { contentType: request.contentType },
      );
    }

    if (this.publishedKeys.has(request.idempotencyKey)) {
      return {
        status: 'SUCCEEDED',
        simulated: false,
        externalPublishId: `pw_dup_${request.idempotencyKey}`,
        containerId: null,
        requestId: this._id(),
        message: 'Duplicate idempotency key — prior browser publish recorded',
        raw: { duplicate: true },
      };
    }

    const media = request.media?.[0];
    if (!media?.filePath) {
      return this._failed('Story publish requires exactly one local media file', {
        mediaCount: request.media?.length ?? 0,
      });
    }
    if (request.media.length !== 1) {
      return this._failed('Story publish accepts exactly one media file', {
        mediaCount: request.media.length,
      });
    }

    const page = this._requirePage();
    const account = await this.validateAccount();
    if (!account.ok) {
      if (account.details?.authState === AuthState.VERIFICATION_REQUIRED) {
        throw new HumanInterventionRequiredError(account.message, {
          details: account.details,
        });
      }
      return this._failed(account.message, account.details);
    }

    if (await this._hasHumanBlockers(page)) {
      throw new HumanInterventionRequiredError(
        'Instagram security challenge or CAPTCHA detected. Complete it manually, then retry.',
        { details: { url: page.url() } },
      );
    }

    if (request.dryRun || !this.allowRealPublish) {
      return {
        status: 'DRY_RUN',
        simulated: true,
        externalPublishId: null,
        containerId: `dry_story_${request.contentId}`,
        requestId: this._id(),
        message:
          'Dry-run only — session and media validated; Share was not clicked',
        raw: {
          dryRun: true,
          filePath: media.filePath,
          fileName: path.basename(media.filePath),
          authOk: true,
        },
      };
    }

    try {
      await this._navigateHome(page, request.signal);
      this._throwIfAborted(request.signal);

      if (await this._hasHumanBlockers(page)) {
        throw new HumanInterventionRequiredError(
          'Instagram security challenge detected after navigation. Human intervention required.',
          { details: { url: page.url() } },
        );
      }

      await this._openStoryComposer(page, request.signal);
      this._throwIfAborted(request.signal);

      await this._uploadFile(page, media.filePath, request.signal);
      this._throwIfAborted(request.signal);

      const previewOk = await this._waitForPreview(page, request.signal);
      if (!previewOk) {
        return {
          status: 'UNCERTAIN',
          simulated: false,
          externalPublishId: null,
          containerId: null,
          requestId: this._id(),
          message:
            'Upload may have started but Story preview was not confirmed. Manual review required — do not blind-retry.',
          raw: {
            stage: 'preview',
            fileName: path.basename(media.filePath),
          },
        };
      }

      const shareClicked = await this._clickShare(page, request.signal);
      if (!shareClicked) {
        return {
          status: 'UNCERTAIN',
          simulated: false,
          externalPublishId: null,
          containerId: null,
          requestId: this._id(),
          message:
            'Could not confirm the Share control after upload. Manual review required — do not blind-retry.',
          raw: {
            stage: 'share_missing',
            fileName: path.basename(media.filePath),
          },
        };
      }

      const success = await this._awaitSuccess(page, request.signal);
      if (success.confirmed) {
        const externalId = `pw_story_${this._id()}`;
        this.publishedKeys.add(request.idempotencyKey);
        return {
          status: 'SUCCEEDED',
          simulated: false,
          externalPublishId: externalId,
          containerId: null,
          requestId: this._id(),
          message: 'Story share confirmed via UI success signals',
          raw: {
            fileName: path.basename(media.filePath),
            signals: success.signals,
            accountHint: success.accountHint,
          },
        };
      }

      return {
        status: 'UNCERTAIN',
        simulated: false,
        externalPublishId: null,
        containerId: null,
        requestId: this._id(),
        message:
          'Share was clicked but a reliable success signal was not observed. Inspect Instagram manually — do not blind-retry.',
        raw: {
          stage: 'post_share',
          fileName: path.basename(media.filePath),
          signals: success.signals,
        },
      };
    } catch (error) {
      if (error instanceof HumanInterventionRequiredError) {
        throw error;
      }
      if (request.signal?.aborted) {
        return {
          status: 'UNCERTAIN',
          simulated: false,
          externalPublishId: null,
          containerId: null,
          requestId: this._id(),
          message: 'Story publish aborted; outcome uncertain',
          raw: { aborted: true },
        };
      }
      return this._failed(error instanceof Error ? error.message : String(error), {
        thrown: true,
      });
    }
  }

  /** @returns {import('playwright').Page} */
  _requirePage() {
    const page = this.getPage();
    if (!page) {
      throw new ContentError('Browser page is not available', {
        code: 'BROWSER_PAGE_UNAVAILABLE',
      });
    }
    return page;
  }

  /**
   * @param {import('playwright').Page} page
   * @param {AbortSignal} [signal]
   */
  async _navigateHome(page, signal) {
    this._throwIfAborted(signal);
    const target = `${this.baseUrl}/`;
    if (!page.url().startsWith(this.baseUrl)) {
      await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });
    }
  }

  /**
   * @param {import('playwright').Page} page
   * @param {AbortSignal} [signal]
   */
  async _openStoryComposer(page, signal) {
    this._throwIfAborted(signal);

    // Prefer an already-visible file input (composer already open).
    if (await this._firstVisible(page, STORY_UI.fileInput)) {
      return;
    }

    const createClicked = await this._clickFirst(page, STORY_UI.createEntry);
    if (!createClicked) {
      throw new ContentError(
        'Could not open Instagram create dialog (Create / New post control not found)',
        { code: 'STORY_UI_CREATE_MISSING' },
      );
    }

    await page.waitForTimeout(500);
    await this._clickFirst(page, STORY_UI.storyMode);
    await this._clickFirst(page, STORY_UI.selectFromComputer);
  }

  /**
   * @param {import('playwright').Page} page
   * @param {string} filePath
   * @param {AbortSignal} [signal]
   */
  async _uploadFile(page, filePath, signal) {
    this._throwIfAborted(signal);
    const input = await this._firstLocator(page, STORY_UI.fileInput);
    if (!input) {
      throw new ContentError(
        'Instagram file input was not found. UI may have changed — manual intervention required.',
        { code: 'STORY_UI_FILE_INPUT_MISSING' },
      );
    }
    await input.setInputFiles(filePath);
  }

  /**
   * @param {import('playwright').Page} page
   * @param {AbortSignal} [signal]
   */
  async _waitForPreview(page, signal) {
    this._throwIfAborted(signal);
    const deadline = Date.now() + this.uploadTimeoutMs;
    while (Date.now() < deadline) {
      this._throwIfAborted(signal);
      if (await this._hasHumanBlockers(page)) {
        throw new HumanInterventionRequiredError(
          'Challenge appeared during Story upload. Complete it in the browser.',
          { details: { url: page.url() } },
        );
      }
      if (await this._firstVisible(page, STORY_UI.previewReady)) {
        return true;
      }
      if (await this._firstVisible(page, STORY_UI.share)) {
        return true;
      }
      await page.waitForTimeout(400);
    }
    return false;
  }

  /**
   * @param {import('playwright').Page} page
   * @param {AbortSignal} [signal]
   */
  async _clickShare(page, signal) {
    this._throwIfAborted(signal);
    return this._clickFirst(page, STORY_UI.share);
  }

  /**
   * @param {import('playwright').Page} page
   * @param {AbortSignal} [signal]
   */
  async _awaitSuccess(page, signal) {
    this._throwIfAborted(signal);
    /** @type {string[]} */
    const signals = [];
    const deadline = Date.now() + Math.min(this.uploadTimeoutMs, 45_000);

    while (Date.now() < deadline) {
      this._throwIfAborted(signal);
      if (await this._hasHumanBlockers(page)) {
        throw new HumanInterventionRequiredError(
          'Challenge appeared after Share. Complete it manually and verify whether the Story posted.',
          { details: { url: page.url() } },
        );
      }

      for (const selector of STORY_UI.success) {
        if (await this._visible(page, selector)) {
          signals.push(`success:${selector}`);
        }
      }

      // Composer closed and we are back on a normal feed URL is a soft signal.
      const url = page.url();
      if (
        signals.length === 0 &&
        /instagram\.com\/?($|\?)/i.test(url) &&
        !(await this._firstVisible(page, STORY_UI.share))
      ) {
        signals.push('composer_closed');
      }

      if (signals.some((s) => s.startsWith('success:'))) {
        return {
          confirmed: true,
          signals,
          accountHint: await this._readAccountHint(page),
        };
      }

      await page.waitForTimeout(400);
    }

    // Soft confirmation: share controls gone + no challenge.
    const soft =
      !(await this._firstVisible(page, STORY_UI.share)) &&
      !(await this._hasHumanBlockers(page));
    if (soft) {
      signals.push('share_controls_gone');
    }

    return {
      confirmed: false,
      signals,
      accountHint: await this._readAccountHint(page),
    };
  }

  /**
   * @param {import('playwright').Page} page
   */
  async _readAccountHint(page) {
    try {
      const profile = page.locator('a[href^="/"][role="link"]').filter({
        has: page.locator('img[alt*="profile" i], img[alt*="Photo" i]'),
      });
      const href = await profile.first().getAttribute('href', { timeout: 1_000 });
      if (href && /^\/[A-Za-z0-9._]+\/?$/.test(href)) {
        return href.replace(/\//g, '') || null;
      }
    } catch {
      // best-effort only
    }
    return null;
  }

  /**
   * @param {import('playwright').Page} page
   */
  async _hasHumanBlockers(page) {
    for (const selector of STORY_UI.humanRequired) {
      if (await this._visible(page, selector)) {
        return true;
      }
    }
    const auth = await this._detectAuthState(page);
    return auth.state === AuthState.VERIFICATION_REQUIRED;
  }

  /**
   * @param {import('playwright').Page} page
   * @param {readonly string[]} selectors
   */
  async _clickFirst(page, selectors) {
    for (const selector of selectors) {
      const locator = this._locator(page, selector);
      try {
        if (await locator.first().isVisible({ timeout: 800 })) {
          await locator.first().click({ timeout: 5_000 });
          return true;
        }
      } catch {
        // try next
      }
    }
    return false;
  }

  /**
   * @param {import('playwright').Page} page
   * @param {readonly string[]} selectors
   */
  async _firstVisible(page, selectors) {
    for (const selector of selectors) {
      if (await this._visible(page, selector)) {
        return true;
      }
    }
    return false;
  }

  /**
   * @param {import('playwright').Page} page
   * @param {readonly string[]} selectors
   */
  async _firstLocator(page, selectors) {
    for (const selector of selectors) {
      const locator = this._locator(page, selector);
      try {
        if ((await locator.count()) > 0) {
          return locator.first();
        }
      } catch {
        // try next
      }
    }
    return null;
  }

  /**
   * @param {import('playwright').Page} page
   * @param {string} selector
   */
  _locator(page, selector) {
    if (selector.startsWith('role=') || selector.startsWith('text=')) {
      return page.locator(selector);
    }
    return page.locator(selector);
  }

  /**
   * @param {import('playwright').Page} page
   * @param {string} selector
   */
  async _visible(page, selector) {
    try {
      return await this._locator(page, selector).first().isVisible({ timeout: 400 });
    } catch {
      return false;
    }
  }

  /**
   * @param {AbortSignal} [signal]
   */
  _throwIfAborted(signal) {
    if (signal?.aborted) {
      const error = new Error('Story publish aborted');
      error.name = 'AbortError';
      throw error;
    }
  }

  /**
   * @param {string} message
   * @param {Record<string, unknown>} [raw]
   * @returns {PublishResult}
   */
  _failed(message, raw = {}) {
    return {
      status: 'FAILED',
      simulated: false,
      externalPublishId: null,
      containerId: null,
      requestId: this._id(),
      message,
      raw,
    };
  }
}
