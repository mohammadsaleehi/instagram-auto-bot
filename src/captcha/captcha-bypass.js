import fs from 'node:fs';
import { chromium } from 'playwright';
import { CaptchaConfigError, CaptchaSolveError } from './errors.js';
import { detectCaptcha, hasVisibleChallenge, normalizeType } from './detectors.js';
import { injectCaptchaToken } from './injectors.js';
import { humanMoveTo, humanPause } from './humanize.js';
import { solveCaptcha } from './solvers/index.js';

/**
 * Drop-in captcha helper for Playwright.
 *
 * Layered model:
 * 1) Avoidance — sane browser defaults / light humanization (does NOT mint tokens)
 * 2) Solve — paid solver API returns a valid token
 * 3) Inject — write token + fire callbacks; never click the checkbox when injecting
 */
export class CaptchaBypass {
  /**
   * @param {{
   *   solver?: '2captcha' | 'capsolver',
   *   apiKey?: string | null,
   *   headless?: boolean,
   *   proxy?: string | null,
   *   timeoutMs?: number,
   *   maxRetries?: number,
   *   humanize?: boolean,
   *   locale?: string,
   *   timezoneId?: string,
   *   browserChannel?: string | null,
   *   executablePath?: string | null,
   *   userDataDir?: string | null,
   *   logger?: {
   *     info?: Function,
   *     warn?: Function,
   *     error?: Function,
   *     debug?: Function,
   *   },
   * }} [options]
   */
  constructor(options = {}) {
    this.solver = options.solver ?? '2captcha';
    this.apiKey = options.apiKey ?? process.env.CAPTCHA_API_KEY ?? null;
    this.headless = options.headless ?? false;
    this.proxy = options.proxy ?? process.env.PROXY ?? null;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.humanize = options.humanize ?? true;
    this.locale = options.locale ?? 'en-US';
    this.timezoneId = options.timezoneId ?? 'America/New_York';
    this.browserChannel = options.browserChannel ?? null;
    this.executablePath = options.executablePath ?? null;
    this.userDataDir = options.userDataDir ?? null;
    this.logger = {
      info: options.logger?.info ?? (() => {}),
      warn: options.logger?.warn ?? (() => {}),
      error: options.logger?.error ?? (() => {}),
      debug: options.logger?.debug ?? (() => {}),
    };

    /** @type {import('playwright').Browser | null} */
    this.browser = null;
    /** @type {import('playwright').BrowserContext | null} */
    this.context = null;
    /** @type {import('playwright').Page | null} */
    this.page = null;
    this._ownsBrowser = false;
  }

  /**
   * Launch an isolated browser/context/page for demos and standalone usage.
   * Prefer attaching an existing page via solve(page) inside Instagram-Auto-Bot.
   *
   * @returns {Promise<{ browser: import('playwright').Browser | null, context: import('playwright').BrowserContext, page: import('playwright').Page }>}
   */
  async launch() {
    if (!this.apiKey) {
      this.logger.warn('CaptchaBypass launched without CAPTCHA_API_KEY; solve() will fail until configured');
    }

    /** @type {import('playwright').LaunchPersistentContextOptions | import('playwright').BrowserContextOptions} */
    const shared = {
      locale: this.locale,
      timezoneId: this.timezoneId,
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    };

    if (this.proxy) {
      shared.proxy = { server: this.proxy };
    }

    if (this.userDataDir) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      /** @type {import('playwright').LaunchPersistentContextOptions} */
      const persistent = {
        ...shared,
        headless: this.headless,
      };
      if (this.executablePath) {
        persistent.executablePath = this.executablePath;
      } else if (this.browserChannel) {
        persistent.channel = this.browserChannel;
      }

      this.context = await chromium.launchPersistentContext(this.userDataDir, persistent);
      this.browser = null;
      this._ownsBrowser = true;
      this.page = this.context.pages()[0] || (await this.context.newPage());
    } else {
      /** @type {import('playwright').LaunchOptions} */
      const launchOptions = { headless: this.headless };
      if (this.executablePath) {
        launchOptions.executablePath = this.executablePath;
      } else if (this.browserChannel) {
        launchOptions.channel = this.browserChannel;
      }
      if (this.proxy) {
        launchOptions.proxy = { server: this.proxy };
      }

      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext(shared);
      this._ownsBrowser = true;
      this.page = await this.context.newPage();
    }

    this.logger.info('CaptchaBypass browser ready', {
      headless: this.headless,
      solver: this.solver,
      proxyConfigured: Boolean(this.proxy),
    });

    return {
      browser: this.browser,
      context: this.context,
      page: this.page,
    };
  }

  /**
   * Detect + solve + inject a captcha token on an existing Playwright page.
   *
   * @param {import('playwright').Page} page
   * @param {{
   *   type?: 'auto' | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile',
   *   action?: string,
   *   minScore?: number,
   *   enterprise?: boolean,
   *   sitekey?: string,
   *   submitSelector?: string | null,
   *   requireVisibleWidget?: boolean,
   * }} [options]
   * @returns {Promise<{
   *   solved: boolean,
   *   type: string,
   *   token: string,
   *   sitekey: string | null,
   *   attempts: number,
   *   provider: string,
   *   injected: { injected: boolean, callbacksFired: number, fieldsWritten: string[] },
   * }>}
   */
  async solve(page, options = {}) {
    if (!this.apiKey) {
      throw new CaptchaConfigError(
        'CAPTCHA_API_KEY is required for CaptchaBypass.solve(). Stealth/humanization alone cannot produce a valid token.',
      );
    }

    const typeHint = normalizeType(options.type || 'auto');
    const requireVisible = options.requireVisibleWidget ?? typeHint === 'auto';

    if (requireVisible) {
      const visible = await hasVisibleChallenge(page);
      if (!visible && typeHint === 'auto') {
        // Still allow v3-only pages where no checkbox is visible.
        this.logger.debug('No visible captcha widget; continuing with page-script detection');
      }
    }

    if (this.humanize) {
      await humanPause(150, 500);
    }

    let lastError = null;
    const maxAttempts = Math.max(1, this.maxRetries + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const detection = await detectCaptcha(page, {
          type: typeHint,
          action: options.action,
          enterprise: options.enterprise,
        });

        const sitekey = options.sitekey || detection.sitekey;
        if (!sitekey) {
          throw new CaptchaSolveError('Captcha sitekey could not be detected');
        }

        const type = detection.type === 'unknown' ? 'recaptcha_v2' : detection.type;

        this.logger.info('Captcha detected', {
          type,
          attempt,
          invisible: detection.invisible,
          enterprise: detection.enterprise,
          evidence: detection.evidence,
          // Never log tokens; sitekey is semi-public widget config.
          sitekeyPrefix: `${sitekey.slice(0, 6)}…`,
        });

        // Important: do NOT click the checkbox / challenge iframe when solving via token injection.
        const solved = await solveCaptcha(this.solver, {
          apiKey: this.apiKey,
          type,
          websiteURL: page.url(),
          websiteKey: sitekey,
          invisible: detection.invisible,
          enterprise: Boolean(options.enterprise ?? detection.enterprise),
          action: options.action ?? detection.action,
          minScore: options.minScore ?? 0.7,
          apiDomain: detection.apiDomain,
          proxy: this.proxy,
          timeoutMs: this.timeoutMs,
        });

        if (this.humanize) {
          await humanPause(200, 700);
        }

        const injected = await injectCaptchaToken(page, {
          type,
          token: solved.token,
          sitekey,
        });

        if (options.submitSelector) {
          const submit = page.locator(options.submitSelector).first();
          if (this.humanize) {
            await humanMoveTo(page, submit);
          }
          await submit.click({ timeout: 15_000 });
        }

        this.logger.info('Captcha solved and token injected', {
          type,
          attempt,
          provider: solved.provider,
          callbacksFired: injected.callbacksFired,
          fieldsWritten: injected.fieldsWritten,
        });

        return {
          solved: true,
          type,
          token: solved.token,
          sitekey,
          attempts: attempt,
          provider: solved.provider,
          injected,
        };
      } catch (error) {
        lastError = error;
        this.logger.warn('Captcha solve attempt failed', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < maxAttempts) {
          await humanPause(800, 1_600);
        }
      }
    }

    throw new CaptchaSolveError(
      `Captcha solve failed after ${maxAttempts} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      { cause: lastError },
    );
  }

  /**
   * Close browser resources owned by this instance.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (!this._ownsBrowser) {
      return;
    }

    try {
      if (this.context) {
        await this.context.close();
      } else if (this.browser) {
        await this.browser.close();
      }
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
      this._ownsBrowser = false;
    }
  }
}
