import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthState } from '../src/auth/auth-state.js';
import { InstagramLogin } from '../src/auth/instagram-login.js';
import { loadConfig, ConfigError } from '../src/config/config.js';
import {
  disconnectExistingChrome,
  runLoginProvisioning,
  saveAuthenticatedStorageState,
} from '../src/scripts/login.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createCdpHarness(options = {}) {
  const preexistingPage = options.preexistingPage ?? {
    url: () => 'https://chatgpt.com/',
    isClosed: () => false,
  };
  const page = options.page ?? {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => 'https://www.instagram.com/'),
    isClosed: () => false,
  };
  const context = {
    pages: () => [preexistingPage],
    newPage: vi.fn(async () => page),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const browser = {
    contexts: () => [context],
    newContext: vi.fn(),
    close: vi.fn(async () => {}),
  };

  return { preexistingPage, page, context, browser };
}

function exportSummary(overrides = {}) {
  return {
    cookieCount: 1,
    originCount: 1,
    hasInstagramState: true,
    removedCookieCount: 0,
    removedOriginCount: 0,
    absolutePath: '/home/mohammad/Work/Instagram-Auto-Bot/data/instagram-auth.json',
    bytes: 128,
    mode: 0o600,
    ...overrides,
  };
}

describe('saveAuthenticatedStorageState', () => {
  it('does not export when authentication is missing', async () => {
    const exportStorageStateFn = vi.fn();
    const result = await saveAuthenticatedStorageState({
      page: {},
      context: {},
      storageStatePath: '/tmp/ig-auth.json',
      logger: createLogger(),
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.LOGIN_REQUIRED,
        url: 'https://www.instagram.com/accounts/login/',
        signals: ['login_form_visible'],
        reason: 'Login form is visible',
      })),
      exportStorageStateFn,
    });

    expect(result.saved).toBe(false);
    expect(exportStorageStateFn).not.toHaveBeenCalled();
  });

  it('exports when authentication is confirmed', async () => {
    const exportStorageStateFn = vi.fn(async () => exportSummary({
      cookieCount: 2,
      removedCookieCount: 5,
      removedOriginCount: 3,
    }));

    const result = await saveAuthenticatedStorageState({
      page: {},
      context: {},
      storageStatePath: '/tmp/ig-auth.json',
      logger: createLogger(),
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.AUTHENTICATED,
        url: 'https://www.instagram.com/',
        signals: ['authenticated_nav_visible'],
        reason: 'ok',
      })),
      exportStorageStateFn,
    });

    expect(result.saved).toBe(true);
    expect(exportStorageStateFn).toHaveBeenCalledTimes(1);
  });
});

describe('disconnectExistingChrome', () => {
  it('disconnects Playwright without closing Chrome', async () => {
    const logger = createLogger();
    const browser = { close: vi.fn(async () => {}) };

    await disconnectExistingChrome(browser, logger);

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Disconnected from existing Chrome (browser left open)',
    );
  });
});

describe('credential configuration for login provisioning', () => {
  it('rejects partial credentials with a safe configuration error', () => {
    expect(() => loadConfig({ INSTAGRAM_USERNAME: 'only-user' })).toThrow(ConfigError);
    try {
      loadConfig({ INSTAGRAM_USERNAME: 'secret-user-value' });
    } catch (error) {
      expect(error.message).not.toContain('secret-user-value');
    }
  });
});

describe('runLoginProvisioning automatic export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exports automatically after successful authentication without requiring Enter to save', async () => {
    const { browser, context, preexistingPage } = createCdpHarness();
    const waitForEnterFn = vi.fn(async () => {});
    const exportStorageStateFn = vi.fn(async () => exportSummary());

    const result = await runLoginProvisioning({
      storageStatePath: '/tmp/ig-auth-test.json',
      logger: createLogger(),
      connectOverCDP: vi.fn(async () => browser),
      waitForEnterFn,
      waitForEnterAfterExport: false,
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.AUTHENTICATED,
        url: 'https://www.instagram.com/',
        signals: ['authenticated_nav_visible'],
        reason: 'ok',
      })),
      exportStorageStateFn,
      createLoginFn: () => ({
        ensureAuthenticated: vi.fn(async () => ({
          state: AuthState.AUTHENTICATED,
          url: 'https://www.instagram.com/',
          signals: ['authenticated_nav_visible'],
          reason: 'Authentication successful',
        })),
      }),
    });

    expect(exportStorageStateFn).toHaveBeenCalledTimes(1);
    expect(waitForEnterFn).not.toHaveBeenCalled();
    expect(result.bytes).toBe(128);
    expect(result.mode).toBe(0o600);
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(context.pages()).toContain(preexistingPage);
  });

  it('optionally waits for Enter only after a successful export', async () => {
    const { browser } = createCdpHarness();
    const waitForEnterFn = vi.fn(async () => {});
    const exportStorageStateFn = vi.fn(async () => exportSummary());

    await runLoginProvisioning({
      storageStatePath: '/tmp/ig-auth-test.json',
      logger: createLogger(),
      connectOverCDP: vi.fn(async () => browser),
      waitForEnterFn,
      waitForEnterAfterExport: true,
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.AUTHENTICATED,
        url: 'https://www.instagram.com/',
        signals: ['authenticated_nav_visible'],
        reason: 'ok',
      })),
      exportStorageStateFn,
      createLoginFn: () => ({
        ensureAuthenticated: vi.fn(async () => ({
          state: AuthState.AUTHENTICATED,
          url: 'https://www.instagram.com/',
          signals: ['authenticated_nav_visible'],
          reason: 'ok',
        })),
      }),
    });

    expect(exportStorageStateFn).toHaveBeenCalledTimes(1);
    expect(waitForEnterFn).toHaveBeenCalledTimes(1);
  });

  it('does not export when login fails', async () => {
    const { browser, context } = createCdpHarness();
    const exportStorageStateFn = vi.fn();

    await expect(
      runLoginProvisioning({
        storageStatePath: '/tmp/ig-auth-test.json',
        logger: createLogger(),
        connectOverCDP: vi.fn(async () => browser),
        waitForEnterAfterExport: false,
        exportStorageStateFn,
        createLoginFn: () => ({
          ensureAuthenticated: vi.fn(async () => {
            const error = new Error('Instagram rejected the login attempt.');
            error.name = 'LoginError';
            error.code = 'INVALID_CREDENTIALS';
            throw error;
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect(exportStorageStateFn).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
  });

  it('reports export failure without claiming success', async () => {
    const { browser } = createCdpHarness();
    const logger = createLogger();

    await expect(
      runLoginProvisioning({
        storageStatePath: '/tmp/ig-auth-test.json',
        logger,
        connectOverCDP: vi.fn(async () => browser),
        waitForEnterAfterExport: false,
        detectAuthStateFn: vi.fn(async () => ({
          state: AuthState.AUTHENTICATED,
          url: 'https://www.instagram.com/',
          signals: ['authenticated_nav_visible'],
          reason: 'ok',
        })),
        exportStorageStateFn: vi.fn(async () => {
          throw new Error('ENOSPC');
        }),
        createLoginFn: () => ({
          ensureAuthenticated: vi.fn(async () => ({
            state: AuthState.AUTHENTICATED,
            url: 'https://www.instagram.com/',
            signals: ['authenticated_nav_visible'],
            reason: 'ok',
          })),
        }),
      }),
    ).rejects.toThrow(/ENOSPC|Failed to export|export/i);

    expect(logger.info.mock.calls.some(([message]) => message === 'Login session export succeeded')).toBe(false);
  });

  it('uses the real InstagramLogin class by default', async () => {
    const { browser, page } = createCdpHarness();
    const ensureSpy = vi
      .spyOn(InstagramLogin.prototype, 'ensureAuthenticated')
      .mockResolvedValue({
        state: AuthState.AUTHENTICATED,
        url: 'https://www.instagram.com/',
        signals: ['authenticated_nav_visible'],
        reason: 'ok',
      });

    try {
      await runLoginProvisioning({
        storageStatePath: '/tmp/ig-auth-test.json',
        logger: createLogger(),
        connectOverCDP: vi.fn(async () => browser),
        waitForEnterAfterExport: false,
        detectAuthStateFn: vi.fn(async () => ({
          state: AuthState.AUTHENTICATED,
          url: 'https://www.instagram.com/',
          signals: ['authenticated_nav_visible'],
          reason: 'ok',
        })),
        exportStorageStateFn: vi.fn(async () => exportSummary()),
        autoLogin: false,
      });

      expect(ensureSpy).toHaveBeenCalledTimes(1);
      expect(ensureSpy.mock.instances[0].page).toBe(page);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('shows a clear error and never launches Chrome when CDP attach fails', async () => {
    await expect(
      runLoginProvisioning({
        storageStatePath: '/tmp/ig-auth-test.json',
        logger: createLogger(),
        connectOverCDP: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
        waitForEnterAfterExport: false,
      }),
    ).rejects.toThrow(/chrome:\/\/inspect\/#remote-debugging/);
  });
});

describe('filesystem verification after automatic export', () => {
  it('writes a real Instagram-only file with mode 0600 when export succeeds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-auto-export-'));
    const filePath = path.join(dir, 'instagram-auth.json');
    const { browser } = createCdpHarness();

    try {
      const { exportContextStorageState } = await import('../src/auth/storage-state.js');
      const mixedState = {
        cookies: [
          { name: 'sessionid', value: 'ig-secret', domain: '.instagram.com', path: '/' },
          { name: 'SID', value: 'google-secret', domain: '.google.com', path: '/' },
        ],
        origins: [
          {
            origin: 'https://www.instagram.com',
            localStorage: [],
            indexedDB: [{ name: 'ig-db', version: 1, stores: [] }],
          },
          { origin: 'https://github.com', localStorage: [{ name: 't', value: 'x' }] },
        ],
      };

      const result = await runLoginProvisioning({
        storageStatePath: filePath,
        logger: createLogger(),
        connectOverCDP: vi.fn(async () => browser),
        waitForEnterAfterExport: false,
        detectAuthStateFn: vi.fn(async () => ({
          state: AuthState.AUTHENTICATED,
          url: 'https://www.instagram.com/',
          signals: ['authenticated_nav_visible'],
          reason: 'ok',
        })),
        exportStorageStateFn: (context, dest, deps) =>
          exportContextStorageState(
            {
              storageState: async ({ path: tmpPath, indexedDB }) => {
                expect(indexedDB).toBe(true);
                await fs.promises.writeFile(tmpPath, JSON.stringify(mixedState));
                return mixedState;
              },
            },
            dest,
            deps,
          ),
        createLoginFn: () => ({
          ensureAuthenticated: vi.fn(async () => ({
            state: AuthState.AUTHENTICATED,
            url: 'https://www.instagram.com/',
            signals: ['authenticated_nav_visible'],
            reason: 'ok',
          })),
        }),
      });

      expect(fs.existsSync(filePath)).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      const raw = fs.readFileSync(filePath, 'utf8');
      expect(raw).toContain('instagram.com');
      expect(raw).not.toContain('google-secret');
      expect(raw).not.toContain('github.com');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
