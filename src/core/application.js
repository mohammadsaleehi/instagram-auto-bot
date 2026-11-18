import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from '../config/config.js';
import { createLogger } from '../utils/logger.js';
import {
  createShutdownController,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  ShutdownError,
  throwIfAborted,
} from '../utils/shutdown.js';
import { BrowserManager, BrowserError } from '../browser/browser-manager.js';
import { InstagramLogin, LoginError } from '../auth/instagram-login.js';
import { AuthState } from '../auth/auth-state.js';
import { SessionPersistenceManager } from '../auth/session-persistence.js';
import { ensureStorageStateAuthenticated } from '../auth/storage-state-auth.js';
import { StorageStateError } from '../auth/storage-state.js';
import { Database, resolveDatabasePath } from '../storage/database.js';
import { TaskRepository } from '../storage/repositories/task-repository.js';
import { EventRepository } from '../storage/repositories/event-repository.js';
import { SettingsRepository } from '../storage/repositories/settings-repository.js';
import { ScheduleRepository } from '../storage/repositories/schedule-repository.js';
import { TaskManager } from '../tasks/task-manager.js';
import { ScheduleStore } from '../scheduler/schedule-store.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { BrowserAdapter } from '../adapters/browser-adapter.js';
import { InstagramAdapter } from '../adapters/instagram-adapter.js';
import { SessionMonitor } from '../monitoring/session-monitor.js';
import { HealthMonitor } from '../monitoring/health-monitor.js';
import { buildSystemStatus } from '../monitoring/system-status.js';
import { ControlServer } from '../ipc/control-server.js';
import { EventBus } from './event-bus.js';
import { ApplicationState, LifecycleManager } from './lifecycle-manager.js';
import { exitCodeForError, sanitizeError } from './error-handler.js';
import { DEMO_TASK_TYPE } from '../tasks/constants.js';
import { createContentManager } from '../modules/content/content-manager.js';
import { createIntelligenceManager } from '../intelligence/intelligence-manager.js';

/**
 * Single-account automation application.
 * Reuses existing auth/browser infrastructure; owns the task engine lifecycle.
 */
export class Application {
  /**
   * @param {{
   *   loadConfigFn?: typeof loadConfig,
   *   createLoggerFn?: typeof createLogger,
   *   BrowserManagerClass?: typeof BrowserManager,
   *   InstagramLoginClass?: typeof InstagramLogin,
   *   SessionPersistenceManagerClass?: typeof SessionPersistenceManager,
   *   ensureStorageStateAuthenticatedFn?: typeof ensureStorageStateAuthenticated,
   *   createShutdownControllerFn?: typeof createShutdownController,
   *   DatabaseClass?: typeof Database,
   *   TaskManagerClass?: typeof TaskManager,
   *   SchedulerClass?: typeof Scheduler,
   *   ControlServerClass?: typeof ControlServer,
   *   forceExitFn?: (code?: number) => void,
   *   shutdownTimeoutMs?: number,
   *   env?: NodeJS.ProcessEnv,
   *   enqueueStartupHealthCheck?: boolean,
   * }} [options]
   */
  constructor(options = {}) {
    this.options = options;
    this.eventsBus = new EventBus();
    this.lifecycle = new LifecycleManager({ eventsBus: this.eventsBus });

    /** @type {ReturnType<typeof createLogger> | null} */
    this.logger = null;
    /** @type {ReturnType<typeof loadConfig> | null} */
    this.config = null;
    /** @type {ReturnType<typeof createShutdownController> | null} */
    this.shutdown = null;
    /** @type {Database | null} */
    this.database = null;
    /** @type {BrowserManager | null} */
    this.browserManager = null;
    /** @type {BrowserAdapter | null} */
    this.browserAdapter = null;
    /** @type {InstagramAdapter | null} */
    this.instagramAdapter = null;
    /** @type {SessionPersistenceManager | null} */
    this.persistence = null;
    /** @type {string | null} */
    this.lastPersistenceSaveAt = null;
    /** @type {TaskManager | null} */
    this.taskManager = null;
    /** @type {Scheduler | null} */
    this.scheduler = null;
    /** @type {SessionMonitor | null} */
    this.sessionMonitor = null;
    /** @type {HealthMonitor | null} */
    this.healthMonitor = null;
    /** @type {ControlServer | null} */
    this.controlServer = null;
    /** @type {ReturnType<typeof createContentManager> | null} */
    this.contentManager = null;
    /** @type {ReturnType<typeof createIntelligenceManager> | null} */
    this.intelligenceManager = null;
    this._shuttingDown = false;
    /** @type {Promise<void> | null} */
    this._stopPromise = null;
  }

  /**
   * @returns {Promise<void>}
   */
  async start() {
    const loadConfigFn = this.options.loadConfigFn ?? loadConfig;
    const createLoggerFn = this.options.createLoggerFn ?? createLogger;
    const createShutdownControllerFn =
      this.options.createShutdownControllerFn ?? createShutdownController;
    const BrowserManagerClass =
      this.options.BrowserManagerClass ?? BrowserManager;
    const InstagramLoginClass =
      this.options.InstagramLoginClass ?? InstagramLogin;
    const SessionPersistenceManagerClass =
      this.options.SessionPersistenceManagerClass ?? SessionPersistenceManager;
    const ensureStorageStateAuthenticatedFn =
      this.options.ensureStorageStateAuthenticatedFn ??
      ensureStorageStateAuthenticated;
    const DatabaseClass = this.options.DatabaseClass ?? Database;
    const TaskManagerClass = this.options.TaskManagerClass ?? TaskManager;
    const SchedulerClass = this.options.SchedulerClass ?? Scheduler;
    const ControlServerClass = this.options.ControlServerClass ?? ControlServer;

    this.lifecycle.transition(ApplicationState.STARTING);

    try {
      this.config = loadConfigFn(this.options.env);
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
        this.lifecycle.transition(ApplicationState.FAILED);
        return;
      }
      throw error;
    }

    this.logger = createLoggerFn({ level: this.config.logLevel });
    this.logger.info('Application started', {
      browserMode: this.config.browserMode,
      timezone: this.config.appTimezone,
    });

    this.shutdown = createShutdownControllerFn({
      logger: this.logger,
      shutdownTimeoutMs:
        this.options.shutdownTimeoutMs ??
        this.config.taskShutdownTimeoutMs ??
        DEFAULT_SHUTDOWN_TIMEOUT_MS,
      forceExitFn: this.options.forceExitFn,
      onShutdown: () => {
        void this.stop();
      },
    });

    try {
      // Storage
      this.database = new DatabaseClass({
        filePath: this.config.databasePath,
        logger: this.logger,
      });
      this.database.open();

      const taskRepo = new TaskRepository(this.database);
      const eventRepo = new EventRepository(this.database);
      const settingsRepo = new SettingsRepository(this.database);
      const scheduleRepo = new ScheduleRepository(this.database);
      void settingsRepo;

      // Browser + auth
      this.lifecycle.transition(ApplicationState.AUTHENTICATING);
      this.browserManager = new BrowserManagerClass({
        mode: this.config.browserMode,
        userDataDir: this.config.userDataDir,
        headless: this.config.headless,
        viewport: this.config.viewport,
        browserChannel: this.config.browserChannel,
        browserExecutablePath: this.config.browserExecutablePath,
        browserPlatform: this.config.browserPlatform,
        cdpEndpoint: this.config.cdpEndpoint,
        authStorageStatePath: this.config.authStorageStatePath,
        navigationTimeoutMs: this.config.navigationTimeoutMs,
        signal: this.shutdown.signal,
        logger: this.logger,
      });

      throwIfAborted(this.shutdown.signal);
      const page = await this.browserManager.start();
      throwIfAborted(this.shutdown.signal);

      this.browserAdapter = new BrowserAdapter({
        browserManager: this.browserManager,
      });
      this.instagramAdapter = new InstagramAdapter({
        browser: this.browserAdapter,
        baseUrl: this.config.instagramBaseUrl,
      });

      /** @type {import('../auth/auth-state.js').AuthStateResult} */
      let authResult;
      if (this.browserManager.isStorageStateMode()) {
        authResult = await ensureStorageStateAuthenticatedFn(page, {
          baseUrl: this.config.instagramBaseUrl,
          navigationTimeoutMs: this.config.navigationTimeoutMs,
          logger: this.logger,
          storageStatePath: this.config.authStorageStatePath,
        });
        this.persistence = new SessionPersistenceManagerClass({
          context: this.browserManager.getContext(),
          page,
          storageStatePath: this.config.authStorageStatePath,
          intervalMs: this.config.authStateSaveIntervalMs,
          logger: this.logger,
        });
        const originalSave = this.persistence.save.bind(this.persistence);
        this.persistence.save = async () => {
          await originalSave();
          this.lastPersistenceSaveAt = new Date().toISOString();
        };
        this.persistence.start();
      } else {
        const login = new InstagramLoginClass({
          page,
          baseUrl: this.config.instagramBaseUrl,
          loginTimeoutMs: this.config.loginTimeoutMs,
          navigationTimeoutMs: this.config.navigationTimeoutMs,
          autoLogin: this.config.autoLogin,
          username: this.config.username,
          password: this.config.password,
          signal: this.shutdown.signal,
          logger: this.logger,
        });
        authResult = await login.ensureAuthenticated();
      }

      throwIfAborted(this.shutdown.signal);
      if (authResult.state !== AuthState.AUTHENTICATED) {
        throw new LoginError(`Expected AUTHENTICATED, received ${authResult.state}`, {
          code: 'AUTH_INCOMPLETE',
        });
      }

      // Monitoring + tasks
      this.sessionMonitor = new SessionMonitor({
        instagram: this.instagramAdapter,
        logger: this.logger,
        eventsBus: this.eventsBus,
        intervalMs: this.config.sessionMonitorIntervalMs,
        onInvalid: () => {
          this.taskManager?.pause();
          this.lifecycle.transition(ApplicationState.PAUSED);
        },
      });
      // Seed monitor with known-good auth.
      this.sessionMonitor.lastResult = authResult;
      this.sessionMonitor.lastCheckedAt = new Date().toISOString();

      this.taskManager = new TaskManagerClass({
        tasks: taskRepo,
        events: eventRepo,
        logger: this.logger,
        concurrencyLimit: this.config.workerConcurrency,
        retryBaseMs: this.config.taskRetryBaseMs,
        retryMaxMs: this.config.taskRetryMaxMs,
        staleTimeoutMs: this.config.taskStaleTimeoutMs,
        pollIntervalMs: this.config.workerPollIntervalMs,
        signal: this.shutdown.signal,
        eventsBus: this.eventsBus,
        createContext: (task) => ({
          browser: this.browserAdapter,
          instagram: this.instagramAdapter,
          logger: this.logger,
          events: this.eventsBus,
          config: this.config,
          task,
        }),
        healthCheck: async () => {
          if (this.sessionMonitor?.isInvalid()) {
            return {
              ok: false,
              pauseAuthTasks: true,
              reason:
                this.sessionMonitor.getStatus().reason ??
                'Authentication invalid',
            };
          }
          if (!this.browserAdapter?.isConnected()) {
            return {
              ok: false,
              reason: 'Browser disconnected',
            };
          }
          return { ok: true };
        },
      });

      this.contentManager = createContentManager({
        database: this.database,
        config: this.config,
        scheduleRepository: scheduleRepo,
        taskRepository: taskRepo,
      });
      this.taskManager.registerHandler(this.contentManager.publishHandler);
      this.logger.info('Content management module registered', {
        adapter: this.contentManager.adapter.getCapabilities().name,
        dryRunDefault: this.config.contentDryRun,
        mediaLibraryDir: this.config.mediaLibraryDir,
      });

      this.intelligenceManager = createIntelligenceManager({
        database: this.database,
        config: this.config,
        taskRepository: taskRepo,
        logger: this.logger,
      });
      this.taskManager.registerHandler(this.intelligenceManager.executeHandler);
      this.logger.info('Intelligence Core module registered', {
        provider: this.intelligenceManager.provider.name,
        isMock: Boolean(this.intelligenceManager.provider.isMock),
        modelConfigured: Boolean(this.config.openrouterModel),
      });

      this.scheduler = new SchedulerClass({
        store: new ScheduleStore(scheduleRepo),
        enqueue: (input) => this.taskManager.enqueue(input),
        timezone: this.config.appTimezone,
        pollIntervalMs: this.config.schedulerPollIntervalMs,
        logger: this.logger,
        signal: this.shutdown.signal,
        onBeforeTick: (now) => {
          try {
            const expired = this.contentManager?.service?.expireDueStories?.({
              now,
              limit: 50,
            });
            if (expired?.length) {
              this.logger.info('Marked expired Instagram Stories', {
                count: expired.length,
              });
            }
          } catch (error) {
            this.logger.warn('Story expiration sweep failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });

      const app = this;
      this.healthMonitor = new HealthMonitor({
        browser: this.browserAdapter,
        session: this.sessionMonitor,
        database: this.database,
        taskManager: this.taskManager,
        persistence: {
          isRunning: () => Boolean(app.persistence?.isRunning()),
          get lastSaveAt() {
            return app.lastPersistenceSaveAt;
          },
        },
      });

      this.controlServer = new ControlServerClass({
        socketPath: this.config.controlSocketPath,
        tokenPath: this.config.controlTokenPath,
        logger: this.logger,
        handlers: {
          status: () => this.getStatus(),
          pause: () => this.pause(),
          resume: () => this.resume(),
          jobs: (params) => this.listJobs(params),
          doctor: () => this.doctor(),
        },
      });
      await this.controlServer.start();

      this.sessionMonitor.start();
      this.lifecycle.transition(ApplicationState.RUNNING);

      if (this.options.enqueueStartupHealthCheck !== false) {
        this.taskManager.enqueueHealthCheck({
          note: 'startup-health-check',
          idempotencyKey: `startup-health:${new Date().toISOString().slice(0, 13)}`,
        });
      }

      // Run worker + scheduler until shutdown.
      await Promise.all([
        this.taskManager.start(),
        this.scheduler.start(),
        this._waitForShutdown(),
      ]);

      if (this.shutdown?.shuttingDown || this.shutdown?.signal?.aborted) {
        this.logger?.info('Application stopped by shutdown signal');
        process.exitCode = process.exitCode ?? 130;
      }
    } catch (error) {
      if (error instanceof ShutdownError) {
        this.logger?.info('Application stopped by shutdown signal');
        process.exitCode = process.exitCode ?? 130;
      } else if (
        error instanceof BrowserError ||
        error instanceof LoginError ||
        error instanceof StorageStateError
      ) {
        this.logger?.error(error.message, {
          code: 'code' in error ? error.code : undefined,
          name: error.name,
        });
        this.healthMonitor?.setLastError(error.message);
        process.exitCode = 1;
        this.lifecycle.transition(ApplicationState.FAILED);
      } else {
        const sanitized = sanitizeError(error);
        this.logger?.error('Unexpected error', sanitized);
        this.healthMonitor?.setLastError(sanitized.message);
        process.exitCode = exitCodeForError(error);
        this.lifecycle.transition(ApplicationState.FAILED);
      }
    } finally {
      await this.stop();
      if (process.exitCode === 130 || this.shutdown?.shuttingDown) {
        // CDP connect promises can keep the event loop alive.
        this.shutdown?.dispose();
        if (process.exitCode === 130) {
          (this.options.forceExitFn ?? ((code = 130) => process.exit(code)))(
            process.exitCode ?? 130,
          );
        }
      }
    }
  }

  /**
   * @returns {Promise<void>}
   */
  _waitForShutdown() {
    return new Promise((resolve) => {
      const signal = this.shutdown?.signal;
      if (!signal) {
        resolve();
        return;
      }
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /**
   * Idempotent graceful shutdown.
   * Concurrent callers await the same in-flight stop promise.
   *
   * @returns {Promise<void>}
   */
  stop() {
    if (this._stopPromise) {
      return this._stopPromise;
    }

    this._shuttingDown = true;
    this._stopPromise = this._stopInternal();
    return this._stopPromise;
  }

  /**
   * @returns {Promise<void>}
   */
  async _stopInternal() {
    this.lifecycle.transition(ApplicationState.STOPPING);
    this.logger?.info('Graceful shutdown starting');

    try {
      this.scheduler && (await this.scheduler.stop());
    } catch (error) {
      this.logger?.warn('Scheduler stop failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      this.taskManager && (await this.taskManager.stop());
    } catch (error) {
      this.logger?.warn('Task manager stop failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      this.sessionMonitor?.stop();
    } catch {
      // ignore
    }

    try {
      if (this.persistence) {
        await this.persistence.stop({ finalSave: true });
        this.lastPersistenceSaveAt = new Date().toISOString();
        this.persistence = null;
      }
    } catch (error) {
      this.logger?.error('Session persistence flush failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.controlServer?.stop();
      this.controlServer = null;
    } catch (error) {
      this.logger?.warn('Control server stop failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.browserManager?.close();
    } catch (error) {
      this.logger?.error('Browser shutdown error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      this.database?.close();
      this.database = null;
    } catch (error) {
      this.logger?.error('Database close failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.eventsBus.clear();
    this.shutdown?.dispose();
    this.lifecycle.transition(ApplicationState.STOPPED);
    this.logger?.info('Graceful shutdown complete');
  }

  /**
   * @returns {object}
   */
  pause() {
    const alreadyPaused = Boolean(this.taskManager?.worker.isPaused());
    this.taskManager?.pause();
    this.lifecycle.transition(ApplicationState.PAUSED);
    return {
      paused: true,
      changed: !alreadyPaused,
      alreadyPaused,
    };
  }

  /**
   * @returns {object}
   */
  resume() {
    if (this.sessionMonitor?.isInvalid()) {
      return {
        resumed: false,
        changed: false,
        reason: 'Authentication is still invalid',
        recovery: this.sessionMonitor.getStatus().recovery,
      };
    }
    const alreadyRunning =
      Boolean(this.taskManager?.worker.isRunning()) &&
      !Boolean(this.taskManager?.worker.isPaused()) &&
      this.lifecycle.state === ApplicationState.RUNNING;
    this.taskManager?.resume();
    this.lifecycle.transition(ApplicationState.RUNNING);
    return {
      resumed: true,
      changed: !alreadyRunning,
      alreadyRunning,
    };
  }

  /**
   * @param {Record<string, unknown>} [params]
   */
  listJobs(params = {}) {
    const limit =
      typeof params.limit === 'number' ? params.limit : Number(params.limit ?? 20);
    return {
      jobs: this.taskManager?.listJobs({ limit }) ?? [],
    };
  }

  /**
   * @returns {object}
   */
  getStatus() {
    const health = this.healthMonitor?.snapshot() ?? {
      healthy: false,
      browser: { connected: false, mode: null, ownsProcess: false },
      session: null,
      database: { open: false, integrity: { ok: false, detail: 'n/a' }, path: null },
      worker: null,
      persistence: { running: false, lastSaveAt: null },
      lastError: null,
    };

    return buildSystemStatus({
      applicationState: this.lifecycle.state,
      startedAt: this.lifecycle.startedAt,
      health,
    });
  }

  /**
   * Offline/online diagnostics without exposing secrets.
   *
   * @returns {object}
   */
  doctor() {
    const checks = [];
    const config = this.config;

    checks.push({
      name: 'config',
      ok: Boolean(config),
      detail: config
        ? {
            browserMode: config.browserMode,
            timezone: config.appTimezone,
            workerConcurrency: config.workerConcurrency,
            databasePath: config.databasePath,
          }
        : 'missing',
    });

    if (this.database?.isOpen()) {
      const integrity = this.database.checkIntegrity();
      checks.push({
        name: 'database',
        ok: integrity.ok,
        detail: {
          path: this.database.filePath,
          schemaVersion: this.database.getSchemaVersion(),
          integrity: integrity.detail,
        },
      });
    } else {
      checks.push({
        name: 'database',
        ok: false,
        detail: 'Database is not open',
      });
    }

    const authPath = config?.authStorageStatePath;
    const authExists = Boolean(authPath && fs.existsSync(authPath));
    checks.push({
      name: 'session_file',
      ok: config?.browserMode === 'storage-state' ? authExists : true,
      detail: {
        path: authPath ? path.basename(authPath) : null,
        present: authExists,
        note:
          config?.browserMode === 'storage-state'
            ? authExists
              ? 'storage-state file present (contents not read)'
              : 'missing — run npm run login and transfer securely'
            : 'not required for current browser mode',
      },
    });

    checks.push({
      name: 'browser',
      ok: Boolean(this.browserAdapter?.isConnected()),
      detail: this.browserAdapter?.getHealth() ?? { connected: false },
    });

    checks.push({
      name: 'authentication',
      ok: !this.sessionMonitor?.isInvalid(),
      detail: this.sessionMonitor?.getStatus() ?? null,
    });

    checks.push({
      name: 'handlers',
      ok: Boolean(this.taskManager?.getStatus().registeredHandlers.includes(DEMO_TASK_TYPE)),
      detail: this.taskManager?.getStatus().registeredHandlers ?? [],
    });

    return {
      ok: checks.every((check) => check.ok),
      checks,
    };
  }
}

/**
 * Resolve control socket path.
 *
 * @param {string | undefined} value
 * @param {string} projectRoot
 * @param {string} fallback
 */
export function resolveControlPath(value, projectRoot, fallback) {
  const raw = value === undefined || value === '' ? fallback : value.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

export { resolveDatabasePath };
