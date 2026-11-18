import { AuthState, detectAuthState } from '../auth/auth-state.js';

/**
 * Periodic authentication / session health checks.
 */
export class SessionMonitor {
  /**
   * @param {{
   *   instagram: import('../adapters/instagram-adapter.js').InstagramAdapter,
   *   logger: { info: Function, warn: Function, error: Function, debug: Function },
   *   eventsBus?: import('../core/event-bus.js').EventBus | null,
   *   intervalMs?: number,
   *   detectAuthStateFn?: typeof detectAuthState,
   *   onInvalid?: (result: import('../auth/auth-state.js').AuthStateResult) => void,
   * }} options
   */
  constructor(options) {
    this.instagram = options.instagram;
    this.logger = options.logger;
    this.eventsBus = options.eventsBus ?? null;
    this.intervalMs = options.intervalMs ?? 30_000;
    this._detect = options.detectAuthStateFn ?? detectAuthState;
    this.onInvalid = options.onInvalid ?? null;

    /** @type {import('../auth/auth-state.js').AuthStateResult | null} */
    this.lastResult = null;
    /** @type {string | null} */
    this.lastCheckedAt = null;
    this._invalid = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._timer = null;
  }

  /**
   * @returns {boolean}
   */
  isInvalid() {
    return this._invalid;
  }

  /**
   * @returns {Promise<import('../auth/auth-state.js').AuthStateResult>}
   */
  async check() {
    const page = this.instagram.browser.getPage();
    const result = await this._detect(page);
    this.lastResult = result;
    this.lastCheckedAt = new Date().toISOString();

    if (result.state === AuthState.AUTHENTICATED) {
      if (this._invalid) {
        this.logger.info('Authentication restored');
        this.eventsBus?.emit('auth.restored', result);
      }
      this._invalid = false;
      return result;
    }

    this._invalid = true;
    this.logger.error('Authentication invalid; pausing auth-dependent work', {
      state: result.state,
      reason: result.reason,
      recovery: recoveryInstructions(result.state),
    });
    this.eventsBus?.emit('auth.invalid', result);
    this.onInvalid?.(result);
    return result;
  }

  /**
   * @returns {void}
   */
  start() {
    if (this._timer) {
      return;
    }
    this._timer = setInterval(() => {
      void this.check().catch((error) => {
        this.logger.warn('Session monitor check failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.intervalMs);
    if (typeof this._timer === 'object' && this._timer && 'unref' in this._timer) {
      this._timer.unref?.();
    }
  }

  /**
   * @returns {void}
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * @returns {object}
   */
  getStatus() {
    return {
      invalid: this._invalid,
      lastCheckedAt: this.lastCheckedAt,
      lastState: this.lastResult?.state ?? null,
      reason: this.lastResult?.reason ?? null,
      recovery: this.lastResult
        ? recoveryInstructions(this.lastResult.state)
        : null,
    };
  }
}

/**
 * @param {string} state
 * @returns {string}
 */
export function recoveryInstructions(state) {
  switch (state) {
    case AuthState.LOGIN_REQUIRED:
    case AuthState.NOT_AUTHENTICATED:
      return 'Log in again in the attached Chrome window, or run `npm run login` and restart the bot.';
    case AuthState.VERIFICATION_REQUIRED:
      return 'Complete CAPTCHA / 2FA / checkpoint in the browser, then resume the worker.';
    case AuthState.UNKNOWN:
      return 'Open Instagram in the bot tab, confirm the session manually, then resume.';
    default:
      return 'No recovery action required.';
  }
}
