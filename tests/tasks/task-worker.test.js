import { describe, expect, it, vi, afterEach } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { TaskRepository } from '../../src/storage/repositories/task-repository.js';
import { EventRepository } from '../../src/storage/repositories/event-repository.js';
import { TaskManager } from '../../src/tasks/task-manager.js';
import { TaskStatus, ErrorClass, TaskError } from '../../src/tasks/constants.js';
import { TaskRecovery } from '../../src/tasks/task-recovery.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createManager(overrides = {}) {
  const database = new Database({ filePath: ':memory:' });
  database.open();
  const tasks = new TaskRepository(database);
  const events = new EventRepository(database);
  const manager = new TaskManager({
    tasks,
    events,
    logger: createLogger(),
    pollIntervalMs: 20,
    retryBaseMs: 10,
    retryMaxMs: 50,
    ...overrides,
  });
  return { database, tasks, events, manager };
}

describe('TaskWorker / TaskManager', () => {
  afterEach(() => {
    // nothing global
  });

  it('executes the demo health-check handler', async () => {
    const { manager, tasks } = createManager();
    const { task } = manager.enqueueHealthCheck({ note: 'unit' });

    const run = manager.start();
    await vi.waitFor(() => {
      const current = tasks.getById(task.id);
      expect(current?.status).toBe(TaskStatus.COMPLETED);
    }, { timeout: 2000 });

    await manager.stop();
    await run;
    expect(tasks.getById(task.id)?.resultMetadata).toMatchObject({
      ok: true,
      note: 'unit',
    });
  });

  it('supports pause and resume', async () => {
    const { manager, tasks } = createManager();
    manager.pause();
    const { task } = manager.enqueueHealthCheck({ note: 'paused' });
    const run = manager.start();

    await new Promise((r) => setTimeout(r, 80));
    expect(tasks.getById(task.id)?.status).toBe(TaskStatus.PENDING);

    manager.resume();
    await vi.waitFor(() => {
      expect(tasks.getById(task.id)?.status).toBe(TaskStatus.COMPLETED);
    }, { timeout: 2000 });

    await manager.stop();
    await run;
  });

  it('retries transient failures with backoff', async () => {
    const { manager, tasks, database } = createManager({
      registerDemoHandler: false,
    });
    let attempts = 0;
    manager.registry.register({
      type: 'test.retry',
      requiresAuth: false,
      externalSideEffect: false,
      execute: async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new TaskError('temporary network issue', {
            errorClass: ErrorClass.TRANSIENT_NETWORK,
            retryable: true,
          });
        }
        return { ok: true, attempts };
      },
    });

    const { task } = manager.enqueue({
      type: 'test.retry',
      maxAttempts: 3,
      payload: {},
    });
    const run = manager.start();
    await vi.waitFor(() => {
      expect(tasks.getById(task.id)?.status).toBe(TaskStatus.COMPLETED);
    }, { timeout: 3000 });
    await manager.stop();
    await run;
    expect(attempts).toBe(2);
    database.close();
  });

  it('does not retry authentication failures and pauses worker', async () => {
    const { manager, tasks } = createManager({ registerDemoHandler: false });
    manager.registry.register({
      type: 'test.auth',
      requiresAuth: true,
      execute: async () => {
        throw new TaskError('login required', {
          errorClass: ErrorClass.AUTHENTICATION_REQUIRED,
          retryable: false,
        });
      },
    });

    const { task } = manager.enqueue({ type: 'test.auth', maxAttempts: 5 });
    const run = manager.start();
    await vi.waitFor(() => {
      expect(tasks.getById(task.id)?.status).toBe(TaskStatus.NEEDS_ATTENTION);
    }, { timeout: 2000 });
    expect(manager.worker.isPaused()).toBe(true);
    await manager.stop();
    await run;
  });

  it('moves uncertain side effects to NEEDS_ATTENTION on stale recovery', () => {
    const { tasks, events } = createManager();
    const { task } = tasks.create({
      type: 'engine.health-check',
      payload: {},
    });
    tasks.update(task.id, {
      status: TaskStatus.RUNNING,
      sideEffectStarted: true,
    });
    // Force claimed_at into the past via raw SQL.
    tasks.db.raw
      .prepare(`UPDATE tasks SET claimed_by = 'dead', claimed_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), task.id);

    const recovery = new TaskRecovery({
      tasks,
      events,
      staleTimeoutMs: 60_000,
      logger: createLogger(),
    });
    const result = recovery.recoverStaleTasks();
    expect(result.needsAttention).toHaveLength(1);
    expect(tasks.getById(task.id)?.status).toBe(TaskStatus.NEEDS_ATTENTION);
  });

  it('re-queues stale RUNNING tasks without side effects', () => {
    const { tasks, events } = createManager();
    const { task } = tasks.create({ type: 'engine.health-check' });
    tasks.update(task.id, { status: TaskStatus.RUNNING, sideEffectStarted: false });
    tasks.db.raw
      .prepare(`UPDATE tasks SET claimed_by = 'dead', claimed_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), task.id);

    const recovery = new TaskRecovery({
      tasks,
      events,
      staleTimeoutMs: 60_000,
      logger: createLogger(),
    });
    const result = recovery.recoverStaleTasks();
    expect(result.recovered).toHaveLength(1);
    expect(tasks.getById(task.id)?.status).toBe(TaskStatus.PENDING);
  });
});
