import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { AuthState } from '../../src/auth/auth-state.js';
import { Application } from '../../src/core/application.js';
import { Database } from '../../src/storage/database.js';
import { TaskStatus } from '../../src/tasks/constants.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('Application graceful shutdown', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('stops worker, closes db, and disconnects without killing personal Chrome', async () => {
    const logger = createLogger();
    const page = {
      isClosed: () => false,
      url: () => 'https://www.instagram.com/',
    };
    const context = new EventEmitter();
    const browser = new EventEmitter();
    let closed = false;
    let disconnected = false;

    class FakeBrowserManager {
      constructor() {
        this.mode = 'existing';
        this._ownsBrowserProcess = false;
        this.page = page;
        this.context = context;
        this.browser = browser;
      }
      isRunning() {
        return !closed;
      }
      isExistingMode() {
        return true;
      }
      isLaunchMode() {
        return false;
      }
      isStorageStateMode() {
        return false;
      }
      async start() {
        return page;
      }
      getPage() {
        return page;
      }
      getContext() {
        return context;
      }
      getBrowser() {
        return browser;
      }
      async close() {
        closed = true;
        disconnected = true;
      }
      async disconnectExisting() {
        disconnected = true;
      }
    }

    class FakeLogin {
      async ensureAuthenticated() {
        return {
          state: AuthState.AUTHENTICATED,
          url: 'https://www.instagram.com/',
          signals: [],
          reason: 'ok',
        };
      }
    }

    const forceExitFn = vi.fn();
    const app = new Application({
      loadConfigFn: () => ({
        instagramBaseUrl: 'https://www.instagram.com',
        headless: false,
        viewport: { width: 1280, height: 800 },
        userDataDir: '/tmp/unused',
        browserMode: 'existing',
        browserChannel: 'chrome',
        browserExecutablePath: null,
        browserPlatform: 'x11',
        cdpEndpoint: 'chrome',
        authStorageStatePath: '/tmp/unused-auth.json',
        authStateSaveIntervalMs: 300_000,
        loginTimeoutMs: 1_000,
        navigationTimeoutMs: 1_000,
        logLevel: 'error',
        autoLogin: false,
        username: null,
        password: null,
        projectRoot: process.cwd(),
        appTimezone: 'Europe/Berlin',
        workerConcurrency: 1,
        taskMaxAttempts: 3,
        taskRetryBaseMs: 10,
        taskRetryMaxMs: 50,
        taskStaleTimeoutMs: 60_000,
        taskShutdownTimeoutMs: 5_000,
        workerPollIntervalMs: 20,
        schedulerPollIntervalMs: 50,
        sessionMonitorIntervalMs: 60_000,
        databasePath: ':memory:',
        controlSocketPath: `/tmp/bot-test-${process.pid}.sock`,
        controlTokenPath: `/tmp/bot-test-${process.pid}.token`,
      }),
      createLoggerFn: () => logger,
      BrowserManagerClass: FakeBrowserManager,
      InstagramLoginClass: FakeLogin,
      DatabaseClass: Database,
      forceExitFn,
      enqueueStartupHealthCheck: true,
      shutdownTimeoutMs: 5_000,
    });

    const started = app.start();

    await vi.waitFor(() => {
      expect(app.lifecycle.state).toBe('RUNNING');
    }, { timeout: 3000 });

    // Wait for demo task completion.
    await vi.waitFor(() => {
      const jobs = app.taskManager?.listJobs({ limit: 5 }) ?? [];
      expect(jobs.some((job) => job.status === TaskStatus.COMPLETED)).toBe(true);
    }, { timeout: 3000 });

    process.emit('SIGINT');
    await started;

    expect(disconnected).toBe(true);
    expect(app.database).toBeNull();
    expect(app.lifecycle.state).toBe('STOPPED');
    expect(process.exitCode).toBe(130);
    // Fake existing-mode close disconnects only; no Chrome process kill API is used.
    expect(closed).toBe(true);
  });
});
