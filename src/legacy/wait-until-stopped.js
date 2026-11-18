import { AuthState, detectAuthState } from '../auth/auth-state.js';
import { sessionInvalidationMessage } from '../auth/storage-state.js';
import { ShutdownError } from '../utils/shutdown.js';

/**
 * Legacy idle wait used by Phase 1 tests. Prefer Application + TaskManager.
 *
 * @param {import('../browser/browser-manager.js').BrowserManager} browserManager
 * @param {{
 *   info: Function,
 *   warn: Function,
 *   error: Function,
 * }} logger
 * @param {{
 *   persistence?: import('../auth/session-persistence.js').SessionPersistenceManager | null,
 *   monitorAuth?: boolean,
 *   authCheckIntervalMs?: number,
 *   detectAuthStateFn?: typeof detectAuthState,
 *   signal?: AbortSignal | null,
 * }} [options]
 * @returns {Promise<void>}
 */
export function waitUntilStopped(browserManager, logger, options = {}) {
  return new Promise((resolve, reject) => {
    const existingMode = browserManager.isExistingMode();
    const storageStateMode = browserManager.isStorageStateMode();
    const persistence = options.persistence ?? null;
    const monitorAuth = options.monitorAuth ?? storageStateMode;
    const authCheckIntervalMs = options.authCheckIntervalMs ?? 30_000;
    const detectAuthStateFn = options.detectAuthStateFn ?? detectAuthState;
    const signal = options.signal ?? null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let authTimer = null;
    let settled = false;

    logger.info('Ready', {
      hint: existingMode
        ? 'Session is authenticated. Press Ctrl+C to stop the bot. Your Chrome window and other tabs will stay open.'
        : storageStateMode
          ? 'Session is authenticated from storage state. Press Ctrl+C to stop. Auth state is persisted periodically.'
          : 'Session is authenticated. Press Ctrl+C to stop and close the isolated browser.',
    });

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const onAbort = () => {
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new ShutdownError('Shutdown requested', { code: 'SHUTDOWN_REQUESTED' }),
      );
    };

    const onBrowserClose = () => {
      logger.info(
        existingMode
          ? 'Disconnected from Chrome externally'
          : 'Browser context closed externally',
      );
      finish();
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);

      if (authTimer) {
        clearInterval(authTimer);
        authTimer = null;
      }

      const browser = browserManager.getBrowser();
      if (browser) {
        browser.off('disconnected', onBrowserClose);
      }

      try {
        browserManager.getContext().off('close', onBrowserClose);
      } catch {
        // Context may already be unavailable.
      }
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const browser = browserManager.getBrowser();
    if (browser) {
      browser.on('disconnected', onBrowserClose);
    }

    try {
      browserManager.getContext().on('close', onBrowserClose);
    } catch {
      // Existing-mode contexts may not expose a close event the same way.
    }

    if (monitorAuth) {
      authTimer = setInterval(() => {
        if (signal?.aborted) {
          return;
        }

        void (async () => {
          try {
            const page = browserManager.getPage();
            const auth = await detectAuthStateFn(page);
            if (signal?.aborted || settled) {
              return;
            }
            if (
              auth.state === AuthState.LOGIN_REQUIRED ||
              auth.state === AuthState.VERIFICATION_REQUIRED ||
              auth.state === AuthState.UNKNOWN
            ) {
              logger.error(
                sessionInvalidationMessage(
                  auth.state,
                  persistence?.storageStatePath ?? 'AUTH_STORAGE_STATE_PATH',
                ),
              );
              finish();
            }
          } catch {
            // Page may already be closed during shutdown.
          }
        })();
      }, authCheckIntervalMs);

      if (typeof authTimer === 'object' && authTimer && 'unref' in authTimer) {
        authTimer.unref?.();
      }
    }
  });
}
