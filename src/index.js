import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, ConfigError } from './config/config.js';
import { createLogger } from './utils/logger.js';
import {
  createShutdownController,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  ShutdownError,
  throwIfAborted,
} from './utils/shutdown.js';
import { BrowserManager, BrowserError } from './browser/browser-manager.js';
import { InstagramLogin, LoginError } from './auth/instagram-login.js';
import { AuthState, detectAuthState } from './auth/auth-state.js';
import { SessionPersistenceManager } from './auth/session-persistence.js';
import { ensureStorageStateAuthenticated } from './auth/storage-state-auth.js';
import {
  sessionInvalidationMessage,
  StorageStateError,
} from './auth/storage-state.js';

/**
 * Keep the process alive until the user stops it, the connection drops,
 * or (in optional storage-state mode) authentication becomes invalid.
 *
 * @param {BrowserManager} browserManager
 * @param {{
 *   info: Function,
 *   warn: Function,
 *   error: Function,
 * }} logger
 * @param {{
 *   persistence?: SessionPersistenceManager | null,
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

/**
 * Application entry used by npm start and unit tests.
 *
 * @param {{
 *   loadConfigFn?: typeof loadConfig,
 *   createLoggerFn?: typeof createLogger,
 *   BrowserManagerClass?: typeof BrowserManager,
 *   InstagramLoginClass?: typeof InstagramLogin,
 *   SessionPersistenceManagerClass?: typeof SessionPersistenceManager,
 *   ensureStorageStateAuthenticatedFn?: typeof ensureStorageStateAuthenticated,
 *   waitUntilStoppedFn?: typeof waitUntilStopped,
 *   createShutdownControllerFn?: typeof createShutdownController,
 *   forceExitFn?: (code?: number) => void,
 *   shutdownTimeoutMs?: number,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function main(options = {}) {
  const loadConfigFn = options.loadConfigFn ?? loadConfig;
  const createLoggerFn = options.createLoggerFn ?? createLogger;
  const BrowserManagerClass = options.BrowserManagerClass ?? BrowserManager;
  const InstagramLoginClass = options.InstagramLoginClass ?? InstagramLogin;
  const SessionPersistenceManagerClass =
    options.SessionPersistenceManagerClass ?? SessionPersistenceManager;
  const ensureStorageStateAuthenticatedFn =
    options.ensureStorageStateAuthenticatedFn ?? ensureStorageStateAuthenticated;
  const waitUntilStoppedFn = options.waitUntilStoppedFn ?? waitUntilStopped;
  const createShutdownControllerFn =
    options.createShutdownControllerFn ?? createShutdownController;

  let config;
  try {
    config = loadConfigFn();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        message: error.message,
      }));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLoggerFn({ level: config.logLevel });
  logger.info('Application started', { browserMode: config.browserMode });

  const shutdown = createShutdownControllerFn({
    logger,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    forceExitFn: options.forceExitFn,
  });

  const browserManager = new BrowserManagerClass({
    mode: config.browserMode,
    userDataDir: config.userDataDir,
    headless: config.headless,
    viewport: config.viewport,
    browserChannel: config.browserChannel,
    browserExecutablePath: config.browserExecutablePath,
    browserPlatform: config.browserPlatform,
    cdpEndpoint: config.cdpEndpoint,
    authStorageStatePath: config.authStorageStatePath,
    navigationTimeoutMs: config.navigationTimeoutMs,
    signal: shutdown.signal,
    logger,
  });

  /** @type {SessionPersistenceManager | null} */
  let persistence = null;
  let shuttingDown = false;
  let exitAfterShutdown = false;

  const runShutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      if (persistence) {
        await persistence.stop({ finalSave: true });
        persistence = null;
      }
      await browserManager.close();
    } catch (error) {
      logger.error('Error during browser shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Keep the force-exit timer armed until we intentionally leave the process.
      // Dangling Playwright CDP connects can otherwise keep the event loop alive.
      if (!exitAfterShutdown) {
        shutdown.dispose();
      }
    }
  };

  try {
    throwIfAborted(shutdown.signal);
    const page = await browserManager.start();
    throwIfAborted(shutdown.signal);

    /** @type {import('./auth/auth-state.js').AuthStateResult} */
    let authResult;

    if (browserManager.isStorageStateMode()) {
      authResult = await ensureStorageStateAuthenticatedFn(page, {
        baseUrl: config.instagramBaseUrl,
        navigationTimeoutMs: config.navigationTimeoutMs,
        logger,
        storageStatePath: config.authStorageStatePath,
      });
      throwIfAborted(shutdown.signal);

      persistence = new SessionPersistenceManagerClass({
        context: browserManager.getContext(),
        page,
        storageStatePath: config.authStorageStatePath,
        intervalMs: config.authStateSaveIntervalMs,
        logger,
      });
      persistence.start();
    } else {
      // Default personal Chrome CDP path and other non-storage-state modes.
      const login = new InstagramLoginClass({
        page,
        baseUrl: config.instagramBaseUrl,
        loginTimeoutMs: config.loginTimeoutMs,
        navigationTimeoutMs: config.navigationTimeoutMs,
        autoLogin: config.autoLogin,
        username: config.username,
        password: config.password,
        signal: shutdown.signal,
        logger,
      });

      authResult = await login.ensureAuthenticated();
    }

    throwIfAborted(shutdown.signal);

    if (authResult.state !== AuthState.AUTHENTICATED) {
      throw new LoginError(`Expected AUTHENTICATED, received ${authResult.state}`, {
        code: 'AUTH_INCOMPLETE',
      });
    }

    await waitUntilStoppedFn(browserManager, logger, {
      persistence,
      monitorAuth: browserManager.isStorageStateMode(),
      signal: shutdown.signal,
    });
  } catch (error) {
    if (error instanceof ShutdownError) {
      logger.info('Application stopped by shutdown signal');
      process.exitCode = process.exitCode ?? 130;
      exitAfterShutdown = true;
    } else if (
      error instanceof BrowserError ||
      error instanceof LoginError ||
      error instanceof StorageStateError
    ) {
      logger.error(error.message, {
        code: 'code' in error ? error.code : undefined,
        name: error.name,
      });
      process.exitCode = 1;
    } else {
      logger.error('Unexpected error', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    }
  } finally {
    await runShutdown();
  }

  if (exitAfterShutdown) {
    // Playwright CDP connect promises are not cancellable; exit so they cannot hang Node.
    shutdown.dispose();
    process.exit(process.exitCode ?? 130);
  }
}

/**
 * @returns {boolean}
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
