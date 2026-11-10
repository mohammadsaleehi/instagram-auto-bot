import fs from 'node:fs';
import { chromium } from 'playwright';
import {
  readStorageStateFile,
  StorageStateError,
} from '../auth/storage-state.js';
import { raceWithAbort, throwIfAborted } from '../utils/shutdown.js';

export class BrowserError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, code?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BrowserError';
    this.code = options.code ?? 'BROWSER_ERROR';
  }
}

/**
 * Build Chromium launch args for the configured display platform.
 * Avoids duplicate `--ozone-platform=*` flags.
 *
 * @param {'x11' | 'wayland' | 'default'} platform
 * @param {string[]} [existingArgs=[]]
 * @returns {string[]}
 */
export function buildPlatformArgs(platform, existingArgs = []) {
  const args = [...existingArgs];
  const withoutOzone = args.filter((arg) => !arg.startsWith('--ozone-platform='));

  if (platform === 'x11') {
    withoutOzone.push('--ozone-platform=x11');
  } else if (platform === 'wayland') {
    withoutOzone.push('--ozone-platform=wayland');
  }

  return withoutOzone;
}

/**
 * Build Playwright `launchPersistentContext` options from browser settings.
 * Used by `BROWSER_MODE=launch` and `BROWSER_MODE=launch-x11`.
 *
 * @param {{
 *   headless?: boolean,
 *   viewport?: { width: number, height: number },
 *   browserChannel?: string | null,
 *   browserExecutablePath?: string | null,
 *   browserPlatform?: 'x11' | 'wayland' | 'default',
 *   extraArgs?: string[],
 * }} options
 * @returns {import('playwright').LaunchPersistentContextOptions}
 */
export function buildPersistentContextOptions(options = {}) {
  const {
    headless = false,
    viewport = { width: 1280, height: 800 },
    browserChannel = null,
    browserExecutablePath = null,
    browserPlatform = 'default',
    extraArgs = [],
  } = options;

  /** @type {import('playwright').LaunchPersistentContextOptions} */
  const launchOptions = {
    headless,
    viewport,
    args: buildPlatformArgs(browserPlatform, extraArgs),
  };

  if (browserExecutablePath) {
    launchOptions.executablePath = browserExecutablePath;
  } else if (browserChannel) {
    launchOptions.channel = browserChannel;
  }

  return launchOptions;
}

/**
 * Resolve the CDP endpoint used for existing-browser mode.
 *
 * @param {{ cdpEndpoint?: string | null, browserChannel?: string | null }} options
 * @returns {string}
 */
export function resolveCdpEndpoint(options = {}) {
  if (options.cdpEndpoint) {
    return options.cdpEndpoint;
  }

  return options.browserChannel || 'chrome';
}

/**
 * Helpful guidance when Chrome remote debugging is not enabled.
 *
 * @param {string} endpoint
 * @returns {string}
 */
export function remoteDebuggingErrorMessage(endpoint) {
  return [
    `Could not connect to the existing Chrome instance via CDP (${endpoint}).`,
    'Chrome appears to be running, but remote debugging is not enabled for this browser instance.',
    '1. Open chrome://inspect/#remote-debugging in Google Chrome.',
    '2. Enable "Allow remote debugging for this browser instance".',
    '3. Approve the connection prompt if Chrome asks.',
    '4. Run the bot again.',
    'The bot will not launch a separate Chrome window as a fallback.',
  ].join('\n');
}

/**
 * Common system browser paths checked for optional storage-state launches.
 * Never downloads Playwright's bundled Chromium from a CDN.
 */
export const SYSTEM_BROWSER_CANDIDATES = Object.freeze([
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
]);

/**
 * Resolve an installed system browser executable when one is needed.
 *
 * @param {{
 *   configuredPath?: string | null,
 *   candidates?: readonly string[],
 *   existsSyncFn?: typeof fs.existsSync,
 * }} [options]
 * @returns {string | null}
 */
export function detectSystemBrowserExecutable(options = {}) {
  const existsSyncFn = options.existsSyncFn ?? fs.existsSync;
  const configuredPath = options.configuredPath ?? null;

  if (configuredPath && existsSyncFn(configuredPath)) {
    return configuredPath;
  }

  const candidates = options.candidates ?? SYSTEM_BROWSER_CANDIDATES;
  for (const candidate of candidates) {
    if (existsSyncFn(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Manages either:
 * - existing: attach to a running Chrome instance over CDP (default)
 * - launch / launch-x11: isolated persistent Playwright Chrome/Chromium profile
 * - storage-state: optional headless browser + Playwright storageState file (server)
 */
export class BrowserManager {
  /**
   * @param {{
   *   mode?: 'existing' | 'launch' | 'launch-x11' | 'storage-state',
   *   userDataDir?: string,
   *   headless?: boolean,
   *   viewport?: { width: number, height: number },
   *   browserChannel?: string | null,
   *   browserExecutablePath?: string | null,
   *   browserPlatform?: 'x11' | 'wayland' | 'default',
   *   cdpEndpoint?: string | null,
   *   authStorageStatePath?: string | null,
   *   navigationTimeoutMs?: number,
   *   logger: {
   *     info: (message: string, meta?: Record<string, unknown>) => void,
   *     warn: (message: string, meta?: Record<string, unknown>) => void,
   *     error: (message: string, meta?: Record<string, unknown>) => void,
   *     debug: (message: string, meta?: Record<string, unknown>) => void,
   *   },
   *   launchPersistentContext?: typeof chromium.launchPersistentContext,
   *   connectOverCDP?: typeof chromium.connectOverCDP,
   *   signal?: AbortSignal | null,
   *   launch?: typeof chromium.launch,
   *   existsSyncFn?: typeof fs.existsSync,
   *   readStorageStateFileFn?: typeof readStorageStateFile,
   * }} options
   */
  constructor(options) {
    this.mode = options.mode ?? 'existing';
    this.userDataDir = options.userDataDir ?? null;
    this.headless = options.headless ?? (options.mode === 'storage-state');
    this.viewport = options.viewport ?? { width: 1280, height: 800 };
    this.browserChannel = options.browserChannel ?? null;
    this.browserExecutablePath = options.browserExecutablePath ?? null;
    this.browserPlatform = options.browserPlatform ?? 'default';
    this.cdpEndpoint = options.cdpEndpoint ?? null;
    this.authStorageStatePath = options.authStorageStatePath ?? null;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
    /** @type {AbortSignal | null} */
    this.signal = options.signal ?? null;
    this.logger = options.logger;
    this._launchPersistentContext =
      options.launchPersistentContext ?? chromium.launchPersistentContext.bind(chromium);
    this._connectOverCDP = options.connectOverCDP ?? chromium.connectOverCDP.bind(chromium);
    this._launch = options.launch ?? chromium.launch.bind(chromium);
    this._existsSync = options.existsSyncFn ?? fs.existsSync;
    this._readStorageStateFile = options.readStorageStateFileFn ?? readStorageStateFile;

    /** @type {import('playwright').Browser | null} */
    this.browser = null;
    /** @type {import('playwright').BrowserContext | null} */
    this.context = null;
    /** @type {import('playwright').Page | null} */
    this.page = null;
    /** @type {import('playwright').Page[]} */
    this._preexistingPages = [];
    this._ownsBrowserProcess = false;
    this._closing = false;
  }

  /**
   * @returns {boolean}
   */
  isRunning() {
    return this.context !== null || this.browser !== null;
  }

  /**
   * @returns {boolean}
   */
  isExistingMode() {
    return this.mode === 'existing';
  }

  /**
   * @returns {boolean}
   */
  isLaunchMode() {
    return this.mode === 'launch' || this.mode === 'launch-x11';
  }

  /**
   * @returns {boolean}
   */
  isStorageStateMode() {
    return this.mode === 'storage-state';
  }

  /**
   * Build launch options for isolated launch modes.
   *
   * @returns {import('playwright').LaunchPersistentContextOptions}
   */
  getLaunchOptions() {
    return buildPersistentContextOptions({
      headless: this.headless,
      viewport: this.viewport,
      browserChannel: this.browserChannel,
      browserExecutablePath: this.browserExecutablePath,
      browserPlatform: this.browserPlatform,
    });
  }

  /**
   * Build non-persistent launch options for storage-state mode.
   *
   * @returns {import('playwright').LaunchOptions}
   */
  getStorageStateLaunchOptions() {
    const executablePath = detectSystemBrowserExecutable({
      configuredPath: this.browserExecutablePath,
      existsSyncFn: this._existsSync,
    });

    /** @type {import('playwright').LaunchOptions} */
    const launchOptions = {
      headless: this.headless,
    };

    if (executablePath) {
      launchOptions.executablePath = executablePath;
    } else if (this.browserChannel) {
      launchOptions.channel = this.browserChannel;
    }

    return launchOptions;
  }

  /**
   * Start the browser according to the configured mode.
   *
   * @returns {Promise<import('playwright').Page>}
   */
  async start() {
    throwIfAborted(this.signal);

    if (this.context && this.page && !this.page.isClosed()) {
      this.logger.debug('Browser already connected; reusing existing page');
      return this.page;
    }

    if (this.mode === 'existing') {
      return this.connectExisting();
    }

    if (this.isLaunchMode()) {
      return this.launchIsolated();
    }

    if (this.isStorageStateMode()) {
      return this.launchWithStorageState();
    }

    throw new BrowserError(`Unsupported browser mode: ${this.mode}`, {
      code: 'UNSUPPORTED_BROWSER_MODE',
    });
  }

  /**
   * Backward-compatible alias for {@link BrowserManager#start}.
   *
   * @returns {Promise<import('playwright').Page>}
   */
  async launch() {
    return this.start();
  }

  /**
   * Attach to an already-running Chrome instance over CDP.
   * Reuses the default context and opens a new tab.
   *
   * @returns {Promise<import('playwright').Page>}
   */
  async connectExisting() {
    throwIfAborted(this.signal);

    const endpoint = resolveCdpEndpoint({
      cdpEndpoint: this.cdpEndpoint,
      browserChannel: this.browserChannel,
    });

    this.logger.info('Connecting to existing Chrome over CDP', {
      mode: 'existing',
      endpoint,
    });

    try {
      this.browser = await raceWithAbort(this._connectOverCDP(endpoint), this.signal);
    } catch (error) {
      this.browser = null;
      throwIfAborted(this.signal);
      throw new BrowserError(remoteDebuggingErrorMessage(endpoint), {
        code: 'REMOTE_DEBUGGING_DISABLED',
        cause: error,
      });
    }

    const contexts = this.browser.contexts();
    if (!contexts.length) {
      await this.disconnectExisting().catch(() => {});
      throw new BrowserError(
        'Connected to Chrome over CDP, but no browser context was available. Enable remote debugging and retry.',
        { code: 'NO_BROWSER_CONTEXT' },
      );
    }

    // Reuse the default existing context. Never call browser.newContext().
    this.context = contexts[0];
    this._ownsBrowserProcess = false;

    this._preexistingPages = [...this.context.pages()];
    this.logger.info('Reusing existing Chrome context', {
      contextCount: contexts.length,
      preexistingTabCount: this._preexistingPages.length,
    });

    this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    this.context.setDefaultTimeout(this.navigationTimeoutMs);

    this.page = await this.context.newPage();
    this.logger.info('Opened a new tab in the existing Chrome window');

    this.browser.on('disconnected', () => {
      this.browser = null;
      this.context = null;
      this.page = null;
    });

    return this.page;
  }

  /**
   * Launch an isolated persistent browser profile (optional non-default modes).
   *
   * @returns {Promise<import('playwright').Page>}
   */
  async launchIsolated() {
    if (!this.userDataDir) {
      throw new BrowserError(
        `USER_DATA_DIR is required when BROWSER_MODE=${this.mode}`,
        { code: 'MISSING_USER_DATA_DIR' },
      );
    }

    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    } catch (error) {
      throw new BrowserError('Failed to prepare browser user data directory', {
        code: 'USER_DATA_DIR_ERROR',
        cause: error,
      });
    }

    const launchOptions = this.getLaunchOptions();

    this.logger.info('Browser initialized', {
      mode: this.mode,
      headless: this.headless,
      viewport: this.viewport,
      channel: this.browserExecutablePath
        ? undefined
        : (this.browserChannel ?? 'chromium'),
      executablePath: this.browserExecutablePath ?? undefined,
      platform: this.browserPlatform,
      userDataDirConfigured: true,
    });

    try {
      this.context = await this._launchPersistentContext(this.userDataDir, launchOptions);
      this._ownsBrowserProcess = true;
      this.browser = null;

      this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      this.context.setDefaultTimeout(this.navigationTimeoutMs);

      const existingPages = this.context.pages();
      this.page = existingPages.length > 0 ? existingPages[0] : await this.context.newPage();

      this.context.on('close', () => {
        this.context = null;
        this.page = null;
      });

      return this.page;
    } catch (error) {
      this.context = null;
      this.page = null;
      this._ownsBrowserProcess = false;

      const message = error instanceof Error ? error.message : String(error);
      if (/already in use|SingletonLock|profile.*lock/i.test(message)) {
        throw new BrowserError(
          'Browser profile appears to be already in use. Close other Chromium instances using this session and try again.',
          { code: 'PROFILE_IN_USE', cause: error },
        );
      }

      if (/Executable doesn't exist|Failed to launch|browserType\.launch/i.test(message)) {
        throw new BrowserError(
          'Failed to launch the browser. Ensure Google Chrome is installed, or set BROWSER_EXECUTABLE_PATH / BROWSER_CHANNEL.',
          { code: 'LAUNCH_FAILED', cause: error },
        );
      }

      throw new BrowserError('Failed to launch Chromium persistent context', {
        code: 'LAUNCH_FAILED',
        cause: error,
      });
    }
  }

  /**
   * Launch a headless browser using a transferred Playwright storage state.
   * Optional server mode — does not use CDP and does not require a display.
   *
   * @returns {Promise<import('playwright').Page>}
   */
  async launchWithStorageState() {
    if (!this.authStorageStatePath) {
      throw new BrowserError(
        'AUTH_STORAGE_STATE_PATH is required when BROWSER_MODE=storage-state',
        { code: 'MISSING_STORAGE_STATE_PATH' },
      );
    }

    try {
      await this._readStorageStateFile(this.authStorageStatePath);
    } catch (error) {
      if (error instanceof StorageStateError) {
        throw new BrowserError(error.message, {
          code: error.code,
          cause: error,
        });
      }
      throw error;
    }

    const launchOptions = this.getStorageStateLaunchOptions();
    if (!launchOptions.executablePath && !launchOptions.channel) {
      throw new BrowserError(
        [
          'No suitable Chrome/Chromium browser was found on this server.',
          'Install Google Chrome or Chromium, or set BROWSER_EXECUTABLE_PATH to an absolute binary path.',
          'This mode does not download Playwright Chromium from the CDN.',
        ].join(' '),
        { code: 'BROWSER_NOT_FOUND' },
      );
    }

    this.logger.info('Browser initialized', {
      mode: 'storage-state',
      headless: this.headless,
      viewport: this.viewport,
      executablePath: launchOptions.executablePath ?? undefined,
      channel: launchOptions.executablePath ? undefined : launchOptions.channel,
      storageStateConfigured: true,
      usesCdpAttachment: false,
    });

    try {
      this.browser = await this._launch(launchOptions);
      this.context = await this.browser.newContext({
        storageState: this.authStorageStatePath,
        viewport: this.viewport,
      });
      this._ownsBrowserProcess = true;

      this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      this.context.setDefaultTimeout(this.navigationTimeoutMs);

      this.page = await this.context.newPage();

      this.browser.on('disconnected', () => {
        this.browser = null;
        this.context = null;
        this.page = null;
      });

      this.context.on('close', () => {
        this.context = null;
        this.page = null;
      });

      return this.page;
    } catch (error) {
      await this.close().catch(() => {});

      if (error instanceof BrowserError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (/Executable doesn't exist|Failed to launch|browserType\.launch/i.test(message)) {
        throw new BrowserError(
          [
            'Failed to launch the browser for storage-state mode.',
            'Ensure Google Chrome or Chromium is installed, or set BROWSER_EXECUTABLE_PATH.',
            'Playwright Chromium will not be downloaded from a blocked CDN.',
          ].join(' '),
          { code: 'LAUNCH_FAILED', cause: error },
        );
      }

      throw new BrowserError('Failed to launch storage-state browser context', {
        code: 'LAUNCH_FAILED',
        cause: error,
      });
    }
  }

  /**
   * Snapshot of pages that existed before the bot opened its tab.
   *
   * @returns {import('playwright').Page[]}
   */
  getPreexistingPages() {
    return [...this._preexistingPages];
  }

  /**
   * @returns {import('playwright').Page}
   */
  getPage() {
    if (!this.page || this.page.isClosed()) {
      throw new BrowserError('Browser page is not available. Call start() first.');
    }
    return this.page;
  }

  /**
   * @returns {import('playwright').BrowserContext}
   */
  getContext() {
    if (!this.context) {
      throw new BrowserError('Browser context is not available. Call start() first.');
    }
    return this.context;
  }

  /**
   * @returns {import('playwright').Browser | null}
   */
  getBrowser() {
    return this.browser;
  }

  /**
   * Disconnect from an existing Chrome instance without closing it.
   *
   * @returns {Promise<void>}
   */
  async disconnectExisting() {
    if (!this.browser) {
      this.context = null;
      this.page = null;
      return;
    }

    try {
      // browser.close() on a CDP connection disconnects Playwright and does not
      // terminate the Chrome process or close pre-existing tabs.
      await this.browser.close();
      this.logger.info('Disconnected from existing Chrome (browser left open)');
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
      this._preexistingPages = [];
    }
  }

  /**
   * Stop the bot's browser session.
   *
   * - existing mode: disconnect only; Chrome and other tabs stay open
   * - launch / launch-x11: close the isolated persistent context
   * - storage-state: close the owned browser process
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this._closing) {
      return;
    }

    this._closing = true;

    try {
      if (this.mode === 'existing' || !this._ownsBrowserProcess) {
        await this.disconnectExisting();
        return;
      }

      if (this.isStorageStateMode()) {
        if (this.context) {
          await this.context.close().catch(() => {});
        }
        if (this.browser) {
          await this.browser.close();
        }
        this.logger.info('Browser closed');
        return;
      }

      if (!this.context) {
        return;
      }

      await this.context.close();
      this.logger.info('Browser closed');
    } catch (error) {
      this.logger.error('Failed to close browser cleanly', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BrowserError('Failed to close browser session', {
        code: 'CLOSE_FAILED',
        cause: error,
      });
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
      this._ownsBrowserProcess = false;
      this._closing = false;
    }
  }
}
