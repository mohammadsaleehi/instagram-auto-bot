import { AuthState, detectAuthState } from './auth-state.js';
import {
  exportContextStorageState,
  sessionInvalidationMessage,
  StorageStateError,
} from './storage-state.js';

export const DEFAULT_AUTH_STATE_SAVE_INTERVAL_MS = 300_000;

/**
 * Periodically persist an authenticated Playwright storage state.
 * Serializes writes, validates authentication before replace, and never
 * overwrites a last-known-valid file with an invalid snapshot.
 */
export class SessionPersistenceManager {
  /**
   * @param {{
   *   context: import('playwright').BrowserContext,
   *   page: import('playwright').Page,
   *   storageStatePath: string,
   *   intervalMs?: number,
   *   logger: {
   *     info: (message: string, meta?: Record<string, unknown>) => void,
   *     warn: (message: string, meta?: Record<string, unknown>) => void,
   *     error: (message: string, meta?: Record<string, unknown>) => void,
   *     debug: (message: string, meta?: Record<string, unknown>) => void,
   *   },
   *   detectAuthStateFn?: typeof detectAuthState,
   *   exportStorageStateFn?: typeof exportContextStorageState,
   *   setIntervalFn?: typeof setInterval,
   *   clearIntervalFn?: typeof clearInterval,
   * }} options
   */
  constructor(options) {
    this.context = options.context;
    this.page = options.page;
    this.storageStatePath = options.storageStatePath;
    this.intervalMs = options.intervalMs ?? DEFAULT_AUTH_STATE_SAVE_INTERVAL_MS;
    this.logger = options.logger;
    this._detectAuthState = options.detectAuthStateFn ?? detectAuthState;
    this._exportStorageState = options.exportStorageStateFn ?? exportContextStorageState;
    this._setInterval = options.setIntervalFn ?? setInterval;
    this._clearInterval = options.clearIntervalFn ?? clearInterval;

    /** @type {ReturnType<typeof setInterval> | null} */
    this._timer = null;
    /** @type {Promise<void>} */
    this._queue = Promise.resolve();
    this._saving = false;
    this._stopped = false;
    /** @type {string | null} */
    this.lastInvalidState = null;
  }

  /**
   * @returns {boolean}
   */
  isRunning() {
    return this._timer !== null && !this._stopped;
  }

  /**
   * @returns {boolean}
   */
  isSaving() {
    return this._saving;
  }

  /**
   * Start the periodic save timer.
   *
   * @returns {void}
   */
  start() {
    if (this._timer || this._stopped) {
      return;
    }

    this.logger.info('Auth storage-state persistence started', {
      intervalMs: this.intervalMs,
      pathConfigured: true,
    });

    this._timer = this._setInterval(() => {
      void this.save().catch(() => {
        // Errors are logged inside save(); never crash the bot from the timer.
      });
    }, this.intervalMs);

    if (typeof this._timer === 'object' && this._timer && 'unref' in this._timer) {
      this._timer.unref?.();
    }
  }

  /**
   * Queue a serialized save. Concurrent callers share one in-flight chain.
   *
   * @returns {Promise<{ saved: boolean, reason?: string, state?: string }>}
   */
  save() {
    /** @type {{ saved: boolean, reason?: string, state?: string }} */
    let result = { saved: false, reason: 'not_started' };

    this._queue = this._queue
      .then(async () => {
        result = await this._saveExclusive();
      })
      .catch((error) => {
        this.logger.error('Auth storage-state save queue failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        result = { saved: false, reason: 'queue_error' };
      });

    return this._queue.then(() => result);
  }

  /**
   * @returns {Promise<{ saved: boolean, reason?: string, state?: string }>}
   */
  async _saveExclusive() {
    if (this._saving) {
      return { saved: false, reason: 'concurrent_blocked' };
    }

    this._saving = true;

    try {
      if (this.page.isClosed?.()) {
        this.logger.warn('Skipping auth storage-state save because the page is closed');
        return { saved: false, reason: 'page_closed' };
      }

      const auth = await this._detectAuthState(this.page);

      if (auth.state !== AuthState.AUTHENTICATED) {
        this.lastInvalidState = auth.state;
        this.logger.warn('Skipping auth storage-state save; session is not authenticated', {
          state: auth.state,
          reason: auth.reason,
        });

        if (
          auth.state === AuthState.LOGIN_REQUIRED ||
          auth.state === AuthState.VERIFICATION_REQUIRED ||
          auth.state === AuthState.UNKNOWN
        ) {
          this.logger.error(sessionInvalidationMessage(auth.state, this.storageStatePath));
        }

        return { saved: false, reason: 'unauthenticated', state: auth.state };
      }

      const summary = await this._exportStorageState(this.context, this.storageStatePath);
      this.lastInvalidState = null;
      this.logger.info('Auth storage state saved', {
        cookieCount: summary.cookieCount,
        originCount: summary.originCount,
      });
      return { saved: true, state: auth.state };
    } catch (error) {
      if (error instanceof StorageStateError) {
        this.logger.error('Auth storage-state save rejected; previous valid file preserved', {
          code: error.code,
          error: error.message,
        });
        return { saved: false, reason: error.code };
      }

      this.logger.error('Auth storage-state save failed; previous valid file preserved', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { saved: false, reason: 'save_failed' };
    } finally {
      this._saving = false;
    }
  }

  /**
   * Clear the timer and wait for any pending save to finish.
   *
   * @param {{ finalSave?: boolean }} [options]
   * @returns {Promise<{ saved: boolean, reason?: string, state?: string }>}
   */
  async stop(options = {}) {
    const finalSave = options.finalSave ?? true;
    this._stopped = true;

    if (this._timer) {
      this._clearInterval(this._timer);
      this._timer = null;
    }

    /** @type {{ saved: boolean, reason?: string, state?: string }} */
    let result = { saved: false, reason: 'stopped' };

    if (finalSave) {
      result = await this.save();
    } else {
      await this._queue;
    }

    this.logger.info('Auth storage-state persistence stopped', {
      finalSaveAttempted: finalSave,
      saved: result.saved,
    });

    return result;
  }
}
