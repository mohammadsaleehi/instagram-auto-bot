#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig, ConfigError } from '../config/config.js';
import { createLogger } from '../utils/logger.js';
import {
  createShutdownController,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  raceWithAbort,
  ShutdownError,
  throwIfAborted,
} from '../utils/shutdown.js';
import { AuthState, detectAuthState } from '../auth/auth-state.js';
import { InstagramLogin, LoginError } from '../auth/instagram-login.js';
import {
  exportContextStorageState,
  resolveAuthStorageStatePath,
  StorageStateError,
} from '../auth/storage-state.js';
import { remoteDebuggingErrorMessage, resolveCdpEndpoint } from '../browser/browser-manager.js';

export const INSTAGRAM_HOME_URL = 'https://www.instagram.com/';

/**
 * Wait until the operator presses Enter in the terminal.
 * Optional after a successful automatic export.
 * Closes the readline interface immediately when AbortSignal fires.
 *
 * @param {{
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   prompt?: string,
 *   signal?: AbortSignal | null,
 *   createInterfaceFn?: typeof readline.createInterface,
 * }} [options]
 * @returns {Promise<void>}
 */
export function waitForEnter(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const prompt =
    options.prompt ??
    'Session exported successfully. Press Enter to finish and disconnect from Chrome… ';
  const createInterfaceFn = options.createInterfaceFn ?? readline.createInterface.bind(readline);
  const signal = options.signal ?? null;

  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const rl = createInterfaceFn({ input: stdin, output: stdout });
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        rl.close();
      } catch {
        // Interface may already be closed.
      }

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
          : new ShutdownError('Enter prompt cancelled by shutdown signal', {
              code: 'SHUTDOWN_ABORTED',
              cause: signal?.reason,
            }),
      );
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    rl.question(prompt, () => {
      finish();
    });
  });
}

/**
 * Confirm AUTHENTICATED and export Instagram-only storage state automatically.
 *
 * @param {{
 *   page: import('playwright').Page,
 *   context: import('playwright').BrowserContext,
 *   storageStatePath: string,
 *   logger: { info: Function, warn: Function, error: Function },
 *   signal?: AbortSignal | null,
 *   detectAuthStateFn?: typeof detectAuthState,
 *   exportStorageStateFn?: typeof exportContextStorageState,
 * }} options
 * @returns {Promise<{ saved: boolean, auth: import('../auth/auth-state.js').AuthStateResult, summary?: object }>}
 */
export async function saveAuthenticatedStorageState(options) {
  const detectAuthStateFn = options.detectAuthStateFn ?? detectAuthState;
  const exportStorageStateFn = options.exportStorageStateFn ?? exportContextStorageState;
  throwIfAborted(options.signal);

  const auth = await detectAuthStateFn(options.page);
  throwIfAborted(options.signal);

  options.logger.info('Authentication detected before export', {
    state: auth.state,
    reason: auth.reason,
    signals: auth.signals,
    url: auth.url,
  });

  if (auth.state !== AuthState.AUTHENTICATED) {
    options.logger.warn('Authentication is not confirmed; refusing to export storage state', {
      state: auth.state,
      reason: auth.reason,
      signals: auth.signals,
      url: auth.url,
    });
    return { saved: false, auth };
  }

  // Once export starts, allow it to finish so an interrupted write cannot leave a corrupt file.
  const summary = await exportStorageStateFn(options.context, options.storageStatePath, {
    logger: options.logger,
  });

  options.logger.info('Authenticated Instagram storage state exported', {
    path: summary.absolutePath ?? options.storageStatePath,
    bytes: summary.bytes,
    mode: summary.mode !== undefined ? summary.mode.toString(8).padStart(3, '0') : undefined,
    cookieCount: summary.cookieCount,
    originCount: summary.originCount,
    removedCookieCount: summary.removedCookieCount,
    removedOriginCount: summary.removedOriginCount,
  });

  return { saved: true, auth, summary };
}

/**
 * Disconnect Playwright from an existing Chrome CDP session without closing Chrome.
 *
 * @param {import('playwright').Browser | null} browser
 * @param {{ info: Function }} logger
 * @returns {Promise<void>}
 */
export async function disconnectExistingChrome(browser, logger) {
  if (!browser) {
    return;
  }

  // browser.close() on a CDP connection disconnects Playwright only.
  await browser.close();
  logger.info('Disconnected from existing Chrome (browser left open)');
}

/**
 * Build the shared InstagramLogin helper for the provisioning page.
 *
 * @param {{
 *   page: import('playwright').Page,
 *   baseUrl: string,
 *   loginTimeoutMs: number,
 *   navigationTimeoutMs: number,
 *   autoLogin?: boolean,
 *   username?: string | null,
 *   password?: string | null,
 *   signal?: AbortSignal | null,
 *   logger: object,
 *   InstagramLoginClass?: typeof InstagramLogin,
 * }} options
 * @returns {InstagramLogin}
 */
export function createProvisioningLogin(options) {
  const LoginClass = options.InstagramLoginClass ?? InstagramLogin;
  return new LoginClass({
    page: options.page,
    baseUrl: options.baseUrl,
    loginTimeoutMs: options.loginTimeoutMs,
    navigationTimeoutMs: options.navigationTimeoutMs,
    autoLogin: options.autoLogin ?? false,
    username: options.username ?? null,
    password: options.password ?? null,
    signal: options.signal ?? null,
    logger: options.logger,
  });
}

/**
 * Local Instagram session provisioning using the already-open personal Chrome window.
 * Exports storage state automatically after AUTHENTICATED; Enter is optional afterward.
 *
 * @param {{
 *   storageStatePath?: string,
 *   baseUrl?: string,
 *   navigationTimeoutMs?: number,
 *   loginTimeoutMs?: number,
 *   autoLogin?: boolean,
 *   username?: string | null,
 *   password?: string | null,
 *   cdpEndpoint?: string | null,
 *   browserChannel?: string | null,
 *   waitForEnterAfterExport?: boolean,
 *   shutdownTimeoutMs?: number,
 *   signal?: AbortSignal | null,
 *   logger?: ReturnType<typeof createLogger>,
 *   connectOverCDP?: typeof chromium.connectOverCDP,
 *   waitForEnterFn?: typeof waitForEnter,
 *   detectAuthStateFn?: typeof detectAuthState,
 *   exportStorageStateFn?: typeof exportContextStorageState,
 *   InstagramLoginClass?: typeof InstagramLogin,
 *   createLoginFn?: typeof createProvisioningLogin,
 *   createShutdownControllerFn?: typeof createShutdownController,
 *   forceExitFn?: (code?: number) => void,
 * }} [options]
 * @returns {Promise<{
 *   storageStatePath: string,
 *   absolutePath: string,
 *   bytes: number,
 *   mode: number,
 *   auth: import('../auth/auth-state.js').AuthStateResult,
 *   summary: object,
 * }>}
 */
export async function runLoginProvisioning(options = {}) {
  const logger = options.logger ?? createLogger({ level: 'info' });
  const storageStatePath =
    options.storageStatePath ?? resolveAuthStorageStatePath(process.env.AUTH_STORAGE_STATE_PATH);
  const baseUrl = (options.baseUrl ?? INSTAGRAM_HOME_URL).replace(/\/$/, '');
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
  const loginTimeoutMs = options.loginTimeoutMs ?? 300_000;
  const autoLogin = options.autoLogin ?? false;
  const username = options.username ?? null;
  const password = options.password ?? null;
  const waitForEnterAfterExport = options.waitForEnterAfterExport ?? true;
  const connectOverCDP = options.connectOverCDP ?? chromium.connectOverCDP.bind(chromium);
  const waitForEnterFn = options.waitForEnterFn ?? waitForEnter;
  const detectAuthStateFn = options.detectAuthStateFn ?? detectAuthState;
  const exportStorageStateFn = options.exportStorageStateFn ?? exportContextStorageState;
  const createLoginFn = options.createLoginFn ?? createProvisioningLogin;
  const createShutdownControllerFn =
    options.createShutdownControllerFn ?? createShutdownController;

  const endpoint = resolveCdpEndpoint({
    cdpEndpoint: options.cdpEndpoint,
    browserChannel: options.browserChannel ?? 'chrome',
  });

  logger.info('Connecting login provisioner to existing Chrome over CDP', {
    endpoint,
    usesPersonalChromeProfile: true,
    usesCdpAttachment: true,
    launchesSeparateChrome: false,
    createsIsolatedProfile: false,
    autoLogin,
    hasCredentials: Boolean(username && password),
    storageStatePath,
  });

  /** @type {import('playwright').Browser | null} */
  let browser = null;
  /** @type {Promise<unknown> | null} */
  let exportInFlight = null;

  const ownsShutdown = !options.signal;
  const shutdown = ownsShutdown
    ? createShutdownControllerFn({
        logger,
        shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        forceExitFn: options.forceExitFn,
      })
    : null;
  const signal = options.signal ?? shutdown?.signal ?? null;

  try {
    throwIfAborted(signal);

    try {
      browser = await raceWithAbort(connectOverCDP(endpoint), signal);
    } catch (error) {
      throwIfAborted(signal);
      throw new StorageStateError(remoteDebuggingErrorMessage(endpoint), {
        code: 'REMOTE_DEBUGGING_DISABLED',
        cause: error,
      });
    }

    throwIfAborted(signal);

    const contexts = browser.contexts();
    if (!contexts.length) {
      throw new StorageStateError(
        'Connected to Chrome over CDP, but no browser context was available. Enable remote debugging and retry.',
        { code: 'NO_BROWSER_CONTEXT' },
      );
    }

    // Reuse the default existing context. Never call browser.newContext().
    const context = contexts[0];
    const preexistingPages = [...context.pages()];

    logger.info('Reusing existing Chrome context for login provisioning', {
      contextCount: contexts.length,
      preexistingTabCount: preexistingPages.length,
    });

    context.setDefaultNavigationTimeout(navigationTimeoutMs);
    context.setDefaultTimeout(navigationTimeoutMs);

    const page = await context.newPage();
    logger.info('Opened a new Instagram tab in the existing Chrome window');

    throwIfAborted(signal);

    const login = createLoginFn({
      page,
      baseUrl,
      loginTimeoutMs,
      navigationTimeoutMs,
      autoLogin,
      username,
      password,
      signal,
      logger,
      InstagramLoginClass: options.InstagramLoginClass,
    });

    const authAfterLogin = await login.ensureAuthenticated();
    throwIfAborted(signal);

    logger.info('Authentication detected', {
      state: authAfterLogin.state,
      reason: authAfterLogin.reason,
      signals: authAfterLogin.signals,
      url: authAfterLogin.url,
    });

    if (authAfterLogin.state !== AuthState.AUTHENTICATED) {
      throw new LoginError(
        `Expected AUTHENTICATED after login workflow, received ${authAfterLogin.state}`,
        { code: 'AUTH_INCOMPLETE' },
      );
    }

    // Automatic export — Enter is not required to save.
    // Keep a handle so shutdown can finish an already-started safe export.
    exportInFlight = saveAuthenticatedStorageState({
      page,
      context,
      storageStatePath,
      logger,
      signal,
      detectAuthStateFn,
      exportStorageStateFn,
    });
    const result = await exportInFlight;
    exportInFlight = null;

    if (!result.saved || !result.summary) {
      throw new StorageStateError(
        'Authentication succeeded, but Instagram storage-state export did not complete.',
        { code: 'EXPORT_NOT_SAVED' },
      );
    }

    const absolutePath = result.summary.absolutePath ?? path.resolve(storageStatePath);
    const bytes = result.summary.bytes ?? 0;
    const mode = result.summary.mode ?? 0o600;

    logger.info('Login session export succeeded', {
      path: absolutePath,
      bytes,
      mode: mode.toString(8).padStart(3, '0'),
      cookieCount: result.summary.cookieCount,
      originCount: result.summary.originCount,
    });

    if (waitForEnterAfterExport) {
      await waitForEnterFn({
        prompt: `Session exported to ${absolutePath} (${bytes} bytes). Press Enter to finish and disconnect from Chrome… `,
        signal,
      });
    }

    return {
      storageStatePath,
      absolutePath,
      bytes,
      mode,
      auth: result.auth,
      summary: result.summary,
    };
  } catch (error) {
    if (error instanceof ShutdownError) {
      if (exportInFlight) {
        await exportInFlight.catch(() => {});
      }
      logger.info('Login provisioning stopped by shutdown signal');
      // Mark so callers can exit hard after disconnect; CDP connect may still be pending.
      error.forceProcessExit = true;
      throw error;
    }
    throw error;
  } finally {
    if (exportInFlight) {
      await exportInFlight.catch(() => {});
      exportInFlight = null;
    }
    await disconnectExistingChrome(browser, logger);
    shutdown?.dispose();
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          message: error.message,
        }),
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  const storageStatePath = resolveAuthStorageStatePath(
    process.env.AUTH_STORAGE_STATE_PATH,
    config.authStorageStatePath,
  );

  try {
    const result = await runLoginProvisioning({
      storageStatePath,
      baseUrl: config.instagramBaseUrl,
      navigationTimeoutMs: config.navigationTimeoutMs,
      loginTimeoutMs: config.loginTimeoutMs,
      autoLogin: config.autoLogin,
      username: config.username,
      password: config.password,
      cdpEndpoint: config.cdpEndpoint,
      browserChannel: config.browserChannel,
      logger,
    });

    logger.info('Login provisioning completed successfully', {
      path: result.absolutePath,
      bytes: result.bytes,
      mode: result.mode.toString(8).padStart(3, '0'),
      nextStep:
        'Transfer data/instagram-auth.json to the server with scp, set chmod 600, then start with BROWSER_MODE=storage-state',
    });
  } catch (error) {
    if (error instanceof ShutdownError) {
      process.exitCode = 130;
      // CDP attach is not cancellable; exit so a rejected connect cannot hang Node.
      process.exit(130);
    }
    if (
      error instanceof StorageStateError ||
      error instanceof ConfigError ||
      error instanceof LoginError
    ) {
      logger.error(error.message, {
        code: 'code' in error ? error.code : undefined,
      });
    } else {
      logger.error('Login provisioning failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    process.exitCode = 1;
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
