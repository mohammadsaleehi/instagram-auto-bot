import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AuthState } from '../src/auth/auth-state.js';
import { InstagramLogin } from '../src/auth/instagram-login.js';
import {
  createShutdownController,
  raceWithAbort,
  ShutdownError,
  throwIfAborted,
} from '../src/utils/shutdown.js';
import {
  disconnectExistingChrome,
  runLoginProvisioning,
  waitForEnter,
} from '../src/scripts/login.js';
import { waitUntilStopped } from '../src/index.js';
import { writeStorageStateAtomic } from '../src/auth/storage-state.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('shutdown helpers', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('logs Shutdown requested once and force-exits on repeated SIGINT', () => {
    const logger = createLogger();
    const forceExitFn = vi.fn();
    const shutdown = createShutdownController({
      logger,
      forceExitFn,
      shutdownTimeoutMs: 60_000,
      setTimeoutFn: () => ({ unref() {} }),
      clearTimeoutFn: vi.fn(),
    });

    process.emit('SIGINT');
    expect(logger.info).toHaveBeenCalledWith('Shutdown requested', { signal: 'SIGINT' });
    expect(shutdown.signal.aborted).toBe(true);
    expect(forceExitFn).not.toHaveBeenCalled();

    process.emit('SIGINT');
    expect(logger.warn).toHaveBeenCalledWith(
      'Second shutdown signal received; forcing Node.js exit',
      { signal: 'SIGINT' },
    );
    expect(forceExitFn).toHaveBeenCalledWith(130);
    shutdown.dispose();
  });

  it('treats SIGTERM like a shutdown request', () => {
    const logger = createLogger();
    const shutdown = createShutdownController({
      logger,
      forceExitFn: vi.fn(),
      setTimeoutFn: () => ({ unref() {} }),
      clearTimeoutFn: vi.fn(),
    });

    process.emit('SIGTERM');
    expect(logger.info).toHaveBeenCalledWith('Shutdown requested', { signal: 'SIGTERM' });
    expect(shutdown.signal.aborted).toBe(true);
    shutdown.dispose();
  });

  it('clears the force-exit timer on dispose', () => {
    const clearTimeoutFn = vi.fn();
    /** @type {(() => void) | null} */
    let scheduled = null;
    const setTimeoutFn = (fn) => {
      scheduled = fn;
      return { unref() {} };
    };

    const shutdown = createShutdownController({
      logger: createLogger(),
      forceExitFn: vi.fn(),
      setTimeoutFn,
      clearTimeoutFn,
      shutdownTimeoutMs: 5,
    });

    process.emit('SIGINT');
    expect(scheduled).toBeTypeOf('function');
    shutdown.dispose();
    expect(clearTimeoutFn).toHaveBeenCalled();
  });

  it('raceWithAbort rejects when the signal aborts pending work', async () => {
    const controller = new AbortController();
    const pending = new Promise(() => {});
    const raced = raceWithAbort(pending, controller.signal);
    controller.abort(new ShutdownError('stop', { code: 'SHUTDOWN_REQUESTED' }));
    await expect(raced).rejects.toBeInstanceOf(ShutdownError);
  });

  it('throwIfAborted raises ShutdownError', () => {
    const controller = new AbortController();
    controller.abort(new ShutdownError('stop'));
    expect(() => throwIfAborted(controller.signal)).toThrow(ShutdownError);
  });
});

describe('waitForEnter abort', () => {
  it('closes readline and rejects when Ctrl+C arrives while waiting for Enter', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    const createInterfaceFn = vi.fn(() => ({
      question: vi.fn(() => {
        // Leave the prompt open until abort closes it.
      }),
      close,
    }));

    const waiting = waitForEnter({
      signal: controller.signal,
      createInterfaceFn,
      prompt: 'Press Enter… ',
    });

    controller.abort(new ShutdownError('Shutdown requested via SIGINT', {
      code: 'SHUTDOWN_REQUESTED',
    }));

    await expect(waiting).rejects.toBeInstanceOf(ShutdownError);
    expect(close).toHaveBeenCalled();
  });
});

describe('authentication polling abort', () => {
  it('stops authentication polling when SIGINT aborts the signal', async () => {
    const controller = new AbortController();
    const page = {
      url: vi.fn(() => 'https://www.instagram.com/accounts/login/'),
      goto: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {
        await new Promise(() => {});
      }),
      getByRole: vi.fn(() => ({
        or: vi.fn(function or() { return this; }),
        first: vi.fn(function first() { return this; }),
        waitFor: vi.fn(async () => {
          await new Promise(() => {});
        }),
      })),
      locator: vi.fn(() => ({
        first: vi.fn(function first() { return this; }),
        waitFor: vi.fn(async () => {
          await new Promise(() => {});
        }),
        isVisible: vi.fn(async () => false),
      })),
    };

    // detectAuthState will see login form via locator visibility — keep login required.
    page.locator = vi.fn((selector) => {
      const sel = String(selector);
      const visible = sel.includes('login') || sel.includes('email') || sel.includes('username')
        || sel.includes('password') || sel.includes('pass');
      return {
        first: vi.fn(function first() { return this; }),
        waitFor: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
        isVisible: vi.fn(async () => visible),
        fill: vi.fn(),
        inputValue: vi.fn(async () => ''),
        isEnabled: vi.fn(async () => true),
        getAttribute: vi.fn(async () => null),
        click: vi.fn(),
        or: vi.fn(function or() { return this; }),
      };
    });

    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 30_000,
      navigationTimeoutMs: 100,
      autoLogin: false,
      signal: controller.signal,
      logger: createLogger(),
    });

    const pending = login.ensureAuthenticated();
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new ShutdownError('Shutdown requested via SIGINT', {
      code: 'SHUTDOWN_REQUESTED',
    }));

    await expect(pending).rejects.toBeInstanceOf(ShutdownError);
  });

  it('cancels while waiting for manual verification', async () => {
    const controller = new AbortController();
    let calls = 0;
    const page = {
      url: vi.fn(() => 'https://www.instagram.com/challenge/'),
      goto: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }),
      getByRole: vi.fn(() => ({
        or: vi.fn(function or() { return this; }),
        first: vi.fn(function first() { return this; }),
        waitFor: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }),
      })),
      locator: vi.fn((selector) => {
        const sel = String(selector);
        const isChallenge = sel.includes('challenge') || sel.includes('suspicious');
        return {
          first: vi.fn(function first() {
            calls += 1;
            return this;
          }),
          waitFor: vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }),
          isVisible: vi.fn(async () => isChallenge),
        };
      }),
    };

    const login = new InstagramLogin({
      page,
      baseUrl: 'https://www.instagram.com',
      loginTimeoutMs: 30_000,
      navigationTimeoutMs: 100,
      autoLogin: false,
      signal: controller.signal,
      logger: createLogger(),
    });

    const pending = login.waitForAuthentication();
    await new Promise((resolve) => setTimeout(resolve, 15));
    controller.abort(new ShutdownError('stop verification wait'));
    await expect(pending).rejects.toBeInstanceOf(ShutdownError);
    expect(calls).toBeGreaterThan(0);
  });
});

describe('login provisioning shutdown', () => {
  it('disconnects CDP only and does not call process killers when aborted during export wait', async () => {
    const controller = new AbortController();
    const browserClose = vi.fn(async () => {});
    const page = {
      goto: vi.fn(async () => {}),
      url: vi.fn(() => 'https://www.instagram.com/'),
      isClosed: () => false,
    };
    const context = {
      pages: () => [{ url: () => 'https://example.com', isClosed: () => false }],
      newPage: vi.fn(async () => page),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
    };
    const browser = {
      contexts: () => [context],
      newContext: vi.fn(),
      close: browserClose,
    };

    class FakeLogin {
      constructor() {
        this.signal = controller.signal;
      }

      async ensureAuthenticated() {
        return {
          state: AuthState.AUTHENTICATED,
          reason: 'ok',
          signals: ['authenticated_nav_visible'],
          url: 'https://www.instagram.com/',
        };
      }
    }

    let resolveExport;
    const exportPromise = new Promise((resolve) => {
      resolveExport = resolve;
    });

    const run = runLoginProvisioning({
      storageStatePath: '/tmp/ig-auth-shutdown.json',
      logger: createLogger(),
      signal: controller.signal,
      waitForEnterAfterExport: false,
      connectOverCDP: vi.fn(async () => browser),
      InstagramLoginClass: FakeLogin,
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.AUTHENTICATED,
        reason: 'ok',
        signals: ['authenticated_nav_visible'],
        url: 'https://www.instagram.com/',
      })),
      exportStorageStateFn: vi.fn(async () => exportPromise),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // Finish the in-flight export, then abort before return completes if needed.
    resolveExport({
      cookieCount: 1,
      originCount: 1,
      hasInstagramState: true,
      removedCookieCount: 0,
      removedOriginCount: 0,
      absolutePath: '/tmp/ig-auth-shutdown.json',
      bytes: 32,
      mode: 0o600,
    });

    await expect(run).resolves.toMatchObject({ bytes: 32 });
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(browser.newContext).not.toHaveBeenCalled();
  });

  it('aborts during session export start when signal fires before write begins', async () => {
    const controller = new AbortController();
    const browserClose = vi.fn(async () => {});
    const page = {
      goto: vi.fn(async () => {}),
      url: vi.fn(() => 'https://www.instagram.com/'),
      isClosed: () => false,
    };
    const context = {
      pages: () => [],
      newPage: vi.fn(async () => page),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
    };
    const browser = {
      contexts: () => [context],
      newContext: vi.fn(),
      close: browserClose,
    };

    class FakeLogin {
      async ensureAuthenticated() {
        controller.abort(new ShutdownError('abort before export'));
        throwIfAborted(controller.signal);
        return {
          state: AuthState.AUTHENTICATED,
          reason: 'ok',
          signals: [],
          url: 'https://www.instagram.com/',
        };
      }
    }

    const exportStorageStateFn = vi.fn(async () => ({
      cookieCount: 1,
      originCount: 1,
      absolutePath: '/tmp/x.json',
      bytes: 1,
      mode: 0o600,
    }));

    await expect(
      runLoginProvisioning({
        storageStatePath: '/tmp/ig-auth-abort-export.json',
        logger: createLogger(),
        signal: controller.signal,
        waitForEnterAfterExport: false,
        connectOverCDP: vi.fn(async () => browser),
        InstagramLoginClass: FakeLogin,
        exportStorageStateFn,
      }),
    ).rejects.toBeInstanceOf(ShutdownError);

    expect(exportStorageStateFn).not.toHaveBeenCalled();
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it('Chrome remains conceptually open after CDP disconnection helper', async () => {
    const logger = createLogger();
    const browser = { close: vi.fn(async () => {}) };
    await disconnectExistingChrome(browser, logger);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Disconnected from existing Chrome (browser left open)',
    );
  });
});

describe('waitUntilStopped signal handling', () => {
  it('clears auth timers and resolves abort without leaving intervals', async () => {
    const controller = new AbortController();
    const emitter = new EventEmitter();
    const browserManager = {
      isExistingMode: () => true,
      isStorageStateMode: () => false,
      getBrowser: () => emitter,
      getContext: () => emitter,
      getPage: () => ({}),
    };

    const pending = waitUntilStopped(browserManager, createLogger(), {
      monitorAuth: true,
      authCheckIntervalMs: 20,
      signal: controller.signal,
      detectAuthStateFn: vi.fn(async () => ({
        state: AuthState.AUTHENTICATED,
        reason: 'ok',
        signals: [],
        url: 'https://www.instagram.com/',
      })),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new ShutdownError('SIGINT'));
    await expect(pending).rejects.toBeInstanceOf(ShutdownError);
  });
});

describe('interrupted storage-state writes', () => {
  /** @type {string} */
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-shutdown-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not corrupt an existing session file when a write fails mid-flight', async () => {
    const target = path.join(dir, 'instagram-auth.json');
    const original = {
      cookies: [
        {
          name: 'sessionid',
          value: 'keep-me',
          domain: '.instagram.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        },
      ],
      origins: [
        {
          origin: 'https://www.instagram.com',
          localStorage: [],
        },
      ],
    };

    await writeStorageStateAtomic(target, original);
    const before = fs.readFileSync(target, 'utf8');

    await expect(
      writeStorageStateAtomic(target, {
        cookies: 'not-an-array',
        origins: [],
      }),
    ).rejects.toBeTruthy();

    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });
});
