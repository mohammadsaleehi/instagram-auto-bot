import { AuthState, detectAuthState } from './auth-state.js';
import { SELECTORS } from './selectors.js';
import { raceWithAbort, ShutdownError, throwIfAborted } from '../utils/shutdown.js';

export class LoginError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'LoginError';
    this.code = options.code ?? 'LOGIN_ERROR';
  }
}

/**
 * Resolve the Instagram login submit control.
 * Prefer an accessible "Log in" role button; fall back to CSS selectors.
 *
 * @param {import('playwright').Page} page
 * @returns {import('playwright').Locator}
 */
export function getLoginSubmitLocator(page) {
  return page
    .getByRole('button', { name: SELECTORS.submitButtonByRoleName })
    .or(page.locator(SELECTORS.submitButton))
    .first();
}

/**
 * Instagram login flow for a Playwright page.
 * Works with CDP-attached existing Chrome or isolated launch mode.
 */
export class InstagramLogin {
  /**
   * @param {{
   *   page: import('playwright').Page,
   *   baseUrl: string,
   *   loginTimeoutMs: number,
   *   navigationTimeoutMs: number,
   *   autoLogin?: boolean,
   *   username?: string | null,
   *   password?: string | null,
   *   signal?: AbortSignal | null,
   *   logger: {
   *     info: (message: string, meta?: Record<string, unknown>) => void,
   *     warn: (message: string, meta?: Record<string, unknown>) => void,
   *     error: (message: string, meta?: Record<string, unknown>) => void,
   *     debug: (message: string, meta?: Record<string, unknown>) => void,
   *   },
   * }} options
   */
  constructor(options) {
    this.page = options.page;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.loginTimeoutMs = options.loginTimeoutMs;
    this.navigationTimeoutMs = options.navigationTimeoutMs;
    this.autoLogin = options.autoLogin ?? false;
    this.username = options.username ?? null;
    this.password = options.password ?? null;
    this.logger = options.logger;
    /** @type {AbortSignal | null} */
    this.signal = options.signal ?? null;
    this._formSubmitted = false;
    this._loginAttempted = false;
  }

  /**
   * @returns {boolean}
   */
  canAutoLogin() {
    return Boolean(this.autoLogin && this.username && this.password);
  }

  /**
   * Open Instagram and ensure we land on a usable page.
   *
   * @returns {Promise<void>}
   */
  async openInstagram() {
    try {
      await this.page.goto(this.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });
      this.logger.info('Instagram opened', { url: this.page.url() });
    } catch (error) {
      throw new LoginError('Failed to open Instagram. Check your network connection and try again.', {
        code: 'NAVIGATION_FAILED',
        cause: error,
      });
    }
  }

  /**
   * Navigate to the login page when the current view does not expose a login form.
   *
   * @returns {Promise<void>}
   */
  async ensureLoginPage() {
    const current = await detectAuthState(this.page);
    if (current.state === AuthState.LOGIN_REQUIRED || current.signals.includes('login_form_visible')) {
      return;
    }

    const loginUrl = `${this.baseUrl}/accounts/login/`;
    this.logger.info('Login required', { navigatingTo: loginUrl });

    try {
      await this.page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });
    } catch (error) {
      throw new LoginError('Failed to navigate to the Instagram login page.', {
        code: 'LOGIN_PAGE_NAVIGATION_FAILED',
        cause: error,
      });
    }
  }

  /**
   * Wait until username and password inputs are visible.
   *
   * @returns {Promise<{ usernameInput: import('playwright').Locator, passwordInput: import('playwright').Locator }>}
   */
  async waitForLoginForm() {
    const usernameInput = this.page.locator(SELECTORS.usernameInput).first();
    const passwordInput = this.page.locator(SELECTORS.passwordInput).first();

    try {
      await usernameInput.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
      await passwordInput.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
    } catch (error) {
      const missing = [];
      if (!(await usernameInput.isVisible().catch(() => false))) {
        missing.push('username input');
      }
      if (!(await passwordInput.isVisible().catch(() => false))) {
        missing.push('password input');
      }

      throw new LoginError(
        `Instagram login form not found (${missing.join(' and ') || 'unknown fields'} unavailable). The page structure may have changed.`,
        { code: 'LOGIN_FORM_NOT_FOUND', cause: error },
      );
    }

    return { usernameInput, passwordInput };
  }

  /**
   * Fill credentials and submit once. Never logs credential values.
   *
   * @returns {Promise<boolean>} true if the form was submitted
   */
  async performAutoLogin() {
    if (!this.canAutoLogin()) {
      this.logger.info('Manual login', {
        hint: 'Enter your credentials in the opened browser window',
        autoLogin: this.autoLogin,
        hasCredentials: Boolean(this.username && this.password),
      });
      return false;
    }

    if (this._formSubmitted) {
      this.logger.debug('Login form already submitted; skipping another submit');
      return false;
    }

    this._loginAttempted = true;
    this.logger.info('Automatic login starting');

    const { usernameInput, passwordInput } = await this.waitForLoginForm();

    await usernameInput.fill(this.username);
    await passwordInput.fill(this.password);

    const usernameFilled = (await usernameInput.inputValue()).length > 0;
    const passwordFilled = (await passwordInput.inputValue()).length > 0;

    if (!usernameFilled || !passwordFilled) {
      throw new LoginError(
        'Login fields were not populated successfully. Automatic login aborted without submitting.',
        { code: 'CREDENTIAL_FILL_FAILED' },
      );
    }

    this.logger.info('Login fields populated', {
      usernameFilled,
      passwordFilled,
    });

    const submitButton = getLoginSubmitLocator(this.page);

    try {
      await submitButton.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
    } catch (error) {
      throw new LoginError(
        'Instagram Login button not found. Expected a visible "Log in" control. The page structure may have changed.',
        { code: 'SUBMIT_BUTTON_NOT_FOUND', cause: error },
      );
    }

    const enabled = await submitButton.isEnabled().catch(() => false);
    if (!enabled) {
      // Some Instagram builds expose enabled state via aria-disabled.
      const ariaDisabled = await submitButton.getAttribute('aria-disabled').catch(() => null);
      if (ariaDisabled === 'true') {
        throw new LoginError(
          'Instagram Login button is disabled after filling credentials. Automatic login aborted without submitting.',
          { code: 'SUBMIT_BUTTON_DISABLED' },
        );
      }
    }

    await submitButton.click();
    this._formSubmitted = true;
    this.logger.info('Login form submitted once');
    return true;
  }

  /**
   * Wait for a meaningful page change using Playwright locators / navigation.
   *
   * @param {number} timeoutMs
   * @param {string} previousUrl
   * @returns {Promise<void>}
   */
  async waitForPageSignal(timeoutMs, previousUrl) {
    throwIfAborted(this.signal);
    const budget = Math.max(500, timeoutMs);

    try {
      await raceWithAbort(
        Promise.race([
          this.page
            .locator(SELECTORS.authenticatedNav)
            .first()
            .waitFor({ state: 'visible', timeout: budget }),
          this.page
            .locator(SELECTORS.challengeText)
            .first()
            .waitFor({ state: 'visible', timeout: budget }),
          this.page
            .locator(SELECTORS.loginError)
            .first()
            .waitFor({ state: 'visible', timeout: budget }),
          this.page.waitForURL((url) => url.href !== previousUrl, { timeout: budget }),
        ]),
        this.signal,
      );
    } catch (error) {
      if (error instanceof ShutdownError) {
        throw error;
      }
      throwIfAborted(this.signal);
      // Race timeouts are expected while the user interacts with the browser.
    }
  }

  /**
   * Wait until authentication succeeds or the timeout elapses.
   * Keeps the browser open so the user can complete 2FA / challenges manually.
   * Honors AbortSignal so Ctrl+C can cancel polling immediately.
   *
   * @returns {Promise<import('./auth-state.js').AuthStateResult>}
   */
  async waitForAuthentication() {
    const deadline = Date.now() + this.loginTimeoutMs;
    /** @type {string | null} */
    let lastState = null;
    /** @type {Set<string>} */
    const announced = new Set();

    while (Date.now() < deadline) {
      throwIfAborted(this.signal);

      const result = await detectAuthState(this.page);
      throwIfAborted(this.signal);

      if (result.state !== lastState) {
        this.logger.info('Authentication state detected', {
          state: result.state,
          reason: result.reason,
          signals: result.signals,
          url: result.url,
        });
        lastState = result.state;
      }

      if (result.state === AuthState.AUTHENTICATED) {
        this.logger.info('Authentication successful');
        return result;
      }

      if (
        result.state === AuthState.VERIFICATION_REQUIRED &&
        !announced.has('verification')
      ) {
        this.logger.warn('Verification required', {
          hint: 'Complete 2FA, checkpoint, CAPTCHA, or challenge steps in the browser. Automatic login is paused.',
        });
        announced.add('verification');
      }

      if (
        result.state === AuthState.LOGIN_REQUIRED &&
        result.signals.includes('login_error_visible') &&
        !announced.has('login_error')
      ) {
        this.logger.warn('Invalid credentials or login error shown by Instagram', {
          hint: 'Correct your credentials in the browser. The form will not be auto-resubmitted.',
        });
        announced.add('login_error');

        if (this._formSubmitted) {
          throw new LoginError(
            'Instagram rejected the login attempt. Credentials were not re-submitted automatically.',
            { code: 'INVALID_CREDENTIALS' },
          );
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      await this.waitForPageSignal(Math.min(5_000, remaining), result.url);
    }

    throwIfAborted(this.signal);

    const finalState = await detectAuthState(this.page);
    if (finalState.state === AuthState.AUTHENTICATED) {
      this.logger.info('Authentication successful');
      return finalState;
    }

    if (finalState.state === AuthState.VERIFICATION_REQUIRED) {
      throw new LoginError(
        `Verification was still required after ${this.loginTimeoutMs}ms. Complete 2FA/checkpoint in Chrome and run again if needed.`,
        { code: 'VERIFICATION_TIMEOUT' },
      );
    }

    throw new LoginError(
      `Login did not complete within ${this.loginTimeoutMs}ms. Last state: ${finalState.state} (${finalState.reason})`,
      { code: 'LOGIN_TIMEOUT' },
    );
  }

  /**
   * Full login orchestration: open Instagram, detect state, assist login if needed.
   *
   * @returns {Promise<import('./auth-state.js').AuthStateResult>}
   */
  async ensureAuthenticated() {
    throwIfAborted(this.signal);
    await this.openInstagram();
    throwIfAborted(this.signal);

    const state = await detectAuthState(this.page);
    this.logger.info('Authentication state detected', {
      state: state.state,
      reason: state.reason,
      signals: state.signals,
      url: state.url,
    });

    if (state.state === AuthState.AUTHENTICATED) {
      this.logger.info('Session valid; skipping login attempt', { reason: state.reason });
      return state;
    }

    if (state.state === AuthState.VERIFICATION_REQUIRED) {
      this.logger.warn('Verification required', {
        hint: 'Complete verification in the browser; waiting for authentication',
      });
      return this.waitForAuthentication();
    }

    if (
      state.state === AuthState.LOGIN_REQUIRED ||
      state.state === AuthState.NOT_AUTHENTICATED ||
      state.state === AuthState.UNKNOWN
    ) {
      if (state.state === AuthState.UNKNOWN) {
        this.logger.warn('Unexpected page state', {
          reason: state.reason,
          url: state.url,
        });
      } else if (state.state !== AuthState.LOGIN_REQUIRED) {
        this.logger.info('Session invalid', { state: state.state });
      }

      throwIfAborted(this.signal);
      await this.ensureLoginPage();
      throwIfAborted(this.signal);
      await this.performAutoLogin();
      return this.waitForAuthentication();
    }

    throw new LoginError(`Unhandled authentication state: ${state.state}`, {
      code: 'UNHANDLED_AUTH_STATE',
    });
  }
}
