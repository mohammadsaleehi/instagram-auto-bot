import { devices } from 'playwright';
import { ContentError } from '../../constants.js';
import { STORY_UI } from '../story-ui-selectors.js';
import { STORY_FAILURE_CODES, STORY_STATE_TIMEOUTS, StoryPublishState } from './story-states.js';

/**
 * Orientation-safe Playwright primitives for the Story path.
 *
 * Hard rules enforced by this module:
 * - No `page.setViewportSize()` (it flips `screen.orientation.type`).
 * - No `page.screenshot()` (it also flips orientation).
 * - Portrait is applied only through CDP `Emulation.setDeviceMetricsOverride`.
 * - Diagnostics screenshots use CDP `Page.captureScreenshot`.
 */
export class StoryBrowserSession {
  /**
   * @param {{
   *   page: import('playwright').Page,
   *   cdpSession?: import('playwright').CDPSession,
   *   deviceName?: string,
   *   timeouts?: { stepPollMs?: number },
   *   diagnostics?: import('./story-diagnostics.js').StoryDiagnostics | null,
   *   logger?: { info?: Function, warn?: Function } | null,
   * }} options
   */
  constructor(options) {
    if (!options?.page) {
      throw new ContentError('StoryBrowserSession requires a Playwright page', {
        code: STORY_FAILURE_CODES.BROWSER_PAGE_UNAVAILABLE,
      });
    }
    this.page = options.page;
    this.cdp = options.cdpSession ?? null;
    this.deviceName = options.deviceName ?? 'iPhone 13';
    this.stepPollMs = options.timeouts?.stepPollMs ?? 400;
    this.diagnostics = options.diagnostics ?? null;
    this.logger = options.logger ?? null;
    this.initialized = false;
  }

  /** @returns {Promise<void>} */
  async initialize() {
    if (this.initialized) return;
    if (!this.cdp) {
      try {
        this.cdp = await this.page.context().newCDPSession(this.page);
      } catch (error) {
        throw new ContentError(
          `CDP session is required for portrait Story emulation: ${error instanceof Error ? error.message : String(error)}`,
          { code: STORY_FAILURE_CODES.CDP_UNAVAILABLE },
        );
      }
    }
    const descriptor = devices[this.deviceName] ?? devices['iPhone 13'];
    await this.cdp.send('Emulation.setUserAgentOverride', {
      userAgent: descriptor.userAgent,
      acceptLanguage: 'en-US,en',
      platform: 'iPhone',
    });
    await this.applyPortrait();
    await this.cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    this.initialized = true;
  }

  /**
   * Apply portrait metrics through CDP only.
   * @returns {Promise<void>}
   */
  async applyPortrait() {
    if (!this.cdp) {
      throw new ContentError('CDP session is not available', {
        code: STORY_FAILURE_CODES.CDP_UNAVAILABLE,
      });
    }
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: STORY_UI.portraitViewport.width,
      height: STORY_UI.portraitViewport.height,
      deviceScaleFactor: STORY_UI.portraitDeviceScaleFactor,
      mobile: true,
      screenWidth: STORY_UI.portraitScreen.width,
      screenHeight: STORY_UI.portraitScreen.height,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
  }

  /** @returns {Promise<Record<string, unknown>>} */
  async environment() {
    try {
      return await this.page.evaluate(() => ({
        url: location.href,
        screenOrientation: window.screen?.orientation?.type ?? null,
        screenAngle: window.screen?.orientation?.angle ?? null,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        screenWidth: window.screen?.width ?? null,
        screenHeight: window.screen?.height ?? null,
        devicePixelRatio: window.devicePixelRatio,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
      }));
    } catch (error) {
      return {
        url: this.page.url(),
        evaluateError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * @param {string} [label]
   * @returns {Promise<{ok: boolean, environment: Record<string, unknown>, failureCode: string|null}>}
   */
  async assertPortrait(label = 'orientation') {
    const environment = await this.environment();
    const portrait =
      environment.screenOrientation === 'portrait-primary' &&
      Number(environment.innerHeight) > Number(environment.innerWidth);
    if (!portrait) {
      this.logger?.warn?.('Story orientation is not portrait', {
        label,
        environment,
      });
    }
    return {
      ok: portrait,
      environment,
      failureCode: portrait ? null : STORY_FAILURE_CODES.ORIENTATION_NOT_PORTRAIT,
    };
  }

  /**
   * Restore portrait before Story entry. Reload is allowed only while the
   * editor has not been opened; callers must not call this after upload.
   *
   * @param {{maxReloads?: number, label?: string}} [options]
   * @returns {Promise<{ok: boolean, environment: Record<string, unknown>, reloads: number, failureCode: string|null}>}
   */
  async stabilizePortrait(options = {}) {
    const maxReloads = options.maxReloads ?? 2;
    const label = options.label ?? 'surface';
    let check = await this.assertPortrait(label);
    if (check.ok) {
      return { ...check, reloads: 0 };
    }

    let reloads = 0;
    for (let i = 0; i < maxReloads; i += 1) {
      reloads += 1;
      this.logger?.warn?.('Reloading to restore portrait Story orientation', {
        label,
        attempt: reloads,
        environment: check.environment,
      });
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: STORY_STATE_TIMEOUTS[StoryPublishState.NAVIGATING_HOME] });
      await this.applyPortrait();
      await this.page.waitForTimeout(this.stepPollMs);
      check = await this.assertPortrait(`${label}:reload-${reloads}`);
      if (check.ok) {
        return { ...check, reloads };
      }
    }

    return { ...check, reloads };
  }

  /**
   * Dismiss ordinary Instagram dialogs. Never clicks Story/Share controls.
   * @returns {Promise<number>} number of clicks performed
   */
  async dismissBlockingDialogs() {
    const names = STORY_UI.dismissDialogNames.filter(
      (pattern) => pattern.source !== '^close$',
    );
    let clicked = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      let passClicked = false;
      for (const name of names) {
        try {
          const locator = this.page.getByRole('button', { name }).first();
          if (await locator.isVisible({ timeout: 250 })) {
            await locator.click({ timeout: 3_000 });
            clicked += 1;
            passClicked = true;
            await this.page.waitForTimeout(200);
          }
        } catch {
          // best effort
        }
      }
      for (const aria of STORY_UI.dismissDialogAria) {
        try {
          const close = this.page.locator(`[aria-label="${aria}"]`).first();
          if (await close.isVisible({ timeout: 250 })) {
            await close.click({ timeout: 3_000 });
            clicked += 1;
            passClicked = true;
            await this.page.waitForTimeout(200);
          }
        } catch {
          // best effort
        }
      }
      if (!passClicked) break;
    }
    return clicked;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async hasHumanBlockers() {
    for (const pattern of STORY_UI.humanRequired) {
      try {
        if (await this.page.getByText(pattern).first().isVisible({ timeout: 250 })) {
          return true;
        }
      } catch {
        // continue
      }
    }
    for (const selector of STORY_UI.humanRequiredCss) {
      try {
        if (await this.page.locator(selector).first().isVisible({ timeout: 250 })) {
          return true;
        }
      } catch {
        // continue
      }
    }
    return false;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async hasRotateOverlay() {
    for (const pattern of STORY_UI.rotateDeviceText) {
      try {
        if (await this.page.getByText(pattern).first().isVisible({ timeout: 250 })) {
          return true;
        }
      } catch {
        // continue
      }
    }
    try {
      return await this.page.evaluate(() =>
        /rotate\s+your\s+(device|phone)/i.test((document.body?.innerText || '').slice(0, 4000)),
      );
    } catch {
      return false;
    }
  }

  /**
   * Diagnostics capture through CDP only.
   *
   * @param {string} stage
   * @param {Record<string, unknown>} [extra]
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async capture(stage, extra = {}) {
    if (!this.diagnostics) return null;
    try {
      return await this.diagnostics.capture({
        page: this.page,
        cdp: this.cdp,
        stage,
        extra,
        environment: await this.environment(),
      });
    } catch (error) {
      this.logger?.warn?.('Story diagnostics capture failed', {
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Guard used by tests and by the adapter before Share. It intentionally does
   * not attempt a repair: after upload, a flipped orientation must fail closed.
   *
   * @returns {Promise<{ok: boolean, environment: Record<string, unknown>, failureCode: string|null}>}
   */
  async assertOrientationInvariant() {
    return this.assertPortrait('pre-share-invariant');
  }
}
